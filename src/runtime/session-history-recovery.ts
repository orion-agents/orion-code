import { assertToolCallGroups, sealToolCallGroups } from '../services/compact/tool-call-groups';
import type { Message } from '../services/llm';

export type SessionHistorySourceV1 = 'turn_commit' | 'transcript' | 'legacy';
export type SessionHistoryResolvedSourceV1 =
  | SessionHistorySourceV1
  | `${SessionHistorySourceV1}_repaired`;

export interface SessionHistoryRecoveryDiagnosticV1 {
  readonly code: 'tool_call_groups_repaired' | 'authoritative_history_invalid';
  readonly message: string;
}

export interface SessionHistoryRecoveryV1 {
  readonly messages: readonly Message[];
  readonly source: SessionHistoryResolvedSourceV1;
  readonly diagnostics: readonly SessionHistoryRecoveryDiagnosticV1[];
}

/**
 * Normalize a persisted history before it becomes provider-visible. Valid
 * histories pass through unchanged; incomplete legacy groups receive explicit
 * cancelled tool results so the original facts remain readable and resumable.
 */
export function normalizeSessionModelHistoryV1(
  messages: readonly Message[],
  source: SessionHistorySourceV1
): SessionHistoryRecoveryV1 {
  const candidate = messages.map(cloneMessage);
  try {
    assertToolCallGroups(candidate);
    return deepFreeze({ messages: candidate, source, diagnostics: [] });
  } catch {
    const repaired = sealToolCallGroups(candidate);
    assertToolCallGroups(repaired);
    return deepFreeze({
      messages: repaired,
      source: `${source}_repaired`,
      diagnostics: [
        {
          code: 'tool_call_groups_repaired',
          message:
            'Recovered incomplete tool-call results as cancelled entries; original transcript facts were preserved.',
        },
      ],
    });
  }
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    ...(message.tool_calls ? { tool_calls: structuredClone(message.tool_calls) } : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
