import {
  agentStepStatus,
  batchingSuggestion,
  compactStatus,
  isLegacyTurnStatus,
  permissionPendingStatus,
  runningToolsStatus,
  verificationGateStatus,
  verifyingStatus,
} from '../src/runtime/agent-status';

describe('agent status helpers', () => {
  test('uses intentful status text instead of Turn labels', () => {
    expect(agentStepStatus(1)).toBe('Working: thinking');
    expect(agentStepStatus(2)).toBe('Working: reading tool results');
    expect(agentStepStatus(8)).toBe('Working: reading tool results');
  });

  test('summarizes batched tool execution status', () => {
    expect(runningToolsStatus(1)).toBe('Working: running tool');
    expect(runningToolsStatus(4)).toBe('Working: running 4 tools');
  });

  test('recognizes legacy Turn labels for UI compatibility', () => {
    expect(isLegacyTurnStatus('Turn 2...')).toBe(true);
    expect(isLegacyTurnStatus('Working: thinking')).toBe(false);
    expect(isLegacyTurnStatus('Working: running 3 tools')).toBe(false);
  });

  test('shows verification status per profile', () => {
    expect(verifyingStatus('node')).toBe('Verifying: running node checks...');
    expect(verifyingStatus('python')).toBe('Verifying: running python checks...');
  });

  test('shows verification gate status with reason', () => {
    expect(verificationGateStatus('missing tests')).toBe('Verification required: missing tests');
  });

  test('shows compact status', () => {
    expect(compactStatus()).toBe('Compacting: summarizing conversation history...');
  });

  test('shows permission pending status for tool', () => {
    expect(permissionPendingStatus('git_push')).toBe('Waiting: permission required for git_push');
  });

  test('suggests batching only when 3+ read-only tool calls', () => {
    expect(batchingSuggestion(0)).toBe('');
    expect(batchingSuggestion(2)).toBe('');
    expect(batchingSuggestion(3)).toContain('3 independent read-only tool calls');
    expect(batchingSuggestion(5)).toContain('5 independent read-only tool calls');
    expect(batchingSuggestion(3)).toContain('batch_read');
    expect(batchingSuggestion(3)).toContain('reduce model-tool roundtrips');
  });
});
