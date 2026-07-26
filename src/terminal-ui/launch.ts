import chalk from 'chalk';
import stringWidth from 'string-width';

import {
  AgentRuntimeController,
  type AgentRuntimeInput,
} from '../runtime/agent-runtime-controller';
import { emitToUiEventSink, type AgentRuntimeEventSink } from '../runtime/agent-runtime-protocol';
import { resolveUiRendererCapabilities } from '../runtime/ui-events';
import {
  createPermissionPromptState,
  createRuntimeCapabilitySummary,
  createSessionRestoredView,
  createSessionPickerState,
  contextUsageStatusText,
  movePickerPageOffset,
  permissionRiskDisplayValue,
  permissionScopeDisplayValue,
  subtaskEventToTimelineEntry,
  type SessionPickerItem,
  sessionPickerTitle,
  type SubtaskTimelineEntry,
} from '../runtime/ui-view-model';
import { formatBytes } from '../services/format';
import { redactTraceText } from '../services/redaction';
import { applyTerminalTabCompletion } from './completion';
import { openExternalEditor } from './editor';
import { RawTerminalEditor } from './raw-editor';
import { TerminalOutputQueue, type TerminalOutputWriter } from './output-queue';
import type {
  EditPreviewRequest,
  OpenHorseUiRuntime,
  RuntimeSessionRestoredEvent,
  RuntimeSubtaskEvent,
  SessionPickerRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  ToolPermissionRequest,
  UiEventSink,
} from '../runtime/ui-events';
import { isTargetCommand, parseTargetCommand } from '../commands/target-command';
import { GoalCoordinator } from '../runtime/goals/coordinator';

const ACCENT = chalk.hex('#80E6E8');
const DIM = chalk.hex('#567089');
const ERROR = chalk.hex('#FF7A7A');
const WARNING = chalk.hex('#F2C14E');
const TOOL = chalk.hex('#7FA2B8');
const BORDER = chalk.hex('#38556A');

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/g, '');
}

export type TerminalSessionPickerSelection =
  | { type: 'cancelled' }
  | { type: 'slash'; input: string }
  | { type: 'selected'; sessionId: string }
  | { type: 'error'; message: string };

function normalizePickerText(value: string): string {
  return value.trim().toLowerCase();
}

function matchingSessionLabels(session: SessionPickerRequest['sessions'][number]): string[] {
  return [session.name, session.taskSummary].filter((value): value is string =>
    Boolean(value?.trim())
  );
}

function findSessionsByText(
  input: string,
  sessions: SessionPickerRequest['sessions']
): SessionPickerRequest['sessions'] {
  const query = normalizePickerText(input);
  if (!query) return [];
  const canMatchIdPrefix = query.length >= 4;

  return sessions.filter(session => {
    const id = session.id.toLowerCase();
    if (id === query || (canMatchIdPrefix && id.startsWith(query))) return true;
    return matchingSessionLabels(session).some(label => normalizePickerText(label).includes(query));
  });
}

function findSessionsByExactLabel(
  input: string,
  sessions: SessionPickerRequest['sessions']
): SessionPickerRequest['sessions'] {
  const query = normalizePickerText(input);
  if (!query) return [];
  return sessions.filter(session =>
    matchingSessionLabels(session).some(label => normalizePickerText(label) === query)
  );
}

export function resolveTerminalSessionPickerInput(
  input: string,
  request: SessionPickerRequest
): TerminalSessionPickerSelection {
  const trimmed = input.trim();
  if (!trimmed) return { type: 'cancelled' };
  if (trimmed.startsWith('/')) return { type: 'slash', input: trimmed };
  if (trimmed === '--last') {
    const latest = request.sessions[0];
    if (latest) return { type: 'selected', sessionId: latest.id };
    return { type: 'error', message: 'No recent session to resume.' };
  }

  const explicitIndex = trimmed.match(/^#(\d+)$/);
  if (explicitIndex) {
    const index = Number(explicitIndex[1]) - 1;
    const selected = request.sessions[index];
    if (selected) return { type: 'selected', sessionId: selected.id };
    return { type: 'error', message: `No session at index ${explicitIndex[1]}.` };
  }

  const numeric = trimmed.match(/^(\d+)$/);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    const selected = request.sessions[index];
    if (selected) return { type: 'selected', sessionId: selected.id };
  }

  const matches = findSessionsByText(trimmed, request.sessions);
  if (matches.length === 1) {
    return { type: 'selected', sessionId: matches[0].id };
  }
  if (matches.length > 1) {
    const preview = matches
      .slice(0, 3)
      .map(session => `${session.id.slice(0, 8)} ${sessionPickerTitle(session)}`)
      .join(', ');
    const suffix = matches.length > 3 ? `, +${matches.length - 3} more` : '';
    return {
      type: 'error',
      message: `Multiple sessions match "${trimmed}": ${preview}${suffix}. Type a number or a longer session id.`,
    };
  }

  if (numeric) {
    return {
      type: 'error',
      message: `No session at index ${numeric[1]} or id prefix "${trimmed}".`,
    };
  }

  return {
    type: 'error',
    message: `No session matches "${trimmed}". Type a number, #number, session id prefix, or /resume --last.`,
  };
}

function formatTranscriptEntry(entry: TranscriptEntry): string {
  const content = stripTrailingNewlines(entry.content);
  if (!content) return '';

  switch (entry.role) {
    case 'user':
      return `${ACCENT('›')} ${content}`;
    case 'tool':
      return TOOL(content);
    case 'error':
      return ERROR(formatTerminalErrorMessage(content, entry.errorLayer));
    case 'status':
      return DIM(content);
    case 'command':
    case 'system':
      return content;
    case 'assistant':
    default:
      return content;
  }
}

export type TerminalErrorLayer = import('../runtime/ui-events').ErrorLayer;

const TERMINAL_ERROR_LAYERS: TerminalErrorLayer[] = [
  'renderer',
  'runtime',
  'provider',
  'tool',
  'session',
  'memory',
  'mcp',
  'skills',
  'unknown',
];

