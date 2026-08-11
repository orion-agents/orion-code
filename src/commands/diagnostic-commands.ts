/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import {
  handleDoctor,
  handleStorage,
  handleUsage,
  handleLoopStats,
  handleTrace,
  handleLastTool,
  handleArtifacts,
  handleCheckpoint,
  handleCost,
  showAgents,
} from './diagnostic-command-handlers';
import { handleMigrateCommand } from '../migration/command';
import { readSessionTraceEvents } from '../services/session-storage';

export const DIAGNOSTIC_COMMANDS: SlashCommand[] = [
  {
    name: 'subagents',
    description: 'Show typed subtask and research activity for the current session',
    category: 'diagnostics',
    priority: 4,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => {
      const sessionId = ctx.getSession?.()?.id ?? ctx.sessionId;
      if (!sessionId) return { success: true, output: 'No active session.' };
      const events = readSessionTraceEvents(sessionId).filter(
        event => event.type.startsWith('subtask_') || event.name?.startsWith('research:')
      );
      return {
        success: true,
        output:
          events.length > 0
            ? events
                .slice(-50)
                .map(event => `${event.type}${event.name ? ` ${event.name}` : ''}`)
                .join('\n')
            : 'No typed subtask or research activity in this session.',
      };
    },
  },
  {
    name: 'doctor',
    aliases: ['diag', 'diagnose'],
    description: 'Run configuration, tools, MCP, skills, session, and harness diagnostics',
    category: 'diagnostics',
    priority: 5,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => handleDoctor(ctx),
  },
  {
    name: 'storage',
    description: 'Inspect, repair, or clean Orion Code storage layout',
    argumentHint:
      '[doctor|repair [--dry-run|--yes] [--plan=<token>]|cleanup [--dry-run|--yes] [--plan=<token>]]',
    category: 'diagnostics',
    priority: 8,
    type: 'builtin',
    execution: 'builtin',
    risk: 'destructive',
    execute: (ctx, args) => handleStorage(ctx, args),
  },
  {
    name: 'usage',
    aliases: ['stats'],
    description: 'Show detailed usage statistics',
    category: 'diagnostics',
    priority: 10,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => handleUsage(ctx),
  },
  {
    name: 'loop-stats',
    aliases: ['loop'],
    description: 'Show detailed agent-loop budget and efficiency diagnostics',
    category: 'diagnostics',
    priority: 12,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => handleLoopStats(ctx),
  },
  {
    name: 'trace',
    description: 'Show structured event timeline for the latest or selected turn',
    argumentHint: '[latest|turn-id]',
    category: 'diagnostics',
    priority: 14,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: (ctx, args) => handleTrace(ctx, args),
  },
  {
    name: 'last-tool',
    aliases: ['tool-last'],
    description: 'Show the latest tool call/result with full inspection hints',
    category: 'diagnostics',
    priority: 15,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: (ctx, args) => handleLastTool(ctx, args),
  },
  {
    name: 'artifacts',
    aliases: ['artifact'],
    description: 'List or inspect saved full tool outputs for this project',
    argumentHint: '[show <id|prefix> --full]',
    category: 'diagnostics',
    priority: 16,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: (ctx, args) => handleArtifacts(ctx, args),
  },
  {
    name: 'checkpoint',
    aliases: ['checkpoints'],
    description: 'List or restore file checkpoints created before agent edits',
    argumentHint: '[list|restore <turn-id|prefix> --yes]',
    category: 'diagnostics',
    priority: 18,
    type: 'builtin',
    execution: 'builtin',
    risk: 'destructive',
    execute: (ctx, args) => handleCheckpoint(ctx, args),
  },
  {
    name: 'rewind',
    description: 'List or restore a checkpoint with explicit preview and confirmation',
    argumentHint: '[list|restore <turn-id> --yes]',
    category: 'session',
    priority: 35,
    type: 'builtin',
    execution: 'builtin',
    risk: 'destructive',
    execute: (ctx, args) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === 'list') return handleCheckpoint(ctx, '');
      if (trimmed.startsWith('restore ')) return handleCheckpoint(ctx, trimmed);
      return { success: false, error: 'Usage: /rewind [list|restore <turn-id> --yes]' };
    },
  },
  {
    name: 'cost',
    description: 'Show session token usage',
    category: 'diagnostics',
    priority: 20,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    deprecated: { since: 'v0.1.1', replacement: '/usage', removeIn: 'v0.3.0' },
    execute: ctx => handleCost(ctx),
  },
  {
    name: 'agents',
    description: 'List registered agents and their status',
    category: 'diagnostics',
    priority: 30,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    isHidden: true,
    execute: ctx => showAgents(ctx),
  },
  {
    name: 'migrate',
    description: 'Migrate data from OpenHorse to Orion Code',
    argumentHint: 'openhorse [--dry-run | --yes] [--include-env] [--include-project-files]',
    category: 'diagnostics',
    priority: 32,
    type: 'builtin',
    execution: 'builtin',
    risk: 'destructive',
    execute: (ctx, args) => handleMigrateCommand(ctx, args),
  },
];
