/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import {
  showHarness,
  handleSkills,
  handleSkill,
  handleMemory,
} from './context-tool-command-handlers';

export const CONTEXT_COMMANDS: SlashCommand[] = [
  {
    name: 'harness',
    description: 'Show Context Harness state, or `/harness explain` for prompt assembly details',
    argumentHint: '[explain]',
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
    description: 'Show memory status, or `/memory reindex` to rebuild semantic index',
    argumentHint: '[reindex]',
    category: 'context',
    priority: 30,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleMemory(ctx, args),
  },
];
