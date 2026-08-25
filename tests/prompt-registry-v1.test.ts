import {
  PromptBudgetExceededError,
  PromptRegistryError,
  PromptRegistryV1,
  digestPromptSource,
  verifyPromptAssemblyReceipt,
  type PromptAssemblyRequestV1,
  type PromptContributorInputsV1,
  type PromptSectionInputV1,
} from '../src/runtime/prompts';
import { estimateTokens } from '../src/utils/token-estimate';

function section(id: string, overrides: Partial<PromptSectionInputV1> = {}): PromptSectionInputV1 {
  return {
    id,
    authority: 'system',
    source: {
      id: `source:${id}`,
      digest: digestPromptSource({ id, revision: 1 }),
    },
    priority: 50,
    tokenBudget: 100,
    mandatory: false,
    atomic: true,
    dynamic: false,
    cacheability: 'cacheable',
    redaction: 'secrets',
    content: `content:${id}`,
    ...overrides,
  };
}

function assemble(contributors: PromptContributorInputsV1, hardTokenBudget = 10_000) {
  return new PromptRegistryV1().assemble({ hardTokenBudget, contributors });
}

describe('Prompt Registry v1', () => {
  test('accepts every first-party contributor slot and assembles in deterministic order', () => {
    const contributors: PromptContributorInputsV1 = {
      taskContext: [section('task', { priority: 90, mandatory: true })],
      skill: [section('skill', { priority: 70 })],
      memory: [section('memory', { priority: 60 })],
      project: [section('project', { priority: 80 })],
      goal: [section('goal', { priority: 50, dynamic: true })],
      subagent: [
        section('subagent', {
          priority: 40,
          dynamic: true,
          cacheability: 'non_cacheable',
        }),
      ],
      mode: [section('mode', { priority: 30, dynamic: true })],
    };

    const first = assemble(contributors);
    const second = assemble({
      ...contributors,
      skill: [...(contributors.skill ?? [])].reverse(),
      project: [...(contributors.project ?? [])].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.sections.map(item => item.id)).toEqual([
      'task',
      'project',
      'skill',
      'memory',
      'goal',
      'subagent',
      'mode',
    ]);
    expect(new Set(first.sections.map(item => item.contributor))).toEqual(
      new Set(['task_context', 'skill', 'memory', 'project', 'goal', 'subagent', 'mode'])
    );
    expect(Object.isFrozen(first.receipt)).toBe(true);
  });

  test('fails closed when one mandatory atomic section exceeds its section budget', () => {
    const mandatory = section('mandatory', {
      mandatory: true,
      content: 'This mandatory section cannot be truncated.',
      tokenBudget: 1,
    });

    expect(() => assemble({ taskContext: [mandatory] })).toThrow(PromptBudgetExceededError);
    try {
      assemble({ taskContext: [mandatory] });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'ORION_PROMPT_BUDGET_EXCEEDED',
        sectionId: 'mandatory',
        availableTokens: 1,
      });
    }
  });

  test('fails closed when mandatory sections exceed the assembly hard budget', () => {
    const first = section('mandatory-a', { mandatory: true, content: 'alpha' });
    const second = section('mandatory-b', { mandatory: true, content: 'beta' });
    const required = estimateTokens('alpha\n\nbeta');

    expect(() => assemble({ taskContext: [first, second] }, required - 1)).toThrow(
      expect.objectContaining({
        sectionId: undefined,
        requiredTokens: required,
        availableTokens: required - 1,
      })
    );
  });

  test('selects optional sections by priority and records every omission reason', () => {
    const mandatory = section('mandatory', {
      mandatory: true,
      priority: 1,
      content: 'must',
    });
    const high = section('high', { priority: 100, content: 'high' });
    const low = section('low', { priority: 10, content: 'low' });
    const oversized = section('oversized', {
      priority: 200,
      content: 'too large for its section',
      tokenBudget: 1,
    });
    const disabled = section('disabled', {
      enabled: false,
      omissionReason: 'authority_denied',
    });
    const budget = estimateTokens('high\n\nmust');

    const result = assemble(
      { taskContext: [mandatory], skill: [low, high, oversized, disabled] },
      budget
    );

    expect(result.receipt.selectedSectionIds).toEqual(['high', 'mandatory']);
    expect(result.receipt.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mandatory', selected: true, reason: 'mandatory' }),
        expect.objectContaining({ id: 'high', selected: true, reason: 'selected_by_priority' }),
        expect.objectContaining({
          id: 'oversized',
          selected: false,
          reason: 'section_token_budget_exceeded',
        }),
        expect.objectContaining({
          id: 'disabled',
          selected: false,
          reason: 'authority_denied',
        }),
        expect.objectContaining({
          id: 'low',
          selected: false,
          reason: 'global_token_budget_exceeded',
        }),
      ])
    );
    expect(result.receipt.estimatedTokens).toBeLessThanOrEqual(budget);
  });

  test('keeps dynamic content outside the cacheable prefix even when declared cacheable', () => {
    const stable = section('stable', { content: 'stable instructions', priority: 10 });
    const dynamic = section('dynamic', {
      content: 'turn-specific state',
      priority: 100,
      dynamic: true,
      cacheability: 'cacheable',
    });

    const result = assemble({ project: [stable], taskContext: [dynamic] });

    expect(result.sections.map(item => item.id)).toEqual(['stable', 'dynamic']);
    expect(result.cacheablePrefix.sectionIds).toEqual(['stable']);
    expect(result.cacheablePrefix.text).toBe('stable instructions');
    expect(result.text).toContain('turn-specific state');
    expect(result.receipt.sections.find(item => item.id === 'dynamic')).toMatchObject({
      dynamic: true,
      cacheability: 'cacheable',
      cacheablePrefix: false,
    });

    const changedDynamic = assemble({
      project: [stable],
      taskContext: [{ ...dynamic, content: 'different turn-specific state' }],
    });
    expect(changedDynamic.cacheablePrefix.digest).toBe(result.cacheablePrefix.digest);
    expect(changedDynamic.receipt.promptDigest).not.toBe(result.receipt.promptDigest);
  });

  test('redacts secrets from model-visible text and never stores text or absolute paths in receipt', () => {
    const secret = 'sk-1234567890ABCDEFGHIJ';
    const absolutePath = '/Users/hope/private/project.txt';
    const input = section('redacted', {
      content: `OPENAI_API_KEY=${secret}\nworkspace=${absolutePath}`,
      dynamic: true,
    });

    const result = assemble({ project: [input] });
    const serializedReceipt = JSON.stringify(result.receipt);

    expect(result.text).toContain('[REDACTED_SECRET]');
    expect(result.text).not.toContain(secret);
    expect(result.sections[0].redactionApplied).toBe(true);
    expect(serializedReceipt).not.toContain(secret);
    expect(serializedReceipt).not.toContain(absolutePath);
    expect(serializedReceipt).not.toContain('OPENAI_API_KEY');
    expect(serializedReceipt).not.toContain('content:');
    expect(result.receipt.sections[0].contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      assemble({
        project: [
          section('unsafe-source', {
            source: { id: absolutePath, digest: digestPromptSource(absolutePath) },
          }),
        ],
      })
    ).toThrow('safe stable id');
    expect(() =>
      assemble({ project: [{ ...input, id: 'unredacted', redaction: 'none' }] })
    ).toThrow('disables redaction');
  });

  test('binds content and source revisions into separate deterministic digests', () => {
    const registry = new PromptRegistryV1();
    const original = section('digest', { content: 'same prompt' });
    const same = registry.assemble({ hardTokenBudget: 100, contributors: { mode: [original] } });
    const contentChanged = registry.assemble({
      hardTokenBudget: 100,
      contributors: { mode: [{ ...original, content: 'changed prompt' }] },
    });
    const sourceChanged = registry.assemble({
      hardTokenBudget: 100,
      contributors: {
        mode: [
          {
            ...original,
            source: { ...original.source, digest: digestPromptSource({ revision: 2 }) },
          },
        ],
      },
    });

    expect(same.receipt.promptDigest).not.toBe(contentChanged.receipt.promptDigest);
    expect(same.receipt.digest).not.toBe(contentChanged.receipt.digest);
    expect(same.receipt.promptDigest).toBe(sourceChanged.receipt.promptDigest);
    expect(same.receipt.digest).not.toBe(sourceChanged.receipt.digest);
    expect(() => verifyPromptAssemblyReceipt(same.receipt)).not.toThrow();
    expect(() =>
      verifyPromptAssemblyReceipt({
        ...same.receipt,
        estimatedTokens: same.receipt.estimatedTokens + 1,
      })
    ).toThrow('digest mismatch');
  });

  test('rejects duplicate ids and non-atomic v1 sections deterministically', () => {
    const duplicate = section('duplicate');
    expect(() => assemble({ taskContext: [duplicate], goal: [{ ...duplicate }] })).toThrow(
      'Duplicate Prompt section id'
    );
    expect(() => assemble({ mode: [section('splittable', { atomic: false })] })).toThrow(
      PromptRegistryError
    );
  });

  test('identical input produces byte-identical assembly and receipt JSON', () => {
    const request: PromptAssemblyRequestV1 = {
      hardTokenBudget: 500,
      contributors: {
        project: [section('project', { content: 'project instructions', priority: 80 })],
        taskContext: [
          section('context', {
            content: 'current task context',
            priority: 100,
            dynamic: true,
          }),
        ],
      },
    };
    const registry = new PromptRegistryV1();

    const first = registry.assemble(request);
    const second = registry.assemble(structuredClone(request));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.receipt.digest).toBe(second.receipt.digest);
    expect(first.cacheablePrefix.digest).toBe(second.cacheablePrefix.digest);
  });
});
