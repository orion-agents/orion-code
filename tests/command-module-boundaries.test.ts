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
  'compact',
  'context',
  'harness',
  'skills',
  'skill',
  'memory',
  'tools',
  'mcp',
  'safety',
  'model',
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
  'trace',
  'last-tool',
  'artifacts',
  'rewind',
  'migrate',
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
    expect(findCommand('target')).toBeUndefined();
    await expect(
      Promise.resolve(findCommand('context')?.execute(context, 'clear'))
    ).resolves.toMatchObject({ success: false });
  });
});