export function formatTerminalErrorMessage(
  message: string,
  explicitLayer?: import('../runtime/ui-events').ErrorLayer
): string {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  if (hasErrorLayerPrefix(trimmed)) return trimmed;
  if (explicitLayer) {
    return `[${explicitLayer.toUpperCase()}] ${trimmed}`;
  }
  return `[${inferTerminalErrorLayer(trimmed)}] ${trimmed}`;
}

function hasErrorLayerPrefix(message: string): boolean {
  const lower = message.toLowerCase();
  return TERMINAL_ERROR_LAYERS.some(layer => {
    const label = layer.toLowerCase();
    return (
      lower.startsWith(`[${label}] `) ||
      lower.startsWith(`error [${label}]:`) ||
      lower.startsWith(`error: [${label}] `)
    );
  });
}

export function inferTerminalErrorLayer(message: string): TerminalErrorLayer {
  const lower = message.toLowerCase();

  if (/\bmcp\b/u.test(lower)) return 'MCP' as TerminalErrorLayer;
  if (/\b(skill|skills)\b/u.test(lower)) return 'skills';
  if (/\b(memory|vector store|recall|forget)\b/u.test(lower)) return 'memory';
  if (/\b(session|resume|compact)\b/u.test(lower)) return 'session';
  if (/\b(renderer|terminal|tty|prompt|resize|input editor|scrollback)\b/u.test(lower))
    return 'renderer';
  if (
    /\btool\b/u.test(lower) ||
    /\b(exec_command|read_file|write_file|edit_file|grep|glob|list_files)\b/u.test(lower) ||
    /command exited with code/u.test(lower) ||
    /path is a directory|not a file|enoent|eacces/u.test(lower)
  ) {
    return 'tool';
  }
  if (
    /\b(provider|model|llm|api|quota|rate limit|rate_limit|provider_busy)\b/u.test(lower) ||
    /\b(openai|anthropic|dashscope|bailian|xunfei|glm|qwen)\b/u.test(lower) ||
    /\bstatus code\b/u.test(lower) ||
    /notEnoughCvError|engineInternalError/i.test(message)
  ) {
    return 'provider';
  }

  return 'runtime';
}

function shouldShowStatus(message: string): boolean {
  return Boolean(message.trim());
}

export function formatTerminalStatusMessage(
  message: string,
  width = terminalContentWidth(120)
): string {
  return truncateTerminalText(message.replace(/\s+/g, ' ').trim(), Math.max(1, width));
}

// --- v0.2.24: /target command result formatting ---

import type { GoalControlInput } from '../runtime/goals/types';

function formatTargetCommandResult(input: GoalControlInput, coordinator?: GoalCoordinator): string {
  switch (input.action) {
    case 'show': {
      const goal = coordinator?.goal;
      if (goal) {
        const status = goal.status;
        const obj = goal.objective.length > 60 ? goal.objective.slice(0, 57) + '...' : goal.objective;
        const turns = goal.continuationCount;
        const tokens = goal.tokensUsed >= 1000 ? `${(goal.tokensUsed / 1000).toFixed(1)}K` : String(goal.tokensUsed);
        return `Target: ${status} · ${obj} · ${turns} turns · ${tokens} tokens`;
      }
      return 'Target: no active goal. Use /target <objective> to create one.';
    }
    case 'create':
      return `Goal created: ${input.payload?.objective ?? ''}`;
    case 'pause':
      return 'Goal paused. Use /target resume to continue.';
    case 'resume':
      return 'Goal resumed. Will continue when runtime is idle.';
    case 'edit':
      return `Goal updated: ${input.payload?.objective ?? ''}`;
    case 'replace':
      return `Goal replaced: ${input.payload?.objective ?? ''}`;
    case 'clear':
      return 'Goal cleared.';
    case 'set_budget':
      return input.payload?.tokenBudget
        ? `Goal token budget set to ${input.payload.tokenBudget}.`
        : 'Goal token budget removed.';
    default:
      return 'Target command processed.';
  }
}

export function formatTerminalSessionRestored(event: RuntimeSessionRestoredEvent): string {
  const width = terminalContentWidth(120);
  const view = createSessionRestoredView(event);
  const fitLine = (prefix: string, value: string): string => {
    const prefixWidth = visibleLength(prefix);
    if (prefixWidth >= width) {
      return truncateTerminalText(prefix, width);
    }
    return `${prefix}${truncateTerminalText(value, width - prefixWidth)}`;
  };

  const lines = [
    truncateTerminalText(view.headline, width),
    fitLine(`  Model: ${view.model} · Project: `, view.projectPath),
  ];

  if (view.summary) {
    lines.push(fitLine('  Summary: ', redactTraceText(view.summary)));
  }
  if (view.summaryGeneratedAt) {
    const origin = view.checkpointId ? 'compact checkpoint' : 'generated on resume';
    lines.push(`  Generated: ${new Date(view.summaryGeneratedAt).toLocaleString()} (${origin})`);
  }
  if (typeof view.summaryCoveredMessages === 'number') {
    lines.push(`  Covers: ${view.summaryCoveredMessages} source messages`);
  }
  if (typeof view.transcriptMessages === 'number') {
    lines.push(
      `✔ Restored ${view.restoredMessages} model-context messages / ${view.transcriptMessages} transcript messages`
    );
  }

  return lines.join('\n');
}

export interface TerminalWriter {
  write(text: string): void;
  writeAsync?: (text: string) => Promise<boolean>;
}

class DirectTerminalWriter implements TerminalWriter {
  write(text: string): void {
    process.stdout.write(text);
  }
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(text: string): number {
  return stringWidth(stripTrailingNewlines(text).replace(ANSI_PATTERN, ''));
}

export function terminalContentWidth(fallback = 88): number {
  const columns = process.stdout.columns;
  if (typeof columns === 'number' && columns > 0) {
    return Math.max(1, Math.min(columns, 200));
  }
  const envColumns = Number(process.env.COLUMNS);
  if (Number.isFinite(envColumns) && envColumns > 0) {
    return Math.max(1, Math.min(envColumns, 200));
  }
  return Math.max(60, Math.min(fallback, 200));
}

export function truncateTerminalText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return '.'.repeat(maxWidth);

