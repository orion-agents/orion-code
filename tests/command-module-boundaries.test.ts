import { readFileSync } from 'fs';
import { resolve } from 'path';
import { findCommand, getCommands } from '../src/commands';
import { WORKFLOW_COMMANDS } from '../src/commands/workflow-commands';
import { SESSION_COMMANDS } from '../src/commands/session-commands';
import { CONTEXT_COMMANDS } from '../src/commands/context-commands';
import { TOOL_COMMANDS } from '../src/commands/tool-commands';
import { MODEL_COMMANDS } from '../src/commands/model-commands';
import { createSystemCommands } from '../src/commands/system-commands';
import { DIAGNOSTIC_COMMANDS } from '../src/commands/diagnostic-commands';
import { LEGACY_COMMANDS } from '../src/commands/legacy-commands';
import type { CommandContext } from '../src/commands/types';

const EXPECTED_REGISTRATION_ORDER = [
  'goal',
  'plan',
  'diff',
  'commit-plan',
  'review',
  'research',
  'security',
  'test-gen',
  'todos',
  'resume',
  'session',
  'sessions',
  'session-rename',
  'compact',
  'context-clear',
  'clear-history',
  'context',
  'harness',
  'skills',
  'skill',
  'memory',
  'tools',
  'edit-preview',
  'mcp',
  'safety',
  'model',
  'models',
  'permissions',
  'effort',
  'config',
  'help',
  'status',
  'clear',
  'theme',
  'keymap',
  'statusline',
  'queue',
  'tool-output',
  'redraw',
  'exit',
  'subagents',
  'doctor',
  'storage',
  'usage',
  'loop-stats',
  'trace',
  'last-tool',
  'artifacts',
  'checkpoint',
  'rewind',
  'cost',
  'agents',
  'migrate',
  'task',
  'run',
  'chat',
] as const;

describe('command module boundaries (#69)', () => {
  it('preserves the exact registration order across grouped modules', () => {
    const systemCommands = createSystemCommands(() => []);
    const registered = [
      ...WORKFLOW_COMMANDS,
      ...SESSION_COMMANDS,
      ...CONTEXT_COMMANDS,
      ...TOOL_COMMANDS,
      ...MODEL_COMMANDS,
      ...systemCommands,
      ...DIAGNOSTIC_COMMANDS,
      ...LEGACY_COMMANDS,
    ];

    expect(registered.map(command => command.name)).toEqual(EXPECTED_REGISTRATION_ORDER);
    expect(new Set(getCommands().map(command => command.name))).toEqual(
      new Set(EXPECTED_REGISTRATION_ORDER)
    );
  });

  it('keeps the registry thin and every handler module below the agreed boundary', () => {
    const commandsRoot = resolve(__dirname, '../src/commands');
    const lineCount = (name: string): number =>
      readFileSync(resolve(commandsRoot, name), 'utf8').split('\n').length;

    expect(lineCount('index.ts')).toBeLessThan(200);
    for (const file of [
      'core-command-handlers.ts',
      'diagnostic-command-handlers.ts',
      'session-command-handlers.ts',
      'model-command-handlers.ts',
      'context-tool-command-handlers.ts',
      'workflow-command-handlers.ts',
    ]) {
      expect({ file, lines: lineCount(file) }).toEqual({
        file,
        lines: expect.any(Number),
      });
      expect(lineCount(file)).toBeLessThan(1_500);
    }
  });

  it('fails closed for unknown, delegated, and destructive commands', async () => {
    const context = {
      store: {
        getSnapshot: () => ({ conversationHistory: [{ role: 'user', content: 'keep me' }] }),
      },
    } as unknown as CommandContext;
    expect(findCommand('__unknown-command__')).toBeUndefined();
    await expect(Promise.resolve(findCommand('target')?.execute(context, 'ship'))).resolves.toEqual(
      {
        success: false,
        error: '/goal must be routed through the shared AgentRuntimeController.',
      }
    );
    await expect(
      Promise.resolve(findCommand('context-clear')?.execute(context, ''))
    ).resolves.toMatchObject({ success: false });
  });
});
