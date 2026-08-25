import { createReadStream, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { createInterface } from 'readline';

import { buildTool, type ToolResult } from '../../framework/tool';
import { coreToolDescriptorV1 } from '../../runtime/core-tools/descriptors';
import { errorMessage } from '../../utils/errors';
import { isWithinWorkspace, normalizeToolPath, safePath, safeStatSync } from './common';

const descriptor = coreToolDescriptorV1('grep');

export const coreTool = buildTool({
  name: descriptor.name,
  aliases: [...descriptor.aliases],
  description: descriptor.description,
  parameters: structuredClone(descriptor.parameters),
  execute: async (args, context) => {
    // Ensure pattern is a valid string
    const pattern = args.pattern;
    if (!pattern || typeof pattern !== 'string') {
      return { success: false, output: '', error: 'grep requires a pattern parameter' };
    }
    return grep_(
      pattern,
      args.path as string | undefined,
      args.glob as string | undefined,
      args.context as number | undefined,
      context.cwd
    );
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: args => `Grep ${args.pattern as string}`,
  getSummary: (args, result) => {
    const pattern = args.pattern as string;
    if (!result.success) return `🔎 grep /${pattern}/ → error`;
    const count = result.output.split('\n').filter(l => l && !l.startsWith('--')).length;
    return `🔎 grep /${pattern}/ → ${count} matches`;
  },
});

/**
 * Validate a caller-supplied regular expression pattern before compiling it.
 *
 * Issue #79: `grep_` compiles user/model-supplied patterns with `new RegExp`
 * directly. A pathological pattern with a quantified group that itself contains
 * a quantifier (e.g. `(a+)+`, `(\d+)*`) triggers catastrophic backtracking
 * (ReDoS) and can hang the process on adversarial input (prompt injection).
 * Reject empty/oversized patterns and the classic nested-quantifier shapes.
 */
export function validateRegexPattern(pattern: string): string | null {
  if (!pattern) return 'pattern must not be empty';
  if (pattern.length > 2000) return 'pattern is too long (max 2000 characters)';
  // A group containing an internal quantifier, then quantified again: the
  // canonical exponential-backtracking construction. Quantifier families
  // include braces; treating only `*+?` as quantifiers lets `(a{1,})+` hang
  // the event loop on a long near miss.
  const quantifier = String.raw`(?:[*+?]|\{\d+(?:,\d*)?\})`;
  if (new RegExp(String.raw`\([^()]*${quantifier}[^()]*\)\s*${quantifier}`).test(pattern)) {
    return 'pattern contains a quantified group with an internal quantifier — this risks catastrophic backtracking (ReDoS)';
  }
  // Reject the common overlapping-alternative form `(a|aa)+`: either branch
  // can consume the same prefix, creating exponentially many partitions.
  const quantifiedGroup = new RegExp(String.raw`\(([^()]*)\)\s*${quantifier}`, 'gu');
  for (const match of pattern.matchAll(quantifiedGroup)) {
    const alternatives = match[1].split('|');
    if (
      alternatives.length > 1 &&
      alternatives.some((left, index) =>
        alternatives.some(
          (right, otherIndex) =>
            index !== otherIndex && left.length > 0 && right.length > 0 && right.startsWith(left)
        )
      )
    ) {
      return 'pattern contains overlapping alternatives inside a quantified group — this risks catastrophic backtracking (ReDoS)';
    }
  }
  try {
    new RegExp(pattern);
  } catch {
    return 'pattern is not a valid regular expression';
  }
  return null;
}

/**
 * Grep 搜索 - 在文件中搜索正则表达式
 */
async function grep_(
  pattern: string,
  basePath?: string,
  globPattern?: string,
  contextLines?: number,
  cwd?: string
): Promise<ToolResult> {
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

    const patternError = validateRegexPattern(pattern);
    if (patternError) {
      return { success: false, output: '', error: `Invalid grep pattern: ${patternError}` };
    }
    const regex = new RegExp(pattern);
    const context = contextLines ?? 0;
    const results: string[] = [];
    const maxResults = 100;

    // Get list of files to search
    const files: string[] = [];
    const skippedDangling: string[] = [];

    function collectFiles(dir: string) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            collectFiles(fullPath);
          } else {
            // Check glob filter if provided
            if (globPattern) {
              if (!matchGlobSimple(entry.name, globPattern)) continue;
            }
            // Skip dangling symlinks — collect their paths for a warning.
            if (entry.isSymbolicLink()) {
              try {
                statSync(fullPath);
              } catch {
                skippedDangling.push(fullPath);
                continue;
              }
            }
            files.push(fullPath);
          }
        }
      } catch {
        // skip unreadable
      }
    }

    function matchGlobSimple(name: string, pat: string): boolean {
      const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${regex}$`).test(name);
    }

    const baseStat = safeStatSync(base);
    if (!baseStat) {
      return {
        success: false,
        output: '',
        error: `Cannot access path: ${base} (may be a dangling symlink or missing)`,
      };
    }
    if (baseStat.isDirectory()) {
      collectFiles(base);
    } else {
      // Skip dangling symlinks / unreadable single files early.
      const fileStat = safeStatSync(base);
      if (fileStat && fileStat.isFile()) {
        files.push(base);
      }
    }

    // Search each file
    for (const file of files) {
      if (results.length >= maxResults) break;

      try {
        // Skip dangling symlinks and unreadable files before creating the stream.
        const fileStat = safeStatSync(file);
        if (!fileStat || !fileStat.isFile()) continue;

        const stream = createReadStream(file, { encoding: 'utf-8' });
        const rl = createInterface({
          input: stream,
          crlfDelay: Infinity,
        });

        const lines: string[] = [];
        const relPath = relative(base, file);

        rl.on('line', line => {
          lines.push(line);
        });

        // Guard against stream errors (dangling symlinks, permission denied, etc.)
        await new Promise<void>((resolve, reject) => {
          stream.on('error', reject);
          rl.on('close', resolve);
        });

        // Search for matches
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            // Format: file:line:content
            const start = Math.max(0, i - context);
            const end = Math.min(lines.length - 1, i + context);

            if (context > 0) {
              results.push(`${relPath}:${i + 1}:`);
              for (let j = start; j <= end; j++) {
                const prefix = j === i ? '>' : ' ';
                results.push(`  ${prefix}${j + 1}: ${lines[j]}`);
              }
              results.push('');
            } else {
              results.push(`${relPath}:${i + 1}: ${lines[i]}`);
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    const symlinkWarning =
      skippedDangling.length > 0
        ? `\n⚠️  Skipped ${skippedDangling.length} dangling symlink(s): ${skippedDangling.slice(0, 3).join(', ')}${skippedDangling.length > 3 ? '...' : ''}\n`
        : '';

    if (results.length === 0) {
      return { success: true, output: 'No matches found' + symlinkWarning };
    }

    return { success: true, output: results.slice(0, maxResults).join('\n') + symlinkWarning };
  } catch (err) {
    return { success: false, output: '', error: errorMessage(err) };
  }
}
