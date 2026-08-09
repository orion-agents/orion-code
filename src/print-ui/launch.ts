import { AgentRuntimeController } from '../runtime/agent-runtime-controller';
import { emitToUiEventSink, type AgentRuntimeEventSink } from '../runtime/agent-runtime-protocol';
import { resolveUiRendererCapabilities } from '../runtime/ui-events';
import type {
  EditPreviewRequest,
  ModelPickerRequest,
  OrionCodeUiRuntime,
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  SessionPickerRequest,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from '../runtime/ui-events';
import type { GoalRuntimeEvent } from '../runtime/goals/types';
import { formatGoalRuntimeEvent } from '../runtime/goals/presentation';
import type { ResearchLifecycleEvent } from '../runtime/subagents/research-renderer';
import {
  appendResearchEventHistory,
  formatResearchLifecycleEvent,
  projectResearchLifecycleEvent,
  type ResearchStatusProjection,
} from '../runtime/ui-view-model';

export type PrintOutputFormat = 'text' | 'json';

export interface PrintModeOptions {
  outputFormat?: PrintOutputFormat;
}

export interface PrintModeResult {
  content: string;
  entries: TranscriptEntry[];
  toolEvents: PrintRuntimeToolEvent[];
  statuses: string[];
  errors: string[];
  goalEvents: GoalRuntimeEvent[];
  researchEvents: ResearchLifecycleEvent[];
  research: ResearchStatusProjection | null;
  sessionId: string | null;
  model: string;
}

export type PrintRuntimeToolEvent =
  | ({ type: 'started' } & RuntimeToolStartedEvent)
  | ({ type: 'finished' } & RuntimeToolFinishedEvent);

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/g, '');
}

function stderrLine(text: string): void {
  if (!text.trim()) return;
  process.stderr.write(`${stripTrailingNewlines(text)}\n`);
}

