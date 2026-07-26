import {
  AgentRuntimeController,
  type AgentRuntimeInput,
} from '../runtime/agent-runtime-controller';
import { format as formatConsoleMessage } from 'util';
import {
  resolveUiRendererCapabilities,
  type OpenHorseUiRuntime,
  type SessionPickerRequest,
  type UiEventSink,
} from '../runtime/ui-events';
import { contextUsageStatusText, createStatusSnapshot } from '../runtime/ui-view-model';
import { TuiRunner } from './runner';
import { InlineTerminalSurface } from './inline-surface';
import { FileToolDetailRepository } from '../runtime/tool-detail-repository';
import { TranscriptInspectorSurface } from './transcript-inspector-surface';
import { spawn } from 'child_process';

const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const SHOW_CURSOR = '\x1b[?25h';
const ENABLE_AUTOWRAP = '\x1b[?7h';
const EXIT_ALTERNATE_SCREEN = '\x1b[?1049l';

export interface TuiLaunchOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export async function launchTuiUI(
  runtime: OpenHorseUiRuntime,
  options: TuiLaunchOptions = {}
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  if (input.isTTY === false || output.isTTY === false) {
    throw new Error('TUI renderer requires a TTY input and output');
  }

  let runner!: TuiRunner;
  let controller!: AgentRuntimeController;
  let surface!: InlineTerminalSurface;
  let systemId: string | null = null;
  let stopping = false;
  let settled = false;
  let resolveLaunch: (() => void) | null = null;
  // Once guard: shared cleanup promise so concurrent stop calls share one execution.
  let cleanupPromise: Promise<void> | null = null;
  let restoreConsole: (() => void) | null = null;

  const dimensions = () => {
    const size = readTtyDimensions(output);
    return {
      width: Math.max(24, size.width),
      height: Math.max(8, size.height),
    };
  };

  const finishLaunch = (): void => {
    if (settled) return;
    settled = true;
    resolveLaunch?.();
  };

  /**
   * Emergency terminal restore — independent of runner/controller/surface.
   * Used when cleanup cannot complete normally (renderer error, partial init).
   * Must not throw; all operations are best-effort with optional guards.
   */
  const emergencyRestore = (): void => {
    try {
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(false);
      }
    } catch {
      /* best effort */
    }
    try {
      input.pause();
    } catch {
      /* best effort */
    }
    try {
      output.write(
        `${SHOW_CURSOR}${ENABLE_AUTOWRAP}${DISABLE_BRACKETED_PASTE}${EXIT_ALTERNATE_SCREEN}\n`
      );
    } catch {
      /* best effort */
    }
  };

  /** Route process-level rejection feedback through the owned TUI surface. */
  const onUnhandledRejection = (reason: unknown): void => {
    if (stopping) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    runner.dispatch({ type: 'setStatus', message: `Unhandled rejection: ${message}` });
  };

  /**
   * Once-guarded cleanup. Multiple concurrent calls (SIGINT, SIGTERM, runtime
   * shutdown, renderer error) all share the same promise. Only the first call
   * executes; subsequent calls await the same promise.
   */
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;

    cleanupPromise = (async () => {
      // Clear any pending resize debounce timer.
      if (resizeDebounceTimer !== null) {
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = null;
      }
      // Remove listeners first to prevent re-entrancy.
      try {
        input.off('data', handleData);
      } catch {
        /* ok */
      }
      try {
        output.off('resize', handleResize);
      } catch {
        /* ok */
      }
      try {
        process.off('SIGWINCH', handleResize);
      } catch {
        /* ok */
      }
      try {
        process.off('SIGINT', handleSigint);
      } catch {
        /* ok */
      }
      try {
        process.off('SIGTERM', handleSigterm);
      } catch {
        /* ok */
      }
      try {
        process.off('SIGHUP', handleSighup);
      } catch {
        /* ok */
      }
      try {
        process.off('unhandledRejection', onUnhandledRejection);
      } catch {
        /* ok */
      }

      // Stop active turn (controller may not exist if init failed).
      if (controller) {
        try {
          await controller.stopActiveTurn();
        } catch {
          /* best effort — don't block cleanup */
        }
      }

      if (runner) {
        try {
          await runner.closeModalSurface();
          await runner.flushTranscriptCommits();
        } catch {
          /* best effort */
        }
      }

      // Restore raw mode.
      try {
        if (typeof input.setRawMode === 'function') {
          input.setRawMode(false);
        }
      } catch {
        /* best effort */
      }
      try {
        input.pause();
      } catch {
        /* best effort */
      }

      // Stop scheduler before surface cleanup (prevents pending renders).
      if (runner) {
        try {
          runner.getScheduler().stop();
        } catch {
          /* best effort */
        }
      }

      // Flush surface queue to ensure all pending writes complete.
      if (surface) {
        try {
          await surface.flush();
        } catch {
          /* best effort */
        }
      }

      // Unmount surface (clears ephemeral live region only).
      if (surface) {
        try {
          await surface.unmount();
        } catch {
          /* best effort */
        }
      }

      restoreConsole?.();
      restoreConsole = null;

      // Restore terminal state: cursor, autowrap, bracketed paste.
      // NO alternate-screen exit, NO full clear, NO erasing committed scrollback.
      try {
        output.write(`${SHOW_CURSOR}${ENABLE_AUTOWRAP}${DISABLE_BRACKETED_PASTE}`);
      } catch {
        /* best effort */
      }

      // Runtime shutdown last; preserves original exit code/signal semantics.
      try {
        await runtime.shutdown();
      } catch {
        /* best effort */
      }
    })();

    return cleanupPromise;
  };

  /**
   * Initiate graceful stop. Once-guarded: only the first call proceeds.
   * Uses async/await so finishLaunch() runs in the same microtask chain
   * as cleanup completion.
   */
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await cleanup();
    } catch {
      // Cleanup error must not mask the original error.
      // Emergency restore as fallback.
      emergencyRestore();
    }
    finishLaunch();
  };

  /**
   * Handle renderer-layer errors. Emergency restore first, then report.
   */
  const failRenderer = (error: unknown): void => {
    if (stopping) return;
    stopping = true;

    // Emergency restore independent of partially-constructed objects.
    emergencyRestore();

    // Report sanitized renderer-layer error to stderr.
    try {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\nTUI renderer error: ${message}\n`);
    } catch {
      /* best effort */
    }

    // Attempt full cleanup (may partially fail — that's ok).
    // Ensure finishLaunch() runs on both success and rejection so the error
    // path always completes and no unhandled promise rejection escapes.
    void cleanup()
      .catch(() => {
        // Cleanup failure must not mask the original renderer error.
        emergencyRestore();
      })
      .finally(() => {
        finishLaunch();
      });
  };

  const consumeSessionPickerSelection = (inputValue: string): string | AgentRuntimeInput => {
    const overlay = runner.getState().overlay;
    if (overlay?.type !== 'sessions') return inputValue;

    runner.dispatch({ type: 'closeOverlay' });
    const request: SessionPickerRequest = overlay.request;
    const trimmed = inputValue.trim();
    if (!trimmed) {
      const selected = request.sessions[overlay.selectedIndex];
      if (!selected) {
        runner.events.append({ role: 'error', content: 'No session selected.' });
        return '';
      }
      return {
        type: 'select_session',
        sessionId: selected.id,
        allProjects: request.allProjects,
        source: 'picker',
      };
    }

    if (trimmed.startsWith('/')) return trimmed;

    const numeric = trimmed.match(/^#?(\d+)$/);
    if (numeric) {
      const index = Number(numeric[1]) - 1;
      const selected = request.sessions[index];
      if (!selected) {
        runner.events.append({ role: 'error', content: `No session at index ${numeric[1]}.` });
        return '';
      }
      return {
        type: 'select_session',
        sessionId: selected.id,
        allProjects: request.allProjects,
        source: 'picker',
      };
    }

    return {
      type: 'select_session',
      sessionId: trimmed,
      allProjects: request.allProjects,
      source: 'picker',
    };
  };

  const submit = (rawInput: string): void => {
    // Finalize the initial system message so it can be committed to scrollback
    // and the commit boundary can advance past it.
    if (systemId !== null) {
      runner.events.finalize(systemId);
      systemId = null; // Only finalize once.
    }

    const selectedInput = consumeSessionPickerSelection(rawInput);
    const runtimeInput: AgentRuntimeInput =
      typeof selectedInput === 'string'
        ? { type: 'submit', text: selectedInput.trim(), source: 'composer' }
        : selectedInput;
    if (runtimeInput.type === 'submit' && !runtimeInput.text) return;

    const result = controller.handle(runtimeInput);
    if (result.type === 'exit_requested') {
      void stop();
    }
  };

  const handleCtrlC = (): void => {
    if (runner.getState().overlay) {
      runner.dispatch({ type: 'closeOverlay' });
      controller.handle({ type: 'clear_exit_intent' });
      return;
    }

    const result = controller.handle({ type: 'interrupt', source: 'keyboard' });
    if (result.type === 'exit_requested') {
      void stop();
      return;
    }
    // Visual feedback: show interrupt/exit-prompt warning in the status bar
    runner.dispatch({
      type: 'setStatus',
      message:
        result.type === 'interrupted'
          ? '⚠️ Interrupted — press Ctrl+C again to force exit'
          : '⚠️ Press Ctrl+C again to exit',
    });
  };

  const handleData = (chunk: Buffer): void => {
    if (!stopping) {
      runner.feedInput(chunk);
    }
  };

  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const RESIZE_DEBOUNCE_MS = 100;

  const handleResize = (): void => {
    if (stopping) return;
    runner.beginResize(dimensions().width);
    if (resizeDebounceTimer !== null) {
      clearTimeout(resizeDebounceTimer);
    }
    resizeDebounceTimer = setTimeout(() => {
      resizeDebounceTimer = null;
      if (stopping) return;
      const { width, height } = dimensions();
      runner.resize(width, height);
    }, RESIZE_DEBOUNCE_MS);
  };

  const handleSigint = (): void => {
    handleCtrlC();
  };

  // SIGTERM/SIGHUP: direct cancel + cleanup (no "double Ctrl+C" product semantics).
  const handleSigterm = (): void => {
    void stop();
  };

  const handleSighup = (): void => {
    void stop();
  };

  try {
    // Primary-screen inline surface: no alternate screen (1049).
    const { width, height } = dimensions();
    surface = new InlineTerminalSurface({ output });
    const inspectorSurface = new TranscriptInspectorSurface(output);
    // Mount enters the same serialized queue as subsequent paints. Start it
    // synchronously so input listeners are installed in this turn; awaiting it
    // here creates a window where early keystrokes are dropped.
    void surface.mount(width, height).catch(error => failRenderer(error));
    // surface.mount() enables bracketed paste and hides cursor; no need for
    // redundant output.write of those sequences.
    runner = new TuiRunner({
      output,
      width,
      height,
      cwd: runtime.cwd,
      onSubmit: submit,
      onCtrlC: handleCtrlC,
      onPermissionDecision: (requestId, approved) => {
        controller.handle({
          type: 'permission_decision',
          requestId,
          approved,
          source: 'keyboard',
        });
      },
      surface,
      onSurfaceError: failRenderer,
      detailRepository: new FileToolDetailRepository(),
      inspectorSurface,
      onOpenExternalEditor: async filePath => {
        await surface.suspend();
        input.off('data', handleData);
        try {
          if (typeof input.setRawMode === 'function') input.setRawMode(false);
          input.pause();
          await launchExternalEditor(filePath);
        } finally {
          if (!stopping) {
            input.resume();
            if (typeof input.setRawMode === 'function') input.setRawMode(true);
            input.on('data', handleData);
            await surface.restore(() => null, dimensions().width, dimensions().height);
          }
        }
      },
    });
    restoreConsole = installTuiConsoleBridge(runner.events, () => stopping);
    const dispatchStatusSnapshot = (phase: 'ready' | 'running'): string => {
      const runtimeSnapshot = runtime.store.getSnapshot();
      const snapshot = createStatusSnapshot({
        renderer: 'tui',
        model: runtimeSnapshot.currentModel || runtime.config.model,
        sessionId: runtime.getSession()?.id,
        context: runtimeSnapshot.contextUsage ?? undefined,
        runningState: phase,
        tokens: tokensFromRuntime(runtime),
      });
      runner.dispatch({ type: 'setStatusSnapshot', snapshot, phase });
      return statusSnapshotString(runtime);
    };
    controller = new AgentRuntimeController({
      runtime,
      events: runner.events,
      uiCapabilities: resolveUiRendererCapabilities(undefined, 'tui'),
      uiRenderer: 'tui',
      useRuntimeToolPermissions: true,
      runningStatus: () => dispatchStatusSnapshot('running'),
      readyStatus: () => dispatchStatusSnapshot('ready'),
    });
    // The initial system message stays live (not finalized) so it's visible
    // in the live region rather than scrolling off into shell scrollback.
    // It's finalized when the user submits their first input.
    systemId = runner.events.append({
      role: 'system',
      content: `ORION CODE v${runtime.version}\nProject ${runtime.cwd}\n/ commands   @ files   ? shortcuts   Ctrl+O tools   Ctrl+C twice exits`,
      live: true,
    });
    runner.events.setStatus(statusSnapshotString(runtime));
    dispatchStatusSnapshot('ready');

    input.resume();
    if (typeof input.setRawMode === 'function') {
      input.setRawMode(true);
    }
    input.on('data', handleData);
    output.on('resize', handleResize);
    process.on('SIGWINCH', handleResize);
    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);
    process.on('SIGHUP', handleSighup);
    process.on('unhandledRejection', onUnhandledRejection);

    await new Promise<void>(resolve => {
      resolveLaunch = resolve;
    });
  } catch (error) {
    failRenderer(error);
    throw error;
  }
}

export function parseExternalEditorCommand(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  let started = false;

  for (const character of commandLine.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true;
      started = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      started = true;
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      started = true;
      continue;
    }
    if (/\s/.test(character) && quote === null) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (escaped || quote !== null) {
    throw new Error('Invalid $VISUAL/$EDITOR command: unterminated quote or escape');
  }
  if (started) args.push(current);
  return args;
}

function launchExternalEditor(filePath: string): Promise<void> {
  const editorCommand = process.env.VISUAL || process.env.EDITOR || 'vi';
  const [editor, ...editorArgs] = parseExternalEditorCommand(editorCommand);
  if (!editor) {
    return Promise.reject(new Error('$VISUAL/$EDITOR does not name an executable'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [...editorArgs, filePath], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${editor} exited from signal ${signal}`
            : `${editor} exited with code ${code ?? 'unknown'}`
        )
      );
    });
  });
}

