import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { DOMElement } from 'ink/build/dom';
import { getCommandCategoryLabel, getCommands, getVisibleCommands } from '../../commands';
import { getModeDisplayText } from '../../commands/types';
import { AgentRuntimeController } from '../../runtime/agent-runtime-controller';
import { resolveUiRendererCapabilities } from '../../runtime/ui-events';
import {
  createCommandPickerState,
  createEditPreviewPickerState,
  createFilePickerState,
  createPermissionDecisionPickerState,
  createSessionRestoredView,
  getFileMentionQuery,
  subtaskEventToTimelineEntry,
  type SubtaskTimelineEntry,
} from '../../runtime/ui-view-model';
import { addToInputHistory, getInputHistory } from '../../services/global-config';
import { formatBytes } from '../../services/format';
import { matchFiles } from '../../services/file-glob';
import type { SessionMeta } from '../../services/session-storage';
import { NativeCursor } from '../components/NativeCursor';
import { PromptInput } from '../components/PromptInput';
import { PixelHorseBanner } from '../components/PixelHorseBanner';
import { SelectList, type SelectListItem } from '../components/SelectList';
import { StatusLine } from '../components/StatusLine';
import { Transcript, TranscriptEntryBlock } from '../components/Transcript';
import { useRawInputBridge } from '../hooks/use-raw-input-bridge';
import { useTerminalSize } from '../hooks/use-terminal-size';
import { initialInputBuffer, reduceInputBuffer, type InputBuffer } from '../runtime/input-buffer';
import { getInkLayoutBudget } from '../runtime/layout-budget';
import type { NativeCursorController } from '../runtime/native-cursor';
import { deleteActionFromRawInput, hasDeletionRawInput } from '../runtime/raw-input';
import {
  initialTranscriptState,
  liveTranscriptEntries,
  staticTranscriptEntries,
  transcriptReducer,
} from '../runtime/transcript-state';
import type { OpenHorseUiRuntime, SessionPickerRequest, ToolPermissionRequest, TranscriptAppendEntry, TranscriptEntry, UiEventSink, EditPreviewRequest, RuntimeSubtaskEvent } from '../types';

type Overlay =
  | { type: 'commands'; selectedIndex: number }
  | { type: 'files'; selectedIndex: number }
  | { type: 'sessions'; selectedIndex: number; request: SessionPickerRequest }
  | { type: 'edit'; selectedIndex: number; request: EditPreviewRequest }
  | { type: 'permission'; selectedIndex: number; request: ToolPermissionRequest }
  | { type: 'shortcuts' }
  | null;

let nextTranscriptId = 1;

function createId(): string {
  return `ui-${nextTranscriptId++}`;
}

type StaticTranscriptItem =
  | { id: string; type: 'banner' }
  | (TranscriptEntry & { type: 'entry' });

export function visibleCommandItems(input: string): SelectListItem[] {
  return createCommandPickerState({
    input,
    commands: getVisibleCommands(),
    categoryLabel: getCommandCategoryLabel,
  }).visibleItems.map(item => ({
    value: item.value,
    label: item.label,
    description: item.description,
  }));
}

export function getFileQuery(input: string): { base: string; query: string } | null {
  return getFileMentionQuery(input);
}

export function visibleFileItems(cwd: string, input: string): SelectListItem[] {
  const fileQuery = getFileQuery(input);
  if (!fileQuery) return [];
  const state = createFilePickerState({
    input,
    files: matchFiles(fileQuery.query, cwd, { limit: 80 }),
    maxVisibleItems: 80,
  });
  return state?.visibleItems.map(item => ({
    value: item.value,
    label: item.label,
    description: item.description,
  })) ?? [];
}

function sessionTitle(session: SessionMeta): string {
  return session.name || session.taskSummary || '(untitled)';
}

