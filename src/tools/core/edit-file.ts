import { existsSync, writeFileSync } from 'fs';

import { buildTool, type ToolResult } from '../../framework/tool';
import { coreToolDescriptorV1 } from '../../runtime/core-tools/descriptors';
import { errorMessage } from '../../utils/errors';
import {
  isWithinWorkspace,
  normalizeToolPath,
  safePath,
  safeReadFileSync,
  safeStatSync,
} from './common';

const descriptor = coreToolDescriptorV1('edit_file');

export const coreTool = buildTool({
  name: descriptor.name,
  aliases: [...descriptor.aliases],
  description: descriptor.description,
  parameters: structuredClone(descriptor.parameters),
  execute: async (args, context) => {
    // Ensure required parameters are valid strings
    const path = args.path;
    const old_string = args.old_string;
    const new_string = args.new_string;
    if (!path || typeof path !== 'string') {
      return { success: false, output: '', error: 'edit_file requires a path parameter' };
    }
    if (!old_string || typeof old_string !== 'string') {
      return { success: false, output: '', error: 'edit_file requires an old_string parameter' };
    }
    if (typeof new_string !== 'string') {
      return { success: false, output: '', error: 'edit_file requires a new_string parameter' };
    }
    return editFile_(
      path,
      old_string,
      new_string,
      args.replace_all as boolean | undefined,
      args.fuzzy_match as boolean | undefined,
      args.preview as boolean | undefined,
      context.cwd
    );
  },
  isDestructive: () => true,
  isFileEdit: () => true,
  checkPermissions: (_args, _context) => {
    return { behavior: 'ask', reason: 'Edit operation modifies file contents' };
  },
  userFacingName: args => `Edit ${args.path as string}`,
  getSummary: (args, result) => {
    const path = args.path as string;
    if (!result.success) return `✏️ edit ${path} → error`;
    const replaceAll = args.replace_all ? ' (all)' : '';
    return `✏️ edit ${path}${replaceAll}`;
  },
});

/**
 * Fuzzy match result
 */
interface FuzzyMatchResult {
  matches: string[]; // Actual strings found in content
  strategy: 'whitespace' | 'line';
}

function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split('\n').length;
}

function findAllMatchIndexes(content: string, needle: string, limit = 20): number[] {
  const indexes: number[] = [];
  let cursor = 0;
  while (indexes.length < limit) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) break;
    indexes.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return indexes;
}

function previewLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export interface EditPreviewCandidate {
  index: number;
  line: number;
  match: string;
  contextBefore: string;
  contextAfter: string;
  isReplaceAll: boolean;
}

function buildEditCandidates(params: {
  kind: 'exact' | 'fuzzy';
  content: string;
  matches: string[];
  newString: string;
  strategy?: string;
  count?: number;
}): EditPreviewCandidate[] {
  const cursorByMatch = new Map<string, number>();
  return params.matches.slice(0, 20).map((match, index) => {
    const cursor = cursorByMatch.get(match) ?? 0;
    const matchIndex = params.content.indexOf(match, cursor);
    cursorByMatch.set(match, matchIndex >= 0 ? matchIndex + Math.max(match.length, 1) : cursor);
    const lineNum = matchIndex >= 0 ? lineNumberForIndex(params.content, matchIndex) : 0;

    // Get context lines (3 before, 3 after)
    const allLines = params.content.split('\n');
    const contextBefore = allLines.slice(Math.max(0, lineNum - 4), lineNum).join('\n');
    const contextAfter = allLines.slice(lineNum + 1, lineNum + 4).join('\n');

    return {
      index,
      line: lineNum,
      match,
      contextBefore,
      contextAfter,
      isReplaceAll: (params.count ?? 1) > 1,
    };
  });
}

function formatEditPreview(params: {
  kind: 'exact' | 'fuzzy';
  content: string;
  matches: string[];
  newString: string;
  strategy?: string;
}): string {
  const cursorByMatch = new Map<string, number>();
  const lines = [
    `Preview: ${params.kind === 'fuzzy' ? `Fuzzy ${params.strategy ?? 'match'}` : 'Exact match'} candidates (${params.matches.length})`,
  ];

  params.matches.slice(0, 20).forEach((match, index) => {
    const cursor = cursorByMatch.get(match) ?? 0;
    const matchIndex = params.content.indexOf(match, cursor);
    cursorByMatch.set(match, matchIndex >= 0 ? matchIndex + Math.max(match.length, 1) : cursor);
    const lineNum = matchIndex >= 0 ? lineNumberForIndex(params.content, matchIndex) : '?';
    lines.push(`${index + 1}. line ${lineNum}: "${previewLine(match)}"`);
  });

  if (params.matches.length > 20) {
    lines.push(`... ${params.matches.length - 20} more candidates omitted`);
  }
  lines.push(`Would replace with: "${previewLine(params.newString)}"`);
  return lines.join('\n');
}

/**
 * Attempt to find old_string in content using fuzzy matching strategies.
 * Returns null if no match found, or the matched strings.
 */
