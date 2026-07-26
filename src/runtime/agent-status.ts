export function agentStepStatus(turn: number): string {
  // request_start on turn 1 is fresh reasoning; later turns continue from
  // tool results, so label them "reading tool results" to distinguish the phase.
  // Tool execution, verification, compact, and permission states are emitted separately.
  return turn <= 1 ? 'Working: thinking' : 'Working: reading tool results';
}

export function runningToolsStatus(count: number): string {
  return count === 1 ? 'Working: running tool' : `Working: running ${count} tools`;
}

export function verifyingStatus(profile: string): string {
  return `Verifying: running ${profile} checks...`;
}

export function verificationGateStatus(reason: string): string {
  return `Verification required: ${reason}`;
}

export function batchingSuggestion(readOnlyCount: number): string {
  if (readOnlyCount >= 3) {
    return `${readOnlyCount} independent read-only tool calls detected. Use the batch_read tool to group related reads into a single turn and reduce model-tool roundtrips.`;
  }
  return '';
}

export function compactStatus(): string {
  return 'Compacting: summarizing conversation history...';
}

export function permissionPendingStatus(toolName: string): string {
  return `Waiting: permission required for ${toolName}`;
}

export function isLegacyTurnStatus(message: string): boolean {
  return /^Turn\s+\d+\.\.\.$/.test(message.trim());
}
