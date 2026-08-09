/** Command definitions extracted from the stable slash-command registry. */

import type { CommandContext, SlashCommand } from './types';
import { showHelp, showStatus, handleExit } from './core-command-handlers';

export function createSystemCommands(
  getVisibleCommands: (renderer?: CommandContext['uiRenderer']) => SlashCommand[]
): SlashCommand[] {
  return [
    {
      name: 'help',
      aliases: ['h'],
      description: 'Show available commands',
      category: 'system',
      priority: 10,
      type: 'builtin',
      execution: 'builtin',
      risk: 'read-only',
      execute: ctx => showHelp(ctx, getVisibleCommands(ctx.uiRenderer)),
    },
    {
      name: 'status',
      aliases: ['s'],
      description: 'Show system status overview',
      category: 'system',
      priority: 20,
      type: 'builtin',
      execution: 'builtin',
      risk: 'read-only',
      execute: ctx => showStatus(ctx),
    },
    {
      name: 'clear',
      description: 'Clear the current view without deleting session data',
      category: 'system',
      priority: 30,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'read-only',
      rendererScope: ['tui', 'terminal'],
      execute: ctx => {
        ctx.clearView?.();
        return { success: true };
      },
    },
    {
      name: 'tool-output',
      description: 'Set the TUI tool output presentation mode',
      argumentHint: '[adaptive|collapsed|full]',
      category: 'system',
      priority: 32,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'read-only',
      rendererScope: ['tui'],
      execute: () => ({ success: true }),
    },
    {
      name: 'permissions',
      description:
        'Set the tool confirmation policy (TUI). No argument opens a picker; with an argument applies immediately.',
      argumentHint: '[allow|ask|deny]',
      category: 'system',
      priority: 33,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'state-write',
      rendererScope: ['tui'],
      execute: () => ({ success: true }),
    },
    {
      name: 'redraw',
      description: 'Redraw the TUI-owned live region',
      category: 'system',
      priority: 34,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'read-only',
      rendererScope: ['tui'],
      execute: () => ({ success: true }),
    },
    {
      name: 'exit',
      aliases: ['quit', 'q'],
      description: 'Shutdown and exit',
      category: 'system',
      priority: 40,
      type: 'builtin',
      execution: 'builtin',
      risk: 'state-write',
      execute: ctx => handleExit(ctx),
    },
  ];
}
