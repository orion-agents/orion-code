import {
  createHarnessTestRig,
  createRuntimeContributors,
  createRuntimeServices,
  emptyRuntimeContributorSlots,
  runRuntimeContributorLane,
  RuntimeContributorError,
  type RuntimeContributor,
  type RuntimeContributorSlots,
  type RuntimeServicePort,
  type RuntimeServiceSlots,
} from '../src/runtime/runtime-services';
import { ResourceScope } from '../src/runtime/resource-scope';
import { createTaskContextService } from '../src/runtime/task-context-service';

function createServiceSlots(): RuntimeServiceSlots & {
  models: RuntimeServicePort & { calls: number };
} {
  const port = (serviceId: string): RuntimeServicePort => ({ serviceId });
  return {
    models: { serviceId: 'models', calls: 0 },
    threads: port('threads'),
    policy: port('policy'),
    execution: port('execution'),
    tools: port('tools'),
    prompts: port('prompts'),
    skills: port('skills'),
    mcp: port('mcp'),
    taskContext: createTaskContextService({ cwd: '/repo', modelId: 'test-model' }),
    capabilities: port('capabilities'),
    events: port('events'),
    subagents: port('subagents'),
  };
}

function contributor(
  id: string,
  order: number,
  contribute: RuntimeContributor['contribute'] = () => id,
  failurePolicy: RuntimeContributor['failurePolicy'] = 'isolate',
  deadlineMs = 100
): RuntimeContributor {
  return { id, order, contribute, failurePolicy, deadlineMs };
}

function contributorsFor(
  lane: keyof RuntimeContributorSlots,
  contributors: RuntimeContributor[]
): RuntimeContributorSlots {
  return { ...emptyRuntimeContributorSlots(), [lane]: contributors };
}

describe('v0.2.0 static runtime composition', () => {
  test('requires every explicit service slot and freezes only the composition', () => {
    const slots = createServiceSlots();
    const services = createRuntimeServices(slots);

    expect(Object.isFrozen(services)).toBe(true);
    expect(Object.isFrozen(services.models)).toBe(false);
    services.models.calls++;
    expect(services.models.calls).toBe(1);
    expect(() =>
      createRuntimeServices({ models: { serviceId: 'models' } } as unknown as RuntimeServiceSlots)
    ).toThrow('Runtime service slot threads');
  });

  test('orders and freezes contributor lanes with globally stable ids', () => {
    const contributors = createRuntimeContributors(
      contributorsFor('context', [
        contributor('later', 20),
        contributor('same-z', 10),
        contributor('same-a', 10),
      ])
    );

    expect(contributors.context.map(item => item.id)).toEqual(['same-a', 'same-z', 'later']);
    expect(Object.isFrozen(contributors)).toBe(true);
    expect(Object.isFrozen(contributors.context)).toBe(true);
    expect(Object.isFrozen(contributors.context[0])).toBe(true);

    const duplicate: RuntimeContributorSlots = {
      ...emptyRuntimeContributorSlots(),
      context: [contributor('duplicate', 1)],
      prompt: [contributor('duplicate', 2)],
    };
    expect(() => createRuntimeContributors(duplicate)).toThrow(
      'Duplicate runtime contributor id: duplicate'
    );
  });

  test('isolates observer failures and continues deterministic execution', async () => {
    const contributors = createRuntimeContributors(
      contributorsFor('prompt', [
        contributor('broken-observer', 1, () => {
          throw new Error('observer failed');
        }),
        contributor('healthy-observer', 2, input => `observed:${String(input)}`),
      ])
    );
    const scope = new ResourceScope({ id: 'isolated-contributors' });

    const result = await runRuntimeContributorLane(contributors, 'prompt', 'turn-1', scope);

    expect(result.values).toEqual([{ id: 'healthy-observer', value: 'observed:turn-1' }]);
    expect(result.failures).toEqual([
      expect.objectContaining({ id: 'broken-observer', timedOut: false }),
    ]);
    await scope.close();
  });

  test('enforces contributor deadlines and required failure policy', async () => {
    const timed = createRuntimeContributors(
      contributorsFor('tools', [
        contributor('hung-observer', 1, () => new Promise(() => undefined), 'isolate', 10),
        contributor('after-timeout', 2),
      ])
    );
    const timedScope = new ResourceScope({ id: 'timed-contributors' });
    const timedResult = await runRuntimeContributorLane(timed, 'tools', {}, timedScope);
    expect(timedResult.failures).toEqual([
      expect.objectContaining({ id: 'hung-observer', timedOut: true }),
    ]);
    expect(timedResult.values.map(value => value.id)).toEqual(['after-timeout']);
    await timedScope.close();

    const required = createRuntimeContributors(
      contributorsFor('turnLifecycle', [
        contributor(
          'required-authority',
          1,
          () => {
            throw new Error('authority unavailable');
          },
          'required'
        ),
        contributor('must-not-run', 2),
      ])
    );
    const requiredScope = new ResourceScope({ id: 'required-contributors' });
    await expect(
      runRuntimeContributorLane(required, 'turnLifecycle', {}, requiredScope)
    ).rejects.toBeInstanceOf(RuntimeContributorError);
    await requiredScope.close();
  });

  test('Harness Test Rig owns a bounded scope and frozen composition', async () => {
    const rig = createHarnessTestRig({
      services: createServiceSlots(),
      contributors: contributorsFor('context', [contributor('context-one', 1)]),
      scopeOptions: { id: 'harness-test-rig' },
    });

    expect(Object.isFrozen(rig.services)).toBe(true);
    expect(await rig.run('context', null)).toMatchObject({
      values: [{ id: 'context-one', value: 'context-one' }],
      failures: [],
    });
    expect(await rig.close()).toMatchObject({ scopeId: 'harness-test-rig', timedOut: false });
    expect(rig.scope.state).toBe('closed');
  });
});
