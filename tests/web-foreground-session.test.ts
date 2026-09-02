import { selectPreferredForegroundSession } from '../web/src/state/foreground-session';

describe('Web foreground Session selection', () => {
  it('preserves a browser-owned Session outside the loaded catalog page', () => {
    expect(
      selectPreferredForegroundSession(
        'stored-session-outside-page',
        [{ id: 'first-loaded-session' }],
        'first-loaded-session'
      )
    ).toBe('stored-session-outside-page');
  });

  it('uses an available Host default only when no browser selection exists', () => {
    expect(
      selectPreferredForegroundSession(
        null,
        [{ id: 'first-loaded-session' }, { id: 'host-default' }],
        'host-default'
      )
    ).toBe('host-default');
    expect(
      selectPreferredForegroundSession(null, [{ id: 'first-loaded-session' }], 'missing-default')
    ).toBe('first-loaded-session');
  });
});