  let output = '';
  for (const char of Array.from(text)) {
    if (stringWidth(`${output}${char}...`) > maxWidth) break;
    output += char;
  }
  return `${output}...`;
}

function bannerRow(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  const safeContent =
    visibleLength(content) > innerWidth
      ? truncateTerminalText(content.replace(ANSI_PATTERN, ''), innerWidth)
      : content;
  const padding = ' '.repeat(Math.max(0, innerWidth - visibleLength(safeContent)));
  return `${BORDER('│')}${safeContent}${padding}${BORDER('│')}`;
}

export function renderTerminalCapabilitySummary(runtime: OpenHorseUiRuntime): string {
  const snapshot = runtime.store.getSnapshot();
  return createRuntimeCapabilitySummary({
    projectInstructionsContent: snapshot.projectInstructionsContent,
    skillsContent: snapshot.skillsContent,
    memoryContent: snapshot.memoryContent,
    tools: snapshot.tools,
    webSearchConfigured: Boolean(runtime.config.webSearch),
  }).text;
}

export function formatTerminalSessionPickerItem(
  item: SessionPickerItem,
  width = terminalContentWidth(120)
): string {
  const safeWidth = Math.max(1, width);
  const prefixPlain = `${String(item.globalIndex).padStart(2, ' ')}. ${item.shortId}  `;
  const prefix = `${String(item.globalIndex).padStart(2, ' ')}. ${ACCENT(item.shortId)}  `;
  const size = formatBytes(item.historySizeBytes);
  const project = item.showProject ? `  ${item.projectPath}` : '';
  const metadataCandidates = [
    `${item.messageCount} msgs  ${size}  ${item.model}${project}`,
    `${item.messageCount} msgs  ${size}  ${item.model}`,
    `${item.messageCount} msgs  ${size}`,
    `${item.messageCount} msgs`,
    '',
  ];

  for (const metadata of metadataCandidates) {
    const suffixPlain = metadata ? `  ${metadata}` : '';
    const titleBudget = safeWidth - visibleLength(prefixPlain) - visibleLength(suffixPlain);
    if (titleBudget < 8) continue;

    const title = truncateTerminalText(item.title, titleBudget);
    const row = `${prefix}${title}${metadata ? `  ${DIM(metadata)}` : ''}`;
    if (visibleLength(row) <= safeWidth) return row;
  }

  return truncateTerminalText(
    `${String(item.globalIndex).padStart(2, ' ')}. ${item.shortId} ${item.title}`,
    safeWidth
  );
}

export function formatTerminalSessionPickerHeader(
  title: string,
  page: number,
  pageCount: number,
  width = terminalContentWidth(120)
): string {
  const safeWidth = Math.max(1, width);
  const pageLabelPlain = ` page ${page}/${pageCount}`;
  const titleBudget = safeWidth - visibleLength(pageLabelPlain);
  if (titleBudget < 4) {
    return truncateTerminalText(`${title}${pageLabelPlain}`, safeWidth);
  }
  return `${ACCENT(truncateTerminalText(title, titleBudget))}${DIM(pageLabelPlain)}`;
}

function formatSessionPickerInstruction(width: number): string {
  const text =
    width < 72
      ? 'Select number/id, n/p page, empty cancels.'
      : 'Type number/#number, session id prefix, unique title text, or /resume --last. Empty input cancels.';
  return truncateTerminalText(text, Math.max(1, width));
}

function editPreviewKindLabel(request: EditPreviewRequest): string {
  return request.kind === 'fuzzy' ? `fuzzy (${request.strategy ?? 'match'})` : 'exact';
}

export function formatTerminalEditPreviewHeader(
  request: EditPreviewRequest,
  width = terminalContentWidth(120)
): string {
  return ACCENT(
    truncateTerminalText(
      `Edit Preview: ${request.path} (${editPreviewKindLabel(request)})`,
      Math.max(1, width)
    )
  );
}

export function formatTerminalEditPreviewCandidate(
  candidate: EditPreviewRequest['candidates'][number],
  newString: string,
  width = terminalContentWidth(120)
): string {
  const safeWidth = Math.max(1, width);
  const prefix = `  line ${String(candidate.line).padStart(3, ' ')}  `;
  const fixedWidth = visibleLength(`${prefix}"" → ""`);
  const contentBudget = safeWidth - fixedWidth;
  if (contentBudget < 8) {
    return truncateTerminalText(`${prefix}"${candidate.match}" → "${newString}"`, safeWidth);
  }

  const matchBudget = Math.max(1, Math.floor(contentBudget * 0.6));
  const replacementBudget = Math.max(1, contentBudget - matchBudget);
  const row = [
    prefix,
    `"${truncateTerminalText(candidate.match, matchBudget)}"`,
    ' → ',
    `"${truncateTerminalText(newString, replacementBudget)}"`,
  ].join('');

  return visibleLength(row) <= safeWidth ? row : truncateTerminalText(row, safeWidth);
}

export class TerminalEventSink implements UiEventSink {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly printedContent = new Map<string, string>();
  private readonly pendingAssistantOutput = new Map<string, string>();
  private readonly finalizedEntryIds = new Set<string>();
  private idCounter = 0;
  private pendingPicker: SessionPickerRequest | null = null;
  private pickerOffset = 0;
  private pendingEditPreview: EditPreviewRequest | null = null;
  private lastStatusMessage = '';
  /**
   * R8: typed subagent timeline, keyed by taskId. The chat-controller's
   * transcript summary drives the visible terminal output (so we do not
   * double-print); this map is the structured source for parity tests and
   * future timeline rendering.
   */
  private readonly subtaskTimeline = new Map<string, SubtaskTimelineEntry>();

  // --- v0.2.23: bounded state configuration ---
  private static readonly MAX_FINALIZED_METADATA = 512;
  private static readonly MAX_PRINTED_CONTENT = 512;
  private static readonly MAX_SUBTASK_TIMELINE = 100;

