import {
  resolveUiRendererCapabilities,
  type EditPreviewRequest,
  type ErrorLayer,
  type ResolvedUiRendererCapabilities,
  type RuntimeLoopStats,
  type RuntimeSessionRestoredEvent,
  type SessionPickerRequest,
  type StructuredToolActivity,
  type ToolPermissionRequest,
  type TranscriptEntry,
  type TranscriptRole,
  type UiRendererCapabilities,
} from './ui-events';
import type { CommandCategory, SlashCommand } from '../commands/types';
import { formatBytes } from '../services/format';
import { classifyCommandSafety } from '../services/verification-profile';
import type { ContextUsageSnapshot } from '../services/model-context';

export type TranscriptBlockKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'error'
  | 'system'
  | 'status'
  | 'command'
  | 'resume';

export interface TranscriptBlock {
  id: string;
  kind: TranscriptBlockKind;
  role: TranscriptRole;
  content: string;
  title?: string;
  /** Error layer when kind is 'error'. Set by runtime, not inferred by renderer. */
  errorLayer?: ErrorLayer;
  /** Structured tool activity — set by tool event presenter. */
  toolActivity?: StructuredToolActivity;
  /** True when this entry was restored from a previous session. */
  restored?: boolean;
}

export type ToolActivityState =
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'skipped'
  | 'requested';

export interface ToolActivity {
  callId?: string;
  name: string;
  state: ToolActivityState;
  detail?: string;
  command?: string;
  summary?: string;
  durationMs?: number;
  error?: string;
  outputBytes?: number;
  artifactRef?: { id: string; outputBytes: number };
  /** Monotonic tool invocation sequence (1-based). Stable across transcript/trace/last-tool. */
  seq?: number;
  batchCount?: number;
  batchIndex?: number;
}

// ============================================================================
// R8: Subagent timeline view-model (shared across terminal/Ink/TUI)
// ============================================================================

/**
 * Stable timeline entry for a subagent lifecycle, derived from the
 * renderer-independent {@link RuntimeSubtaskEvent}. terminal/Ink/TUI all
 * consume this single shape instead of each implementing its own state
 * machine. The chat-controller's transcript summary remains as a degraded
 * output, but the typed timeline is the authoritative view.
 */
export interface SubtaskTimelineEntry {
  batchId: string;
  taskId: string;
  role: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'rejected';
  objective: string;
  summary?: string;
  durationMs?: number;
  /** True once a terminal state (completed/failed/cancelled/timed_out/rejected) is reached. */
  terminal: boolean;
}

/**
 * Map a {@link RuntimeSubtaskEvent} to a timeline entry. Pure: renderers call
 * this from their `subtaskEvent` consumer and store the result keyed by
 * `taskId`, so each task has exactly one entry whose state advances.
 */
export function subtaskEventToTimelineEntry(event: {
  batchId: string;
  taskId: string;
  role: string;
  state: SubtaskTimelineEntry['state'];
  objective: string;
  summary?: string;
  durationMs?: number;
}): SubtaskTimelineEntry {
  const terminalStates: SubtaskTimelineEntry['state'][] = [
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'rejected',
  ];
  return {
    batchId: event.batchId,
    taskId: event.taskId,
    role: event.role,
    state: event.state,
    objective: event.objective,
    summary: event.summary,
    durationMs: event.durationMs,
    terminal: terminalStates.includes(event.state),
  };
}

/** A short human-readable label for a timeline entry, used by renderers. */
export function subtaskTimelineLabel(entry: SubtaskTimelineEntry): string {
  const arrow = entry.terminal ? '◂' : '▸';
  const tail = entry.summary ? ` - ${entry.summary.slice(0, 120)}` : '';
  const dur = entry.durationMs ? ` (${entry.durationMs}ms)` : '';
  return `${arrow} subtask ${entry.role} ${entry.state}${tail}${dur}`;
}

export type UiRendererStatus = 'stable' | 'beta' | 'deprecated' | 'non-interactive' | 'custom';

export interface StatusSnapshot {
  model?: string;
  sessionId?: string;
  tokens?: {
    input?: number;
    output?: number;
    contextPercent?: number;
  };
  costUsd?: number;
  context?: ContextUsageSnapshot;
  runningState?: string;
  permissionMode?: string;
  loop?: Pick<
    RuntimeLoopStats,
    'llmRequests' | 'toolCalls' | 'finishReason' | 'budgetExceededReason' | 'localFastPathUsed'
  >;
  renderer: {
    name: string;
    status: UiRendererStatus;
    capabilities: ResolvedUiRendererCapabilities;
    capabilityLabels: string[];
  };
}

