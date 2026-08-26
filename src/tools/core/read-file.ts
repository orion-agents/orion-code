import { existsSync } from 'fs';

import { buildTool, type ToolResult } from '../../framework/tool';
import { coreToolDescriptorV1 } from '../../runtime/core-tools/descriptors';
import { errorMessage } from '../../utils/errors';
import {
  isWithinWorkspace,
  normalizeToolPath,
  safePath,
  safeReadFileSync,
  safeStatSync,
  truncateToBytes,
} from './common';

const descriptor = coreToolDescriptorV1('read_file');

export const coreTool = buildTool({
  name: descriptor.name,
  aliases: [...descriptor.aliases],
  description: descriptor.description,
  parameters: structuredClone(descriptor.parameters),
  execute: async (args, context) => {
    // Ensure path is a valid string
    const path = args.path;
    if (!path || typeof path !== 'string') {
      return { success: false, output: '', error: 'read_file requires a path parameter' };
    }
    const maxLines = readPositiveInteger(args.maxLines, 'maxLines', 500);
    if (typeof maxLines === 'string') {
      return { success: false, output: '', error: maxLines };
    }
    const offset = readPositiveInteger(args.offset, 'offset', 1);
    if (typeof offset === 'string') {
      return { success: false, output: '', error: offset };
    }
    return readFileSync_(path, maxLines, offset, context.cwd);
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: args => `Read ${args.path as string}`,
  getSummary: (args, result) => {
    const path = args.path as string;
    if (!result.success) return `📄 read ${path} → error`;
    const lines = result.output.split('\n').length;
    const bytes = Buffer.byteLength(result.output, 'utf8');
    return `📄 read ${path} (${lines}L, ${bytes}B)`;
  },
});

function readPositiveInteger(value: unknown, name: string, defaultValue: number): number | string {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return `read_file ${name} must be a positive integer`;
  }
  return value;
}

async function readFileSync_(
  path: string,
  maxLines: number,
  offset: number,
  cwd?: string
): Promise<ToolResult> {
  try {
    const normalizedPath = normalizeToolPath(path);
    const resolved = safePath(path, cwd);
    const workspaceRoot = cwd ?? process.cwd();
    if (!isWithinWorkspace(resolved, workspaceRoot)) {
      return {
        success: false,
        output: '',
        error: `Refusing to read outside the workspace: ${normalizedPath}`,
      };
    }
    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${normalizedPath}` };
    }
    const st = safeStatSync(resolved);
    if (!st) {
      return {
        success: false,
        output: '',
        error: `Cannot access file: ${normalizedPath} (may be a dangling symlink or missing)`,
      };
    }
    if (st.isDirectory()) {
      return {
        success: false,
        output: '',
        error: `Path is a directory, not a file: ${normalizedPath}`,
      };
    }

    const content = safeReadFileSync(resolved);
    if (content === null) {
      return {
        success: false,
        output: '',
        error: `Cannot read file: ${normalizedPath}`,
      };
    }
    const lines = content.split('\n');
    const maxBytes = 51200; // 50KB byte limit
    if (offset > lines.length) {
      return {
        success: false,
        output: '',
        error: `read_file offset ${offset} is beyond the file (${lines.length} lines)`,
      };
    }

    const startIndex = offset - 1;
    const selectedLines = lines.slice(startIndex, startIndex + maxLines);
    const selected = selectedLines.join('\n');
    const remainingLines = Math.max(0, lines.length - startIndex - selectedLines.length);

    if (remainingLines > 0) {
      const byteLen = Buffer.byteLength(selected, 'utf8');
      const notice = `\n\n[... truncated, ${remainingLines} more lines; showing lines ${offset}-${offset + selectedLines.length - 1} of ${lines.length}]`;
      if (byteLen > maxBytes) {
        const cut = truncateToBytes(selected, maxBytes);
        return {
          success: true,
          output: cut.text + `\n\n[... truncated at ${cut.bytes}B]`,
        };
      }
      return { success: true, output: selected + notice };
    }

    // Also apply byte limit to the selected page.
    const byteLen = Buffer.byteLength(selected, 'utf8');
    if (byteLen > maxBytes) {
      const cut = truncateToBytes(selected, maxBytes);
      return {
        success: true,
        output: cut.text + `\n\n[... truncated at ${cut.bytes}B of ${byteLen}B]`,
      };
    }

    return { success: true, output: selected };
  } catch (err) {
    return { success: false, output: '', error: errorMessage(err) };
  }
}
