/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import {
  handleResume,
  handleSessions,
  handleSessionInfo,
  handleSessionRename,
  handleCompact,
} from './session-command-handlers';

export const SESSION_COMMANDS: SlashCommand[] = [
  {
    name: 'resume',
    description: 'Resume a previous session',
    argumentHint: '[number|session-id|name]',
    category: 'session',
    priority: 10,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleResume(ctx, args),
  },
  {
    name: 'session',
    description: 'List, inspect, or rename sessions through one domain command',
    argumentHint: '[list [query|--all]|info [query]|rename <query> <name>]',
    category: 'session',
    priority: 15,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => {
      const [subcommand = 'list', ...rest] = args.trim().split(/\s+/u);
      const tail = rest.join(' ');
      if (subcommand === 'list') return handleSessions(ctx, tail);
      if (subcommand === 'info') return handleSessionInfo(ctx, tail);
      if (subcommand === 'rename') return handleSessionRename(ctx, tail);
      return {
        success: false,
        error: 'Usage: /session [list [query|--all]|info [query]|rename <query> <name>]',
      };
    },
  },
  {
    name: 'compact',
    description: 'Compact conversation history with optional summary focus',
    argumentHint: '[threshold] [focus]',
    category: 'session',
    priority: 40,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleCompact(ctx, args),
  },
];