function installTuiConsoleBridge(events: UiEventSink, isStopping: () => boolean): () => void {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const originalWarn = console.warn;
  const originalError = console.error;

  const publish = (role: 'system' | 'error', args: unknown[]): void => {
    if (isStopping()) return;
    const content = stripTerminalControlSequences(formatConsoleMessage(...args)).trimEnd();
    if (!content) return;
    const id = events.append({ role, content });
    events.finalize(id);
  };
  const log = (...args: unknown[]): void => publish('system', args);
  const info = (...args: unknown[]): void => publish('system', args);
  const debug = (...args: unknown[]): void => publish('system', args);
  const warn = (...args: unknown[]): void => publish('system', args);
  const error = (...args: unknown[]): void => publish('error', args);

  console.log = log;
  console.info = info;
  console.debug = debug;
  console.warn = warn;
  console.error = error;

  return () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function tokensFromRuntime(rt: OpenHorseUiRuntime): {
  input?: number;
  output?: number;
  contextPercent?: number;
} {
  const snapshot = rt.store.getSnapshot();
  const usage = snapshot.tokenUsage;
  return {
    input: usage?.promptTokens,
    output: usage?.completionTokens,
    contextPercent: snapshot.contextUsage?.percent,
  };
}

export function statusSnapshotString(rt: OpenHorseUiRuntime): string {
  const snapshot = rt.store.getSnapshot();
  const session = rt.getSession()?.id.slice(0, 8) ?? 'none';
  const tokens = snapshot.tokenUsage
    ? `${((snapshot.tokenUsage.promptTokens + snapshot.tokenUsage.completionTokens) / 1000).toFixed(1)}K`
    : '0.0K';
  const context = contextUsageStatusText(snapshot.contextUsage);
  return [
    `model=${snapshot.currentModel || rt.config.model}`,
    context,
    `session=${session}`,
    `tokens=${tokens}`,
  ]
    .filter(Boolean)
    .join('  ');
}

function readTtyDimensions(output: NodeJS.WriteStream): { width: number; height: number } {
  const getWindowSize = (
    output as NodeJS.WriteStream & {
      getWindowSize?: () => [number, number];
    }
  ).getWindowSize;

  if (typeof getWindowSize === 'function') {
    try {
      const [width, height] = getWindowSize.call(output);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    } catch {
      // Fall back to cached columns/rows below.
    }
  }

  return {
    width: output.columns || 80,
    height: output.rows || 24,
  };
}
