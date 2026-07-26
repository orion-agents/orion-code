/**
 * orion code - Memory Drift Validation
 *
 * Validates that memory content references (files, symbols) still exist.
 * Prevents stale memories from causing confusion.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import type { MemoryEntry } from './types';

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
  for (const ref of symbolRefs) {
    // For now, we just check if the symbol looks valid (not a comprehensive grep)
    // A full implementation would grep the project for the symbol
    if (ref.length < 2 || ref.includes(' ')) {
      // Likely not a valid symbol name
      continue;
    }
    // Note: Full symbol validation would require grep search
    // For simplicity, we skip comprehensive validation here
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
    valid: drifts.length === 0,
    drifts,
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

  for (const mem of memories) {
    const result = validateMemoryDrift(mem, projectPath);
    results.set(mem.name, result);
  }

  return results;
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
  const relativePathRegex = /(?:\.\/|src\/|lib\/|tests\/|docs\/|[\w-]+\/)[\w-]+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml)/g;
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

  return [...new Set(paths)];  // unique
}

/**
 * Extract symbol references (function/class names) from content
 */
function extractSymbolRefs(content: string): string[] {
  const symbols: string[] = [];

  // Match camelCase or PascalCase identifiers that look like code symbols
  const symbolRegex = /\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = symbolRegex.exec(content)) !== null) {
    symbols.push(match[1]);
  }

  // Match `SymbolName` references in text
  const refRegex = /`([A-Za-z_][A-Za-z0-9_]*)`/g;
  while ((match = refRegex.exec(content)) !== null) {
    symbols.push(match[1]);
  }

  return [...new Set(symbols)];  // unique
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