/**
 * v0.2.26 — ModelCoordinator unit tests.
 */

import { ModelCoordinator } from '../src/runtime/model-coordinator';
import { buildRegistry } from '../src/services/model-registry';
import { ModelClientPool } from '../src/services/model-client-pool';

describe('ModelCoordinator', () => {
  let coordinator: ModelCoordinator;
  let registry: ReturnType<typeof buildRegistry>['registry'];
  let pool: ModelClientPool;

  beforeEach(() => {
    coordinator = new ModelCoordinator();
    const result = buildRegistry({
      providers: [{ id: 'test-provider', baseUrl: 'https://test.example.com/v1', apiKey: 'sk-test', protocol: 'openai-completions' }],
      models: [{ id: 'test-model', provider: 'test-provider', model: 'test-model-v1' }],
    });
    if (!result.registry) throw new Error('Failed to build registry: ' + result.errors.map(e => e.message).join(', '));
    registry = result.registry;
    pool = new ModelClientPool();
    coordinator.bind(registry, pool);
  });

  it('returns error when not bound', () => {
    const unbound = new ModelCoordinator();
    expect(unbound.switchTo('any')).toEqual({
      success: false,
      error: 'ModelCoordinator not bound to a registry/pool.',
    });
  });

  it('returns error for unknown model', () => {
    expect(coordinator.switchTo('nonexistent')).toEqual({
      success: false,
      error: expect.stringContaining('Unknown model'),
    });
  });

  it('switches to a valid model', () => {
    const result = coordinator.switchTo('test-model');
    expect(result.success).toBe(true);
    expect(coordinator.getCurrent()?.id).toBe('test-model');
  });

  it('emits model_changed event on switch', () => {
    const events: any[] = [];
    coordinator.on('model_changed', (e) => events.push(e));
    coordinator.switchTo('test-model');
    expect(events.length).toBe(1);
    expect(events[0].toId).toBe('test-model');
    expect(events[0].fromId).toBeNull();
  });

  it('emits model_changed with from/to on second switch', () => {
    const events: any[] = [];
    coordinator.switchTo('test-model');
    coordinator.on('model_changed', (e) => events.push(e));
    // Build a second registry with two models.
    const result2 = buildRegistry({
      providers: [
        { id: 'test-provider', baseUrl: 'https://test.example.com/v1', apiKey: 'sk-test', protocol: 'openai-completions' as const },
        { id: 'provider-2', baseUrl: 'https://test2.example.com/v1', apiKey: 'sk-test2', protocol: 'openai-completions' as const },
      ],
      models: [
        { id: 'test-model', provider: 'test-provider', model: 'test-model-v1' },
        { id: 'model-2', provider: 'provider-2', model: 'model-2-v1' },
      ],
    });
    if (!result2.registry) throw new Error('Failed to build second registry');
    coordinator.bind(result2.registry, pool);
    coordinator.initModel('test-model');
    coordinator.switchTo('model-2');
    expect(events.length).toBe(2);
    // events[0] is from initModel, events[1] is from switchTo
    expect(events[1].toId).toBe('model-2');
    expect(events[1].fromId).toBe('test-model');
  });

  it('initModel sets the initial model', () => {
    const result = coordinator.initModel('test-model');
    expect(result.success).toBe(true);
    expect(coordinator.getCurrent()?.id).toBe('test-model');
  });

  it('initModel emits model_changed', () => {
    const events: any[] = [];
    coordinator.on('model_changed', (e) => events.push(e));
    coordinator.initModel('test-model');
    expect(events.length).toBe(1);
  });

  it('isSwitching returns true only during switch', () => {
    expect(coordinator.isSwitching()).toBe(false);
    coordinator.switchTo('test-model');
    expect(coordinator.isSwitching()).toBe(false); // switch is synchronous
  });
});