  constructor(
    private readonly runtime: OpenHorseUiRuntime,
    private readonly writer: TerminalWriter = new DirectTerminalWriter()
  ) {}

  append(entry: TranscriptAppendEntry): string {
    const id = `terminal-${++this.idCounter}`;
    const { live, ...transcriptEntry } = entry;
    const fullEntry: TranscriptEntry = {
      id,
      ...transcriptEntry,
    };
    this.entries.set(id, fullEntry);
    const finalized = live !== true;
    const write = this.printEntry(fullEntry, finalized);
    if (finalized) {
      if (write instanceof Promise) {
        void write.then(written => {
          if (written) this.releaseEntryBody(id);
        });
      } else {
        this.releaseEntryBody(id);
      }
    }
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
    const write = this.printEntry(next, true);
    if (write instanceof Promise) {
      void write.then(written => {
        if (written) this.releaseEntryBody(id);
      });
    } else {
      this.releaseEntryBody(id);
    }
  }

  remove(id: string): void {
    this.entries.delete(id);
    this.printedContent.delete(id);
    this.pendingAssistantOutput.delete(id);
    this.finalizedEntryIds.delete(id);
  }

  replaceTranscript(entries: TranscriptEntry[]): void {
    this.entries.clear();
    this.printedContent.clear();
    this.pendingAssistantOutput.clear();
    if (entries.length === 0) return;

    this.writer.write(`\n${BORDER('─'.repeat(terminalContentWidth(80)))}\n`);
    this.writer.write(`${DIM('Restored conversation')}\n\n`);
    for (const entry of entries) {
      const formatted = formatTranscriptEntry(entry);
      if (formatted) {
        this.writer.write(`${formatted}\n\n`);
      }
    }
  }

  clearTranscript(): void {
    this.entries.clear();
    this.printedContent.clear();
    this.pendingAssistantOutput.clear();
    this.writer.write(`${DIM('View marker reset. Terminal scrollback is preserved.')}\n`);
  }

  setStatus(message: string): void {
    if (!shouldShowStatus(message)) return;
    if (message === this.lastStatusMessage) return;
    this.lastStatusMessage = message;
    this.writer.write(`${DIM(formatTerminalStatusMessage(message))}\n`);
  }

  showSessionPicker(request: SessionPickerRequest): void {
    this.pendingPicker = request;
    this.pickerOffset = 0;
    this.printSessionPickerPage();
  }

  showEditPreview(request: EditPreviewRequest): void {
    this.pendingEditPreview = request;
    const rowWidth = terminalContentWidth(120);
    this.writer.write(`\n${formatTerminalEditPreviewHeader(request, rowWidth)}\n`);
    this.writer.write(`${BORDER('─'.repeat(terminalContentWidth(80)))}\n`);
    request.candidates.slice(0, 10).forEach(c => {
      this.writer.write(`${formatTerminalEditPreviewCandidate(c, request.newString, rowWidth)}\n`);
    });
    if (request.candidates.length > 10) {
      this.writer.write(
        `${DIM(truncateTerminalText(`  ... ${request.candidates.length - 10} more candidates`, rowWidth))}\n`
      );
    }
    this.writer.write(`${DIM(truncateTerminalText('Press Enter to dismiss.', rowWidth))}\n`);
  }

  sessionRestored(event: RuntimeSessionRestoredEvent): void {
    this.append({
      role: 'status',
      title: 'resume',
      content: formatTerminalSessionRestored(event),
    });
  }

  setProcessing(_processing: boolean): void {
    // The stable terminal UI is append-only, so there is no live spinner state.
  }

  consumePendingSelection(input: string): string | AgentRuntimeInput | null {
    const picker = this.pendingPicker;
    if (picker) {
      const navigation = normalizePickerText(input);
      const direction =
        navigation === 'n' || navigation === 'next'
          ? 1
          : navigation === 'p' || navigation === 'prev' || navigation === 'previous'
            ? -1
            : 0;
      if (direction !== 0 && findSessionsByExactLabel(input, picker.sessions).length === 0) {
        this.moveSessionPickerPage(direction);
        return '';
      }

      const selection = resolveTerminalSessionPickerInput(input, picker);
      switch (selection.type) {
        case 'cancelled':
          this.pendingPicker = null;
          this.pickerOffset = 0;
          this.writer.write(`${DIM('Session picker cancelled.')}\n`);
          return '';
        case 'slash':
          this.pendingPicker = null;
          this.pickerOffset = 0;
          return selection.input;
        case 'selected':
          this.pendingPicker = null;
          this.pickerOffset = 0;
          return {
            type: 'select_session',
            sessionId: selection.sessionId,
            allProjects: picker.allProjects,
            source: 'picker',
          };
        case 'error':
          this.writer.write(`${ERROR(selection.message)}\n`);
          return '';
      }
    }

    // Dismiss pending edit preview on any input
    if (this.pendingEditPreview) {
      this.pendingEditPreview = null;
      return '';
    }

    return null;
  }

  hasPendingInteraction(): boolean {
    return Boolean(this.pendingPicker || this.pendingEditPreview);
  }

  private printSessionPickerPage(): void {
    const request = this.pendingPicker;
    if (!request) return;

    const state = createSessionPickerState(request, this.pickerOffset);
    this.pickerOffset = state.visibleStart;

    const rowWidth = terminalContentWidth(120);
    this.writer.write(
      `\n${formatTerminalSessionPickerHeader(state.title, state.page, state.pageCount, rowWidth)}\n`
    );
    this.writer.write(`${BORDER('─'.repeat(terminalContentWidth(80)))}\n`);

    if (state.visibleItems.length === 0) {
      this.writer.write(`${DIM('No saved sessions found.')}\n`);
    }

    state.visibleItems.forEach(item => {
      this.writer.write(`${formatTerminalSessionPickerItem(item, rowWidth)}\n`);
    });

    if (state.totalItems > state.visibleLimit) {
      this.writer.write(
        `${DIM(truncateTerminalText(`Showing ${state.visibleStart + 1}-${state.visibleStart + state.visibleItems.length} of ${state.totalItems}. Type n/next or p/prev to page.`, rowWidth))}\n`
      );
    }
    this.writer.write(`${DIM(formatSessionPickerInstruction(rowWidth))}\n`);
  }

