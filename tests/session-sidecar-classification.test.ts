/**
 * v0.2.23 Slice 1 - Session sidecar classification tests.
 *
 * These assertions exercise the production scanner predicate directly so a
 * sidecar addition cannot silently diverge from a copied test implementation.
 */

import { isSessionMetaFile, SESSION_SIDECAR_SUFFIXES } from '../src/services/session-storage';

describe('Session sidecar classification', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';

  it('accepts only the canonical session metadata filename', () => {
    expect(isSessionMetaFile(`${sessionId}.json`)).toBe(true);
    expect(isSessionMetaFile(`${sessionId}.jsonl`)).toBe(false);
    expect(isSessionMetaFile(`${sessionId}.txt`)).toBe(false);
  });

  it.each(SESSION_SIDECAR_SUFFIXES)('excludes the %s sidecar from scanning', suffix => {
    expect(isSessionMetaFile(`${sessionId}${suffix}`)).toBe(false);
  });

  it('covers every persisted JSON sidecar suffix used by the session services', () => {
    expect(new Set(SESSION_SIDECAR_SUFFIXES)).toEqual(
      new Set([
        '.messages.json',
        '.harness.json',
        '.compact.json',
        '.runtime.json',
        '.trace.json',
        '.goal.json',
        '.index.json',
      ])
    );
  });
});
