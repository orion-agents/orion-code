/**
 * Bug-hunt round 13 evidence: exit_plan_mode does not validate its plan arg.
 *
 * exit_plan_mode lists `plan` as required but never checks it is a non-empty
 * string. Calling it with undefined / empty / non-string stores undefined as
 * the current plan and reports success, so the UI and /resume see a "plan"
 * that is undefined or empty while plan mode is silently exited.
 */
import { resetToolState } from '../src/framework/tool-state';
import { getCurrentPlan, isInPlanMode } from '../src/tools/plan';

const TOOLS = require('../src/tools').TOOLS;
const exitPlan = TOOLS.find((t: any) => t.name === 'exit_plan_mode');
const enterPlan = TOOLS.find((t: any) => t.name === 'enter_plan_mode');

const ctx = { cwd: process.cwd(), config: { name: 'orion-code', mode: 'development' } };

describe('exit_plan_mode validation (bug-hunt round 13)', () => {
  beforeEach(() => {
    resetToolState();
    enterPlan.execute({}, ctx); // ensure we are in plan mode
  });
  afterEach(() => resetToolState());

  it('rejects a missing plan argument instead of saving undefined', async () => {
    const result = await exitPlan.execute({}, ctx);
    // Before the fix: success:true with "Plan saved:\n\nundefined".
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects an empty plan string', async () => {
    const result = await exitPlan.execute({ plan: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a non-string plan', async () => {
    const result = await exitPlan.execute({ plan: 42 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('stays in plan mode when the plan is invalid', async () => {
    await exitPlan.execute({}, ctx);
    expect(isInPlanMode()).toBe(true);
    expect(getCurrentPlan()).toBe('');
  });
});
