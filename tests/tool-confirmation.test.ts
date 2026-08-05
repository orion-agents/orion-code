import { AgentRuntimeController, type AgentRuntimeRunner } from '../src/runtime/agent-runtime-controller';
import type { OpenHorseUiRuntime, TranscriptAppendEntry, UiEventSink } from '../src/runtime/ui-events';
import * as globalConfig from '../src/services/global-config';

function createRuntime(overrides: Partial<OpenHorseUiRuntime> = {}): OpenHorseUiRuntime {
  return {
    cwd: '/tmp/openhorse',
    version: 'test',
    config: { model: 'test-model' } as OpenHorseUiRuntime['config'],
    store: { setProcessing: jest.fn() } as unknown as OpenHorseUiRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseUiRuntime['runtime'],
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
  let updateGlobalConfigSpy: jest.SpyInstance;

  beforeEach(() => {
    // updateGlobalConfig writes ~/.orion-code/orion.json; stub it to avoid touching disk.
    updateGlobalConfigSpy = jest
      .spyOn(globalConfig, 'updateGlobalConfig')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildController(toolConfirmation: 'allow' | 'ask' | 'deny') {
    const runtime = createRuntime({
      config: { model: 'test-model', toolConfirmation } as OpenHorseUiRuntime['config'],
    });
    const { events } = createEvents();
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => {}),
    } as unknown as AgentRuntimeRunner;
    const controller = new AgentRuntimeController({ runtime, events, runner });
    return { runtime, controller };
  }

  it('mutates runtime.config immediately and persists on valid change', () => {
    const { runtime, controller } = buildController('allow');

    const result = controller.handle({ type: 'permission_mode_change', value: 'ask', source: 'command' });

    expect(result).toEqual({ type: 'permission_mode_changed' });
    // Live mutation: chat-controller passes this.runtime.config.toolConfirmation into the
    // scheduler on every tool call, so the next call uses the new value without restart.
    expect(runtime.config.toolConfirmation).toBe('ask');
    // Persisted so the change survives restart.
    expect(updateGlobalConfigSpy).toHaveBeenCalledWith({ toolConfirmation: 'ask' });
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
    expect(updateGlobalConfigSpy).not.toHaveBeenCalled();
  });

  it('round-trips allow -> deny -> allow', () => {
    const { runtime, controller } = buildController('allow');

    expect(controller.handle({ type: 'permission_mode_change', value: 'deny' }).type).toBe(
      'permission_mode_changed'
    );
    expect(runtime.config.toolConfirmation).toBe('deny');

    expect(controller.handle({ type: 'permission_mode_change', value: 'allow' }).type).toBe(
      'permission_mode_changed'
    );
    expect(runtime.config.toolConfirmation).toBe('allow');
    expect(updateGlobalConfigSpy).toHaveBeenLastCalledWith({ toolConfirmation: 'allow' });
  });
});
