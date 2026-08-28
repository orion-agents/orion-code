import {
  AgentRuntimeController,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type {
  OrionCodeUiRuntime,
  TranscriptAppendEntry,
  UiEventSink,
} from '../src/runtime/ui-events';

function createRuntime(overrides: Partial<OrionCodeUiRuntime> = {}): OrionCodeUiRuntime {
  return {
    cwd: '/tmp/openhorse',
    version: 'test',
    config: { model: 'test-model' } as OrionCodeUiRuntime['config'],
    store: { setProcessing: jest.fn() } as unknown as OrionCodeUiRuntime['store'],
    llm: null,
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
    ...overrides,
  };
}

function createEvents() {
  const appended: TranscriptAppendEntry[] = [];
  const statuses: string[] = [];
  const events: UiEventSink = {
    append: jest.fn(entry => {
      appended.push(entry);
      return `entry-${appended.length}`;
    }),
    update: jest.fn(),
    finalize: jest.fn(),
    remove: jest.fn(),
    replaceTranscript: jest.fn(),
    clearTranscript: jest.fn(),
    setStatus: jest.fn(message => statuses.push(message)),
    showSessionPicker: jest.fn(),
    showEditPreview: jest.fn(),
    toolStarted: jest.fn(),
    toolFinished: jest.fn(),
    sessionRestored: jest.fn(),
    loopStatsUpdated: jest.fn(),
    traceEventRecorded: jest.fn(),
    harnessDiagnosticsUpdated: jest.fn(),
    goalEvent: jest.fn(),
    setProcessing: jest.fn(),
  };
  return { events, appended, statuses };
}

describe('tool confirmation policy (toolConfirmation) live switch', () => {
  function buildController(
    toolConfirmation: 'allow' | 'ask' | 'deny',
    update?: OrionCodeUiRuntime['updateSettings']
  ) {
    const runtime = createRuntime({
      config: { model: 'test-model', toolConfirmation } as OrionCodeUiRuntime['config'],
    });
    runtime.describeSettings = jest.fn(() => ({ revision: 'hmac-sha256:test-revision' }) as never);
    runtime.updateSettings =
      update ??
      jest.fn(async input => {
        const operation = input.operations[0];
        if (operation?.op === 'set' && operation.key === 'permissions.toolConfirmation') {
          runtime.config.toolConfirmation = operation.value;
        }
        return {} as never;
      });
    const { events, statuses } = createEvents();
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => {}),
    } as unknown as AgentRuntimeRunner;
    const controller = new AgentRuntimeController({ runtime, events, runner });
    return { runtime, controller, statuses };
  }

  it('reports success only after the durable Settings update commits', async () => {
    let commit!: () => void;
    const committed = new Promise<void>(resolve => {
      commit = resolve;
    });
    let runtime!: OrionCodeUiRuntime;
    const updateSettings = jest.fn(async input => {
      await committed;
      const operation = input.operations[0];
      if (operation?.op === 'set' && operation.key === 'permissions.toolConfirmation') {
        runtime.config.toolConfirmation = operation.value;
      }
      return {} as never;
    });
    const built = buildController('allow', updateSettings);
    runtime = built.runtime;

    const result = built.controller.handle({
      type: 'permission_mode_change',
      value: 'ask',
      source: 'command',
    });

    expect(result).toEqual({ type: 'started' });
    expect(runtime.config.toolConfirmation).toBe('allow');
    expect(built.statuses).not.toContain('Tool confirmation → ask');

    commit();
    await built.controller.waitForIdle();

    expect(runtime.config.toolConfirmation).toBe('ask');
    expect(built.statuses).toContain('Tool confirmation → ask');
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^runtime:permission-mode:/u),
        expectedRevision: 'hmac-sha256:test-revision',
        operations: [{ op: 'set', key: 'permissions.toolConfirmation', value: 'ask' }],
      })
    );
  });

  it('rejects invalid policy values without mutating or persisting', () => {
    const { runtime, controller } = buildController('allow');

    const result = controller.handle({
      type: 'permission_mode_change',
      value: 'bogus' as never,
      source: 'command',
    });

    expect(result).toEqual({ type: 'permission_mode_invalid' });
    expect(runtime.config.toolConfirmation).toBe('allow');
    expect(runtime.updateSettings).not.toHaveBeenCalled();
  });

  it('keeps the previous policy and omits success when persistence fails', async () => {
    const { runtime, controller, statuses } = buildController(
      'allow',
      jest.fn(async () => {
        throw new Error('CAS conflict');
      })
    );

    expect(controller.handle({ type: 'permission_mode_change', value: 'deny' })).toEqual({
      type: 'started',
    });
    await controller.waitForIdle();

    expect(runtime.config.toolConfirmation).toBe('allow');
    expect(statuses).not.toContain('Tool confirmation → deny');
    expect(statuses).toContain('Tool confirmation was not changed: CAS conflict');
  });
});
