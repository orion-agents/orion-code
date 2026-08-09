/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import { handleModel, handleModels, handleMode, showConfig } from './model-command-handlers';

export const MODEL_COMMANDS: SlashCommand[] = [
  {
    name: 'model',
    description: 'Show or change the current model',
    argumentHint: '[model|info]',
    category: 'model',
    priority: 10,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleModel(ctx, args),
  },
  {
    name: 'models',
    description: 'Switch the current model interactively',
    argumentHint: '',
    category: 'model',
    priority: 10,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleModels(ctx, args),
  },
  {
    name: 'mode',
    aliases: ['perm'],
    description: 'Show or change tool permission mode',
    argumentHint: '[default|accept-edits|plan|auto|next]',
    category: 'model',
    priority: 20,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleMode(ctx, args),
  },
  {
    name: 'config',
    description: 'Show current configuration',
    category: 'model',
    priority: 30,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => showConfig(ctx),
  },
];
