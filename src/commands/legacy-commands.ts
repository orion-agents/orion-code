/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import { handleTask, handleRun } from './core-command-handlers';

export const LEGACY_COMMANDS: SlashCommand[] = [
  {
    name: 'task',
    description: 'Submit or list tasks',
    params: [{ name: 'action', description: 'list | <task-name>', required: false }],
    category: 'legacy',
    type: 'builtin',
    isHidden: true,
    execution: 'builtin',
    risk: 'state-write',
    deprecated: { since: 'v0.1.1', replacement: '/goal', removeIn: 'v0.3.0' },
    execute: (ctx, args) => handleTask(ctx, args),
  },
  {
    name: 'run',
    description: 'Create and run a task through Agent + LLM',
    params: [{ name: 'description', description: 'Task description', required: true }],
    category: 'legacy',
    type: 'builtin',
    isHidden: true,
    execution: 'agent-workflow',
    risk: 'state-write',
    deprecated: { since: 'v0.1.1', replacement: '/goal', removeIn: 'v0.3.0' },
    execute: (ctx, args) => handleRun(ctx, args),
  },
  {
    name: 'chat',
    description: 'Send a message to the LLM',
    params: [{ name: 'message', description: 'Message to send', required: true }],
    category: 'legacy',
    type: 'chat',
    isHidden: true,
    execution: 'agent-workflow',
    risk: 'state-write',
    deprecated: { since: 'v0.1.1', removeIn: 'v0.3.0' },
    execute: (ctx, args) => ({ success: true, continueAsChat: true, chatInput: args }),
  },
];
