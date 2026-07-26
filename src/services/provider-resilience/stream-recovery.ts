/**
 * v0.2.25 — Stream Recovery Engine.
 *
 * Handles mid-stream interruption recovery with overlap deduplication.
 * When a stream fails after partial text has been emitted, constructs
 * a continuation recovery request instead of blindly replaying.
 */

export interface StreamOverlapResult {
  /** The deduplicated suffix to append to the existing partial text. */
  suffix: string;
  /** True if a trustworthy overlap was found and removed. */
  overlapFound: boolean;
  /** The overlap text that was removed (for diagnostics). */
  overlapText: string;
}

/**
 * Reconcile a recovery stream's initial output with previously emitted
 * partial text. Finds the longest suffix of previousText that matches
 * a prefix of recoveryText, and returns only the new suffix.
 *
 * Uses strict suffix-prefix matching — never deletes content based on
 * fuzzy similarity, which could accidentally remove real new content.
 */
export function reconcileStreamOverlap(
  previousText: string,
  recoveryText: string,
  maxWindow = 2048,
): StreamOverlapResult {
  if (!previousText || !recoveryText) {
    return { suffix: recoveryText, overlapFound: false, overlapText: '' };
  }

  // Only look at the tail of previousText within maxWindow.
  const tail = previousText.length > maxWindow
    ? previousText.slice(-maxWindow)
    : previousText;

  // Find longest suffix-prefix match.
  let bestLen = 0;
  for (let len = Math.min(tail.length, recoveryText.length); len > 0; len--) {
    const suffix = tail.slice(-len);
    const prefix = recoveryText.slice(0, len);
    if (suffix === prefix) {
      bestLen = len;
      break;
    }
  }

  if (bestLen === 0) {
    // No overlap found. Insert a recovery boundary marker.
    return {
      suffix: `\n[stream recovered]\n${recoveryText}`,
      overlapFound: false,
      overlapText: '',
    };
  }

  return {
    suffix: recoveryText.slice(bestLen),
    overlapFound: true,
    overlapText: recoveryText.slice(0, bestLen),
  };
}

/**
 * Build a stream recovery prompt fragment. This is injected into the
 * model request but NOT persisted as a user message.
 */
export function buildRecoveryInstruction(partialText: string): string {
  return `[Internal Stream Recovery]
The previous assistant response was interrupted by a transport failure.
Continue from the exact partial assistant content supplied above.
Do not repeat content already present.
Do not claim that the user sent a new request.
If a tool is still needed, emit a fresh complete tool call.`;
}

/**
 * Determine if a given stream chunk represents a semantic delta
 * that commits the stream (meaning retry must use recovery, not replay).
 */
export function isSemanticDelta(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const c = chunk as Record<string, unknown>;
  // Text content delta
  if (typeof c.content === 'string' && c.content.length > 0) return true;
  // Tool call delta
  if (c.tool_calls || c.function_call) return true;
  // Reasoning delta (Anthropic/OpenAI thinking)
  if (typeof c.reasoning_content === 'string' && c.reasoning_content.length > 0) return true;
  return false;
}

/**
 * Check if a partial tool call is present and should be discarded.
 * Returns true if tool call delta was seen but the call is incomplete.
 */
export function isPartialToolCall(state: {
  toolCallDeltaSeen: boolean;
  partialToolCalls: Map<number, { name?: string; arguments: string }>;
}): boolean {
  if (!state.toolCallDeltaSeen) return false;
  for (const call of state.partialToolCalls.values()) {
    // Incomplete if name is missing or arguments are empty/malformed.
    if (!call.name || !call.arguments || call.arguments === '{}') return true;
    // Try to parse — if it fails, it's partial.
    try { JSON.parse(call.arguments); } catch { return true; }
  }
  return false;
}