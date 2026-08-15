import type { Message } from '../llm';
import { estimateMessagesTokens } from '../../utils/token-estimate';
import { canonicalMessagesFingerprint } from './fingerprint';

export const DEFAULT_COMPACT_TARGET_RATIO = 0.65;

export interface CompactMessageGroup {
  id: string;
  /** Inclusive index in the input passed to groupMessagesForCompact. */
  startIndex: number;
  /** Exclusive index in the input passed to groupMessagesForCompact. */
  endIndex: number;
  messages: Message[];
  estimatedTokens: number;
}

export interface CompactPlanOptions {
  maxMessages?: number;
  safeInputBudget?: number;
  targetRatio?: number;
  /** Tokens already occupied by system and other pinned context. */
  fixedTokens?: number;
  /** Space reserved for the semantic summary and its framing messages. */
  summaryReserveTokens?: number;
}

export interface CompactPlan {
  groups: CompactMessageGroup[];
  evictedGroups: CompactMessageGroup[];
  recentGroups: CompactMessageGroup[];
  recentStartIndex: number;
  targetRatio: number;
  targetTokens?: number;
  tailTokenBudget?: number;
  fixedTokens: number;
  summaryReserveTokens: number;
}

function createGroup(
  messages: Message[],
  startIndex: number,
  endIndex: number
): CompactMessageGroup {
  const grouped = messages.slice(startIndex, endIndex).map(message => ({ ...message }));
  return {
    id: canonicalMessagesFingerprint(grouped),
    startIndex,
    endIndex,
    messages: grouped,
    estimatedTokens: estimateMessagesTokens(grouped),
  };
}

/** Group assistant tool declarations and their contiguous results atomically. */
export function groupMessagesForCompact(messages: readonly Message[]): CompactMessageGroup[] {
  const copy = messages.map(message => ({ ...message }));
  const groups: CompactMessageGroup[] = [];

  for (let index = 0; index < copy.length; index++) {
    const message = copy[index];
    if (!message.tool_calls?.length) {
      groups.push(createGroup(copy, index, index + 1));
      continue;
    }

    const declared = new Set(message.tool_calls.map(call => call.id));
    let cursor = index + 1;
    while (
      cursor < copy.length &&
      copy[cursor].role === 'tool' &&
      declared.has(copy[cursor].tool_call_id ?? '')
    ) {
      cursor++;
    }
    groups.push(createGroup(copy, index, cursor));
    index = cursor - 1;
  }

  return groups;
}

function normalizeRatio(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPACT_TARGET_RATIO;
  return Math.max(
    0.1,
    Math.min(DEFAULT_COMPACT_TARGET_RATIO, value ?? DEFAULT_COMPACT_TARGET_RATIO)
  );
}

/**
 * Select a recent tail from newest to oldest without splitting message groups.
 * The latest group is always retained; validation will fail closed if that one
 * group cannot fit the requested target.
 */
export function planCompactMessages(
  messages: readonly Message[],
  options: CompactPlanOptions = {}
): CompactPlan {
  const groups = groupMessagesForCompact(messages);
  const maxMessages = Math.max(0, Math.floor(options.maxMessages ?? 20));
  const targetRatio = normalizeRatio(options.targetRatio);
  const fixedTokens = Math.max(0, Math.floor(options.fixedTokens ?? 0));
  const targetTokens = Number.isFinite(options.safeInputBudget)
    ? Math.max(1, Math.floor((options.safeInputBudget ?? 0) * targetRatio))
    : undefined;
  const defaultSummaryReserve = targetTokens
    ? Math.min(1024, Math.max(128, Math.floor(targetTokens * 0.18)))
    : 0;
  const summaryReserveTokens = Math.max(
    0,
    Math.floor(options.summaryReserveTokens ?? defaultSummaryReserve)
  );
  const tailTokenBudget = targetTokens
    ? Math.max(0, targetTokens - fixedTokens - summaryReserveTokens)
    : undefined;

  const recentReversed: CompactMessageGroup[] = [];
  let retainedMessages = 0;
  let retainedTokens = 0;
  const requestedTailStart = Math.max(0, messages.length - maxMessages);
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    const isLatest = recentReversed.length === 0;
    const nextMessageCount = retainedMessages + group.messages.length;
    const crossesLegacyTailBoundary =
      targetTokens === undefined && group.endIndex > requestedTailStart;
    const withinMessageLimit = nextMessageCount <= maxMessages || crossesLegacyTailBoundary;
    const withinTokenLimit =
      tailTokenBudget === undefined || retainedTokens + group.estimatedTokens <= tailTokenBudget;
    if (!isLatest && (!withinMessageLimit || !withinTokenLimit)) break;

    recentReversed.push(group);
    retainedMessages = nextMessageCount;
    retainedTokens += group.estimatedTokens;
  }

  const recentGroups = recentReversed.reverse();
  const recentStartIndex = recentGroups[0]?.startIndex ?? messages.length;
  const evictedGroups = groups.slice(0, groups.length - recentGroups.length);
  return {
    groups,
    evictedGroups,
    recentGroups,
    recentStartIndex,
    targetRatio,
    targetTokens,
    tailTokenBudget,
    fixedTokens,
    summaryReserveTokens,
  };
}

export function flattenCompactGroups(groups: readonly CompactMessageGroup[]): Message[] {
  return groups.flatMap(group => group.messages.map(message => ({ ...message })));
}
