import { findCommand, getVisibleCommands } from '../src/commands';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSession } from '../src/services/session-storage';

describe('v0.1.5 command migration roots', () => {
  it('registers high-value domain roots with typed subcommands', () => {
    expect(findCommand('session')).toMatchObject({
      id: 'builtin.session.session',
      argumentSchema: { kind: 'subcommands', subcommands: ['list', 'info', 'rename'] },
    });
    expect(findCommand('context')).toMatchObject({
      id: 'builtin.context.context',
      argumentSchema: {
        kind: 'subcommands',
        subcommands: ['show', 'clear', 'harness', 'explain'],
      },
    });
    expect(findCommand('rewind')?.id).toBe('builtin.session.rewind');
    expect(findCommand('subagents')?.id).toBe('builtin.diagnostics.subagents');
    expect(findCommand('research')?.id).toBe('builtin.workflow.research');
  });

  it('keeps old roots executable but removes them from discovery surfaces', () => {
    for (const name of ['sessions', 'session-rename', 'context-clear', 'checkpoint', 'agents']) {
      expect(findCommand(name)).toBeDefined();
    }
    const visible = new Set(getVisibleCommands().map(command => command.name));
    expect(visible.has('sessions')).toBe(false);
    expect(visible.has('session-rename')).toBe(false);
    expect(visible.has('context-clear')).toBe(false);
    expect(visible.has('agents')).toBe(false);
  });

  it('adds the v0.1.7 TUI discovery roots to the stable primary slash surface', () => {
    const primary = getVisibleCommands('tui').filter(command => command.audience === 'primary');
    expect(primary.map(command => command.name)).toEqual([
      'goal',
      'plan',
      'diff',
      'review',
      'resume',
      'compact',
      'context',
      'model',
      'effort',
      'permissions',
      'help',
      'status',
      'theme',
      'keymap',
      'queue',
    ]);
  });

  it('returns typed session info without reading transcript content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-command-session-info-'));
    const previous = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
    try {
      const session = createSession(root, 'test-model');
      session.effortPreference = 'high';
      const result = await findCommand('session')!.execute(
        {
          cwd: root,
          getSession: () => session,
        } as never,
        'info'
      );
      expect(result).toMatchObject({ success: true });
      expect(result.output).toContain(`Session ${session.id}`);
      expect(result.output).toContain('Effort: high');
    } finally {
      if (previous === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