  private moveSessionPickerPage(delta: -1 | 1): void {
    const request = this.pendingPicker;
    if (!request) return;
    const state = createSessionPickerState(request, this.pickerOffset);
    const nextOffset = movePickerPageOffset(state, delta);
    if (nextOffset === this.pickerOffset) {
      this.writer.write(
        `${DIM(delta > 0 ? 'Already at last session page.' : 'Already at first session page.')}\n`
      );
      return;
    }
    this.pickerOffset = nextOffset;
    this.printSessionPickerPage();
  }

  private printEntry(entry: TranscriptEntry, finalized: boolean): void | Promise<boolean> {
    if (!entry.content) return;

    if (entry.role === 'assistant') {
      return this.printAssistantDelta(entry, finalized);
    }

    const previous = this.printedContent.get(entry.id);
    if (previous === entry.content && !finalized) return;
    this.printedContent.set(entry.id, entry.content);
    // v0.2.23: bound printed content.
    this.evictIfNeeded(this.printedContent, TerminalEventSink.MAX_PRINTED_CONTENT);
    const formatted = formatTranscriptEntry(entry);
    if (formatted) {
      return this.writeWithAcknowledgement(`${formatted}\n`);
    }
  }

  private printAssistantDelta(entry: TranscriptEntry, finalized: boolean): void | Promise<boolean> {
    const previous = this.printedContent.get(entry.id) ?? '';
    const next = entry.content;
    if (next === previous && !finalized) return;

    const delta = next.startsWith(previous) ? next.slice(previous.length) : `\n${next}`;
    const pending = `${this.pendingAssistantOutput.get(entry.id) ?? ''}${delta}`;
    this.printedContent.set(entry.id, next);
    // v0.2.23: bound printed content.
    this.evictIfNeeded(this.printedContent, TerminalEventSink.MAX_PRINTED_CONTENT);

    const shouldFlush = finalized || pending.includes('\n') || visibleLength(pending) >= 80;
    if (shouldFlush) {
      this.pendingAssistantOutput.delete(entry.id);
      if (pending) {
        return this.writeWithAcknowledgement(pending);
      } else if (finalized && next && !next.endsWith('\n')) {
        return this.writeWithAcknowledgement('\n');
      }
      return;
    }

    this.pendingAssistantOutput.set(entry.id, pending);
  }

  private writeWithAcknowledgement(text: string): void | Promise<boolean> {
    if (this.writer.writeAsync) return this.writer.writeAsync(text);
    this.writer.write(text);
  }

  /**
   * R8: consume the typed subagent event into the shared timeline view-model.
   * Does not print (the chat-controller transcript summary already drives
   * visible terminal output); this is the structured source for parity.
   */
  subtaskEvent(event: RuntimeSubtaskEvent): void {
    this.subtaskTimeline.set(event.taskId, subtaskEventToTimelineEntry(event));
    // v0.2.23: bound subtask timeline.
    this.evictIfNeeded(this.subtaskTimeline, TerminalEventSink.MAX_SUBTASK_TIMELINE);
  }

  /** R8: read-only access to the typed subagent timeline (for parity tests). */
  getSubtaskTimeline(): SubtaskTimelineEntry[] {
    return Array.from(this.subtaskTimeline.values());
  }

  // --- v0.2.23: bounded state helpers ---

  /**
   * After finalize, the entry content is in native scrollback.
   * Replace the full body with a lightweight marker so memory doesn't grow
   * with scrollback length.
   */
  private releaseEntryBody(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Keep role/id/title but replace heavy content with a marker.
    this.entries.set(id, {
      ...entry,
      content: `[scrollback:${entry.role} posted ${entry.content.length} chars]`,
    });
    this.printedContent.delete(id);
    this.pendingAssistantOutput.delete(id);
    this.finalizedEntryIds.delete(id);
    this.finalizedEntryIds.add(id);
    while (this.finalizedEntryIds.size > TerminalEventSink.MAX_FINALIZED_METADATA) {
      const oldest = this.finalizedEntryIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.finalizedEntryIds.delete(oldest);
      this.entries.delete(oldest);
    }
  }

  /**
   * Evict oldest entries from a Map when it exceeds the configured limit.
   * Uses Map's insertion-order iteration — oldest entries are evicted first.
   * Mirrors evictOldest in session-storage.ts; kept private to avoid a shared
   * dependency on session-storage internals.
   */
  private evictIfNeeded<K, V>(map: Map<K, V>, limit: number): void {
    while (map.size > limit) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
      else break;
    }
  }
}

export function renderTerminalBanner(runtime: OpenHorseUiRuntime): string {
  const width = Math.max(2, terminalContentWidth(88));
  const line = '─'.repeat(Math.max(0, width - 2));
  const firstLine = ` ${ACCENT.bold('ORION CODE')} ${DIM(`v${runtime.version}`)} ${DIM('stable terminal UI')}`;
  const projectPrefix = ` ${DIM('Model')} ${ACCENT(runtime.config.model)}  ${DIM('Project')} `;
  const project = truncateTerminalText(
    runtime.cwd,
    Math.max(10, width - 2 - visibleLength(projectPrefix))
  );
  const session = runtime.getSession()?.id.slice(0, 8) ?? 'new';
  const renderer = runtime.config.ui?.renderer ?? 'terminal';
  const rendererLine = ` ${DIM('Session')} ${ACCENT(session)}  ${DIM('Renderer')} ${ACCENT(renderer)}`;
  const capabilityPrefix = ` ${DIM('Capabilities')} `;
  const capabilityText = renderTerminalCapabilitySummary(runtime);
  const capabilities = truncateTerminalText(
    capabilityText,
    Math.max(10, width - 2 - visibleLength(capabilityPrefix))
  );

  return [
    '',
    BORDER(`╭${line}╮`),
    bannerRow(firstLine, width),
    bannerRow(`${projectPrefix}${project}`, width),
    bannerRow(rendererLine, width),
    bannerRow(`${capabilityPrefix}${capabilities}`, width),
    BORDER(`╰${line}╯`),
    '',
    '',
  ].join('\n');
}

