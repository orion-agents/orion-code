import { createHash } from 'crypto';
import type { Message } from '../llm';

export const COMPACT_CANDIDATE_STRATEGY_VERSION = 'semantic-compact-v2';

export interface CompactCandidateFingerprintInput {
  messages: readonly Message[];
  sourceBoundary: {
    firstGroupId?: string;
    lastGroupId?: string;
    groupCount: number;
    messageCount: number;
    groupIds: readonly string[];
  };
  strategyVersion?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined)
      .map(key => [key, canonicalize(record[key])])
  );
}

function canonicalToolArguments(value: string): unknown {
  try {
    return canonicalize(JSON.parse(value) as unknown);
  } catch {
    return value;
  }
}

/**
 * Hash every provider-visible field. Equal JSON tool arguments produce the same
 * digest regardless of object key order; content or tool-result changes never
 * collide merely because their character counts are equal.
 */
export function canonicalMessagesFingerprint(messages: readonly Message[]): string {
  const canonicalMessages = messages.map(message => ({
    role: message.role,
    content: message.content,
    toolCallId: message.tool_call_id,
    cacheControl: canonicalize(message.cacheControl),
    toolCalls: message.tool_calls?.map(call => ({
      id: call.id,
      type: call.type,
      name: call.function.name,
      arguments: canonicalToolArguments(call.function.arguments),
    })),
  }));

  return createHash('sha256').update(JSON.stringify(canonicalMessages)).digest('hex');
}

/**
 * Bind a semantic candidate to both its provider-visible projection and the
 * exact source boundary/strategy that produced it. A projection-only digest is
 * insufficient because two compactions can render the same summary while
 * covering different durable transcript prefixes.
 */
export function canonicalCompactCandidateFingerprint(
  input: CompactCandidateFingerprintInput
): string {
  const receipt = {
    contentHash: canonicalMessagesFingerprint(input.messages),
    sourceBoundary: {
      firstGroupId: input.sourceBoundary.firstGroupId,
      lastGroupId: input.sourceBoundary.lastGroupId,
      groupCount: input.sourceBoundary.groupCount,
      messageCount: input.sourceBoundary.messageCount,
      groupIds: [...input.sourceBoundary.groupIds],
    },
    strategyVersion: input.strategyVersion ?? COMPACT_CANDIDATE_STRATEGY_VERSION,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(receipt)))
    .digest('hex');
}
