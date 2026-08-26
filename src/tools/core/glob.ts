import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { buildTool, type ToolResult } from '../../framework/tool';
import { coreToolDescriptorV1 } from '../../runtime/core-tools/descriptors';
import { errorMessage } from '../../utils/errors';
import { isWithinWorkspace, normalizeToolPath, safePath } from './common';

const descriptor = coreToolDescriptorV1('glob');

export const coreTool = buildTool({
  name: descriptor.name,
  aliases: [...descriptor.aliases],
  description: descriptor.description,
  parameters: structuredClone(descriptor.parameters),
  execute: async (args, context) => {
    // Ensure pattern is a valid string
    const pattern = args.pattern;
    if (!pattern || typeof pattern !== 'string') {
      return { success: false, output: '', error: 'glob requires a pattern parameter' };
    }
    return glob_(pattern, args.path as string | undefined, context.cwd);
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: args => `Glob ${args.pattern as string}`,
  getSummary: (args, result) => {
    const pattern = args.pattern as string;
    if (!result.success) return `🔍 glob ${pattern} → error`;
    const count = result.output.split('\n').filter(Boolean).length;
    return `🔍 glob ${pattern} → ${count} matches`;
  },
});

/**
 * Glob 模式匹配 - 简化版实现
 * 支持: **（递归目录）、*（任意字符）、?（单个字符）
 */
async function glob_(pattern: string, basePath?: string, cwd?: string): Promise<ToolResult> {
  try {
    const normalizedBasePath = basePath ? normalizeToolPath(basePath) : (cwd ?? process.cwd());
    const base = basePath ? safePath(basePath, cwd) : (cwd ?? process.cwd());
    const workspaceRoot = cwd ?? process.cwd();
    if (!isWithinWorkspace(base, workspaceRoot)) {
      return {
        success: false,
        output: '',
        error: `Refusing to search outside the workspace: ${normalizedBasePath}`,
      };
    }
    if (!existsSync(base)) {
      return { success: false, output: '', error: `Path not found: ${normalizedBasePath}` };
    }
    if (!statSync(base).isDirectory()) {
      return {
        success: false,
        output: '',
        error: `Path is not a directory: ${normalizedBasePath}`,
      };
    }

    const results: string[] = [];

    // Convert glob pattern to regex.
    // Escape ALL regex metacharacters first, then translate glob wildcards.
    // Escaping only `.` (the old behavior) left parens/brackets/+/^/$/| as
    // regex syntax: a literal "(group)" became a capture group (so the real
    // file stopped matching) and an unbalanced "[" made new RegExp throw.
    function globToRegex(pat: string): RegExp {
      // Use placeholders for glob wildcards so escaping does not touch them.
      let regex = pat;

      // **/ at start - matches optional path (including empty)
      regex = regex.replace(/^\*\*\//, '<<STARSTAR_SLASH_START>>');

      // **/ in middle - matches any number of path segments
      regex = regex.replace(/\*\*\//g, '<<STARSTAR_SLASH>>');

      // standalone ** - matches anything
      regex = regex.replace(/\*\*/g, '<<STARSTAR>>');

      // Escape every regex metacharacter in the remaining literal text.
      // NOTE: * and ? are glob wildcards, handled below - do not escape them.
      regex = regex.replace(/[.+^${}()|[\]\\]/g, '\\$&');

      // * matches anything except /
      regex = regex.replace(/\*/g, '[^/]*');

      // ? matches single char except /
      regex = regex.replace(/\?/g, '[^/]');

      // Now restore ** placeholders
      regex = regex.replace(/<<STARSTAR_SLASH_START>>/g, '(.*\\/)?');
      regex = regex.replace(/<<STARSTAR_SLASH>>/g, '([^/]+\\/)*');
      regex = regex.replace(/<<STARSTAR>>/g, '.*');

      return new RegExp(`^${regex}$`);
    }

    const regex = globToRegex(pattern);

    // Recursive walk with a depth cap so a pathological tree (or symlink loop)
    // cannot hang or OOM the tool.
    const MAX_DEPTH = 16;
    function walk(dir: string, prefix: string, depth: number) {
      if (depth > MAX_DEPTH) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;

          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(join(dir, entry.name), relPath, depth + 1);
          } else {
            if (regex.test(relPath)) {
              results.push(relPath);
            }
          }
        }
      } catch {
        // skip unreadable directories
      }
    }

    walk(base, '', 0);

    if (results.length === 0) {
      return { success: true, output: 'No files found matching pattern' };
    }

    // Limit output to 200 matches
    const maxMatches = 200;
    const sorted = results.sort();
    const output =
      sorted.length > maxMatches
        ? sorted.slice(0, maxMatches).join('\n') +
          `\n\n[... truncated, ${sorted.length - maxMatches} more matches]`
        : sorted.join('\n');

    return { success: true, output };
  } catch (err) {
    return { success: false, output: '', error: errorMessage(err) };
  }
}