export function contextUsageStatusText(usage: ContextUsageSnapshot | null | undefined): string {
  if (!usage) return '';
  const label = `ctx=${usage.percent}%`;
  if (usage.autoCompactEnabled && usage.percent >= usage.autoCompactThresholdPercent) {
    return `${label} auto-compact`;
  }
  if (usage.percent >= usage.warningThresholdPercent) {
    return `${label} /compact`;
  }
  return label;
}

export interface RuntimeCapabilityTool {
  name: string;
}

export interface RuntimeCapabilityInput {
  projectInstructionsContent?: string;
  skillsContent?: string;
  memoryContent?: string;
  tools?: RuntimeCapabilityTool[];
  webSearchConfigured?: boolean;
}

export interface RuntimeCapabilitySummary {
  labels: string[];
  text: string;
  hasProjectRules: boolean;
  hasSkills: boolean;
  hasMemory: boolean;
  hasMcp: boolean;
  hasWebSearch: boolean;
}

export interface SessionRestoredView {
  sessionId: string;
  shortId: string;
  projectPath: string;
  model: string;
  restoredMessages: number;
  messageCount?: number;
  summary?: string;
  summaryGeneratedAt?: number;
  summarySource?: RuntimeSessionRestoredEvent['summarySource'];
  summaryCoveredMessages?: number;
  checkpointId?: string;
  transcriptMessages?: number;
  headline: string;
}

export type PickerKind = 'command' | 'session' | 'model' | 'file' | 'permission' | 'edit-preview';