function flushStdout(text: string = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function flushStderr(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write('', error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export class PrintEventSink implements UiEventSink {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly printedContent = new Map<string, string>();
  private readonly toolEvents: PrintRuntimeToolEvent[] = [];
  private readonly statuses: string[] = [];
  private readonly errors: string[] = [];
  private readonly goalEvents: GoalRuntimeEvent[] = [];
  private researchEvents: ResearchLifecycleEvent[] = [];
  private researchProjection: ResearchStatusProjection | null = null;
  private idCounter = 0;

  constructor(
    private readonly runtime: OrionCodeUiRuntime,
    private readonly outputFormat: PrintOutputFormat
  ) {}

  append(entry: TranscriptAppendEntry): string {
    const id = `print-${++this.idCounter}`;
    const fullEntry: TranscriptEntry = {
      id,
      role: entry.role,
      title: entry.title,
      content: entry.content,
    };
    this.entries.set(id, fullEntry);
    this.printEntry(fullEntry, false);
    return id;
  }

  update(id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    const next = { ...existing, ...patch };
    this.entries.set(id, next);
    this.printEntry(next, false);
  }

  finalize(id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    const next = patch ? { ...existing, ...patch } : existing;
    this.entries.set(id, next);
    this.printEntry(next, true);
  }

  remove(id: string): void {
    this.entries.delete(id);
    this.printedContent.delete(id);
  }

  replaceTranscript(entries: TranscriptEntry[]): void {
    this.entries.clear();
    this.printedContent.clear();
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  clearTranscript(): void {
    this.entries.clear();
    this.printedContent.clear();
  }

  setStatus(message: string): void {
    if (!message.trim()) return;
    this.statuses.push(message);
    if (message.startsWith('Goal continuation deferred but persistence failed:')) {
      this.errors.push(message);
    }
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  showSessionPicker(request: SessionPickerRequest): void {
    const message = `Session picker is not interactive in print mode. Use /resume <session-id> or /resume --last. (${request.sessions.length} sessions available)`;
    this.errors.push(message);
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  showModelPicker(request: ModelPickerRequest): void {
    const message = `Model picker is not interactive in print mode. Use /model <name|alias> to switch. (${request.models.length} models available)`;
    this.errors.push(message);
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  showEditPreview(_request: EditPreviewRequest): void {
    const message = 'Edit preview rendering is not available in print mode.';
    this.errors.push(message);
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  showPermissionRequest(request: ToolPermissionRequest): void {
    const message = `Tool ${request.name} requires confirmation, but print mode is non-interactive.${request.reason ? ` ${request.reason}` : ''}`;
    this.errors.push(message);
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  toolStarted(event: RuntimeToolStartedEvent): void {
    this.toolEvents.push({ type: 'started', ...event });
  }

  toolFinished(event: RuntimeToolFinishedEvent): void {
    this.toolEvents.push({ type: 'finished', ...event });
  }

  goalEvent(event: GoalRuntimeEvent): void {
    this.goalEvents.push(event);
    if (this.outputFormat === 'text') {
      stderrLine(formatGoalRuntimeEvent(event));
    }
  }

  researchEvent(event: ResearchLifecycleEvent): void {
    this.researchEvents = appendResearchEventHistory(this.researchEvents, event);
    this.researchProjection = projectResearchLifecycleEvent(this.researchProjection, event);
    if (this.outputFormat === 'text') {
      stderrLine(formatResearchLifecycleEvent(event, 'print'));
    }
  }

  setProcessing(_processing: boolean): void {
    // Non-interactive print mode has no live processing indicator.
  }

  result(): PrintModeResult {
    const entries = Array.from(this.entries.values());
    const content = entries
      .filter(
        entry => entry.role === 'assistant' || entry.role === 'system' || entry.role === 'command'
      )
      .map(entry => entry.content)
      .filter(Boolean)
      .join('\n')
      .trimEnd();

    return {
      content,
      entries,
      toolEvents: [...this.toolEvents],
      statuses: [...this.statuses],
      errors: [...this.errors],
      goalEvents: [...this.goalEvents],
      researchEvents: [...this.researchEvents],
      research: this.researchProjection
        ? {
            ...this.researchProjection,
            sources: [...this.researchProjection.sources],
            conflictClaimIds: [...this.researchProjection.conflictClaimIds],
          }
        : null,
      sessionId: this.runtime.getSession()?.id ?? null,
      model: this.runtime.store.getSnapshot().currentModel || this.runtime.config.model,
    };
  }

  hasErrors(): boolean {
    return (
      Array.from(this.entries.values()).some(entry => entry.role === 'error') ||
      this.errors.length > 0
    );
  }

  private printEntry(entry: TranscriptEntry, finalized: boolean): void {
    if (this.outputFormat === 'json' || !entry.content) return;

    if (entry.role === 'assistant') {
      this.printAssistantDelta(entry, finalized);
      return;
    }

    const previous = this.printedContent.get(entry.id);
    if (previous === entry.content && !finalized) return;
    this.printedContent.set(entry.id, entry.content);

    if (entry.role === 'error') {
      this.errors.push(entry.content);
      stderrLine(entry.content);
      return;
    }

    if (entry.role === 'tool' || entry.role === 'status') {
      stderrLine(entry.content);
      return;
    }

    process.stdout.write(`${stripTrailingNewlines(entry.content)}\n`);
  }

  private printAssistantDelta(entry: TranscriptEntry, finalized: boolean): void {
    const previous = this.printedContent.get(entry.id) ?? '';
    const next = entry.content;
    if (next === previous && !finalized) return;

    if (next.startsWith(previous)) {
      const delta = next.slice(previous.length);
      if (delta) process.stdout.write(delta);
    } else {
      process.stdout.write(next);
    }
    this.printedContent.set(entry.id, next);

    if (finalized && next && !next.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
}

export async function readPromptFromStdinIfAvailable(
  stdin: NodeJS.ReadStream = process.stdin
): Promise<string> {
  if (stdin.isTTY) return '';

  stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of stdin) {
    data += String(chunk);
  }
  return data.trim();
}

export async function launchPrintMode(
  runtime: OrionCodeUiRuntime,
  input: string,
  options: PrintModeOptions = {}
): Promise<number> {
  const outputFormat = options.outputFormat ?? 'text';
  await runtime.mcpReady?.catch(() => undefined);

  const events = new PrintEventSink(runtime, outputFormat);
  const eventSink: AgentRuntimeEventSink = {
    emit: event => {
      if (event.type !== 'permission_requested') {
        return emitToUiEventSink(events, event);
      }

      events.showPermissionRequest(event.request);
      controller.handle({
        type: 'permission_decision',
        requestId: event.request.id,
        approved: false,
        source: 'programmatic',
      });
      return undefined;
    },
  };
  const controller = new AgentRuntimeController({
    runtime,
    eventSink,
    echoSubmittedInput: false,
    useRuntimeToolPermissions: true,
    uiCapabilities: resolveUiRendererCapabilities(undefined, 'print'),
    uiRenderer: 'print',
  });

  let requestedExitCode: number | undefined;
  let lifecycleError: unknown;
  let hasLifecycleError = false;
  try {
    const result = controller.handle({ type: 'submit', text: input, source: 'programmatic' });
    if (result.type === 'exit_requested' || result.type === 'empty') {
      requestedExitCode = result.type === 'empty' ? 1 : 0;
    } else {
      await controller.waitForIdle();
    }
  } catch (error) {
    lifecycleError = error;
    hasLifecycleError = true;
  }

  // A completed turn may already have queued a Goal continuation for the next
  // tick. Stop the shared controller before shutting down runtime services so
  // non-interactive mode can never issue a ghost provider call. Capture errors
  // until after output is drained because the CLI exits immediately on reject.
  try {
    await controller.stopActiveTurn();
  } catch (error) {
    lifecycleError = error;
    hasLifecycleError = true;
  }
  try {
    await runtime.shutdown();
  } catch (error) {
    // Preserve shutdown as the primary lifecycle failure, matching the former
    // nested-finally behavior when stopping and shutdown both failed.
    lifecycleError = error;
    hasLifecycleError = true;
  }

  let outputError: unknown;
  let hasOutputError = false;
  try {
    if (outputFormat === 'json') {
      await flushStdout(`${JSON.stringify(events.result(), null, 2)}\n`);
    } else {
      // `src/cli.ts` exits immediately after this promise resolves. Queueing an
      // empty write behind the streamed text guarantees every prior write has
      // reached the underlying descriptor before that explicit process exit.
      await flushStdout();
    }
  } catch (error) {
    outputError = error;
    hasOutputError = true;
  }
  // Status, Goal lifecycle and error diagnostics are written to stderr. The
  // CLI calls process.exit immediately after this function resolves, so queue
  // a callback behind those writes as well to prevent redirected diagnostics
  // from being truncated.
  try {
    await flushStderr();
  } catch (error) {
    if (!hasOutputError) {
      outputError = error;
      hasOutputError = true;
    }
  }

  if (hasLifecycleError) throw lifecycleError;
  if (hasOutputError) throw outputError;

  if (events.hasErrors()) return 1;
  return requestedExitCode ?? 0;
}
