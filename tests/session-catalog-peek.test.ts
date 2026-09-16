/**
 * v0.3.17 — the picker's session-count peek must never pay for a catalog
 * rebuild. With a pristine module (no catalog loaded yet) it has to answer
 * `null` rather than reading, scanning or locking anything, so the caller can
 * mark the count as deferred instead of blocking the confirmation card.
 */
describe('peekCachedSessionCounts', () => {
  it('returns null before any catalog has been loaded', () => {
    jest.isolateModules(() => {
      // A fresh module registry means an empty in-memory catalog cache.
      const fresh =
        require('../src/services/session-storage') as typeof import('../src/services/session-storage');
      expect(fresh.peekCachedSessionCounts()).toBeNull();
    });
  });
});
