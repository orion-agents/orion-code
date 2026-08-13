/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import {
  handleModel,
  handleModels,
  handlePermissions,
  handleEffort,
  showConfig,
} from './model-command-handlers';

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
    name: 'permissions',
    description: 'Show or change tool confirmation and edit policy',
    argumentHint: '[show|ask|allow|deny|allow-edits|audit]',
    category: 'model',
    priority: 25,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handlePermissions(ctx, args),
  },
  {
    name: 'effort',
    aliases: ['reasoning'],
    description: 'Show or change reasoning effort for the active model',
    argumentHint: '[status|auto|none|minimal|low|medium|high|xhigh|max] [--project|--global]',
    category: 'model',
    priority: 22,
    type: 'builtin',
    execution: 'builtin',
    risk: 'state-write',
    execute: (ctx, args) => handleEffort(ctx, args),
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
