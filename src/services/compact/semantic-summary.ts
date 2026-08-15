import type { Message } from '../llm';
import { redactTraceText } from '../redaction';
import { estimateMessagesTokens } from '../../utils/token-estimate';
import type { CompactMessageGroup } from './planner';

export type ContextItemKind =
  | 'system'
  | 'contract'
  | 'decision'
  | 'evidence'
  | 'tool_group'
  | 'turn'
  | 'next_action'
  /** @deprecated Read compatibility for pre-v0.1.9 semantic candidates. */
  | 'user_instruction'
  /** @deprecated Read compatibility for pre-v0.1.9 semantic candidates. */
  | 'assistant_outcome'
  /** @deprecated Read compatibility for pre-v0.1.9 semantic candidates. */
  | 'tool_outcome'
  /** @deprecated Read compatibility for pre-v0.1.9 semantic candidates. */
  | 'system_context';

export type ContextItemPriority = 'must_keep' | 'high' | 'normal' | 'evictable';

export interface ContextItem {
  id: string;
  groupId: string;
  kind: ContextItemKind;
  priority: ContextItemPriority;
  sourceRefs: string[];
  tokenEstimate: number;
  taskEpoch: number;
  expires?: 'turn' | 'task' | 'session';
  text: string;
  sourceRole: Message['role'];
  messageIndexes: { start: number; end: number };
  toolNames?: string[];
  toolCallIds?: string[];
  status?: 'passed' | 'failed' | 'unknown';
}

export interface CompactSummary {
  version: 1;
  taskEpoch: number;
  /** Secondary guidance supplied to a manual compact; never an invariant override. */
  requestedFocus?: string;
  /** Bounded project guidance used by manual and automatic compact. */
  projectInstructions?: string;
  objective?: string;
  activeInstruction?: string;
  scope?: {
    cwd: string;
    files?: string[];
    commands?: string[];
  };
  nonGoals?: string[];
  openQuestions?: string[];
  criterionStates?: Array<{
    id: string;
    statement: string;
    status: 'pending' | 'passed' | 'failed' | 'waived';
    evidenceRefs: string[];
  }>;
  latestUserInstruction?: string;
  constraints: string[];
  decisions: string[];
  completed: string[];
  pending: string[];
  blockers: string[];
  files: string[];
  changedFiles?: string[];
  successfulVerifications?: string[];
  failedVerifications?: string[];
  nextAction?: string;
  capability?: {
    revision: number;
    fingerprint: string;
    modelId: string;
    permissionMode: string;
    tools: string[];
  };
  sourceBoundary?: {
    firstGroupId?: string;
    lastGroupId?: string;
    groupCount: number;
    messageCount: number;
  };
  verification: ContextItem[];
  toolOutcomes: ContextItem[];
  evidenceRefs: string[];
  items: ContextItem[];
  coverage: {
    groupIds: string[];
    groupCount: number;
    messageCount: number;
  };
}

