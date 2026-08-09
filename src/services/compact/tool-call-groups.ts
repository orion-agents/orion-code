import type { Message } from '../llm';

type ToolCall = NonNullable<Message['tool_calls']>[number];

/**
 * Keep an assistant tool-call declaration and its tool results in the same
 * recent-history window. A raw positional slice may otherwise retain a tool
 * result while compacting away the assistant message that declared its id.
 */
export function snapToToolCallGroupStart(messages: Message[], requestedStart: number): number {
  const start = Math.max(0, Math.min(messages.length, requestedStart));
  if (start === 0 || messages[start]?.role !== 'tool') return start;

  let candidate = start - 1;
  while (candidate >= 0 && messages[candidate].role === 'tool') candidate--;

  const head = messages[candidate];
  if (!head?.tool_calls?.length) return start;
  const declaredIds = new Set(head.tool_calls.map(call => call.id));
  return declaredIds.has(messages[start].tool_call_id ?? '') ? candidate : start;
}

/** Return the declared calls that do not yet have a model-visible tool result. */
export function pendingToolCalls(
  toolCalls: readonly ToolCall[],
  answeredToolCallIds: ReadonlySet<string>
): ToolCall[] {
  return toolCalls.filter(call => !answeredToolCallIds.has(call.id));
}

const RECOVERED_TOOL_RESULT = JSON.stringify({
  success: false,
  status: 'cancelled',
  error: 'Missing tool result was sealed during session recovery.',
});

/**
 * Repair legacy histories before resume: drop orphan/duplicate tool results and
 * synthesize a terminal result for every declared call that was never persisted.
 */
export function sealToolCallGroups(messages: readonly Message[]): Message[] {
  const sealed: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'tool') continue;
    if (!message.tool_calls?.length) {
      sealed.push(message);
      continue;
    }

    const seenIds = new Set<string>();
    const calls = message.tool_calls.filter(call => {
      if (!call.id || seenIds.has(call.id)) return false;
      seenIds.add(call.id);
      return true;
    });
    sealed.push(
      calls.length === message.tool_calls.length ? message : { ...message, tool_calls: calls }
    );

    const pending = new Map(calls.map(call => [call.id, call]));
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      const result = messages[cursor];
      const callId = result.tool_call_id ?? '';
      if (pending.has(callId)) {
        sealed.push(result);
        pending.delete(callId);
      }
      cursor++;
    }
    for (const call of pending.values()) {
      sealed.push({ role: 'tool', content: RECOVERED_TOOL_RESULT, tool_call_id: call.id });
    }
    index = cursor - 1;
  }
  return sealed;
}

/** Reject malformed provider histories before a request reaches the network. */
export function assertToolCallGroups(messages: readonly Message[]): void {
  let pending: Set<string> | null = null;
  for (const [index, message] of messages.entries()) {
    if (pending) {
      if (message.role !== 'tool') {
        throw new Error(
          `Incomplete tool-call group before message ${index}: missing ${[...pending].join(', ')}`
        );
      }
      const callId = message.tool_call_id ?? '';
      if (!pending.delete(callId)) {
        throw new Error(
          `Orphan or duplicate tool result at message ${index}: ${callId || '<empty>'}`
        );
      }
      if (pending.size === 0) pending = null;
      continue;
    }

    if (message.role === 'tool') {
      throw new Error(
        `Orphan or duplicate tool result at message ${index}: ${message.tool_call_id || '<empty>'}`
      );
    }
    if (message.tool_calls?.length) {
      const ids = message.tool_calls.map(call => call.id);
      if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
        throw new Error(`Invalid or duplicate tool call id at message ${index}`);
      }
      pending = new Set(ids);
    }
  }
  if (pending) {
    throw new Error(
      `Incomplete tool-call group at end of history: missing ${[...pending].join(', ')}`
    );
  }
}
