/**
 * orion code - Memory Drift Validation
 *
 * Validates that memory content references (files, symbols) still exist.
 * Prevents stale memories from causing confusion.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { extname, join, resolve } from 'path';
import type { MemoryEntry } from './types';

const SYMBOL_SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
]);
const SYMBOL_SCAN_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.orion-code',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);
const MAX_SYMBOL_SCAN_FILES = 10_000;
const MAX_SYMBOL_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SYMBOL_FILE_BYTES = 2 * 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

export type DriftType = 'file_missing' | 'symbol_missing' | 'url_invalid';

export interface DriftItem {
  type: DriftType;
  ref: string;
  message: string;
}

export interface DriftResult {
  valid: boolean;
  drifts: DriftItem[];
  /** False means symbol absence was not reported because the bounded scan was incomplete. */
  symbolScanComplete: boolean;
  symbolFilesScanned: number;
}

interface SymbolIndex {
  symbols: Set<string>;
  complete: boolean;
  filesScanned: number;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a memory entry for drift (stale references)
 * @param entry - Memory entry to validate
 * @param projectPath - Project path for resolving file references
 */
export function validateMemoryDrift(entry: MemoryEntry, projectPath: string): DriftResult {
  return validateMemoryDriftWithIndex(entry, projectPath);
}

function validateMemoryDriftWithIndex(
  entry: MemoryEntry,
  projectPath: string,
  symbolIndex?: SymbolIndex
): DriftResult {
  const drifts: DriftItem[] = [];
  const content = entry.content;

  // 1. Check file path references
  const fileRefs = extractFilePaths(content);
  for (const ref of fileRefs) {
    const fullPath = join(projectPath, ref);
    if (!existsSync(fullPath)) {
      drifts.push({
        type: 'file_missing',
        ref,
        message: `File not found: ${ref}`,
      });
    }
  }

  // 2. Check symbol references (function/class names)
  const symbolRefs = extractSymbolRefs(content);
  const effectiveSymbolIndex =
    symbolRefs.length > 0
      ? (symbolIndex ?? buildProjectSymbolIndex(projectPath))
      : emptySymbolIndex();
  if (effectiveSymbolIndex.complete) {
    for (const ref of symbolRefs) {
      if (!effectiveSymbolIndex.symbols.has(ref)) {
        drifts.push({
          type: 'symbol_missing',
          ref,
          message: `Symbol not found in project source: ${ref}`,
        });
      }
    }
  }

  // 3. Check URL references (basic format check)
  const urlRefs = extractUrls(content);
  for (const ref of urlRefs) {
    if (!isValidUrlFormat(ref)) {
      drifts.push({
        type: 'url_invalid',
        ref,
        message: `Invalid URL format: ${ref}`,
      });
    }
  }

  return {
    valid: drifts.length === 0 && effectiveSymbolIndex.complete,
    drifts,
    symbolScanComplete: effectiveSymbolIndex.complete,
    symbolFilesScanned: effectiveSymbolIndex.filesScanned,
  };
}

/**
 * Validate all memories in a project
 */
export function validateAllMemories(projectPath: string): Map<string, DriftResult> {
  const results = new Map<string, DriftResult>();

  // Import loadAllMemories dynamically to avoid circular dependency
  const { loadAllMemories } = require('./storage');
  const memories = loadAllMemories(projectPath);
  const needsSymbolIndex = memories.some(
    (memory: MemoryEntry) => extractSymbolRefs(memory.content).length > 0
  );
  const symbolIndex = needsSymbolIndex ? buildProjectSymbolIndex(projectPath) : emptySymbolIndex();

  for (const mem of memories) {
    const result = validateMemoryDriftWithIndex(mem, projectPath, symbolIndex);
    results.set(mem.name, result);
  }

  return results;
}

function emptySymbolIndex(): SymbolIndex {
  return { symbols: new Set<string>(), complete: true, filesScanned: 0 };
}

/** Build one bounded, deterministic source-symbol index for a validation pass. */
function buildProjectSymbolIndex(projectPath: string): SymbolIndex {
  const root = resolve(projectPath);
  const symbols = new Set<string>();
  const pending = [root];
  let filesScanned = 0;
  let bytesScanned = 0;
  let complete = true;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch {
      complete = false;
      continue;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SYMBOL_SCAN_IGNORED_DIRECTORIES.has(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile() || !SYMBOL_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }

      if (filesScanned >= MAX_SYMBOL_SCAN_FILES) {
        complete = false;
        pending.length = 0;
        break;
      }

      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        complete = false;
        continue;
      }
      if (size > MAX_SYMBOL_FILE_BYTES || bytesScanned + size > MAX_SYMBOL_SCAN_BYTES) {
        complete = false;
        if (bytesScanned + size > MAX_SYMBOL_SCAN_BYTES) pending.length = 0;
        continue;
      }

      try {
        const source = readFileSync(path, 'utf8');
        const identifiers = source.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g);
        if (identifiers) {
          for (const identifier of identifiers) symbols.add(identifier);
        }
        filesScanned += 1;
        bytesScanned += size;
      } catch {
        complete = false;
      }
    }
  }

  return { symbols, complete, filesScanned };
}

// ============================================================================
// Extraction Helpers
// ============================================================================

/**
 * Extract file path references from content
 * Matches patterns like:
 * - src/file.ts
 * - ./path/to/file.js
 * - /absolute/path.py
 * - file.md
 */
function extractFilePaths(content: string): string[] {
  const paths: string[] = [];

  // Match relative paths (common code references)
  const relativePathRegex =
    /(?:\.\/|src\/|lib\/|tests\/|docs\/|[\w-]+\/)[\w-]+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml)/g;
  const matches = content.match(relativePathRegex);
  if (matches) {
    paths.push(...matches);
  }

  // Match quoted file paths
  const quotedPathRegex = /['"`]([\w/-]+\.[\w]+)['"`]/g;
  let match;
  while ((match = quotedPathRegex.exec(content)) !== null) {
    const path = match[1];
    // Skip if it looks like a URL
    if (!path.startsWith('http') && !path.includes('://')) {
      paths.push(path);
    }
  }

  return [...new Set(paths)]; // unique
}

/**
 * Extract symbol references (function/class names) from content
 */
function extractSymbolRefs(content: string): string[] {
  const symbols: string[] = [];

  // Match camelCase or PascalCase identifiers that look like code symbols
  const symbolRegex =
    /\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = symbolRegex.exec(content)) !== null) {
    symbols.push(match[1]);
  }

  // Match `SymbolName` references in text
  const refRegex = /`([A-Za-z_][A-Za-z0-9_]*)`/g;
  while ((match = refRegex.exec(content)) !== null) {
    symbols.push(match[1]);
  }

  return [...new Set(symbols)]; // unique
}

/**
 * Extract URL references from content
 */
function extractUrls(content: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"']+/g;
  const matches = content.match(urlRegex);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Basic URL format validation
 */
function isValidUrlFormat(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