export function sessionItems(request: SessionPickerRequest): SelectListItem[] {
  return request.sessions.map(session => ({
    value: session.id,
    label: `${session.id.slice(0, 8)}  ${sessionTitle(session)}`,
    description: [
      `${session.messageCount ?? 0} msgs`,
      formatBytes(session.historySizeBytes ?? 0),
      session.model,
      request.showProject ? session.projectPath : '',
    ].filter(Boolean).join('  '),
  }));
}

export function permissionItems(request: ToolPermissionRequest): SelectListItem[] {
  return createPermissionDecisionPickerState(request).visibleItems.map(item => ({
    value: item.value,
    label: item.label,
    description: item.description,
  }));
}

export function editPreviewTitle(request: EditPreviewRequest): string {
  return createEditPreviewPickerState({ request }).title;
}

export function editPreviewItems(request: EditPreviewRequest): SelectListItem[] {
  return createEditPreviewPickerState({ request }).visibleItems.map(item => ({
    value: item.value,
    label: item.label,
    description: item.description,
  }));
}

export function normalizePastedInput(value: string): string {
  return value
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .replace(/\[200~/g, '')
    .replace(/\[201~/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function isMultilinePasteValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizePastedInput(value);
  return normalized.length > 1 && normalized.includes('\n');
}

export interface ReplScreenProps {
  runtime: OpenHorseUiRuntime;
  cursorController: NativeCursorController;
  resizeEpoch?: number;
}

export function ReplScreen({ runtime, cursorController, resizeEpoch = 0 }: ReplScreenProps): JSX.Element {
  const app = useApp();
  const { stdout } = useStdout();
  const terminalSize = useTerminalSize(stdout);
  const terminalHeight = terminalSize.height;
  const terminalWidth = terminalSize.width;
  const [transcriptState, dispatchTranscript] = useReducer(transcriptReducer, initialTranscriptState);
  const [inputBuffer, dispatchInput] = useReducer(reduceInputBuffer, initialInputBuffer);
  const input = inputBuffer.value;
  const inputCursor = inputBuffer.cursor;
  const [overlay, setOverlay] = useState<Overlay>(null);
  const layout = useMemo(
    () => getInkLayoutBudget(terminalWidth, terminalHeight, { overlayVisible: overlay !== null }),
    [terminalWidth, terminalHeight, overlay]
  );
  const { layoutWidth, maxLiveTranscriptItems, maxOverlayItems, maxPromptRows } = layout;
  const [processing, setProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  // R8: typed subagent timeline, keyed by taskId (last write wins).
  const [, setSubtaskTimeline] = useState<SubtaskTimelineEntry[]>([]);
  const [exiting, setExiting] = useState(false);
  const [history, setHistory] = useState(() => getInputHistory());
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [, setStoreVersion] = useState(0);
  const shuttingDownRef = useRef(false);
  const lastCtrlCEventAtRef = useRef(0);
  const inputRef = useRef<InputBuffer>(initialInputBuffer);
  const promptBoxRef = useRef<DOMElement>(null);
  const bracketedPasteActiveRef = useRef(false);

  useEffect(() => {
    inputRef.current = inputBuffer;
  }, [inputBuffer]);

  useEffect(() => runtime.store.subscribe(() => setStoreVersion(version => version + 1)), [runtime.store]);

  const append = useCallback((entry: TranscriptAppendEntry): string => {
    const id = createId();
    const next = { id, ...entry };
    dispatchTranscript({ type: 'append', entry: next });
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => {
    dispatchTranscript({ type: 'update', id, patch });
  }, []);

  const finalize = useCallback((id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>) => {
    dispatchTranscript({ type: 'finalize', id, patch });
  }, []);

  const remove = useCallback((id: string) => {
    dispatchTranscript({ type: 'remove', id });
  }, []);

  const events: UiEventSink = useMemo(() => ({
    append,
    update,
    finalize,
    remove,
    replaceTranscript: entries => {
      dispatchTranscript({ type: 'replace', entries });
    },
    clearTranscript: () => {
      dispatchTranscript({ type: 'clear' });
    },
    setStatus: setStatusMessage,
    showSessionPicker: request => setOverlay({ type: 'sessions', selectedIndex: 0, request }),
    showEditPreview: request => setOverlay({ type: 'edit', selectedIndex: 0, request }),
    showPermissionRequest: request => setOverlay({ type: 'permission', selectedIndex: 0, request }),
    setProcessing,
    sessionRestored: event => {
      const view = createSessionRestoredView(event);
      const lines = [view.headline];
      if (view.summary) lines.push(`Summary: ${view.summary}`);
      if (view.summaryGeneratedAt) {
        lines.push(
          `Generated: ${new Date(view.summaryGeneratedAt).toLocaleString()} (${view.checkpointId ? 'compact checkpoint' : 'generated on resume'})`
        );
      }
      if (typeof view.summaryCoveredMessages === 'number') {
        lines.push(`Covers: ${view.summaryCoveredMessages} source messages`);
      }
      lines.push(
        `✔ Restored ${event.restoredMessages} model-context messages / ${event.transcriptMessages ?? event.messageCount ?? event.restoredMessages} transcript messages`
      );
      dispatchTranscript({
        type: 'append',
        entry: {
          id: `resume-${event.sessionId}`,
          role: 'status',
          title: 'resume',
          content: lines.join('\n'),
          errorLayer: undefined,
        },
      });
    },
    // R8: consume the typed subagent event into the shared timeline. Keyed by
    // taskId so state advances queued -> running -> terminal without duplicates.
    subtaskEvent: (event: RuntimeSubtaskEvent) => {
      const entry = subtaskEventToTimelineEntry(event);
      setSubtaskTimeline(prev => {
        const without = prev.filter(e => e.taskId !== entry.taskId);
        return [...without, entry];
      });
    },
  }), [append, finalize, remove, stdout, update]);

  const agentController = useMemo(() => new AgentRuntimeController({
    runtime,
    events,
    uiCapabilities: resolveUiRendererCapabilities(undefined, 'ink'),
    uiRenderer: 'ink',
    exitConfirmWindowMs: 5000,
    useRuntimeToolPermissions: true,
    beforeTurn: () => setStatusMessage(''),
  }), [runtime, events]);

  const shutdown = useCallback(() => {
    if (shuttingDownRef.current) return;
    shuttingDownRef.current = true;
    cursorController.disable();
    runtime.store.setProcessing(false);
    setProcessing(false);
    setExiting(true);

    setTimeout(() => {
      app.exit();
    }, 50);

    void runtime.shutdown().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Orion Code shutdown warning: ${message}\n`);
    });
  }, [app, cursorController, runtime]);

  const submit = useCallback((value: string) => {
    const submitted = value.trim();
    if (!submitted) return;
    dispatchInput({ type: 'clear' });
    setOverlay(null);
    addToInputHistory(submitted);
    setHistory(getInputHistory());
    setHistoryIndex(-1);

    const result = agentController.handle({ type: 'submit', text: submitted, source: 'composer' });
    if (result.type === 'exit_requested') {
      void shutdown();
    }
  }, [agentController, shutdown]);

  const answerPermission = useCallback((request: ToolPermissionRequest, approved: boolean) => {
    setOverlay(null);
    agentController.handle({
      type: 'permission_decision',
      requestId: request.id,
      approved,
      source: 'keyboard',
    });
  }, [agentController]);

  const closeOverlay = useCallback((): boolean => {
    if (!overlay) return false;
    if (overlay.type === 'permission') {
      answerPermission(overlay.request, false);
      return true;
    }
    setOverlay(null);
    return true;
  }, [answerPermission, overlay]);

  const handleCtrlC = useCallback(() => {
    if (closeOverlay()) {
      agentController.handle({ type: 'clear_exit_intent' });
      return;
    }

    const result = agentController.handle({ type: 'interrupt', source: 'keyboard' });
    if (result.type === 'exit_requested') {
      void shutdown();
    }
  }, [agentController, closeOverlay, shutdown]);

  const handleCtrlCEvent = useCallback((options: { allowRapidRepeat?: boolean } = {}) => {
    const now = Date.now();
    const delta = now - lastCtrlCEventAtRef.current;
    if (!options.allowRapidRepeat && delta < 30) {
      return;
    }
    lastCtrlCEventAtRef.current = now;
    handleCtrlC();
  }, [handleCtrlC]);

  const lastRawInputRef = useRawInputBridge(handleCtrlCEvent);

  const commandItems = visibleCommandItems(input);
  const fileItems = visibleFileItems(runtime.cwd, input);

  const completeCommand = useCallback((item: SelectListItem, submitImmediately: boolean) => {
    const command = getCommands().find(candidate => candidate.name === item.value);
    const value = `/${item.value}${command?.argumentHint || command?.params?.some(param => param.required) ? ' ' : ''}`;
    setOverlay(null);
    if (submitImmediately && value.trim() === `/${item.value}`) {
      submit(value);
    } else {
      dispatchInput({ type: 'set', value });
    }
  }, [submit]);

  const completeFile = useCallback((item: SelectListItem) => {
    const fileQuery = getFileQuery(inputRef.current.value);
    if (!fileQuery) return;
    dispatchInput({ type: 'set', value: `${fileQuery.base}@${item.value}` });
    setOverlay(null);
  }, []);

  const selectSession = useCallback((request: SessionPickerRequest, index: number) => {
    const session = request.sessions[index];
    if (!session) return;
    setOverlay(null);
    const result = agentController.handle({
      type: 'select_session',
      sessionId: session.id,
      allProjects: request.allProjects,
      source: 'picker',
    });
    if (result.type === 'exit_requested') {
      void shutdown();
    }
  }, [agentController, shutdown]);

  useInput((value, key: any) => {
    const isReturn = key?.return || value === '\r' || value === '\n';

    if (key?.ctrl && value === 'c') {
      handleCtrlCEvent();
      return;
    }

    agentController.handle({ type: 'clear_exit_intent' });

    const rawInput = lastRawInputRef.current || '';
    const pasteSource = value || rawInput;
    const startsBracketedPaste = rawInput.includes('\x1b[200~')
      || pasteSource.includes('\x1b[200~')
      || pasteSource.includes('[200~');
    const endsBracketedPaste = rawInput.includes('\x1b[201~')
      || pasteSource.includes('\x1b[201~')
      || pasteSource.includes('[201~');

    if (!key?.ctrl && (bracketedPasteActiveRef.current || startsBracketedPaste || endsBracketedPaste)) {
      bracketedPasteActiveRef.current = true;
      const normalized = normalizePastedInput(value || rawInput);
      if (normalized) {
        dispatchInput({ type: 'inputChunk', text: normalized });
      }
      setOverlay(null);
      if (endsBracketedPaste) {
        bracketedPasteActiveRef.current = false;
      }
      return;
    }

    if (!key?.ctrl && isMultilinePasteValue(value)) {
      dispatchInput({ type: 'inputChunk', text: normalizePastedInput(value) });
      setOverlay(null);
      return;
    }

    if (overlay?.type === 'shortcuts') {
      if (key?.escape || isReturn || value === '?') setOverlay(null);
      return;
    }

    if (overlay?.type === 'commands') {
      const items = commandItems;
      if (key?.escape) {
        setOverlay(null);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, items.length - 1), overlay.selectedIndex + 1) });
        return;
      }
      if (key?.tab && items[overlay.selectedIndex]) {
        completeCommand(items[overlay.selectedIndex], false);
        return;
      }
      if (isReturn && items[overlay.selectedIndex]) {
        completeCommand(items[overlay.selectedIndex], true);
        return;
      }
    }

    if (overlay?.type === 'files') {
      const items = fileItems;
      if (key?.escape) {
        setOverlay(null);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, items.length - 1), overlay.selectedIndex + 1) });
        return;
      }
      if ((key?.tab || isReturn) && items[overlay.selectedIndex]) {
        completeFile(items[overlay.selectedIndex]);
        return;
      }
    }

    if (overlay?.type === 'sessions') {
      const total = overlay.request.sessions.length;
      if (key?.escape) {
        setOverlay(null);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, total - 1), overlay.selectedIndex + 1) });
        return;
      }
      if (key?.pageUp) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 10) });
        return;
      }
      if (key?.pageDown) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, total - 1), overlay.selectedIndex + 10) });
        return;
      }
      if (isReturn) {
        selectSession(overlay.request, overlay.selectedIndex);
        return;
      }
    }

    if (overlay?.type === 'edit') {
      const total = overlay.request.candidates.length;
      if (key?.escape || isReturn) {
        setOverlay(null);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, total - 1), overlay.selectedIndex + 1) });
        return;
      }
      if (key?.pageUp) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 10) });
        return;
      }
      if (key?.pageDown) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, total - 1), overlay.selectedIndex + 10) });
        return;
      }
    }

    if (overlay?.type === 'permission') {
      const items = permissionItems(overlay.request);
      if (key?.escape || value?.toLowerCase() === 'n') {
        answerPermission(overlay.request, false);
        return;
      }
      if (value?.toLowerCase() === 'y') {
        answerPermission(overlay.request, true);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow || key?.tab) {
        setOverlay({ ...overlay, selectedIndex: Math.min(items.length - 1, overlay.selectedIndex + 1) });
        return;
      }
      if (isReturn) {
        answerPermission(overlay.request, items[overlay.selectedIndex]?.value === 'allow');
        return;
      }
      return;
    }

    if (isReturn && key?.meta) {
      dispatchInput({ type: 'insert', text: '\n' });
      return;
    }

    if (key?.leftArrow) {
      dispatchInput({ type: 'move', direction: 'left' });
      return;
    }

    if (key?.rightArrow) {
      dispatchInput({ type: 'move', direction: 'right' });
      return;
    }

    if (key?.ctrl && value === 'a') {
      dispatchInput({ type: 'move', direction: 'home' });
      return;
    }

    if (key?.ctrl && value === 'e') {
      dispatchInput({ type: 'move', direction: 'end' });
      return;
    }

    if (key?.ctrl && value === 'u') {
      const rawInput = lastRawInputRef.current;
      dispatchInput({ type: 'inputChunk', text: rawInput.startsWith('\x15') ? rawInput : '\x15' });
      setOverlay(null);
      return;
    }

    if (isReturn) {
      submit(inputRef.current.value);
      return;
    }

    if (value && hasDeletionRawInput(value)) {
      dispatchInput({ type: 'inputChunk', text: value });
      return;
    }

    if (key?.backspace) {
      dispatchInput({ type: 'backspace' });
      return;
    }

    if (key?.delete) {
      dispatchInput({ type: deleteActionFromRawInput(value || lastRawInputRef.current) });
      return;
    }

    if (key?.upArrow && inputRef.current.value === '' && history.length > 0) {
      const nextIndex = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(nextIndex);
      dispatchInput({ type: 'set', value: history[nextIndex]?.content ?? '' });
      return;
    }

    if (key?.downArrow && historyIndex >= 0) {
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      dispatchInput({ type: 'set', value: nextIndex >= 0 ? history[nextIndex]?.content ?? '' : '' });
      return;
    }

    if (key?.tab) {
      if (inputRef.current.value.startsWith('/')) {
        setOverlay({ type: 'commands', selectedIndex: 0 });
      } else if (getFileQuery(inputRef.current.value)) {
        setOverlay({ type: 'files', selectedIndex: 0 });
      }
      return;
    }

    if (value === '/' && inputRef.current.value === '' && !agentController.hasActiveTurn()) {
      dispatchInput({ type: 'set', value: '/' });
      setOverlay({ type: 'commands', selectedIndex: 0 });
      return;
    }

    if (value === '@' && !agentController.hasActiveTurn()) {
      dispatchInput({ type: 'insert', text: '@' });
      setOverlay({ type: 'files', selectedIndex: 0 });
      return;
    }

    if (value === '?' && inputRef.current.value === '') {
      setOverlay({ type: 'shortcuts' });
      return;
    }

    if (value && !key?.ctrl) {
      dispatchInput({ type: 'inputChunk', text: value });
    }
  });

  const modeText = getModeDisplayText(runtime.store.getSnapshot().permissionMode);

  const staticItems = useMemo<StaticTranscriptItem[]>(
    () => [
      { id: 'orion-code-banner', type: 'banner' },
      ...staticTranscriptEntries(transcriptState).map(entry => ({ ...entry, type: 'entry' as const })),
    ],
    [transcriptState]
  );
  const liveEntries = useMemo(() => liveTranscriptEntries(transcriptState), [transcriptState]);

  if (exiting) {
    return <Box flexDirection="column" />;
  }

  return (
    <Box flexDirection="column">
      <Static key={`${transcriptState.generation}:${resizeEpoch}`} items={staticItems}>
        {item => item.type === 'banner' ? (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <PixelHorseBanner runtime={runtime} width={layoutWidth} />
          </Box>
        ) : (
          <TranscriptEntryBlock key={item.id} entry={item} width={layoutWidth} />
        )}
      </Static>

      <Transcript
        entries={liveEntries}
        maxItems={maxLiveTranscriptItems}
        width={layoutWidth}
        emptyMessage={null}
      />

      {overlay?.type === 'commands' ? (
        <SelectList
          title={`Commands ${input.slice(1) ? `"${input.slice(1)}"` : ''}`}
          items={commandItems}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={maxOverlayItems}
          footer="↑↓ navigate  Tab complete  Enter select  Esc cancel"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'files' ? (
        <SelectList
          title="Files"
          items={fileItems}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={maxOverlayItems}
          footer="↑↓ navigate  Tab/Enter complete  Esc cancel"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'sessions' ? (
        <SelectList
          title={overlay.request.title}
          items={sessionItems(overlay.request)}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={Math.min(overlay.request.maxVisibleItems ?? maxOverlayItems, maxOverlayItems)}
          footer="↑↓ scroll  PgUp/PgDn  Enter resume  Esc cancel"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'edit' ? (
        <SelectList
          title={editPreviewTitle(overlay.request)}
          items={editPreviewItems(overlay.request)}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={maxOverlayItems}
          footer="↑↓ scroll  PgUp/PgDn  Enter/Esc close"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'permission' ? (
        <SelectList
          title="Tool Permission"
          items={permissionItems(overlay.request)}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={2}
          footer="↑↓ choose  Enter select  y allow  n/Esc deny"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'shortcuts' ? (
        <Box width={layoutWidth} borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
          <Text color="cyan">Shortcuts</Text>
          <Text>/ commands    @ file picker    ? shortcuts</Text>
          <Text>Alt+Enter newline    Ctrl+C interrupt / twice exits    ↑↓ history or picker navigation</Text>
          <Text color="gray">Enter or Esc closes this panel.</Text>
        </Box>
      ) : null}

      <StatusLine runtime={runtime} running={processing} statusMessage={statusMessage} width={layoutWidth} />
      <PromptInput ref={promptBoxRef} value={input} cursor={inputCursor} running={processing} modeText={modeText} width={layoutWidth} maxRows={maxPromptRows} />
      <NativeCursor
        cursorController={cursorController}
        promptRef={promptBoxRef}
        value={input}
        cursor={inputCursor}
        maxRows={maxPromptRows}
        terminalWidth={layoutWidth}
      />
    </Box>
  );
}
