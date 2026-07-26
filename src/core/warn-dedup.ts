/**
 * orion code - Warning Deduplication
 *
 * Suppresses repeated console warnings in CI and interactive sessions.
 * Each unique warning key is emitted once, with a counter for subsequent
 * identical warnings. On process exit or explicit flush, a summary line
 * reports how many duplicates were suppressed.
 *
 * Usage:
 *   import { warnOnce, flushWarnings } from '../core/warn-dedup';
 *   warnOnce('sqlite-vec', '[VectorStore] sqlite-vec not available: ...');
 */

import chalk from 'chalk';

interface WarningCount {
  message: string;
  count: number;
}

const _seen = new Map<string, WarningCount>();
let _flushed = false;

/**
 * Emit a warning only once per unique key. Subsequent calls with the same
 * key are silently counted.
 *
 * @param key Stable identifier (e.g. 'sqlite-vec', 'skill-frontmatter')
 * @param message Warning text (logged on first occurrence)
 */
export function warnOnce(key: string, message: string): void {
  if (_flushed) return;

  const existing = _seen.get(key);
  if (!existing) {
    _seen.set(key, { message, count: 1 });
    console.warn(chalk.yellow(`⚠ ${message}`));
    return;
  }

  existing.count++;
}

/**
 * Flush accumulated warning summary. Call once at session exit or test
 * teardown. Returns the summary string (empty if no warnings were seen).
 */
export function flushWarnings(): string {
  if (_flushed || _seen.size === 0) return '';
  _flushed = true;

  const lines: string[] = [];
  let suppressed = 0;

  for (const [, wc] of _seen) {
    if (wc.count > 1) {
      suppressed += wc.count - 1;
      lines.push(`  [x${wc.count}] ${wc.message}`);
    }
  }

  if (suppressed > 0) {
    lines.unshift(chalk.yellow(`\n⚠ ${suppressed} duplicate warning(s) suppressed:`));
    const summary = lines.join('\n');
    console.warn(summary);
    return summary;
  }

  return '';
}

/**
 * Reset dedup state (for tests).
 */
export function resetWarnings(): void {
  _seen.clear();
  _flushed = false;
}

/**
 * Return the current dedup state for testing.
 */
export function getWarningState(): ReadonlyMap<string, WarningCount> {
  return _seen;
}
