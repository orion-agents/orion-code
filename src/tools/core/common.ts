import { existsSync, lstatSync, readFileSync, statSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';

import type { ToolResult } from '../../framework/tool';
import { isWorkspacePath } from '../../services/workspace-containment';
import { debugError } from '../../utils/debug-log';

export function validateOptionalSafeInteger(
  args: Record<string, unknown>,
  toolName: string,
  field: string,
  minimum: number,
  maximum: number
): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return `${toolName} ${field} must be a safe integer between ${minimum} and ${maximum}`;
  }
  return undefined;
}

export function compactOneLine(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 3) return compact.slice(0, maxLength);

  const headLength = Math.ceil((maxLength - 3) * 0.55);
  const tailLength = Math.floor((maxLength - 3) * 0.45);
  return `${compact.slice(0, headLength)}...${compact.slice(-tailLength)}`;
}

export function summarizeFailedToolResult(result: ToolResult): string {
  const details: string[] = [];
  if (result.error) {
    details.push(compactOneLine(result.error, 80));
  }

  const output = result.output ? compactOneLine(result.output, 120) : '';
  if (output && output !== result.error) {
    details.push(`output: ${output}`);
  }

  return details.join('; ');
}

/** Normalize model/tool path strings before resolving them on disk. */
export function normalizeToolPath(input: string): string {
  let value = input.trim();

  const markdownLink = value.match(/^!?\[[^\]]*\]\(([\s\S]+)\)$/u);
  if (markdownLink) {
    value = markdownLink[1].trim();
    if (value.startsWith('<')) {
      const end = value.indexOf('>');
      if (end >= 0) {
        value = value.slice(1, end);
      }
    } else {
      value = value.replace(/\s+["'][\s\S]*["']$/u, '');
    }
  }

  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  if (value.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      // Malformed URL or bad percent-encoding: strip the scheme so the path
      // still reaches the caller's own validation instead of vanishing.
      return value.replace(/^file:\/\//u, '');
    }
  }

  // Plain filesystem paths are not URLs: do NOT percent-decode them, or a
  // literal filename like "lit%41.txt" is silently rewritten to "litA.txt".
  return value;
}

/** Safely stat a path, returning null for dangling symlinks or missing files
 *  instead of throwing ENOENT. Uses lstatSync to avoid following symlinks
 *  when checking existence. */
export function safeStatSync(resolved: string): ReturnType<typeof statSync> | null {
  try {
    // lstatSync does NOT follow symlinks — safe for dangling ones.
    const lst = lstatSync(resolved);
    if (lst.isSymbolicLink()) {
      // For symlinks, use statSync (follows the link) inside try/catch.
      // If the target doesn't exist, statSync throws ENOENT — catch and return null.
      try {
        return statSync(resolved);
      } catch {
        return null; // dangling symlink
      }
    }
    return statSync(resolved);
  } catch {
    return null; // path doesn't exist at all
  }
}

/** Read a file safely, returning null for dangling symlinks or unreadable files. */
export function safeReadFileSync(resolved: string): string | null {
  try {
    // Check if it's a dangling symlink before attempting read.
    const st = safeStatSync(resolved);
    if (!st || st.isDirectory()) return null;
    return readFileSync(resolved, 'utf-8');
  } catch (error) {
    // Permission denied or a binary that is not valid UTF-8; callers treat null
    // as "no content", which otherwise hides a real read failure.
    debugError('tools.safeReadFile', error, resolved);
    return null;
  }
}

/** Resolve tool path parameters relative to the current tool cwd. */
export function safePath(input: string, cwd = process.cwd()): string {
  return resolve(cwd, normalizeToolPath(input));
}

/**
 * Return true when `p` resolves (after following symlinks) to a location at or
 * under `rootReal`. Used to enforce that a realpath is still inside the
 * workspace even when directories along the path are themselves symlinks.
 */
export function isWithinWorkspace(resolved: string, cwd: string): boolean {
  return isWorkspacePath(cwd, resolved);
}

export function isExecCwdWithinWorkspace(workdir: string, projectRoot: string): boolean {
  const root = resolve(projectRoot);
  const rel = relative(root, workdir);
  if (!(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))) return false;
  // A missing synthetic root can only fail at spawn time; lexical containment
  // still prevents it from selecting an external directory. Real workspaces
  // take the shared symlink-aware boundary check.
  return existsSync(root) ? isWorkspacePath(root, workdir) : true;
}

/**
 * Truncate text to at most maxBytes UTF-8 bytes, cutting on a character
 * boundary (never inside a multi-byte sequence or surrogate pair). Returns the
 * truncated text and the byte length it was cut at. String.slice counts UTF-16
 * code units, not bytes, so it is wrong for enforcing a byte budget on CJK or
 * emoji content and can split a surrogate pair.
 */
export function truncateToBytes(text: string, maxBytes: number): { text: string; bytes: number } {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return { text, bytes: buf.length };
  let cut = maxBytes;
  // Walk back past UTF-8 continuation bytes (0x80-0xBF) to a lead-byte boundary.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf-8'), bytes: cut };
}
