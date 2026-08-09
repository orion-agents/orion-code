/** Command definitions extracted from the stable slash-command registry. */

import type { SlashCommand } from './types';
import {
  handleTools,
  handleEditPreview,
  handleMcp,
  showSafety,
} from './context-tool-command-handlers';

export const TOOL_COMMANDS: SlashCommand[] = [
  {
    name: 'tools',
    aliases: ['tool'],
    description: 'List available built-in and MCP tools',
    category: 'tools',
    priority: 10,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => handleTools(ctx),
  },
  {
    name: 'edit-preview',
    description: 'Preview the last edit_file match candidates without writing',
    category: 'tools',
    priority: 15,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => handleEditPreview(ctx),
  },
  {
    name: 'mcp',
    description: 'Show connected MCP servers and their status',
    category: 'tools',
    priority: 20,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => handleMcp(ctx),
  },
  {
    name: 'safety',
    description: 'Show safety checker status and audit summary',
    category: 'tools',
    priority: 30,
    type: 'builtin',
    execution: 'builtin',
    risk: 'read-only',
    execute: ctx => showSafety(ctx),
  },
];