function fuzzyMatch(content: string, oldString: string): FuzzyMatchResult | null {
  // Strategy 1: Line-by-line matching (allow different indentation)
  const oldLines = oldString
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const contentLines = content.split('\n');
  const lineMatches: string[] = [];

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== oldLines[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      const matchedStr = contentLines.slice(i, i + oldLines.length).join('\n');
      lineMatches.push(matchedStr);
    }
  }

  if (lineMatches.length > 0) {
    return { matches: lineMatches, strategy: 'line' };
  }

  // Strategy 2: Whitespace-tolerant token match. This preserves the actual
  // matched span without consuming unrelated leading/trailing blank lines.
  const tokens = oldString.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const pattern = tokens.map(escapeRegExp).join('\\s+');
  const regex = new RegExp(pattern, 'g');
  const wsMatches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[0]) {
      wsMatches.push(match[0]);
    }
    if (wsMatches.length > 5) break; // Safety limit
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }

  if (wsMatches.length > 0) {
    return { matches: wsMatches, strategy: 'whitespace' };
  }

  return null;
}

async function editFile_(
  path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean,
  fuzzy_match?: boolean,
  preview?: boolean,
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
        error: `Refusing to edit outside the workspace: ${normalizedPath}`,
      };
    }
    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${normalizedPath}` };
    }
    const fileStat = safeStatSync(resolved);
    if (!fileStat) {
      return {
        success: false,
        output: '',
        error: `Cannot access file: ${normalizedPath} (may be a dangling symlink)`,
      };
    }
    if (fileStat.isDirectory()) {
      return {
        success: false,
        output: '',
        error: `Path is a directory, not a file: ${normalizedPath}`,
      };
    }

    const content = safeReadFileSync(resolved);
    if (content === null) {
      return { success: false, output: '', error: `Cannot read file: ${normalizedPath}` };
    }

    // Check if old_string exists exactly
    const count = (content.match(new RegExp(escapeRegExp(old_string), 'g')) || []).length;

    if (count > 0 && preview) {
      const matchIndexes = findAllMatchIndexes(content, old_string);
      const matches = matchIndexes.map(() => old_string);
      return {
        success: true,
        output: formatEditPreview({
          kind: 'exact',
          content,
          matches,
          newString: new_string,
        }),
        metadata: {
          candidates: buildEditCandidates({
            kind: 'exact',
            content,
            matches,
            newString: new_string,
            count,
          }),
        },
      };
    }

    if (count === 0) {
      if (!fuzzy_match) {
        return {
          success: false,
          output: '',
          error: `old_string not found in file: ${old_string.slice(0, 100)}...`,
        };
      }

      // Try fuzzy match strategies
      const fuzzyResult = fuzzyMatch(content, old_string);

      if (fuzzyResult === null) {
        return {
          success: false,
          output: '',
          error: `old_string not found in file: ${old_string.slice(0, 100)}...`,
        };
      }

      if (preview) {
        return {
          success: true,
          output: formatEditPreview({
            kind: 'fuzzy',
            content,
            matches: fuzzyResult.matches,
            newString: new_string,
            strategy: fuzzyResult.strategy,
          }),
          metadata: {
            candidates: buildEditCandidates({
              kind: 'fuzzy',
              content,
              matches: fuzzyResult.matches,
              newString: new_string,
              strategy: fuzzyResult.strategy,
            }),
          },
        };
      }

      if (fuzzyResult.matches.length > 1) {
        return {
          success: false,
          output: '',
          error: `Fuzzy match found ${fuzzyResult.matches.length} candidates. Provide a more specific string. First 3 candidates:\n${fuzzyResult.matches
            .slice(0, 3)
            .map((m, i) => `  ${i + 1}: "${m.slice(0, 80)}..."`)
            .join('\n')}`,
        };
      }

      // Use the single fuzzy match only.
      const match = fuzzyResult.matches[0];

      const idx = content.indexOf(match);
      const newContent = content.slice(0, idx) + new_string + content.slice(idx + match.length);

      writeFileSync(resolved, newContent, 'utf-8');
      return {
        success: true,
        output: `Fuzzy edited ${normalizedPath} (matched by ${fuzzyResult.strategy}, "${match.slice(0, 50)}...")`,
      };
    }

    // If not replace_all, require unique match
    if (!replace_all && count > 1) {
      return {
        success: false,
        output: '',
        error: `old_string found ${count} times in file. Use replace_all=true to replace all occurrences, or provide a more specific string that matches exactly once.`,
      };
    }

    // Perform replacement
    let newContent: string;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
    } else {
      // Replace first occurrence only
      const idx = content.indexOf(old_string);
      newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
    }

    writeFileSync(resolved, newContent, 'utf-8');

    return {
      success: true,
      output: `Replaced ${count} occurrence(s) of old_string with new_string in ${normalizedPath}`,
    };
  } catch (err) {
    return { success: false, output: '', error: errorMessage(err) };
  }
}

/** Escape special regex characters for literal matching */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
