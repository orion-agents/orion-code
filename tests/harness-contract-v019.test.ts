import {
  buildHarnessContext,
  createContextHarness,
  createTaskContract,
  normalizeTaskContract,
  ProgressController,
  StopController,
  summarizeHarnessStateForMeta,
} from '../src/harness';

describe('v0.1.9 Harness contract compatibility', () => {
  test('upgrades legacy success strings to stable criterion ids', () => {
    const legacy = createTaskContract('Implement the change and run npm test', '/repo');
    const first = normalizeTaskContract({ ...legacy, criteria: undefined });
    const restored = normalizeTaskContract(JSON.parse(JSON.stringify(first)));

    expect(first.criteria).toHaveLength(first.successCriteria.length);
    expect(first.criteria?.map(criterion => criterion.statement)).toEqual(first.successCriteria);
    expect(
      first.criteria?.every(criterion => /^criterion:harness:[a-f0-9]{16}$/u.test(criterion.id))
    ).toBe(true);
    expect(restored.criteria?.map(criterion => criterion.id)).toEqual(
      first.criteria?.map(criterion => criterion.id)
    );
  });

  test('preserves explicit criterion ids and evidence links during normalization', () => {
    const contract = createTaskContract('Run npm test and ensure it passes', '/repo');
    const statement = contract.successCriteria[0];
    const normalized = normalizeTaskContract({
      ...contract,
      criteria: [{ id: 'criterion:caller-owned', statement, evidenceRefs: ['ledger:one'] }],
    });

    expect(normalized.criteria?.[0]).toMatchObject({
      id: 'criterion:caller-owned',
      statement,
      evidenceRefs: ['ledger:one'],
      source: { kind: 'user' },
      scope: 'task',
      dependencies: [],
      status: 'pending',
    });
  });

  test('writes TaskContract V3 without truncating or colliding long criteria', () => {
    const prefix = 'A'.repeat(220);
    const firstStatement = `${prefix} first-tail must pass npm test`;
    const secondStatement = `${prefix} second-tail must pass npm test`;
    const base = createTaskContract('Implement the change', '/repo');
    const normalized = normalizeTaskContract({
      ...base,
      version: undefined,
      successCriteria: [firstStatement, secondStatement],
      criteria: undefined,
    });

    expect(normalized.version).toBe(3);
    expect(normalized.criteria?.map(item => item.statement)).toEqual([
      firstStatement,
      secondStatement,
    ]);
    expect(new Set(normalized.criteria?.map(item => item.id)).size).toBe(2);
    expect(normalized.criteria?.[0]).toMatchObject({
      source: { kind: 'user' },
      scope: 'task',
      dependencies: [],
      status: 'pending',
    });
  });

  test('links ledger evidence to a known criterion and rejects unknown ids', () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });
    harness.updateContractFromUserInput('Run npm test and ensure it passes');
    harness.recordToolResult({
      name: 'exec_command',
      args: { command: 'npm test' },
      result: JSON.stringify({ success: true, output: 'passed' }),
      duration: 10,
      success: true,
    });
    const before = harness.toJSON();
    const criterionId = before.contract!.criteria![0].id;
    const evidenceId = before.ledger[before.ledger.length - 1].id;

    expect(harness.linkEvidenceToCriterion(criterionId, evidenceId)).toBe(true);
    expect(harness.linkEvidenceToCriterion('criterion:missing', evidenceId)).toBe(false);
    expect(harness.toJSON().contract?.criteria?.[0].evidenceRefs).toEqual([evidenceId]);
  });

  test('audits test and build criteria independently', () => {
    const base = createTaskContract('Implement the feature', '/repo');
    const contract = normalizeTaskContract({
      ...base,
      successCriteria: ['Run npm test and ensure it passes', 'Run npm run build successfully'],
      criteria: undefined,
    });
    const harness = createContextHarness({
      cwd: '/repo',
      modelId: 'gpt-4o',
      state: { contract, ledger: [], updatedAt: 1 },
      config: { completionGate: 'block' },
    });

    harness.recordToolResult({
      name: 'exec_command',
      args: { command: 'npm test', cwd: '/repo' },
      result: JSON.stringify({ success: true, output: 'passed', exitCode: 0, sourceSha: 'abc' }),
      duration: 10,
      success: true,
    });
    const afterTest = harness.beforeComplete();
    expect(afterTest.canComplete).toBe(false);
    expect(afterTest.criterionResults).toEqual([
      expect.objectContaining({ status: 'passed', requiredKinds: ['test'], missingKinds: [] }),
      expect.objectContaining({
        status: 'pending',
        requiredKinds: ['build'],
        missingKinds: ['build'],
      }),
    ]);
    expect(harness.toJSON().contract?.criteria?.[0].evidenceRefs).toHaveLength(1);
    expect(harness.toJSON().contract?.criteria?.[1].evidenceRefs).toHaveLength(0);

    harness.recordToolResult({
      name: 'exec_command',
      args: { command: 'npm run build', cwd: '/repo' },
      result: JSON.stringify({ success: true, output: 'built', exitCode: 0, artifactHash: 'def' }),
      duration: 20,
      success: true,
    });
    expect(harness.beforeComplete()).toMatchObject({ canComplete: true, missing: [] });
    const receipts = harness.toJSON().ledger.filter(entry => entry.type === 'verification');
    expect(receipts[0].metadata).toMatchObject({
      command: 'npm test',
      cwd: '/repo',
      exitCode: 0,
      sourceSha: 'abc',
      verificationKind: 'test',
      freshness: 'current_run',
    });
    expect(receipts[1].metadata).toMatchObject({
      artifactHash: 'def',
      verificationKind: 'build',
    });
  });

  test('rejects opaque evidence and requires user provenance for a waiver', () => {
    const harness = createContextHarness({
      cwd: '/repo',
      modelId: 'gpt-4o',
      config: { completionGate: 'block' },
    });
    harness.updateContractFromUserInput('Run npm test and ensure it passes');
    harness.recordToolResult({
      name: 'exec_command',
      args: { command: 'npm test' },
      result: 'passed',
      duration: 5,
      success: true,
    });
    const state = harness.toJSON();
    const criterionId = state.contract!.criteria![0].id;
    const evidenceId = state.ledger[state.ledger.length - 1].id;

    expect(harness.linkEvidenceToCriterion(criterionId, evidenceId)).toBe(false);
    expect(harness.beforeComplete().canComplete).toBe(false);
    expect(
      harness.authorizeCriterionWaiver(criterionId, {
        authorizedBy: 'user',
        reason: 'User explicitly accepted the external CI receipt.',
        at: 123,
        sourceRef: 'message:42',
      })
    ).toBe(true);
    expect(harness.beforeComplete().criterionResults?.[0]).toMatchObject({
      status: 'waived',
      missingKinds: [],
    });
  });

  test('toJSON is deterministic until Harness state mutates', () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });
    harness.updateContractFromUserInput('Implement deterministic Harness serialization');

    const first = harness.toJSON();
    const second = harness.toJSON();
    expect(second).toEqual(first);
    expect(summarizeHarnessStateForMeta(first).updatedAt).toBe(first.updatedAt);

    harness.recordAssistantResponse({ content: 'decision', model: 'gpt-4o' });
    expect(harness.toJSON().updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  test('maxRecentTurns bounds durable summaries and prompt projection', () => {
    const harness = createContextHarness({
      cwd: '/repo',
      modelId: 'gpt-4o',
      config: { maxRecentTurns: 2 },
    });
    harness.updateContractFromUserInput('Keep only bounded recent turn summaries');
    for (let turn = 1; turn <= 4; turn++) {
      harness.ingestTurn({
        userInput: `turn-${turn}`,
        assistantContent: `outcome-${turn}`,
        sessionMessages: [],
      });
    }

    const state = harness.toJSON();
    expect(state.turnSummaries?.map(summary => summary.turn)).toEqual([3, 4]);
    const built = buildHarnessContext(state, 'gpt-4o', { maxRecentTurns: 1 });
    expect(built.text).toContain('Turn 4');
    expect(built.text).not.toContain('Turn 3');
  });

  test('tracks deterministic progress and pauses repeated incomplete states', () => {
    const contract = normalizeTaskContract({
      ...createTaskContract('Implement the feature', '/repo'),
      successCriteria: ['Run npm test and ensure it passes'],
      criteria: undefined,
    });
    const controller = new ProgressController();
    const first = controller.observe({ contract, ledger: [], now: 1 });
    const second = controller.observe({ contract, ledger: [], now: 2 });
    controller.observe({ contract, ledger: [], now: 3 });
    const fourth = controller.observe({ contract, ledger: [], now: 4 });

    expect(first).toMatchObject({ changed: true, repeatedSignatureCount: 0, recordedAt: 1 });
    expect(second).toMatchObject({ changed: false, repeatedSignatureCount: 1, recordedAt: 2 });
    expect(fourth).toMatchObject({ changed: false, repeatedSignatureCount: 3, recordedAt: 4 });
    const decision = new StopController().decideCompletion(
      {
        canComplete: false,
        missing: ['Required verification has not passed yet.'],
        evidence: [],
        criterionResults: [
          {
            criterionId: contract.criteria![0].id,
            statement: contract.criteria![0].statement,
            status: 'pending',
            applicable: true,
            evidenceRefs: [],
            requiredKinds: ['test'],
            missingKinds: ['test'],
            failedKinds: [],
          },
        ],
      },
      fourth
    );
    expect(decision).toMatchObject({
      status: 'stopped',
      disposition: 'pause_scope',
      reason: { code: 'no_progress' },
      resumable: true,
      criterionStates: [{ id: contract.criteria![0].id, status: 'pending' }],
      progressDelta: { repeatedSignatureCount: 3 },
    });
  });

  test('versions immutable capability profiles only when runtime capability changes', () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });
    const first = harness.updateCapabilityProfile({
      modelId: 'gpt-4o',
      contextWindow: 128_000,
      permissionMode: 'interactive',
      toolConfirmation: 'ask',
      tools: ['read_file', 'subtask', 'web_search'],
      now: 10,
    });
    const afterFirst = harness.toJSON().updatedAt;
    const same = harness.updateCapabilityProfile({
      modelId: 'gpt-4o',
      contextWindow: 128_000,
      permissionMode: 'interactive',
      toolConfirmation: 'ask',
      tools: ['web_search', 'read_file', 'subtask'],
      now: 11,
    });

    expect(first).toMatchObject({
      revision: 1,
      createdAt: 10,
      permission: { mode: 'interactive', confirmation: 'ask', hardDenyEnforced: true },
      features: { network: true, subagents: true },
    });
    expect(same).toEqual(first);
    expect(harness.toJSON().updatedAt).toBe(afterFirst);

    const changed = harness.updateCapabilityProfile({
      modelId: 'gpt-4o',
      contextWindow: 128_000,
      permissionMode: 'auto',
      toolConfirmation: 'allow',
      tools: ['read_file', 'subtask', 'web_search'],
      now: 12,
    });
    const state = harness.toJSON();
    expect(changed).toMatchObject({ revision: 2, createdAt: 12 });
    expect(state.capabilityHistory?.map(profile => profile.revision)).toEqual([1, 2]);
    const built = buildHarnessContext(state, 'gpt-4o');
    expect(built.text).toContain('Capability profile: v2');
    expect(built.stats.capabilityProfileFingerprint).toBe(changed?.fingerprint);
  });
});
