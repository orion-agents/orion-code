import { AgentModeLifecycleController } from '../src/framework/agent-mode';
import { Store } from '../src/framework/store';
import { getToolState, resetToolState } from '../src/framework/tool-state';
import { loadConfig } from '../src/services/config';

describe('AgentModeLifecycleController', () => {
  beforeEach(() => resetToolState());
  afterEach(() => resetToolState());

  function createLifecycle() {
    const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
    const store = new Store({ config, tools: [], currentModel: config.model });
    return { store, lifecycle: new AgentModeLifecycleController(store) };
  }

  it('cycles BUILD → PLAN → AUTO → BUILD and keeps Store/tool-state synchronized', () => {
    const { store, lifecycle } = createLifecycle();

    expect(lifecycle.cycle({ defer: false })).toEqual({
      baseMode: 'plan',
      pendingBaseMode: null,
    });
    expect(store.getSnapshot()).toMatchObject({ agentMode: 'plan', planMode: true });
    expect(getToolState()).toMatchObject({ planMode: true, planReturnMode: 'interactive' });

    expect(lifecycle.cycle({ defer: false }).baseMode).toBe('auto');
    expect(store.getSnapshot()).toMatchObject({ agentMode: 'auto', planMode: false });
    expect(lifecycle.cycle({ defer: false }).baseMode).toBe('interactive');
  });

  it('cycles from the pending mode and cancels pending when it returns to the current mode', () => {
    const { lifecycle } = createLifecycle();

    expect(lifecycle.cycle({ defer: true }).pendingBaseMode).toBe('plan');
    expect(lifecycle.cycle({ defer: true }).pendingBaseMode).toBe('auto');
    expect(lifecycle.cycle({ defer: true }).pendingBaseMode).toBeNull();
    expect(lifecycle.snapshot().baseMode).toBe('interactive');
  });

  it('saves a Plan and uses pending Auto for the execution phase', () => {
    const { store, lifecycle } = createLifecycle();
    lifecycle.setMode('plan');
    lifecycle.cycle({ defer: true });

    expect(lifecycle.completePlan('  implement safely  ', 'interactive')).toEqual({
      baseMode: 'auto',
      pendingBaseMode: null,
    });
    expect(store.getSnapshot()).toMatchObject({
      agentMode: 'auto',
      planMode: false,
      currentPlan: 'implement safely',
    });
    expect(lifecycle.completedPlanSince(0)).toBe('implement safely');
  });
});
