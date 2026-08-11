import {
  buildProviderEffortParams,
  resolveEffort,
  type ReasoningCapability,
} from '../src/services/effort';

const capability: ReasoningCapability = {
  kind: 'effort-level',
  supportedLevels: ['none', 'low', 'medium', 'high'],
  defaultLevel: 'medium',
  adapter: 'openai-chat-reasoning-effort',
  source: 'config',
};

describe('effort resolution', () => {
  it('resolves request, session, project, global, then provider default', () => {
    expect(
      resolveEffort({ request: 'high', session: 'low', project: 'medium', global: 'none', capability })
    ).toMatchObject({ requested: 'high', effective: 'high', source: 'request' });
    expect(resolveEffort({ session: 'low', project: 'medium', global: 'none', capability })).toMatchObject({
      requested: 'low',
      effective: 'low',
      source: 'session',
    });
    expect(resolveEffort({ session: 'auto', project: 'medium', global: 'none', capability })).toMatchObject({
      requested: 'medium',
      source: 'project',
    });
    expect(resolveEffort({ global: 'none', capability })).toMatchObject({
      requested: 'none',
      source: 'global',
    });
    expect(resolveEffort({ capability })).toMatchObject({
      requested: 'auto',
      effective: 'medium',
      source: 'model-default',
    });
  });

  it('does not infer support from an absent capability', () => {
    expect(resolveEffort({ session: 'high' })).toMatchObject({
      requested: 'high',
      supported: false,
      supportedLevels: [],
    });
  });

  it('sends an explicit OpenAI Chat effort but never sends auto or unsupported values', () => {
    const explicit = resolveEffort({ session: 'high', capability });
    expect(
      buildProviderEffortParams({
        protocol: 'openai-completions',
        capability,
        resolved: explicit,
      })
    ).toEqual({ reasoning_effort: 'high' });
    expect(
      buildProviderEffortParams({
        protocol: 'openai-completions',
        capability,
        resolved: resolveEffort({ session: 'auto', capability }),
      })
    ).toEqual({});
    expect(
      buildProviderEffortParams({
        protocol: 'openai-completions',
        capability,
        resolved: resolveEffort({ session: 'max', capability }),
      })
    ).toEqual({});
  });
});
