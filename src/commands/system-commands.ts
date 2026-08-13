/** Command definitions extracted from the stable slash-command registry. */

import type { CommandContext, SlashCommand } from './types';
import { showHelp, showStatus, handleExit } from './core-command-handlers';
import {
  loadGlobalConfig,
  updateGlobalConfig,
  type TuiThemePreference,
} from '../services/global-config';

const TUI_THEMES: TuiThemePreference[] = ['orion-pixel', 'classic', 'high-contrast', 'auto'];

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
      execute: (ctx, args) =>
        showHelp(ctx, getVisibleCommands(ctx.uiRenderer), args.trim().toLowerCase() === '--all'),
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
      name: 'theme',
      description: 'Choose the TUI theme',
      argumentHint: '[orion-pixel|classic|high-contrast|auto]',
      category: 'system',
      priority: 31,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'state-write',
      rendererScope: ['tui'],
      execute: (_ctx, args) => {
        const requested = args.trim() as TuiThemePreference;
        const current = loadGlobalConfig().ui?.theme ?? 'orion-pixel';
        if (!requested) return { success: true, output: `Theme: ${current}` };
        if (!TUI_THEMES.includes(requested)) {
          return { success: false, error: `Theme must be one of: ${TUI_THEMES.join(', ')}` };
        }
        const config = loadGlobalConfig();
        updateGlobalConfig({ ui: { ...config.ui, theme: requested } });
        return { success: true, output: `Theme set to ${requested}; restart TUI to apply.` };
      },
    },
    {
      name: 'keymap',
      description: 'Show TUI keyboard actions and custom bindings',
      category: 'system',
      priority: 32,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'read-only',
      rendererScope: ['tui'],
      execute: () => ({
        success: true,
        output:
          'Enter send/steer · Tab queue while working · Esc stop · Ctrl+R history · Ctrl+E editor · Ctrl+O tools · Ctrl+L redraw · Ctrl+D exit',
      }),
    },
    {
      name: 'statusline',
      description: 'Show the ordered TUI status components',
      category: 'system',
      priority: 33,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'read-only',
      rendererScope: ['tui'],
      execute: () => ({
        success: true,
        output: `Status line: ${(
          loadGlobalConfig().ui?.statusLine ?? [
            'mode',
            'goal',
            'model',
            'effort',
            'context',
            'permission',
            'queue',
            'activity',
          ]
        ).join(', ')}`,
      }),
    },
    {
      name: 'queue',
      description: 'Show or clear queued follow-up messages',
      argumentHint: '[clear]',
      category: 'system',
      priority: 34,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'state-write',
      rendererScope: ['tui'],
      execute: () => ({ success: true }),
    },
    {
      name: 'tool-output',
      description: 'Set the TUI tool output presentation mode',
      argumentHint: '[adaptive|collapsed|full]',
      category: 'system',
      priority: 35,
      type: 'builtin',
      execution: 'renderer-local',
      risk: 'read-only',
      rendererScope: ['tui'],
      execute: () => ({ success: true }),
    },
    {
      name: 'redraw',
      description: 'Redraw the TUI-owned live region',
      category: 'system',
      priority: 36,
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
