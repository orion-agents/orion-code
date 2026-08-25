/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import {
  showHarness,
  handleSkills,
  handleSkill,
  handleMemory,
} from './context-tool-command-handlers';
import { handleContextClear } from './session-command-handlers';

export const CONTEXT_COMMANDS: SlashCommand[] = [
  {
    name: 'context',
    description: 'Show diagnostics or clear only in-memory model context with confirmation',
    argumentHint: '[show|harness|explain [--json]|clear --yes]',
    category: 'context',
    priority: 5,
    type: 'builtin',
    execution: 'builtin',
    risk: 'destructive',
    execute: (ctx, args) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === 'show' || trimmed === 'harness') return showHarness(ctx, '');
      if (trimmed === 'explain' || trimmed.startsWith('explain ')) {
        return showHarness(ctx, trimmed);
      }
      if (trimmed === 'harness explain' || trimmed.startsWith('harness explain ')) {
        return showHarness(ctx, trimmed.slice('harness '.length));
      }
      if (trimmed.startsWith('clear')) {
        return handleContextClear(ctx, trimmed.slice('clear'.length).trim());
      }
      return {
        success: false,
        error: 'Usage: /context [show|harness|explain [--json]|clear --yes]',
      };
    },
  },
  {
    name: 'harness',
    description: 'Explain the live v0.2 runtime, capability, Skill, MCP, and compact state',
    argumentHint: '[explain [--json]]',
    category: 'context',
    priority: 10,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: (ctx, args) => showHarness(ctx, args),
  },
  {
    name: 'skills',
    description: 'List loaded skills (built-in / user / project)',
    category: 'context',
    priority: 20,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => handleSkills(ctx),
  },
  {
    name: 'skill',
    aliases: ['use-skill', 'activate-skill'],
    description: 'Activate a loaded skill for one chat turn',
    argumentHint: '<name> <task>',
    category: 'context',
    priority: 21,
    type: 'chat',
    execution: 'agent-workflow',
    risk: 'state-write',
    execute: (ctx, args) => handleSkill(ctx, args),
  },
  {
    name: 'memory',
    description: 'Show memory status, validate references, or rebuild the semantic index',
    argumentHint: '[validate|reindex]',
    category: 'context',
    priority: 30,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleMemory(ctx, args),
  },
];