function printBanner(runtime: OpenHorseUiRuntime): void {
  process.stdout.write(renderTerminalBanner(runtime));
}

export function renderTerminalContextStatus(runtime: OpenHorseUiRuntime): string {
  const usage = runtime.store.getSnapshot().contextUsage;
  const status = contextUsageStatusText(usage);
  if (!status) return '';
  return usage && usage.percent >= usage.warningThresholdPercent ? WARNING(status) : DIM(status);
}

export function promptText(runtime: OpenHorseUiRuntime): string {
  const session = runtime.getSession()?.id.slice(0, 8) ?? 'new';
  const context = renderTerminalContextStatus(runtime);
  return `${DIM(`[${session}]`)}${context ? ` ${context}` : ''} ${ACCENT('›')} `;
}

function compactPermissionValue(value: string, maxWidth: number): string {
  const singleLine = redactTraceText(value).replace(/\s+/g, ' ').trim();
  return truncateTerminalText(singleLine, Math.max(8, maxWidth));
}

function formatTerminalPermissionScope(
  state: ReturnType<typeof createPermissionPromptState>
): string {
  const width = terminalContentWidth(120);
  const maxScopeWidth = Math.max(24, Math.min(72, Math.floor(width * 0.35)));
  return compactPermissionValue(permissionScopeDisplayValue(state.scope), maxScopeWidth);
}

export function formatTerminalPermissionPrompt(
  request: ToolPermissionRequest,
  cwd: string
): string {
  const state = createPermissionPromptState(request, cwd);
  const width = terminalContentWidth(120);
  const budget = Math.max(1, width);
  const base = `${ACCENT('?')} Allow tool ${ACCENT(state.toolName)}?`;
  const options = DIM(`[${state.options.approve} ${state.options.deny}]`);
  const scope = DIM(formatTerminalPermissionScope(state));
  const cwdLabel = DIM(
    `cwd=${compactPermissionValue(state.cwd, Math.max(12, Math.min(48, Math.floor(width * 0.22))))}`
  );
  const risk = DIM(
    `risk=${compactPermissionValue(permissionRiskDisplayValue(state.risk), Math.max(12, Math.min(48, Math.floor(width * 0.24))))}`
  );

  const parts = [base, scope, cwdLabel, risk, options];
  while (parts.length > 3 && visibleLength(`${parts.join(' ')} `) > budget) {
    const riskIndex = parts.indexOf(risk);
    if (riskIndex >= 0) {
      parts.splice(riskIndex, 1);
      continue;
    }
    const cwdIndex = parts.indexOf(cwdLabel);
    if (cwdIndex >= 0) {
      parts.splice(cwdIndex, 1);
      continue;
    }
    break;
  }

  let prompt = `${parts.join(' ')} `;
  if (visibleLength(prompt) <= budget) return prompt;

  const fixed = `${base} ${options} `;
  const scopeBudget = Math.max(8, budget - visibleLength(fixed) - 1);
  prompt = `${base} ${DIM(truncateTerminalText(formatTerminalPermissionScope(state), scopeBudget))} ${options} `;
  if (visibleLength(prompt) <= budget) return prompt;

  const optionWidth = visibleLength(options);
  if (budget <= optionWidth + 1) {
    return truncateTerminalText(
      `${stripTrailingNewlines(base)} ${stripTrailingNewlines(options)} `,
      budget
    );
  }

  const baseBudget = Math.max(1, budget - optionWidth - 2);
  return `${truncateTerminalText(stripTrailingNewlines(base), baseBudget)} ${options} `;
}

export function parseEditInput(input: string): { isEdit: boolean; initialContent: string } {
  const trimmed = input.trimStart();
  if (trimmed === '/edit') return { isEdit: true, initialContent: '' };
  if (trimmed.startsWith('/edit ')) {
    return { isEdit: true, initialContent: trimmed.slice('/edit '.length) };
  }
  return { isEdit: false, initialContent: '' };
}

export function renderTerminalShortcuts(): string {
  const width = terminalContentWidth(88);
  if (width < 44) {
    const rows = [
      `${ACCENT('Shortcuts')}`,
      `${BORDER('─'.repeat(Math.min(width, 32)))}`,
      `${DIM('Enter')} send  ${DIM('Tab')} complete`,
      `${DIM('Ctrl+J')} newline`,
      `${DIM('Ctrl+C')} interrupt; twice exits`,
      `${DIM('/paste')} ${DIM('/edit')} ${DIM('/resume')}`,
      `${DIM('/last-tool')} ${DIM('/trace')}`,
    ];
    return `\n${rows.join('\n')}\n`;
  }

  if (width < 72) {
    const rows = [
      `${ACCENT('Shortcuts')}`,
      `${BORDER('─'.repeat(Math.min(width, 40)))}`,
      `${DIM('Enter')} send  ${DIM('Tab')} complete  ${DIM('↑/↓')} history`,
      `${DIM('Alt+Enter/Ctrl+J')} newline`,
      `${DIM('Ctrl+U/W')} edit  ${DIM('Ctrl+C')} interrupt; twice exits`,
      `${DIM('/paste')} multiline  ${DIM('/edit')} editor  ${DIM('/resume')} sessions`,
      `${DIM('/last-tool')} tool detail  ${DIM('/trace')} timeline`,
    ];
    return `\n${rows.join('\n')}\n`;
  }

  const rows = [
    `${ACCENT('Terminal shortcuts')}`,
    `${BORDER('─'.repeat(48))}`,
    `${DIM('Enter')}      send current input`,
    `${DIM('Alt+Enter')}  insert newline (${DIM('Ctrl+J')} also works)`,
    `${DIM('Tab')}        complete slash command or @file mention`,
    `${DIM('↑/↓')}        navigate local input history`,
    `${DIM('Ctrl+U')}     clear current input`,
    `${DIM('Ctrl+W')}     delete previous word`,
    `${DIM('Ctrl+C')}     interrupt current turn; press twice to exit`,
    `${DIM('/paste')}     collect multiline input until /end`,
    `${DIM('/edit')}      open $VISUAL or $EDITOR for long input`,
    `${DIM('/resume')}    pick a session; use n/p to page results`,
    `${DIM('/last-tool')} inspect the latest tool call/result`,
    `${DIM('/trace')}     show the ordered event timeline`,
  ];
  return `\n${rows.join('\n')}\n`;
}