function compactBothEnds(value: string, maxLength: number = 600): string {
  const redacted = redactTraceText(value).replace(/\s+/g, ' ').trim();
  if (redacted.length <= maxLength) return redacted;
  const headLength = Math.floor((maxLength - 5) / 2);
  const tailLength = maxLength - 5 - headLength;
  return `${redacted.slice(0, headLength)} ... ${redacted.slice(-tailLength)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractPaths(messages: readonly Message[]): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const path = args.path ?? args.file_path ?? args.filePath;
        if (typeof path === 'string' && path.trim()) paths.push(redactTraceText(path.trim()));
      } catch {
        // Invalid arguments are still represented by the ContextItem text.
      }
    }
  }
  return paths;
}

function inferStatus(text: string): ContextItem['status'] {
  if (/\b(pass(?:ed)?|success(?:ful)?|ok|complete(?:d)?)\b|通过|成功/iu.test(text)) {
    return 'passed';
  }
  if (/\b(fail(?:ed|ure)?|error|blocked|timeout)\b|失败|错误|阻塞|超时/iu.test(text)) {
    return 'failed';
  }
  return 'unknown';
}

function contextItem(group: CompactMessageGroup, taskEpoch: number): ContextItem {
  const head = group.messages[0];
  const toolCalls = group.messages.flatMap(message => message.tool_calls ?? []);
  const toolResults = group.messages.filter(message => message.role === 'tool');
  const toolNames = unique(toolCalls.map(call => call.function.name));
  const toolCallIds = unique([
    ...toolCalls.map(call => call.id),
    ...toolResults.map(message => message.tool_call_id ?? ''),
  ]);

  let kind: ContextItemKind;
  let text: string;
  if (toolCalls.length > 0 || head.role === 'tool') {
    kind = 'tool_group';
    const results = toolResults.map(message => compactBothEnds(message.content, 360));
    text = compactBothEnds(
      [toolNames.length > 0 ? `Tools: ${toolNames.join(', ')}` : 'Tool result', ...results].join(
        ' | '
      )
    );
  } else if (head.role === 'user') {
    kind = 'turn';
    text = compactBothEnds(head.content);
  } else if (head.role === 'system') {
    kind = 'system';
    text = compactBothEnds(head.content);
  } else {
    kind = 'decision';
    text = compactBothEnds(head.content);
  }
  const status = kind === 'tool_group' ? inferStatus(text) : undefined;
  const verificationTool = toolNames.some(name =>
    /test|lint|build|check|verify|typecheck/iu.test(name)
  );

  return {
    id: `ctx-${group.id.slice(0, 20)}`,
    groupId: group.id,
    kind,
    priority:
      kind === 'system'
        ? 'must_keep'
        : kind === 'turn'
          ? 'high'
          : kind === 'tool_group'
            ? status === 'failed' || verificationTool
              ? 'high'
              : 'evictable'
            : 'normal',
    sourceRefs: unique([`group:${group.id}`, ...toolCallIds.map(id => `tool-call:${id}`)]),
    tokenEstimate: group.estimatedTokens || estimateMessagesTokens(group.messages),
    taskEpoch,
    expires: kind === 'system' ? 'session' : 'task',
    text,
    sourceRole: head.role,
    messageIndexes: { start: group.startIndex, end: group.endIndex },
    toolNames: toolNames.length > 0 ? toolNames : undefined,
    toolCallIds: toolCallIds.length > 0 ? toolCallIds : undefined,
    status,
  };
}

/** Build a typed, auditable item for every evicted atomic message group. */
export function extractCompactSummary(
  groups: readonly CompactMessageGroup[],
  options: { taskEpoch?: number } = {}
): CompactSummary {
  const taskEpoch = Math.max(1, Math.floor(options.taskEpoch ?? 1));
  const items = groups.map(group => contextItem(group, taskEpoch));
  const userItems = items.filter(item => item.kind === 'turn' && item.sourceRole === 'user');
  const assistantItems = items.filter(item => item.kind === 'decision');
  const toolOutcomes = items.filter(item => item.kind === 'tool_group');
  const allMessages = groups.flatMap(group => group.messages);
  const evidenceRefs = unique(
    allMessages.flatMap(message =>
      [
        ...message.content.matchAll(/\b(?:evidence|criterion|checkpoint)[-_:\s]?[a-z0-9._:-]+/giu),
      ].map(match => match[0])
    )
  );
  const constraints = unique(
    userItems
      .filter(item =>
        /\b(must|only|never|do not|without)\b|必须|不得|不要|只能|严禁/iu.test(item.text)
      )
      .map(item => item.text)
  );
  const decisions = unique(
    assistantItems
      .filter(item =>
        /\b(decid(?:e|ed)|chosen|will use|approach)\b|决定|采用|选择/iu.test(item.text)
      )
      .map(item => item.text)
  );
  const blockers = unique(
    items
      .filter(item =>
        /\b(blocked|cannot|unable|error|failed)\b|阻塞|无法|失败|错误/iu.test(item.text)
      )
      .map(item => item.text)
  );
  const pending = unique(
    items
      .filter(item => /\b(pending|todo|remaining|next)\b|待办|尚未|下一步/iu.test(item.text))
      .map(item => item.text)
  );
  const completed = unique(
    items
      .filter(item =>
        /\b(done|completed|passed|implemented|fixed)\b|完成|通过|已修复/iu.test(item.text)
      )
      .map(item => item.text)
  );
  const verification = toolOutcomes.filter(
    item =>
      item.status !== 'unknown' ||
      item.toolNames?.some(name => /test|lint|build|check|verify/iu.test(name))
  );

  return {
    version: 1,
    taskEpoch,
    objective: userItems[0]?.text,
    latestUserInstruction: userItems.at(-1)?.text,
    constraints,
    decisions,
    completed,
    pending,
    blockers,
    files: unique(extractPaths(allMessages)),
    verification,
    toolOutcomes,
    evidenceRefs,
    items,
    sourceBoundary: {
      firstGroupId: groups[0]?.id,
      lastGroupId: groups.at(-1)?.id,
      groupCount: groups.length,
      messageCount: groups.reduce((sum, group) => sum + group.messages.length, 0),
    },
    coverage: {
      groupIds: groups.map(group => group.id),
      groupCount: groups.length,
      messageCount: groups.reduce((sum, group) => sum + group.messages.length, 0),
    },
  };
}

export function emptyCompactSummary(): CompactSummary {
  return extractCompactSummary([]);
}
