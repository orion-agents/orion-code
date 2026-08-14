import { findCommand, getCommands, getVisibleCommands } from '../src/commands';
import { isBuiltinCommandName, registerBuiltinCommands } from '../src/commands/registry';
import type { SlashCommand } from '../src/commands/types';
import { createCommandPickerState } from '../src/runtime/ui-view-model';

describe('v0.1.5 command descriptor contract', () => {
  it('reserves canonical names and aliases from extension shadowing', () => {
    expect(isBuiltinCommandName('goal')).toBe(true);
    expect(isBuiltinCommandName('target')).toBe(true);
    expect(isBuiltinCommandName('reasoning')).toBe(true);
    expect(isBuiltinCommandName('not-a-builtin')).toBe(false);
  });

  it('replaces the reserved-name snapshot without leaking aliases across registrations', () => {
    const definitions = getCommands().map(command => ({ ...command })) as SlashCommand[];
    const temporaryAlias = 'temporary-test-alias';
    const withTemporaryAlias = definitions.map((command, index) =>
      index === 0 ? { ...command, aliases: [...(command.aliases ?? []), temporaryAlias] } : command
    );

    try {
      registerBuiltinCommands(withTemporaryAlias);
      expect(isBuiltinCommandName(temporaryAlias)).toBe(true);
      registerBuiltinCommands(definitions);
      expect(isBuiltinCommandName(temporaryAlias)).toBe(false);
    } finally {
      registerBuiltinCommands(definitions);
    }
  });

  it('registers complete, unique, lower-kebab built-in descriptors', () => {
    const commands = getCommands();
    expect(commands.length).toBeGreaterThan(0);
    expect(new Set(commands.map(command => command.id)).size).toBe(commands.length);

    for (const command of commands) {
      expect(command.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(command.id).toMatch(/^builtin\./u);
      expect(command.source).toEqual({ kind: 'builtin', id: 'orion-code', trust: 'core' });
      expect(command.audience).toMatch(/^(primary|advanced|compatibility|internal)$/u);
      expect(command.sideEffects.length).toBeGreaterThan(0);
      expect(command.busyPolicy).toMatch(/^(immediate|queue-next|reject-busy)$/u);
      expect(command.defaultAction).toBeTruthy();
      expect(command.lifecycle.status).toMatch(/^(stable|deprecated|internal)$/u);
      expect(command.argumentSchema.kind).toMatch(/^(none|raw|subcommands)$/u);
    }
  });

  it('uses /goal as the stable root and resolves /target to the same id', () => {
    expect(findCommand('goal')).toMatchObject({
      id: 'builtin.workflow.goal',
      name: 'goal',
      compatibilityAliases: [
        expect.objectContaining({
          name: 'target',
          lifecycle: expect.objectContaining({ replacement: '/goal' }),
        }),
      ],
    });
    expect(findCommand('target')).toBe(findCommand('goal'));
    expect(getVisibleCommands().some(command => command.name === 'target')).toBe(false);
  });

  it('keeps compatibility and internal roots out of help/completion surfaces', () => {
    const visible = getVisibleCommands();
    expect(
      visible.every(command => !['compatibility', 'internal'].includes(command.audience))
    ).toBe(true);
    expect(visible.some(command => command.name === 'sessions')).toBe(false);
    expect(visible.some(command => command.name === 'redraw')).toBe(false);
  });

  it('limits the empty palette to primary roots and discovers advanced roots by search', () => {
    const commands = getVisibleCommands('tui');
    const empty = createCommandPickerState({ input: '/', commands });
    expect(empty.totalItems).toBeLessThanOrEqual(12);
    expect(empty.visibleItems.every(item => item.command.audience === 'primary')).toBe(true);

    const searched = createCommandPickerState({ input: '/secur', commands });
    expect(searched.visibleItems.some(item => item.value === 'security')).toBe(true);
    expect(searched.visibleItems.some(item => item.command.audience === 'compatibility')).toBe(
      false
    );
  });

  it('filters 200 local descriptors within the deterministic 50ms budget', () => {
    const prototype = findCommand('status')!;
    const commands = Array.from({ length: 200 }, (_, index) => ({
      ...prototype,
      id: `plugin.test.command-${index}`,
      name: `command-${index}`,
      description: `Local command number ${index}`,
      aliases: [`c-${index}`],
      source: { kind: 'plugin' as const, id: 'test', trust: 'project' as const },
      audience: 'advanced' as const,
    }));
    const startedAt = performance.now();
    const state = createCommandPickerState({ input: '/number 199', commands });
    const elapsed = performance.now() - startedAt;
    expect(state.visibleItems.some(item => item.value === 'command-199')).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});
