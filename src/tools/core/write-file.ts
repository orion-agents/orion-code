import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { buildTool, type ToolResult } from '../../framework/tool';
import { coreToolDescriptorV1 } from '../../runtime/core-tools/descriptors';
import { errorMessage } from '../../utils/errors';
import { isWithinWorkspace, normalizeToolPath, safePath } from './common';

const descriptor = coreToolDescriptorV1('write_file');

export const coreTool = buildTool({
  name: descriptor.name,
  aliases: [...descriptor.aliases],
  description: descriptor.description,
  parameters: structuredClone(descriptor.parameters),
  execute: async (args, context) => {
    // Ensure path and content are valid strings
    const path = args.path;
    const content = args.content;
    if (!path || typeof path !== 'string') {
      return { success: false, output: '', error: 'write_file requires a path parameter' };
    }
    if (typeof content !== 'string') {
      return { success: false, output: '', error: 'write_file requires a content parameter' };
    }
    return writeFileSync_(path, content, context.cwd);
  },
  isDestructive: () => true,
  isFileEdit: () => true,
  checkPermissions: (_args, _context) => {
    return { behavior: 'ask', reason: 'Write operation may modify existing files' };
  },
  userFacingName: args => `Write ${args.path as string}`,
  getSummary: (args, result) => {
    const path = args.path as string;
    if (!result.success) return `💾 write ${path} → error`;
    const bytes = Buffer.byteLength((args.content as string) || '', 'utf8');
    return `💾 write ${path} (${bytes}B)`;
  },
});

async function writeFileSync_(path: string, content: string, cwd?: string): Promise<ToolResult> {
  try {
    const normalizedPath = normalizeToolPath(path);
    const resolved = safePath(path, cwd);
    const workspaceRoot = cwd ?? process.cwd();
    if (!isWithinWorkspace(resolved, workspaceRoot)) {
      return {
        success: false,
        output: '',
        error: `Refusing to write outside the workspace: ${normalizedPath}`,
      };
    }
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, content, 'utf-8');
    return {
      success: true,
      output: `Wrote ${content.split('\n').length} lines to ${normalizedPath}`,
    };
  } catch (err) {
    return { success: false, output: '', error: errorMessage(err) };
  }
}
