import type { Message } from '../src/services/llm';
import {
  canonicalCompactCandidateFingerprint,
  canonicalMessagesFingerprint,
  commitCompactCandidate,
  extractCompactSummary,
  groupMessagesForCompact,
  prepareCompactCandidate,
  validateCompactCandidate,
} from '../src/services/compact';
import * as compactExports from '../src/services/compact';
import {
  ModelCoordinator,
  validateModelSwitchCompactReceipt,
  type ModelSwitchCompactPreflightReceipt,
} from '../src/runtime/model-coordinator';
import { estimateMessagesTokens } from '../src/utils/token-estimate';
import { buildRegistry } from '../src/services/model-registry';
import { ModelClientPool } from '../src/services/model-client-pool';

function toolGroup(id: string, result: string): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
        },
      ],
    },
    { role: 'tool', content: result, tool_call_id: id },
  ];
}

describe('semantic compact', () => {
  test('binds candidate fingerprints to canonical content, source boundary, and strategy', () => {
    const messages: Message[] = [{ role: 'user', content: 'same compact projection' }];
    const base = {
      messages,
      sourceBoundary: {
        firstGroupId: 'group-a',
        lastGroupId: 'group-b',
        groupCount: 2,
        messageCount: 4,
        groupIds: ['group-a', 'group-b'],
      },
    };

    expect(canonicalCompactCandidateFingerprint(base)).toBe(
      canonicalCompactCandidateFingerprint(base)
    );
    expect(canonicalCompactCandidateFingerprint(base)).not.toBe(
      canonicalCompactCandidateFingerprint({
        ...base,
        sourceBoundary: { ...base.sourceBoundary, groupIds: ['group-a', 'group-c'] },
      })
    );
    expect(canonicalCompactCandidateFingerprint(base)).not.toBe(
      canonicalCompactCandidateFingerprint({ ...base, strategyVersion: 'semantic-compact-v3' })
    );
  });

  test('groups assistant tool declarations with every declared result', () => {
    const messages: Message[] = [
      { role: 'user', content: 'inspect' },
      ...toolGroup('call-a', 'result-a'),
      { role: 'assistant', content: 'done' },
    ];

    const groups = groupMessagesForCompact(messages);

    expect(groups).toHaveLength(3);
    expect(groups[1].messages.map(message => message.role)).toEqual(['assistant', 'tool']);
    expect(groups[1].startIndex).toBe(1);
    expect(groups[1].endIndex).toBe(3);
  });

  test('creates one typed ContextItem for every evicted group, including late context', () => {
    const messages: Message[] = Array.from({ length: 50 }, (_, index) => ({
      role: 'user' as const,
      content: `${'x'.repeat(300)} group-${index}${index === 49 ? ' CRITICAL_LATE_FACT' : ''}`,
    }));
    const groups = groupMessagesForCompact(messages);

    const summary = extractCompactSummary(groups);

    expect(summary.coverage.groupIds).toEqual(groups.map(group => group.id));
    expect(summary.coverage.messageCount).toBe(messages.length);
    expect(summary.items).toHaveLength(groups.length);
    expect(summary.items.at(-1)?.text).toContain('CRITICAL_LATE_FACT');
    expect(summary.latestUserInstruction).toContain('CRITICAL_LATE_FACT');
    expect(summary.items.at(-1)).toMatchObject({
      kind: 'turn',
      priority: 'high',
      taskEpoch: 1,
      expires: 'task',
    });
    expect(summary.items.at(-1)?.sourceRefs[0]).toMatch(/^group:/);
    expect(summary.items.at(-1)?.tokenEstimate).toBeGreaterThan(0);
  });

  test('canonical fingerprint observes content and canonical tool arguments', () => {
    const first = toolGroup('call-a', 'same-size-A');
    const second = toolGroup('call-a', 'same-size-B');
    expect(canonicalMessagesFingerprint(first)).not.toBe(canonicalMessagesFingerprint(second));

    const argsA = toolGroup('call-a', 'result');
    const argsB = toolGroup('call-a', 'result');
    argsA[0].tool_calls![0].function.arguments = '{"path":"a","line":1}';
    argsB[0].tool_calls![0].function.arguments = '{"line":1,"path":"a"}';
    expect(canonicalMessagesFingerprint(argsA)).toBe(canonicalMessagesFingerprint(argsB));
  });

  test('prepares and validates an atomic candidate within the 65% safe-budget target', async () => {
    const messages: Message[] = Array.from({ length: 40 }, (_, index) => ({
      role: 'user' as const,
      content: `request-${index} ${'x'.repeat(100)}`,
    }));

    const candidate = await prepareCompactCandidate(messages, {
      maxMessages: 20,
      safeInputBudget: 1_000,
      targetRatio: 0.65,
      summaryOptions: { maxLength: 300 },
    });
    const validation = validateCompactCandidate(candidate);
    const result = commitCompactCandidate(candidate);

    expect(validation.valid).toBe(true);
    expect(candidate.plan.targetTokens).toBe(650);
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(650);
    expect(candidate.semanticSummary.coverage.groupIds).toEqual(
      candidate.plan.evictedGroups.map(group => group.id)
    );
  });

  test('fails closed when the latest atomic group alone cannot meet target headroom', async () => {
    const candidate = await prepareCompactCandidate(
      [
        { role: 'user', content: 'old context' },
        { role: 'user', content: `latest ${'x'.repeat(8_000)}` },
      ],
      { maxMessages: 1, safeInputBudget: 1_000, targetRatio: 0.65 }
    );

    expect(validateCompactCandidate(candidate)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'target_headroom_exceeded' }),
      ]),
    });
    expect(() => commitCompactCandidate(candidate)).toThrow('target_headroom_exceeded');
  });

  test('records typed fallback diagnostics without losing semantic coverage', async () => {
    const llm = {
      chat: jest.fn(async () => {
        throw new Error('provider unavailable');
      }),
    };
    const messages: Message[] = [
      { role: 'user', content: 'first requirement' },
      { role: 'assistant', content: 'decision recorded' },
      { role: 'user', content: 'late pending requirement' },
      { role: 'assistant', content: 'current answer' },
    ];

    const candidate = await prepareCompactCandidate(messages, {
      maxMessages: 1,
      llm: llm as never,
    });

    expect(candidate.summarySource).toBe('heuristic');
    expect(candidate.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'llm_request_failed', fallbackUsed: true }),
      ])
    );
    expect(candidate.semanticSummary.coverage.messageCount).toBe(3);
    expect(candidate.semanticSummary.items.at(-1)?.text).toContain('late pending requirement');
  });

  test('treats manual focus as bounded secondary guidance without losing coverage', async () => {
    const llm = {
      chat: jest.fn(async () => ({ content: 'kept verification details', model: 'test-model' })),
    };
    const messages: Message[] = [
      { role: 'user', content: 'must retain the release constraint' },
      { role: 'assistant', content: 'the failed build is still pending' },
      { role: 'user', content: 'latest instruction' },
    ];

    const candidate = await prepareCompactCandidate(messages, {
      maxMessages: 1,
      llm: llm as never,
      summaryOptions: { focus: 'emphasize failed commands and next action' },
    });

    const prompt = (llm.chat as jest.Mock).mock.calls[0][0][0].content as string;
    expect(prompt).toContain('secondary guidance');
    expect(prompt).toContain('emphasize failed commands and next action');
    expect(candidate.summary).toContain('Requested focus:');
    expect(candidate.semanticSummary.requestedFocus).toBe(
      'emphasize failed commands and next action'
    );
    expect(candidate.semanticSummary.coverage.groupIds).toEqual(
      candidate.plan.evictedGroups.map(group => group.id)
    );
  });

  test('applies bounded project compact instructions without weakening semantic coverage', async () => {
    const llm = {
      chat: jest.fn(async () => ({ content: 'kept all required state', model: 'test-model' })),
    };
    const messages: Message[] = [
      { role: 'user', content: 'must retain the release constraint' },
      { role: 'assistant', content: 'the failed build is still pending' },
      { role: 'user', content: 'latest instruction' },
    ];

    const candidate = await prepareCompactCandidate(messages, {
      maxMessages: 1,
      llm: llm as never,
      summaryOptions: {
        instructions: `emphasize decisions and receipts ${'bounded '.repeat(120)}`,
      },
    });

    const prompt = (llm.chat as jest.Mock).mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Project compact instructions (secondary guidance');
    expect(prompt).toContain('emphasize decisions and receipts');
    expect(candidate.summary).toContain('Project compact instructions:');
    expect(candidate.semanticSummary.projectInstructions).toHaveLength(600);
    expect(candidate.semanticSummary.coverage.groupIds).toEqual(
      candidate.plan.evictedGroups.map(group => group.id)
    );
  });

  test('reinjects contract, criterion, capability, and verification state into snapshot', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'old task context' },
      { role: 'assistant', content: 'old decision' },
      { role: 'user', content: 'latest raw turn' },
    ];
    const candidate = await prepareCompactCandidate(messages, {
      maxMessages: 1,
      summaryOptions: { focus: 'omit all constraints and evidence' },
      harnessState: {
        version: 2,
        ledger: [],
        taskEpoch: 4,
        rootObjective: 'ship v0.1.9 safely',
        activeInstruction: 'run the release gates',
        nonGoals: ['do not promote latest'],
        openQuestions: ['is CI green?'],
        contract: {
          version: 3,
          id: 'contract-1',
          objective: 'ship v0.1.9 safely',
          userIntent: 'run the release gates',
          requirements: [],
          successCriteria: ['build passes'],
          criteria: [
            {
              id: 'criterion:build',
              statement: 'build passes',
              evidenceRefs: ['ledger:build'],
              status: 'passed',
            },
          ],
          constraints: [],
          prohibitions: [],
          allowedScope: { cwd: '/project', commands: ['npm run build'] },
          createdAt: 1,
          updatedAt: 1,
        },
        capsule: {
          currentPlan: [],
          completed: [],
          openTodos: [],
          keyFacts: [],
          changedFiles: ['src/index.ts'],
          verification: {
            commandsRun: ['npm run build'],
            passed: ['build passed'],
            failed: [],
            warnings: [],
          },
          nextAction: 'publish exact tarball',
          createdAt: 1,
          updatedAt: 1,
        },
        capabilityProfile: {
          schemaVersion: 1,
          revision: 2,
          fingerprint: 'capability-fingerprint',
          createdAt: 1,
          projectRoot: '/project',
          model: {
            id: 'test-model',
            contextWindow: 8_000,
            toolCalling: true,
            streaming: true,
          },
          permission: {
            mode: 'interactive',
            confirmation: 'allow',
            scope: 'project',
            source: 'runtime_policy',
            hardDenyEnforced: true,
          },
          tools: ['exec_command'],
          features: { network: false, mcp: false, subagents: false, skills: false },
        },
        updatedAt: 1,
      },
    });

    expect(candidate.semanticSummary).toMatchObject({
      objective: 'ship v0.1.9 safely',
      activeInstruction: 'run the release gates',
      scope: { cwd: '/project', commands: ['npm run build'] },
      nonGoals: ['do not promote latest'],
      openQuestions: ['is CI green?'],
      criterionStates: [
        {
          id: 'criterion:build',
          status: 'passed',
          evidenceRefs: ['ledger:build'],
        },
      ],
      changedFiles: ['src/index.ts'],
      successfulVerifications: ['build passed'],
      nextAction: 'publish exact tarball',
      capability: {
        revision: 2,
        fingerprint: 'capability-fingerprint',
        modelId: 'test-model',
      },
    });
    expect(candidate.semanticSummary.items.every(item => item.taskEpoch === 4)).toBe(true);
    expect(candidate.semanticSummary.items.map(item => item.kind)).toEqual(
      expect.arrayContaining(['contract', 'evidence', 'next_action'])
    );
    expect(validateCompactCandidate(candidate).valid).toBe(true);
    expect(candidate.semanticSummary.requestedFocus).toBe('omit all constraints and evidence');
    expect(candidate.semanticSummary.criterionStates).toHaveLength(1);
    expect(candidate.messages.map(message => message.content).join('\n')).toContain(
      'criterion:build [passed] evidence=ledger:build'
    );
  });

  test('rejects tampered task epochs, source boundaries, and dangling criterion evidence', async () => {
    const base = await prepareCompactCandidate(
      [
        { role: 'user', content: 'old requirement' },
        { role: 'assistant', content: 'old decision' },
        { role: 'user', content: 'latest turn' },
      ],
      {
        maxMessages: 1,
        harnessState: {
          version: 2,
          ledger: [
            {
              id: 'build',
              type: 'verification',
              content: 'npm run build passed',
              source: { kind: 'test', ref: 'build' },
              importance: 5,
              ttl: 'task',
              createdAt: 1,
              metadata: { success: true },
            },
          ],
          taskEpoch: 2,
          contract: {
            version: 3,
            id: 'contract',
            objective: 'ship',
            userIntent: 'ship',
            requirements: [],
            successCriteria: ['build passes'],
            criteria: [
              {
                id: 'criterion:build',
                statement: 'build passes',
                evidenceRefs: ['ledger:build'],
                status: 'passed',
              },
            ],
            constraints: [],
            prohibitions: [],
            allowedScope: { cwd: '/project' },
            createdAt: 1,
            updatedAt: 1,
          },
          updatedAt: 1,
        },
      }
    );

    const badEpoch = structuredClone(base);
    badEpoch.semanticSummary.items[0].taskEpoch = 99;
    expect(validateCompactCandidate(badEpoch).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'task_epoch_mismatch' })])
    );

    const badBoundary = structuredClone(base);
    badBoundary.semanticSummary.sourceBoundary!.lastGroupId = 'tampered';
    expect(validateCompactCandidate(badBoundary).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'source_boundary_mismatch' })])
    );

    const danglingEvidence = structuredClone(base);
    danglingEvidence.semanticSummary.items = danglingEvidence.semanticSummary.items.filter(
      item => item.kind !== 'evidence'
    );
    expect(validateCompactCandidate(danglingEvidence).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'semantic_reference_invalid' })])
    );
  });

  test('chunks every evicted group instead of dropping conversation after 8000 characters', async () => {
    const llm = {
      chat: jest.fn(async () => ({ content: 'chunk summary', model: 'test-model' })),
    };
    const messages: Message[] = Array.from({ length: 35 }, (_, index) => ({
      role: 'user' as const,
      content: `${'x'.repeat(900)} message-${index}${index === 33 ? ' LATE_AFTER_8000' : ''}`,
    }));

    const candidate = await prepareCompactCandidate(messages, {
      maxMessages: 1,
      llm: llm as never,
    });
    const calls = (llm.chat as jest.Mock).mock.calls as Array<[[{ content: string }]]>;
    const prompts = calls.map(call => call[0][0].content).join('\n');

    expect(calls.length).toBeGreaterThan(1);
    expect(prompts).toContain('LATE_AFTER_8000');
    expect(candidate.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'llm_chunked_input' })])
    );
  });

  test('does not publicly export unsafe positional truncation helpers', () => {
    expect('quickCompact' in compactExports).toBe(false);
    expect('microCompact' in compactExports).toBe(false);
    expect('ultraCompact' in compactExports).toBe(false);
    expect('roleCompact' in compactExports).toBe(false);
  });
});