export interface TerminalComposeResult {
  input?: string;
  notice?: string;
  cancelled?: boolean;
}

export class TerminalInputComposer {
  private mode: 'paste' | 'continuation' | null = null;
  private readonly lines: string[] = [];

  isActive(): boolean {
    return this.mode !== null;
  }

  prompt(basePrompt: string): string {
    if (!this.mode) return basePrompt;
    const lineCount = Math.max(1, this.lines.length + 1);
    const label = this.mode === 'paste' ? `paste ${lineCount}L` : `multi ${lineCount}L`;
    return `${DIM(`[${label}]`)} ${ACCENT('…')} `;
  }

  receive(input: string): TerminalComposeResult {
    const trimmed = input.trim();

    if (!this.mode && ['/paste', '/multi', '/multiline'].includes(trimmed)) {
      this.mode = 'paste';
      this.lines.length = 0;
      return {
        notice: DIM('Multiline input: paste or type lines, finish with /end, cancel with /cancel.'),
      };
    }

    if (this.mode === 'paste') {
      if (trimmed === '/cancel') {
        this.reset();
        return { cancelled: true, notice: DIM('Multiline input cancelled.') };
      }
      if (trimmed === '/end') {
        const submitted = this.lines.join('\n').trimEnd();
        this.reset();
        return submitted
          ? { input: submitted }
          : { cancelled: true, notice: DIM('Multiline input was empty.') };
      }
      this.lines.push(input);
      return {};
    }

    if (this.mode === 'continuation') {
      const continued = input.endsWith('\\');
      this.lines.push(continued ? input.slice(0, -1) : input);
      if (continued) return {};

      const submitted = this.lines.join('\n').trimEnd();
      this.reset();
      return submitted ? { input: submitted } : {};
    }

    if (input.endsWith('\\')) {
      this.mode = 'continuation';
      this.lines.length = 0;
      this.lines.push(input.slice(0, -1));
      return {};
    }

    return { input };
  }

  private reset(): void {
    this.mode = null;
    this.lines.length = 0;
  }
}

export function normalizeTerminalAnswer(input: string): string {
  let output = '';
  let index = 0;

  const popChar = (): void => {
    const chars = Array.from(output);
    chars.pop();
    output = chars.join('');
  };

  while (index < input.length) {
    const escapeMatch = input.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/u);
    if (escapeMatch) {
      index += escapeMatch[0].length;
      continue;
    }

    const char = input[index];
    if (char === '\x7f' || char === '\b') {
      popChar();
      index++;
      continue;
    }
    if (char === '\x15') {
      output = '';
      index++;
      continue;
    }
    if (char === '\x17') {
      output = output.replace(/\s*\S+\s*$/u, '');
      index++;
      continue;
    }
    if (char >= ' ' || char === '\t') {
      output += char;
    }
    index++;
  }

  return output;
}

