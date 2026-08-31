import type { WebSessionSummaryV1 } from '../web/src/types';
import { upsertSessionSummary } from '../web/src/state/session-collection';

const session = (id: string, name: string): WebSessionSummaryV1 => ({
  id,
  projectPath: '/workspace',
  name,
  taskSummary: '',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
  messageCount: 0,
  model: 'test-model',
  contextDigest: 'sha256:test-context',
});

describe('Session summary collection', () => {
  it('replaces an existing summary without reordering the collection', () => {
    const first = session('session-a', 'First');
    const second = session('session-b', 'Second');
    const renamed = session('session-b', 'Renamed');

    expect(upsertSessionSummary([first, second], renamed)).toEqual([first, renamed]);
  });

  it('prepends a newly observed active Session instead of dropping it', () => {
    const existing = session('session-a', 'Existing');
    const created = session('session-b', 'Created');

    expect(upsertSessionSummary([existing], created)).toEqual([created, existing]);
  });
});
