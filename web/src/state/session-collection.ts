import type { WebSessionSummaryV1 } from '../types';

/** Replace a known Session summary or prepend a newly observed active Session. */
export function upsertSessionSummary(
  sessions: readonly WebSessionSummaryV1[],
  updated: WebSessionSummaryV1
): readonly WebSessionSummaryV1[] {
  return sessions.some(session => session.id === updated.id)
    ? sessions.map(session => (session.id === updated.id ? updated : session))
    : [updated, ...sessions];
}