export async function launchTerminalUI(runtime: OpenHorseUiRuntime): Promise<void> {
  printBanner(runtime);

  let agentController!: AgentRuntimeController;
  let writer!: TerminalWriter;
  const editor = new RawTerminalEditor({
    cwd: runtime.cwd,
    onSubmit: input => handleInput(input),
    onCtrlC: () => handleSigint(),
    onNotice: message => { void writer.write(`${DIM(message)}\n`); },
  });
  const outputAdapter: TerminalOutputWriter = {
    write: text => editor.writeExternalBatch([text]),
    on: (event, listener) => { process.stdout.on(event, listener); },
    off: (event, listener) => { process.stdout.off(event, listener); },
  };
  const outputQueue = new TerminalOutputQueue(outputAdapter);
  let outputBatchSequence = 0;
  writer = {
    write: text => {
      void outputQueue.enqueue({
        id: `terminal-output-${++outputBatchSequence}`,
        chunks: [text],
        releaseEntryIds: [],
      }).catch(() => undefined);
    },
    writeAsync: text => outputQueue.enqueue({
      id: `terminal-output-${++outputBatchSequence}`,
      chunks: [text],
      releaseEntryIds: [],
    }).then(() => true, () => false),
  };
  const events = new TerminalEventSink(runtime, writer);

  let stopping = false;
  let settled = false;
  let resolveLaunch: (() => void) | null = null;
  const composer = new TerminalInputComposer();
  let confirmingTool = false;
  const eventSink: AgentRuntimeEventSink = {
    emit: event => {
      if (event.type !== 'permission_requested') {
        return emitToUiEventSink(events, event);
      }

      if (event.request.abortSignal?.aborted || stopping) {
        agentController.handle({
          type: 'permission_decision',
          requestId: event.request.id,
          approved: false,
          source: 'programmatic',
        });
        return undefined;
      }

      confirmingTool = true;

      void editor
        .ask(formatTerminalPermissionPrompt(event.request, runtime.cwd), event.request.abortSignal)
        .then(answer => {
          agentController.handle({
            type: 'permission_decision',
            requestId: event.request.id,
            approved: /^y(es)?$/i.test(answer.trim()),
            source: 'keyboard',
          });
        })
        .catch(() => {
          agentController.handle({
            type: 'permission_decision',
            requestId: event.request.id,
            approved: false,
            source: 'programmatic',
          });
        })
        .finally(() => {
          confirmingTool = false;
          prompt();
        });
      return undefined;
    },
  };

  // v0.2.24: initialize goal coordinator for /target mode.
  const goalCoordinator = new GoalCoordinator(runtime.cwd, runtime.getSession()?.id ?? 'new');
  goalCoordinator.load();

  agentController = new AgentRuntimeController({
    runtime,
    eventSink,
    uiCapabilities: resolveUiRendererCapabilities(undefined, 'terminal'),
    uiRenderer: 'terminal',
    useRuntimeToolPermissions: true,
    echoSubmittedInput: false,
    beforeTurn: () => writer.write('\n'),
    afterTurnLoop: () => {
      writer.write('\n');
      prompt();
    },
    onTurnError: error => {
      const message = error instanceof Error ? error.message : String(error);
      events.append({ role: 'error', content: message });
    },
  });
  agentController.setGoalCoordinator(goalCoordinator);
  const prompt = (): void => {
    if (stopping) return;
    editor.setPrompt(composer.prompt(promptText(runtime)));
  };

  const finishLaunch = (): void => {
    if (settled) return;
    settled = true;
    resolveLaunch?.();
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await agentController.stopActiveTurn();
    try {
      await outputQueue.close();
    } catch {
      // Terminal output failure must not block shutdown.
    } finally {
      editor.stop();
      await runtime.shutdown();
    }
    process.stdout.write('\n');
    finishLaunch();
  };

  const handleInput = (rawInput: string): void => {
    if (stopping) return;

    const answer = applyTerminalTabCompletion(normalizeTerminalAnswer(rawInput), runtime.cwd);
    const submitted = answer.trim();

    if (agentController.hasActiveTurn()) {
      if (confirmingTool) {
        return;
      }

      if (!submitted) {
        prompt();
        return;
      }

      // v0.2.26: allow /target pause/status/resume even during active turn.
      if (isTargetCommand(answer)) {
        const parsed = parseTargetCommand(answer);
        if (parsed.ok && (parsed.input.action === 'pause' || parsed.input.action === 'show' || parsed.input.action === 'resume' || parsed.input.action === 'set_budget' || parsed.input.action === 'clear')) {
          // For pause/resume, interrupt the current turn first.
          if (parsed.input.action === 'pause' || parsed.input.action === 'resume') {
            agentController.handle({ type: 'interrupt', source: 'keyboard' } as AgentRuntimeInput);
          }
          events.append({
            role: 'system',
            content: formatTargetCommandResult(parsed.input, goalCoordinator),
          });
          agentController.handle(parsed.input as unknown as AgentRuntimeInput);
          prompt();
          return;
        }
      }

      const result = agentController.handle({ type: 'submit', text: answer, source: 'composer' });
      if (result.type === 'exit_requested') {
        void stop();
        return;
      }
      prompt();
      return;
    }

    agentController.handle({ type: 'clear_exit_intent' });

    if (!composer.isActive() && !events.hasPendingInteraction() && submitted === '?') {
      writer.write(renderTerminalShortcuts());
      prompt();
      return;
    }

    let input = !composer.isActive() ? events.consumePendingSelection(answer) : null;
    if (input === '') {
      prompt();
      return;
    }
    if (input && typeof input !== 'string') {
      const result = agentController.handle(input);
      if (result.type === 'exit_requested') {
        void stop();
        return;
      }
      return;
    }
    input ??= answer;

    if (!composer.isActive()) {
      // v0.2.24: intercept /target and /goal commands.
      if (isTargetCommand(input)) {
        const parsed = parseTargetCommand(input);
        if (parsed.ok) {
          events.append({
            role: 'system',
            content: formatTargetCommandResult(parsed.input, goalCoordinator),
          });
          // Route to controller for goal lifecycle.
          if (parsed.input.action !== 'show') {
            agentController.handle(parsed.input as unknown as AgentRuntimeInput);
          }
          // v0.2.26: auto-start the first turn when a goal is created or resumed.
          if (
            (parsed.input.action === 'create' || parsed.input.action === 'resume') &&
            goalCoordinator?.isActive
          ) {
            const req = goalCoordinator.buildContinuationRequest();
            if (req) {
              agentController.handle({
                type: 'submit',
                text: req.goal?.continuationIndex
                  ? `[goal continuation #${req.goal.continuationIndex}]`
                  : 'Continue pursuing the goal.',
                source: 'programmatic',
              } as AgentRuntimeInput);
            }
          }
        } else {
          events.append({ role: 'error', content: parsed.error });
        }
        prompt();
        return;
      }

      const edit = parseEditInput(input);
      if (edit.isEdit) {
        editor.stop();
        const result = openExternalEditor({ initialContent: edit.initialContent });
        if (!stopping) editor.start();
        if (result.error) {
          events.append({
            role: 'error',
            content: `Editor failed: ${result.error}`,
            errorLayer: 'renderer',
          });
          prompt();
          return;
        }
        if (result.cancelled || !result.content) {
          events.setStatus('Editor input cancelled.');
          prompt();
          return;
        }
        input = result.content;
      }
    }

    const composed = composer.receive(input);
    if (composed.notice) writer.write(`${composed.notice}\n`);
    if (composed.cancelled) {
      prompt();
      return;
    }
    if (composed.input === undefined) {
      prompt();
      return;
    }
    input = composed.input;

    if (!input.trim()) {
      prompt();
      return;
    }

    const result = agentController.handle({ type: 'submit', text: input, source: 'composer' });
    if (result.type === 'exit_requested') {
      void stop();
      return;
    }
    prompt();
  };

  const handleSigint = (): void => {
    const result = agentController.handle({ type: 'interrupt', source: 'keyboard' });
    if (result.type === 'exit_requested') {
      void stop();
      return;
    }
    prompt();
  };

  try {
    process.stdout.write(
      `${DIM('Ready. Terminal editor supports CJK, Alt/Option+Enter or Ctrl+J newlines, multiline paste, and live revision. /edit is available for oversized drafts.')}\n`
    );
    editor.start();
    prompt();
    await new Promise<void>(resolve => {
      resolveLaunch = resolve;
    });
  } finally {
    if (!stopping) {
      stopping = true;
      try {
        await outputQueue.close();
      } catch {
        // Terminal output failure must not block shutdown.
      } finally {
        editor.stop();
        await runtime.shutdown();
      }
      process.stdout.write('\n');
    }
  }
}