export interface PickerState<TItem> {
  kind: PickerKind;
  title: string;
  totalItems: number;
  visibleStart: number;
  visibleLimit: number;
  page: number;
  pageCount: number;
  visibleItems: TItem[];
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface SessionPickerItem {
  session: SessionPickerRequest['sessions'][number];
  globalIndex: number;
  sessionId: string;
  shortId: string;
  title: string;
  messageCount: number;
  historySizeBytes: number;
  model: string;
  projectPath: string;
  showProject: boolean;
}

export interface CommandPickerItem {
  command: Pick<
    SlashCommand,
    'name' | 'aliases' | 'description' | 'argumentHint' | 'category' | 'priority'
  >;
  name: string;
  value: string;
  label: string;
  description: string;
  categoryLabel: string;
  aliases: string[];
  matchRank: number;
}

export interface FilePickerQuery {
  base: string;
  query: string;
}

export interface FilePickerCandidate {
  path: string;
  isDirectory: boolean;
}

export interface FilePickerItem {
  file: FilePickerCandidate;
  path: string;
  value: string;
  label: string;
  description: string;
  isDirectory: boolean;
}

export type PermissionDecisionValue = 'allow' | 'deny';

export interface PermissionDecisionItem {
  value: PermissionDecisionValue;
  label: string;
  description: string;
  approved: boolean;
}

export interface EditPreviewPickerItem {
  candidate: EditPreviewRequest['candidates'][number];
  value: string;
  label: string;
  description: string;
  line: number;
  matchPreview: string;
  replacementPreview: string;
}

export interface ModelPickerCandidate {
  name: string;
  alias?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  source?: string;
}

export interface ModelPickerItem {
  model: ModelPickerCandidate;
  name: string;
  value: string;
  alias?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  source?: string;
  isCurrent: boolean;
  label: string;
  description: string;
}

export type PromptCompletionState =
  | { kind: 'none' }
  | { kind: 'command'; query: string }
  | { kind: 'file'; base: string; query: string };

export interface PromptHistoryState {
  index: number;
  size: number;
  active: boolean;
  canMovePrevious: boolean;
  canMoveNext: boolean;
}

export interface PromptState {
  value: string;
  cursor: number;
  modeText?: string;
  running: boolean;
  isEmpty: boolean;
  lineCount: number;
  currentLineIndex: number;
  currentLine: string;
  cursorInCurrentLine: number;
  textBeforeCursor: string;
  textAfterCursor: string;
  completion: PromptCompletionState;
  history: PromptHistoryState;
}

export type PermissionScopeKind = 'command' | 'path' | 'paths' | 'args' | 'unknown';

export interface PermissionScopeState {
  kind: PermissionScopeKind;
  value?: string;
  count?: number;
}

export type PermissionRiskLevel = 'high' | 'medium' | 'low' | 'unknown';

export interface PermissionRiskState {
  level: PermissionRiskLevel;
  reason: string;
}

export interface PermissionPromptState {
  requestId: string;
  toolName: string;
  scope: PermissionScopeState;
  cwd: string;
  risk: PermissionRiskState;
  options: {
    approve: string;
    deny: string;
  };
}

const COMMAND_CATEGORY_LABELS: Record<CommandCategory, string> = {
  workflow: 'Workflow',
  session: 'Session',
  context: 'Context',
  tools: 'Tools',
  model: 'Model',
  system: 'System',
  diagnostics: 'Diagnostics',
  legacy: 'Legacy',
};

export function rendererStatus(renderer: unknown): UiRendererStatus {
  if (renderer === 'terminal') return 'stable';
  if (renderer === 'tui') return 'beta';
  if (renderer === 'ink') return 'deprecated';
  if (renderer === 'print') return 'non-interactive';
  return 'custom';
}

export function rendererCapabilityLabels(capabilities: ResolvedUiRendererCapabilities): string[] {
  return [
    capabilities.structuredPickers ? 'pickers' : 'text-pickers',
    capabilities.inlineProgress ? 'inline-progress' : 'legacy-progress',
    capabilities.suppressLegacyTokenMeta ? 'clean-meta' : 'legacy-meta',
    capabilities.extraAssistantSpacing ? 'assistant-spacing' : 'compact-spacing',
    capabilities.suppressAbortNotice ? 'quiet-abort' : 'abort-notice',
  ];
}

export function createRuntimeCapabilitySummary(
  input: RuntimeCapabilityInput = {}
): RuntimeCapabilitySummary {
  const hasProjectRules = Boolean(input.projectInstructionsContent?.trim());
  const hasSkills = Boolean(input.skillsContent?.trim());
  const hasMemory = Boolean(input.memoryContent?.trim());
  const hasMcp = Boolean(input.tools?.some(tool => tool.name.startsWith('mcp__')));
  const hasWebSearch = Boolean(input.webSearchConfigured);
  const labels = ['scrollback', 'CJK input', 'paste/edit', 'trace'];

  if (hasProjectRules) labels.push('repo rules');
  if (hasSkills) labels.push('skills');
  if (hasMemory) labels.push('memory');
  if (hasMcp) labels.push('MCP');
  if (hasWebSearch) labels.push('web search');

  return {
    labels,
    text: labels.join(', '),
    hasProjectRules,
    hasSkills,
    hasMemory,
    hasMcp,
    hasWebSearch,
  };
}

function normalizeSingleLineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function createSessionRestoredView(event: RuntimeSessionRestoredEvent): SessionRestoredView {
  const shortId = event.sessionId.slice(0, 8);
  const summary = event.summary ? normalizeSingleLineText(event.summary) : undefined;
  const hasDetailedCounts = typeof event.transcriptMessages === 'number';
  const total = typeof event.messageCount === 'number' ? `/${event.messageCount}` : '';
  const view: SessionRestoredView = {
    sessionId: event.sessionId,
    shortId,
    projectPath: event.projectPath,
    model: event.model,
    restoredMessages: event.restoredMessages,
    messageCount: event.messageCount,
    summary: summary || undefined,
    headline: hasDetailedCounts
      ? `Resumed session ${shortId} · restored ${event.restoredMessages} model-context / ${event.transcriptMessages} transcript messages`
      : `Resumed session ${shortId} · restored ${event.restoredMessages}${total} messages`,
  };
  if (event.summaryGeneratedAt !== undefined) view.summaryGeneratedAt = event.summaryGeneratedAt;
  if (event.summarySource !== undefined) view.summarySource = event.summarySource;
  if (event.summaryCoveredMessages !== undefined) {
    view.summaryCoveredMessages = event.summaryCoveredMessages;
  }
  if (event.checkpointId !== undefined) view.checkpointId = event.checkpointId;
  if (event.transcriptMessages !== undefined) view.transcriptMessages = event.transcriptMessages;
  return view;
}

export function sessionPickerTitle(session: SessionPickerRequest['sessions'][number]): string {
  return session.name || session.taskSummary || '(untitled)';
}

export function clampPromptCursor(value: string, cursor: number | undefined): number {
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return value.length;
  return Math.min(Math.max(0, Math.floor(cursor)), value.length);
}

function promptCompletionState(value: string): PromptCompletionState {
  const commandMatch = value.match(/^\/([^\s]*)$/u);
  if (commandMatch) {
    return { kind: 'command', query: commandMatch[1] ?? '' };
  }

  const fileQuery = getFileMentionQuery(value);
  if (fileQuery) {
    return { kind: 'file', base: fileQuery.base, query: fileQuery.query };
  }

  return { kind: 'none' };
}

function promptHistoryState(
  index: number | undefined,
  size: number | undefined
): PromptHistoryState {
  const safeSize =
    typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  const safeIndex = typeof index === 'number' && Number.isFinite(index) ? Math.floor(index) : -1;
  const active = safeIndex >= 0 && safeIndex < safeSize;

  return {
    index: active ? safeIndex : -1,
    size: safeSize,
    active,
    canMovePrevious: safeSize > 0 && (!active || safeIndex < safeSize - 1),
    canMoveNext: active,
  };
}

export function createPromptState(input: {
  value: string;
  cursor?: number;
  modeText?: string;
  running?: boolean;
  historyIndex?: number;
  historySize?: number;
}): PromptState {
  const cursor = clampPromptCursor(input.value, input.cursor);
  const before = input.value.slice(0, cursor);
  const after = input.value.slice(cursor);
  const currentLineIndex = before.split('\n').length - 1;
  const lineStart = before.lastIndexOf('\n') + 1;
  const nextLineBreak = input.value.indexOf('\n', cursor);
  const lineEnd = nextLineBreak === -1 ? input.value.length : nextLineBreak;
  const currentLine = input.value.slice(lineStart, lineEnd);

  return {
    value: input.value,
    cursor,
    modeText: input.modeText,
    running: Boolean(input.running),
    isEmpty: input.value.length === 0,
    lineCount: input.value.split('\n').length,
    currentLineIndex,
    currentLine,
    cursorInCurrentLine: cursor - lineStart,
    textBeforeCursor: before,
    textAfterCursor: after,
    completion: promptCompletionState(input.value),
    history: promptHistoryState(input.historyIndex, input.historySize),
  };
}

function commandCategoryLabel(category: CommandCategory | undefined): string {
  return COMMAND_CATEGORY_LABELS[category ?? 'system'];
}

function commandPickerQuery(input: string): string {
  return input.startsWith('/') ? input.slice(1).toLowerCase() : '';
}

function commandMatchRank(command: Pick<SlashCommand, 'name' | 'aliases'>, query: string): number {
  if (!query) return 0;
  const name = command.name.toLowerCase();
  const aliases = command.aliases?.map(alias => alias.toLowerCase()) ?? [];
  if (name === query) return 0;
  if (aliases.some(alias => alias === query)) return 1;
  if (name.startsWith(query)) return 2;
  if (aliases.some(alias => alias.startsWith(query))) return 3;
  return 4;
}

function commandMatchesQuery(
  command: Pick<SlashCommand, 'name' | 'aliases'>,
  query: string
): boolean {
  if (!query) return true;
  const name = command.name.toLowerCase();
  const aliases = command.aliases?.map(alias => alias.toLowerCase()) ?? [];
  return name.startsWith(query) || aliases.some(alias => alias.startsWith(query));
}

function commandPickerLabel(
  command: Pick<SlashCommand, 'name' | 'aliases' | 'argumentHint'>
): string {
  const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
  const aliases = command.aliases?.length ? ` (${command.aliases.join(', ')})` : '';
  return `/${command.name}${hint}${aliases}`;
}

export function createCommandPickerState(input: {
  title?: string;
  input: string;
  commands: Array<
    Pick<
      SlashCommand,
      'name' | 'aliases' | 'description' | 'argumentHint' | 'category' | 'priority'
    >
  >;
  visibleStart?: number;
  maxVisibleItems?: number;
  categoryLabel?: (category: CommandCategory | undefined) => string;
}): PickerState<CommandPickerItem> {
  const query = commandPickerQuery(input.input);
  const getCategoryLabel = input.categoryLabel ?? commandCategoryLabel;
  const ranked = input.commands
    .map((command, index) => ({
      command,
      index,
      matchRank: commandMatchRank(command, query),
    }))
    .filter(item => commandMatchesQuery(item.command, query))
    .sort((left, right) => {
      const rankDelta = left.matchRank - right.matchRank;
      return rankDelta !== 0 ? rankDelta : left.index - right.index;
    });
  const totalItems = ranked.length;
  const visibleLimit = normalizeVisibleLimit(totalItems, input.maxVisibleItems ?? totalItems);
  const maxOffset = maxPickerOffset(totalItems, visibleLimit);
  const visibleStart = Math.max(0, Math.min(input.visibleStart ?? 0, maxOffset));
  const visibleItems = ranked.slice(visibleStart, visibleStart + visibleLimit).map(item => {
    const category = getCategoryLabel(item.command.category);
    const aliases = item.command.aliases ?? [];
    return {
      command: item.command,
      name: item.command.name,
      value: item.command.name,
      label: commandPickerLabel(item.command),
      description: `${category}  ${item.command.description}`,
      categoryLabel: category,
      aliases,
      matchRank: item.matchRank,
    };
  });

  return {
    kind: 'command',
    title: input.title ?? (query ? `Commands "${query}"` : 'Commands'),
    totalItems,
    visibleStart,
    visibleLimit,
    page: totalItems === 0 ? 1 : Math.floor(visibleStart / visibleLimit) + 1,
    pageCount: totalItems === 0 ? 1 : Math.ceil(totalItems / visibleLimit),
    visibleItems,
    hasPreviousPage: visibleStart > 0,
    hasNextPage: visibleStart < maxOffset,
  };
}

export function getFileMentionQuery(input: string): FilePickerQuery | null {
  const match = input.match(/(^|\s)@([^\s]*)$/u);
  if (!match || match.index === undefined) return null;
  const atIndex = match.index + match[1].length;
  return {
    base: input.slice(0, atIndex),
    query: match[2] ?? '',
  };
}

function filePickerValue(file: FilePickerCandidate): string {
  return file.isDirectory ? `${file.path}/` : file.path;
}

function filePickerLabel(file: FilePickerCandidate): string {
  return `${file.isDirectory ? 'dir' : 'file'} ${filePickerValue(file)}`;
}

export function createFilePickerState(input: {
  title?: string;
  input: string;
  files: FilePickerCandidate[];
  visibleStart?: number;
  maxVisibleItems?: number;
}): PickerState<FilePickerItem> | null {
  const query = getFileMentionQuery(input.input);
  if (!query) return null;

  const totalItems = input.files.length;
  const visibleLimit = normalizeVisibleLimit(totalItems, input.maxVisibleItems ?? totalItems);
  const maxOffset = maxPickerOffset(totalItems, visibleLimit);
  const visibleStart = Math.max(0, Math.min(input.visibleStart ?? 0, maxOffset));

  return {
    kind: 'file',
    title: input.title ?? (query.query ? `Files "${query.query}"` : 'Files'),
    totalItems,
    visibleStart,
    visibleLimit,
    page: totalItems === 0 ? 1 : Math.floor(visibleStart / visibleLimit) + 1,
    pageCount: totalItems === 0 ? 1 : Math.ceil(totalItems / visibleLimit),
    visibleItems: input.files.slice(visibleStart, visibleStart + visibleLimit).map(file => ({
      file,
      path: file.path,
      value: filePickerValue(file),
      label: filePickerLabel(file),
      description: file.isDirectory ? 'directory' : 'file',
      isDirectory: file.isDirectory,
    })),
    hasPreviousPage: visibleStart > 0,
    hasNextPage: visibleStart < maxOffset,
  };
}

function previewText(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function createPermissionDecisionPickerState(
  request: ToolPermissionRequest
): PickerState<PermissionDecisionItem> {
  const scope = permissionScopeDisplayValue(permissionScopeFromArgs(request.args));
  const reason = request.reason?.trim();
  const allowDescription = [scope === 'scope=unknown' ? '' : scope, reason]
    .filter(Boolean)
    .join('  ');
  const items: PermissionDecisionItem[] = [
    {
      value: 'allow',
      label: `Allow ${request.name}`,
      description: allowDescription,
      approved: true,
    },
    {
      value: 'deny',
      label: `Deny ${request.name}`,
      description: 'Do not run this tool call',
      approved: false,
    },
  ];

  return {
    kind: 'permission',
    title: 'Tool Permission',
    totalItems: items.length,
    visibleStart: 0,
    visibleLimit: items.length,
    page: 1,
    pageCount: 1,
    visibleItems: items,
    hasPreviousPage: false,
    hasNextPage: false,
  };
}

export function createEditPreviewPickerState(input: {
  request: EditPreviewRequest;
  visibleStart?: number;
  maxVisibleItems?: number;
  maxMatchLength?: number;
  maxReplacementLength?: number;
}): PickerState<EditPreviewPickerItem> {
  const { request } = input;
  const totalItems = request.candidates.length;
  const visibleLimit = normalizeVisibleLimit(totalItems, input.maxVisibleItems ?? totalItems);
  const maxOffset = maxPickerOffset(totalItems, visibleLimit);
  const visibleStart = Math.max(0, Math.min(input.visibleStart ?? 0, maxOffset));
  const matchLimit = input.maxMatchLength ?? 50;
  const replacementLimit = input.maxReplacementLength ?? 40;
  const kindLabel = request.kind === 'fuzzy' ? `fuzzy (${request.strategy ?? 'match'})` : 'exact';

  return {
    kind: 'edit-preview',
    title: `Edit Preview: ${request.path} (${kindLabel}, ${totalItems} candidate${totalItems === 1 ? '' : 's'})`,
    totalItems,
    visibleStart,
    visibleLimit,
    page: totalItems === 0 ? 1 : Math.floor(visibleStart / visibleLimit) + 1,
    pageCount: totalItems === 0 ? 1 : Math.ceil(totalItems / visibleLimit),
    visibleItems: request.candidates
      .slice(visibleStart, visibleStart + visibleLimit)
      .map(candidate => {
        const matchPreview = previewText(candidate.match, matchLimit);
        const replacementPreview = previewText(request.newString, replacementLimit);
        return {
          candidate,
          value: String(candidate.line),
          label: `line ${candidate.line}: ${matchPreview}`,
          description: `→ ${replacementPreview}`,
          line: candidate.line,
          matchPreview,
          replacementPreview,
        };
      }),
    hasPreviousPage: visibleStart > 0,
    hasNextPage: visibleStart < maxOffset,
  };
}

function normalizePickerModelId(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function createModelPickerState(input: {
  models: ModelPickerCandidate[];
  currentModel?: string;
  title?: string;
  visibleStart?: number;
  maxVisibleItems?: number;
}): PickerState<ModelPickerItem> {
  const current = normalizePickerModelId(input.currentModel);
  const totalItems = input.models.length;
  const visibleLimit = normalizeVisibleLimit(totalItems, input.maxVisibleItems ?? totalItems);
  const maxOffset = maxPickerOffset(totalItems, visibleLimit);
  const visibleStart = Math.max(0, Math.min(input.visibleStart ?? 0, maxOffset));

  return {
    kind: 'model',
    title: input.title ?? 'Available Models',
    totalItems,
    visibleStart,
    visibleLimit,
    page: totalItems === 0 ? 1 : Math.floor(visibleStart / visibleLimit) + 1,
    pageCount: totalItems === 0 ? 1 : Math.ceil(totalItems / visibleLimit),
    visibleItems: input.models.slice(visibleStart, visibleStart + visibleLimit).map(model => {
      const name = model.name;
      const alias = model.alias?.trim() || undefined;
      const isCurrent =
        current !== '' &&
        (normalizePickerModelId(name) === current || normalizePickerModelId(alias) === current);
      const aliasLabel = alias ? ` (${alias})` : '';
      const description = [
        model.provider,
        typeof model.contextWindow === 'number' ? `${model.contextWindow} ctx` : undefined,
        typeof model.maxOutputTokens === 'number' ? `${model.maxOutputTokens} output` : undefined,
        model.source,
      ]
        .filter(Boolean)
        .join('  ');

      return {
        model,
        name,
        value: name,
        alias,
        provider: model.provider,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        source: model.source,
        isCurrent,
        label: `${name}${aliasLabel}`,
        description,
      };
    }),
    hasPreviousPage: visibleStart > 0,
    hasNextPage: visibleStart < maxOffset,
  };
}

function summarizePermissionValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function summarizePermissionArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${summarizePermissionValue(value)}`)
    .join(' ');
}

export function permissionScopeFromArgs(args: Record<string, unknown>): PermissionScopeState {
  if (typeof args.command === 'string' && args.command.trim()) {
    return { kind: 'command', value: `$ ${args.command}` };
  }
  if (typeof args.path === 'string' && args.path.trim()) {
    return { kind: 'path', value: args.path };
  }
  if (Array.isArray(args.paths) && args.paths.length > 0) {
    return { kind: 'paths', count: args.paths.length };
  }

  const detail = summarizePermissionArgs(args);
  return detail ? { kind: 'args', value: detail } : { kind: 'unknown' };
}

export function permissionScopeDisplayValue(scope: PermissionScopeState): string {
  if (scope.kind === 'command') return `cmd=${scope.value ?? ''}`;
  if (scope.kind === 'path') return `path=${scope.value ?? ''}`;
  if (scope.kind === 'paths') return `paths=${scope.count ?? 0}`;
  if (scope.kind === 'args') return `args=${scope.value ?? ''}`;
  return 'scope=unknown';
}

function permissionRiskLevel(
  toolName: string,
  args: Record<string, unknown> = {}
): PermissionRiskLevel {
  if (toolName === 'exec_command' && typeof args.command === 'string') {
    return classifyCommandSafety(args.command).risk;
  }
  const normalized = toolName.toLowerCase();
  if (/(?:write|edit|delete|remove|patch|git_push|publish)/.test(normalized)) return 'high';
  if (/(?:read|search|list|grep|find|stat|ls|cat)/.test(normalized)) return 'low';
  return 'medium';
}

export function permissionRiskDisplayValue(risk: PermissionRiskState): string {
  const label = risk.level === 'high' ? 'HIGH' : risk.level === 'medium' ? 'med' : risk.level;
  return `${label}: ${risk.reason}`;
}

export function createPermissionPromptState(
  request: ToolPermissionRequest,
  cwd: string
): PermissionPromptState {
  return {
    requestId: request.id,
    toolName: request.name,
    scope: permissionScopeFromArgs(request.args),
    cwd,
    risk: {
      level: permissionRiskLevel(request.name, request.args),
      reason: request.reason?.trim() || 'approval required',
    },
    options: {
      approve: 'y=yes',
      deny: 'n=no',
    },
  };
}

function normalizeVisibleLimit(totalItems: number, requestedLimit?: number): number {
  const safeRequested =
    Number.isFinite(requestedLimit) && requestedLimit && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : 10;
  return Math.max(1, Math.min(safeRequested, Math.max(1, totalItems)));
}

function maxPickerOffset(totalItems: number, visibleLimit: number): number {
  return Math.max(0, Math.ceil(totalItems / visibleLimit) - 1) * visibleLimit;
}

export function createSessionPickerState(
  request: SessionPickerRequest,
  visibleStart = 0
): PickerState<SessionPickerItem> {
  const totalItems = request.sessions.length;
  const visibleLimit = normalizeVisibleLimit(totalItems, request.maxVisibleItems);
  const maxOffset = maxPickerOffset(totalItems, visibleLimit);
  const clampedStart = Math.max(0, Math.min(visibleStart, maxOffset));
  const visibleSessions = request.sessions.slice(clampedStart, clampedStart + visibleLimit);

  return {
    kind: 'session',
    title: request.title,
    totalItems,
    visibleStart: clampedStart,
    visibleLimit,
    page: totalItems === 0 ? 1 : Math.floor(clampedStart / visibleLimit) + 1,
    pageCount: totalItems === 0 ? 1 : Math.ceil(totalItems / visibleLimit),
    visibleItems: visibleSessions.map((session, index) => ({
      session,
      globalIndex: clampedStart + index + 1,
      sessionId: session.id,
      shortId: session.id.slice(0, 8),
      title: sessionPickerTitle(session),
      messageCount: session.messageCount ?? 0,
      historySizeBytes: session.historySizeBytes ?? 0,
      model: session.model,
      projectPath: session.projectPath,
      showProject: Boolean(request.showProject),
    })),
    hasPreviousPage: clampedStart > 0,
    hasNextPage: clampedStart < maxOffset,
  };
}

export function movePickerPageOffset(
  state: Pick<PickerState<unknown>, 'totalItems' | 'visibleLimit' | 'visibleStart'>,
  delta: -1 | 1
): number {
  const maxOffset = maxPickerOffset(state.totalItems, state.visibleLimit);
  return Math.max(0, Math.min(state.visibleStart + delta * state.visibleLimit, maxOffset));
}

export function createStatusSnapshot(
  input: {
    renderer?: unknown;
    capabilities?: UiRendererCapabilities;
    model?: string;
    sessionId?: string;
    tokens?: StatusSnapshot['tokens'];
    costUsd?: number;
    context?: ContextUsageSnapshot;
    runningState?: string;
    permissionMode?: string;
    loop?: StatusSnapshot['loop'];
  } = {}
): StatusSnapshot {
  const rendererName =
    typeof input.renderer === 'string' && input.renderer.trim() ? input.renderer : 'terminal';
  const capabilities = resolveUiRendererCapabilities(input.capabilities, rendererName);

  return {
    model: input.model,
    sessionId: input.sessionId,
    tokens: input.tokens,
    costUsd: input.costUsd,
    context: input.context,
    runningState: input.runningState,
    permissionMode: input.permissionMode,
    loop: input.loop,
    renderer: {
      name: rendererName,
      status: rendererStatus(rendererName),
      capabilities,
      capabilityLabels: rendererCapabilityLabels(capabilities),
    },
  };
}

export function transcriptEntryToBlock(entry: TranscriptEntry): TranscriptBlock {
  const kind = entry.title === 'resume' ? 'resume' : entry.role;
  return {
    id: entry.id,
    kind,
    role: entry.role,
    title: entry.title,
    content: entry.content,
    errorLayer: entry.errorLayer,
    toolActivity: entry.toolActivity,
    restored: entry.title === 'resume' ? true : undefined,
  };
}

export function toolActivityBatchLabel(
  activity: Pick<ToolActivity, 'batchCount' | 'batchIndex'>
): string {
  if (
    typeof activity.batchCount !== 'number' ||
    activity.batchCount <= 1 ||
    typeof activity.batchIndex !== 'number' ||
    activity.batchIndex < 0 ||
    activity.batchIndex >= activity.batchCount
  ) {
    return '';
  }

  return `Batch ${activity.batchIndex + 1}/${activity.batchCount} · `;
}

export function toolActivityFromStarted(
  event: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    sequence?: number;
    batchCount?: number;
    batchIndex?: number;
  },
  detail = ''
): ToolActivity {
  const command =
    event.name === 'exec_command' && typeof event.args.command === 'string'
      ? event.args.command
      : undefined;

  return {
    callId: event.callId,
    name: event.name,
    state: 'running',
    detail: command ? undefined : detail || undefined,
    command,
    seq: event.sequence,
    batchCount: event.batchCount,
    batchIndex: event.batchIndex,
  };
}

export function toolActivityFromFinished(
  event: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    success: boolean;
    skipped?: boolean;
    duration: number;
    summary?: string;
    error?: string;
    outputBytes?: number;
    artifactRef?: { id: string; outputBytes: number };
    sequence?: number;
    batchCount?: number;
    batchIndex?: number;
  },
  detail = ''
): ToolActivity {
  return {
    callId: event.callId,
    name: event.name,
    state: event.skipped ? 'skipped' : event.success ? 'success' : 'error',
    detail: detail || undefined,
    command:
      event.name === 'exec_command' && typeof event.args.command === 'string'
        ? event.args.command
        : undefined,
    summary: event.summary,
    durationMs: event.duration,
    error: event.error,
    outputBytes: event.outputBytes,
    artifactRef: event.artifactRef,
    seq: event.sequence,
    batchCount: event.batchCount,
    batchIndex: event.batchIndex,
  };
}

export function formatToolActivityTranscript(activity: ToolActivity): string {
  const prefix = toolActivityBatchLabel(activity);
  const lines: string[] = [];
  const detailLooksTruncated = Boolean(activity.detail?.includes('...'));

  if (activity.state === 'queued') {
    lines.push(`${prefix}Queued ${activity.name}${activity.detail ? ` ${activity.detail}` : ''}`);
  } else if (activity.state === 'running') {
    lines.push(`${prefix}Running ${activity.name}${activity.detail ? ` ${activity.detail}` : ''}`);
  } else if (activity.state === 'requested') {
    lines.push(
      `${prefix}Requested ${activity.name}${activity.detail ? ` ${activity.detail}` : ''}`
    );
  } else if (activity.state === 'skipped') {
    lines.push(`${prefix}Skipped ${activity.name}${activity.detail ? ` ${activity.detail}` : ''}`);
  } else {
    const symbol = activity.state === 'success' ? '✓' : '✗';
    const suffix = activity.detail ? ` ${activity.detail}` : '';
    const duration = typeof activity.durationMs === 'number' ? ` (${activity.durationMs}ms)` : '';
    lines.push(`${prefix}${activity.summary || `${symbol} ${activity.name}${suffix}${duration}`}`);
  }

  if (activity.command) {
    lines.push(`  $ ${activity.command}`);
  }

  if (activity.artifactRef) {
    lines.push(
      `  Full output: /artifacts show ${activity.artifactRef.id} --full (${formatBytes(activity.artifactRef.outputBytes)})`
    );
  } else if (typeof activity.outputBytes === 'number') {
    lines.push(`  output ${formatBytes(activity.outputBytes)}`);
  }

  if (activity.error) {
    lines.push(`Error: ${activity.error}`);
  }

  if (detailLooksTruncated || activity.artifactRef || activity.error) {
    lines.push('  Details: /last-tool or /trace latest');
  }

  return lines.filter(Boolean).join('\n');
}
