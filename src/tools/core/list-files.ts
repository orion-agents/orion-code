import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { buildTool, type ToolResult } from '../../framework/tool';
import { coreToolDescriptorV1 } from '../../runtime/core-tools/descriptors';
import {
  isWithinWorkspace,
  normalizeToolPath,
  safePath,
  validateOptionalSafeInteger,
} from './common';

const LIST_FILES_MAX_DEPTH = 8;

const descriptor = coreToolDescriptorV1('list_files');

export const coreTool = buildTool({
  name: descriptor.name,
  aliases: [...descriptor.aliases],
  description: descriptor.description,
  parameters: structuredClone(descriptor.parameters),
  execute: async (args, context) => {
    // Ensure path is a valid string
    const path = args.path;
    if (!path || typeof path !== 'string') {
      return { success: false, output: '', error: 'list_files requires a path parameter' };
    }
    return listFiles_(path, args.maxDepth as number | undefined, context.cwd);
  },
  validateInput: args =>
    validateOptionalSafeInteger(args, 'list_files', 'maxDepth', 0, LIST_FILES_MAX_DEPTH),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: args => `List ${args.path as string}`,
  getSummary: (args, result) => {
    const path = args.path as string;
    if (!result.success) return `📁 list ${path} → error`;
    const count = result.output.split('\n').filter(Boolean).length;
    return `📁 list ${path} (${count} entries)`;
  },
});

async function listFiles_(path: string, maxDepth?: number, cwd?: string): Promise<ToolResult> {
  const normalizedPath = normalizeToolPath(path);
  const resolved = safePath(path, cwd);
  const workspaceRoot = cwd ?? process.cwd();
  if (!isWithinWorkspace(resolved, workspaceRoot)) {
    return {
      success: false,
      output: '',
      error: `Refusing to list outside the workspace: ${normalizedPath}`,
    };
  }
  if (!existsSync(resolved)) {
    return { success: false, output: '', error: `Path not found: ${normalizedPath}` };
  }
  if (!statSync(resolved).isDirectory()) {
    return { success: true, output: normalizedPath };
  }

  const depth = maxDepth ?? 2;
  const results: string[] = [];

  function walk(dir: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          results.push(`${relPath}/`);
          walk(fullPath, currentDepth + 1, relPath);
        } else {
          results.push(relPath);
        }
      }
    } catch {
      // skip unreadable directories
    }
  }

  walk(resolved, 1, '');

  // Limit output to 500 entries
  const maxEntries = 500;
  const output =
    results.length > maxEntries
      ? results.slice(0, maxEntries).join('\n') +
        `\n\n[... truncated, ${results.length - maxEntries} more entries]`
      : results.join('\n');

  return { success: true, output };
}
