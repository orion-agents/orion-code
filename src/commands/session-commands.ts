/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import {
  handleResume,
  handleSessions,
  handleSessionInfo,
  handleSessionRename,
  handleCompact,
  handleContextClear,
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
    name: 'sessions',
    description: 'List recent sessions, or search by file/tool/keyword',
    argumentHint: '[<query>|--all]',
    category: 'session',
    priority: 20,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: (ctx, args) => handleSessions(ctx, args),
  },
  {
    name: 'session-rename',
    aliases: ['rename-session'],
    description: 'Rename a saved session',
    argumentHint: '<number|session-id|name> <new name>',
    category: 'session',
    priority: 30,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleSessionRename(ctx, args),
  },
  {
    name: 'compact',
    description: 'Compact conversation history to reduce context size',
    argumentHint: '[threshold]',
    category: 'session',
    priority: 40,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleCompact(ctx, args),
  },
  {
    name: 'context-clear',
    description: 'Clear current in-memory model context; preserve saved session history',
    argumentHint: '--yes',
    category: 'session',
    priority: 50,
    type: 'builtin',
    execution: 'builtin',
    risk: 'destructive',
    execute: (ctx, args) => handleContextClear(ctx, args),
  },
  {
    name: 'clear-history',
    aliases: ['reset'],
    description: 'Deprecated alias for clearing only the current in-memory model context',
    argumentHint: '--yes',
    category: 'legacy',
    priority: 50,
    type: 'builtin',
    isHidden: true,
    execution: 'builtin',
    risk: 'destructive',
    deprecated: { since: 'v0.1.1', replacement: '/context-clear', removeIn: 'v0.3.0' },
    execute: (ctx, args) => handleContextClear(ctx, args),
  },
];
