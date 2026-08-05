import { AgentRuntimeController, type AgentRuntimeRunner } from '../src/runtime/agent-runtime-controller';
import type { OpenHorseUiRuntime, TranscriptAppendEntry, UiEventSink } from '../src/runtime/ui-events';

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

/**
 * A runner whose runInput never resolves until we trigger the abort, so the
 * controller keeps an active turn and `hasActiveTurn()` stays true. This lets
 * us submit incremental input *while* a turn is running.
 */
function buildController() {
  const runtime = createRuntime();
  const { events, appended, statuses } = createEvents();
  let activeAbort: AbortSignal | undefined;
  const runner: AgentRuntimeRunner = {
    runInput: jest.fn((_input: string, opts?: { abortSignal?: AbortSignal }) => {
      activeAbort = opts?.abortSignal;
      return new Promise<void>(() => {
        // never resolves on its own; we abort via the signal to end the turn.
      });
    }),
  } as unknown as AgentRuntimeRunner;
  const controller = new AgentRuntimeController({ runtime, events, runner });
  return {
    runtime,
    controller,
    appended,
    statuses,
    abortActiveTurn: () => activeAbort?.dispatchEvent(new Event('abort')),
  };
}

describe('incremental input while a turn is running (v0.1.3)', () => {
  it('G1: echoes the incremental input immediately on submit (before the turn aborts)', () => {
    const { controller, appended, statuses, abortActiveTurn } = buildController();

    // Start a normal turn; it stays "running" because the mock runner never resolves.
    controller.submit('删除讯飞模型');
    expect(controller.submit('其实在 ~/.orion-code/orion.json').type).toBe('revision_requested');

    // The incremental input must already be in the transcript, immediately.
    const echoed = appended.find(e => e.content === '其实在 ~/.orion-code/orion.json');
    expect(echoed).toBeDefined();
    expect(echoed?.role).toBe('user');
    // And the status must reflect the new "received" wording.
    expect(statuses.some(s => s.includes('已接收补充'))).toBe(true);

    // End the turn so the test process does not hang.
    abortActiveTurn();
  });

  it('G2: accumulates multiple incremental inputs instead of keeping only the last', () => {
    const { controller, abortActiveTurn } = buildController();

    controller.submit('原始指令');
    expect(controller.submit('补充A').type).toBe('revision_requested');
    expect(controller.submit('补充B').type).toBe('revision_requested');

    const snapshot = (controller as unknown as { turnController: { getSnapshot(): { pendingRevision?: string } } })
      .turnController.getSnapshot();
    expect(snapshot.pendingRevision).toBe('补充A\n补充B');

    abortActiveTurn();
  });

  it('G1: does not re-echo the revision when the next turn starts (no duplicate entry)', async () => {
    const { controller, appended, abortActiveTurn } = buildController();

    controller.submit('原始指令');
    controller.submit('补充X');

    // Capture how many times the revision text appears before the turn restarts.
    const beforeRestart = appended.filter(e => e.content === '补充X').length;
    expect(beforeRestart).toBe(1); // echoed once at submit time

    // Abort the running turn; the controller restarts with the revision.
    abortActiveTurn();
    // Allow the restart turn (and its never-resolving runner) to begin.
    await new Promise(r => setTimeout(r, 50));

    const afterRestart = appended.filter(e => e.content === '补充X').length;
    expect(afterRestart).toBe(1); // still exactly once → no double echo
  });
});
