/**
 * Phase 2 (P0-B) — Command registry contract tests.
 *
 * Validates that every registered slash command carries the metadata required by
 * the v0.1.1 command contract: execution classification, risk level, and
 * correctness of deprecation/availability/hidden signals.
 */

import { getCommands, findCommand, getVisibleCommands } from '../src/commands';
import type { SlashCommand, CommandRisk, CommandExecution } from '../src/commands/types';
import { DEFAULT_COMMAND_RISK } from '../src/commands/types';

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

describe('Command registry contract', () => {
  let all: SlashCommand[];
  let visible: SlashCommand[];

  beforeAll(() => {
    all = getCommands();
    visible = getVisibleCommands();
  });

  describe('registry integrity', () => {
    it('has at least one visible command per non-legacy category', () => {
      const categories = new Set(visible.map(c => c.category));
      // Every product-facing category must appear.
      for (const cat of [
        'workflow',
        'session',
        'context',
        'tools',
        'model',
        'system',
        'diagnostics',
      ] as const) {
        expect(categories.has(cat)).toBe(true);
      }
    });

    it('has no duplicate command names', () => {
      const names = all.map(c => c.name);
      expect(names.length).toBe(new Set(names).size);
    });

    it('aliases must not collide with other command names', () => {
      const nameSet = new Set(all.map(c => c.name));
      for (const cmd of all) {
        for (const alias of cmd.aliases ?? []) {
          expect(nameSet.has(alias)).toBe(false);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Metadata coverage — every command must carry execution + risk
  // -----------------------------------------------------------------------

  describe('metadata coverage', () => {
    it('every command has execution metadata', () => {
      const missing = all.filter(c => c.execution === undefined);
      expect(missing.map(c => c.name)).toEqual([]);
    });

    it('every command has risk metadata', () => {
      const missing = all.filter(c => c.risk === undefined);
      expect(missing.map(c => c.name)).toEqual([]);
    });

    it('no command relies on the implicit default risk', () => {
      // DEFAULT_COMMAND_RISK is a fallback for external command authors;
      // every built-in command must declare its risk explicitly.
      expect(DEFAULT_COMMAND_RISK).toBe('state-write');
      expect(all.every(command => command.source?.kind === 'builtin')).toBe(true);
      expect(
        all.filter(command => command.risk === undefined).map(command => command.name)
      ).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Execution classification
  // -----------------------------------------------------------------------

  describe('execution classification', () => {
    const valid: CommandExecution[] = ['builtin', 'agent-workflow', 'renderer-local'];

    it('all execution values are valid', () => {
      for (const cmd of all) {
        expect(valid).toContain(cmd.execution);
      }
    });

    it('chat-type commands are agent-workflow (not builtin)', () => {
      const chatCommands = all.filter(c => c.type === 'chat');
      for (const cmd of chatCommands) {
        expect(cmd.execution).toBe('agent-workflow');
      }
    });

    it('renderer-local commands declare a renderer scope', () => {
      const local = all.filter(c => c.execution === 'renderer-local');
      for (const cmd of local) {
        expect(cmd.rendererScope).toBeDefined();
        expect(cmd.rendererScope!.length).toBeGreaterThan(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Risk classification
  // -----------------------------------------------------------------------

  describe('risk classification', () => {
    const valid: CommandRisk[] = ['read-only', 'state-write', 'destructive'];

    it('all risk values are valid', () => {
      for (const cmd of all) {
        expect(valid).toContain(cmd.risk);
      }
    });

    it('read-only commands do not mutate state (semantic check)', () => {
      const readOnly = all.filter(c => c.risk === 'read-only');
      // At minimum these well-known query commands must be read-only.
      const names = new Set(readOnly.map(c => c.name));
      expect(names.has('status')).toBe(true);
      expect(names.has('help')).toBe(true);
      expect(names.has('doctor')).toBe(true);
      expect(names.has('diff')).toBe(true);
      expect(names.has('tools')).toBe(true);
    });

    it('destructive commands are explicitly marked', () => {
      const destructive = all.filter(c => c.risk === 'destructive');
      const names = new Set(destructive.map(c => c.name));
      // context clear, storage (repair/cleanup), rewind restore, migrate
      expect(names.has('context')).toBe(true);
      expect(names.has('storage')).toBe(true);
      expect(names.has('rewind')).toBe(true);
      expect(names.has('migrate')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Deprecation contract
  // -----------------------------------------------------------------------

  describe('deprecation contract', () => {
    it('deprecated commands have a replacement or removal window', () => {
      const deprecated = all.filter(c => c.deprecated !== undefined);
      for (const cmd of deprecated) {
        expect(cmd.deprecated!.since).toBeTruthy();
        // Must have either a replacement or a planned removal version.
        expect(
          cmd.deprecated!.replacement !== undefined || cmd.deprecated!.removeIn !== undefined
        ).toBe(true);
      }
    });

    it('deprecated aliases point to active commands', () => {
      const deprecated = all.filter(c => c.deprecated?.replacement !== undefined);
      const nameSet = new Set(all.map(c => c.name));
      for (const cmd of deprecated) {
        const replacement = cmd.deprecated!.replacement!.replace(/^\//, '');
        expect(nameSet.has(replacement)).toBe(true);
      }
    });

    it('/target is removed instead of retained as a compatibility alias', () => {
      const goal = findCommand('goal');
      expect(findCommand('target')).toBeUndefined();
      expect(goal?.name).toBe('goal');
    });

    it('/goal advertises only the v0.2 lifecycle controls', () => {
      const goal = findCommand('goal');
      expect(goal?.argumentHint).toBe('[objective | status | pause | resume | clear]');
      expect(goal?.argumentSchema).toMatchObject({
        kind: 'subcommands',
        subcommands: ['status', 'pause', 'resume', 'clear'],
      });
    });

    it('removes compatibility-only command roots from v0.2', () => {
      for (const name of [
        'sessions',
        'session-rename',
        'context-clear',
        'clear-history',
        'models',
        'loop-stats',
        'checkpoint',
        'cost',
        'commit',
      ]) {
        expect(findCommand(name)).toBeUndefined();
      }
    });

    it('/task, /run, /chat are removed from the v0.2 command surface', () => {
      for (const name of ['task', 'run', 'chat']) {
        expect(findCommand(name)).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Visibility contract
  // -----------------------------------------------------------------------

  describe('visibility contract', () => {
    it('hidden commands are excluded from visible list', () => {
      const hiddenNames = all.filter(c => c.isHidden).map(c => c.name);
      const visibleNames = new Set(visible.map(c => c.name));
      for (const name of hiddenNames) {
        expect(visibleNames.has(name)).toBe(false);
      }
    });

    it('does not retain legacy category commands in v0.2', () => {
      const legacy = all.filter(c => c.category === 'legacy');
      expect(legacy).toEqual([]);
    });

    it('/agents legacy diagnostic root is removed', () => {
      expect(findCommand('agents')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Palette defaults — visible commands group into the expected categories
  // -----------------------------------------------------------------------

  describe('palette categories', () => {
    it('workflow palette contains the product-default workflow commands', () => {
      const names = new Set(visible.filter(c => c.category === 'workflow').map(c => c.name));
      expect(names.has('goal')).toBe(true);
      expect(names.has('diff')).toBe(true);
      expect(names.has('commit-plan')).toBe(true);
      expect(names.has('review')).toBe(true);
      expect(names.has('security')).toBe(true);
      expect(names.has('test-gen')).toBe(true);
    });

    it('session palette contains session lifecycle commands', () => {
      const names = new Set(visible.filter(c => c.category === 'session').map(c => c.name));
      expect(names.has('resume')).toBe(true);
      expect(names.has('sessions')).toBe(false);
      expect(names.has('compact')).toBe(true);
    });

    it('context palette contains harness/skills/memory commands', () => {
      const names = new Set(visible.filter(c => c.category === 'context').map(c => c.name));
      expect(names.has('harness')).toBe(true);
      expect(names.has('skills')).toBe(true);
      expect(names.has('skill')).toBe(true);
      expect(names.has('memory')).toBe(true);
      expect(findCommand('memory')?.argumentHint).toBe('[validate|reindex]');
    });

    it('runtime palette contains model and tools commands without the retired /mode root', () => {
      const modelNames = new Set(visible.filter(c => c.category === 'model').map(c => c.name));
      expect(modelNames.has('model')).toBe(true);
      expect(modelNames.has('mode')).toBe(false);
      expect(modelNames.has('config')).toBe(true);
      expect(findCommand('mode')).toBeUndefined();
      expect(findCommand('perm')).toBeUndefined();

      const toolNames = new Set(visible.filter(c => c.category === 'tools').map(c => c.name));
      expect(toolNames.has('tools')).toBe(true);
      expect(toolNames.has('mcp')).toBe(true);
    });

    it('system palette contains help/status/clear/exit', () => {
      const names = new Set(visible.filter(c => c.category === 'system').map(c => c.name));
      expect(names.has('help')).toBe(true);
      expect(names.has('status')).toBe(true);
      expect(names.has('clear')).toBe(true);
      expect(names.has('exit')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Renderer scope
  // -----------------------------------------------------------------------

  describe('renderer scope', () => {
    it('commands with rendererScope only use valid values', () => {
      const valid = ['tui', 'terminal', 'print'];
      for (const cmd of all) {
        if (cmd.rendererScope) {
          for (const r of cmd.rendererScope) {
            expect(valid).toContain(r);
          }
        }
      }
    });

    it('/clear is scoped to terminal-capable renderers', () => {
      const clear = findCommand('clear');
      expect(clear?.rendererScope).toBeDefined();
      expect(clear?.rendererScope).toContain('tui');
      expect(clear?.rendererScope).toContain('terminal');
    });

    it('TUI-local commands are registered once with TUI scope', () => {
      for (const name of ['tool-output']) {
        const command = findCommand(name);
        expect(command?.execution).toBe('renderer-local');
        expect(command?.rendererScope).toEqual(['tui']);
        expect(getVisibleCommands('tui').filter(item => item.name === name)).toHaveLength(1);
        expect(getVisibleCommands('terminal').some(item => item.name === name)).toBe(false);
      }
      expect(findCommand('redraw')?.audience).toBe('internal');
      expect(getVisibleCommands('tui').some(item => item.name === 'redraw')).toBe(false);
    });

    it('renderer-aware visible commands exclude commands outside the active renderer', () => {
      expect(getVisibleCommands('tui').some(command => command.name === 'clear')).toBe(true);
      expect(getVisibleCommands('terminal').some(command => command.name === 'clear')).toBe(true);
      expect(getVisibleCommands('print').some(command => command.name === 'clear')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Stable command semantics
  // -----------------------------------------------------------------------

  describe('stable commands', () => {
    it('/goal has no legacy target alias', () => {
      const goal = findCommand('goal');
      expect(goal).toBeDefined();
      expect(findCommand('target')).toBeUndefined();
      expect(getVisibleCommands().filter(command => command.name === 'goal')).toHaveLength(1);
    });

    it('terminal-ui technical commands share business semantics with TUI product commands', () => {
      // All workflow commands should be available in both TUI and terminal.
      const workflow = visible.filter(c => c.category === 'workflow');
      for (const cmd of workflow) {
        // If no rendererScope is set, the command is all-renderer by default.
        if (cmd.rendererScope) {
          expect(cmd.rendererScope).toContain('tui');
        }
      }
    });
  });
});