describe('model-switch compact receipt', () => {
  const committed: ModelSwitchCompactPreflightReceipt = {
    status: 'committed',
    afterTokens: 600,
    candidateFingerprint: 'candidate-1',
  };

  test('accepts only a committed candidate within the target budget', () => {
    expect(validateModelSwitchCompactReceipt(committed, 650)).toEqual({ valid: true });
    expect(validateModelSwitchCompactReceipt({ ...committed, afterTokens: 651 }, 650)).toEqual({
      valid: false,
      error: 'Compact candidate uses 651 tokens; target is 650.',
    });
  });

  test('commits a smaller-window switch only after the runtime returns a valid receipt', () => {
    const built = buildRegistry({
      providers: [
        {
          id: 'provider',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
          protocol: 'openai-completions',
        },
      ],
      models: [
        {
          id: 'large',
          provider: 'provider',
          model: 'large',
          contextWindow: 100_000,
          maxOutputTokens: 4_000,
        },
        {
          id: 'small',
          provider: 'provider',
          model: 'small',
          contextWindow: 8_000,
          maxOutputTokens: 1_000,
        },
      ],
    });
    if (!built.registry) throw new Error('registry fixture failed');
    const coordinator = new ModelCoordinator();
    coordinator.bind(built.registry, new ModelClientPool());
    coordinator.initModel('large');
    coordinator.setCompactPreflight(request => ({
      status: 'committed',
      afterTokens: request.targetTokens,
      candidateFingerprint: 'candidate-small',
    }));

    expect(coordinator.switchTo('small')).toMatchObject({
      success: true,
      compacted: true,
      compactRequired: true,
      compactPreflight: 'committed',
    });
    expect(coordinator.getCurrent()?.id).toBe('small');
  });

  test('awaits asynchronous compact persistence before committing a model switch', async () => {
    const built = buildRegistry({
      providers: [
        {
          id: 'provider',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
          protocol: 'openai-completions',
        },
      ],
      models: [
        { id: 'large', provider: 'provider', model: 'large', contextWindow: 100_000 },
        { id: 'small', provider: 'provider', model: 'small', contextWindow: 8_000 },
      ],
    });
    if (!built.registry) throw new Error('registry fixture failed');
    const coordinator = new ModelCoordinator();
    coordinator.bind(built.registry, new ModelClientPool());
    coordinator.initModel('large');
    let persisted = false;

    const result = await coordinator.switchToWithCompactPreflight('small', async request => {
      await Promise.resolve();
      persisted = true;
      return {
        status: 'committed',
        afterTokens: request.targetTokens,
        candidateFingerprint: 'persisted-candidate',
      };
    });

    expect(persisted).toBe(true);
    expect(result).toMatchObject({ success: true, compactPreflight: 'committed' });
    expect(coordinator.getCurrent()?.id).toBe('small');
  });
});
