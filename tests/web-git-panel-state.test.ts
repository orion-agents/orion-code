/**
 * v0.3.17 S2 — Git panel session store and display preference.
 *
 * The store is what lets the dock unmount the Git pane without losing the reading position,
 * so its bucketing and its refresh-repair behaviour are worth asserting directly.
 */
import {
  createGitPanelStore,
  defaultGitDisplayPreference,
  defaultGitPanelSessionState,
  gitPanelScopeKey,
  isGitPanelView,
  normalizeGitDisplayPreference,
  resolveGitPanelLayout,
  resolveSelectionAfterRefresh,
} from '../web/src/state/git-panel-state';

describe('git panel session store', () => {
  test('starts from the default and keeps updates per workspace', () => {
    const store = createGitPanelStore();
    const first = gitPanelScopeKey('ws-1');
    const second = gitPanelScopeKey('ws-2');

    expect(store.read(first)).toBe(defaultGitPanelSessionState);
    expect(store.read(first)).toBe(defaultGitPanelSessionState);

    store.update(first, { view: 'history', query: 'src/' });
    expect(store.read(first)).toMatchObject({ view: 'history', query: 'src/' });
    // A different workspace must not inherit another workspace's reading state.
    expect(store.read(second)).toBe(defaultGitPanelSessionState);

    store.clear(first);
    expect(store.read(first)).toBe(defaultGitPanelSessionState);
  });

  test('merges patches without dropping untouched fields', () => {
    const store = createGitPanelStore();
    const scope = gitPanelScopeKey('ws');
    store.update(scope, { selectedFileId: 'git_a', selectedSource: 'staged' });
    store.update(scope, { collapsedHunks: ['0:1:1'] });
    expect(store.read(scope)).toMatchObject({
      selectedFileId: 'git_a',
      selectedSource: 'staged',
      collapsedHunks: ['0:1:1'],
      view: 'changes',
    });
  });

  test('separates an empty workspace id from a real one', () => {
    expect(gitPanelScopeKey('')).not.toBe(gitPanelScopeKey('ws'));
    expect(gitPanelScopeKey('ws')).toBe('ws');
  });

  test('recognises only the declared views', () => {
    expect(isGitPanelView('changes')).toBe(true);
    expect(isGitPanelView('history')).toBe(true);
    expect(isGitPanelView('compare')).toBe(true);
    expect(isGitPanelView('nope')).toBe(false);
    expect(isGitPanelView(undefined)).toBe(false);
  });
});

describe('git display preference', () => {
  test('falls back to the default for anything unrecognised', () => {
    expect(normalizeGitDisplayPreference(null)).toBe(defaultGitDisplayPreference);
    expect(normalizeGitDisplayPreference('side-by-side')).toBe(defaultGitDisplayPreference);
    expect(normalizeGitDisplayPreference({ mode: 'weird', wrap: 'yes' })).toEqual({
      mode: 'unified',
      wrap: false,
      showWhitespace: false,
      ignoreWhitespace: false,
      wordDiff: false,
    });
  });

  test('accepts a valid stored preference', () => {
    expect(
      normalizeGitDisplayPreference({
        mode: 'side-by-side',
        wrap: true,
        showWhitespace: true,
        ignoreWhitespace: true,
        wordDiff: true,
      })
    ).toEqual({
      mode: 'side-by-side',
      wrap: true,
      showWhitespace: true,
      ignoreWhitespace: true,
      wordDiff: true,
    });
  });
});

describe('resolveSelectionAfterRefresh', () => {
  const entries = [
    { fileId: 'git_a', path: 'a.ts' },
    { fileId: 'git_b', path: 'b.ts' },
  ];

  test('keeps the current selection when it survives the refresh', () => {
    expect(
      resolveSelectionAfterRefresh({
        entries,
        previousFileId: 'git_b',
        previousPath: 'b.ts',
      })
    ).toEqual({ fileId: 'git_b', path: 'b.ts', notice: '' });
  });

  test('repairs to the same path under another source before jumping elsewhere', () => {
    const result = resolveSelectionAfterRefresh({
      entries: [{ fileId: 'git_a2', path: 'a.ts' }],
      previousFileId: 'git_a',
      previousPath: 'a.ts',
    });
    expect(result.fileId).toBe('git_a2');
    expect(result.notice).toMatch(/a\.ts/u);
  });

  test('falls back to the first entry with an explanation, and stays silent on first load', () => {
    const fellBack = resolveSelectionAfterRefresh({
      entries,
      previousFileId: 'git_gone',
      previousPath: 'gone.ts',
    });
    expect(fellBack.fileId).toBe('git_a');
    expect(fellBack.notice).toMatch(/已跳到/u);

    expect(
      resolveSelectionAfterRefresh({ entries, previousFileId: null, previousPath: null })
    ).toEqual({ fileId: 'git_a', path: 'a.ts', notice: '' });
  });

  test('clears the selection when nothing is left, without inventing a notice', () => {
    expect(
      resolveSelectionAfterRefresh({ entries: [], previousFileId: 'git_a', previousPath: 'a.ts' })
    ).toEqual({ fileId: null, path: null, notice: '' });
  });
});

/**
 * v0.3.19 (G317-19) — the responsive tier, asserted at the widths the plan names
 * (panel 960 / 620 / 360) instead of only in whichever browser window was open.
 */
describe('resolveGitPanelLayout', () => {
  test('the plan widths pick the documented tiers', () => {
    expect(resolveGitPanelLayout(960, 'side-by-side')).toEqual({
      tier: 'wide',
      narrow: false,
      effectiveMode: 'side-by-side',
      dataWidth: 'wide',
    });
    expect(resolveGitPanelLayout(620, 'side-by-side')).toEqual({
      tier: 'narrow',
      narrow: true,
      // 620 <= 640, so two code columns would be dishonest here.
      effectiveMode: 'unified',
      dataWidth: 'narrow',
    });
    expect(resolveGitPanelLayout(360, 'side-by-side')).toEqual({
      tier: 'narrow',
      narrow: true,
      effectiveMode: 'unified',
      dataWidth: 'narrow',
    });
  });

  test('the tier boundaries are inclusive where the plan says they are', () => {
    expect(resolveGitPanelLayout(620, 'unified').tier).toBe('narrow');
    expect(resolveGitPanelLayout(621, 'unified').tier).toBe('compact');
    expect(resolveGitPanelLayout(959, 'unified').tier).toBe('compact');
    expect(resolveGitPanelLayout(960, 'unified').tier).toBe('wide');
    // The side-by-side floor is separate from the narrow ceiling, on purpose.
    expect(resolveGitPanelLayout(640, 'side-by-side').effectiveMode).toBe('unified');
    expect(resolveGitPanelLayout(641, 'side-by-side').effectiveMode).toBe('side-by-side');
  });

  test('an unmeasured panel is wide, never guessed to be narrow', () => {
    // Before the first ResizeObserver callback the width is unknown; the unconstrained render
    // is the safe default, and a narrow panel must never be inferred from a missing number.
    for (const width of [0, -1, Number.NaN]) {
      expect(resolveGitPanelLayout(width, 'side-by-side')).toEqual({
        tier: 'wide',
        narrow: false,
        effectiveMode: 'side-by-side',
        dataWidth: 'wide',
      });
    }
  });

  test('the narrowed mode is a rendering decision, never written back to the preference', () => {
    const narrow = resolveGitPanelLayout(360, 'side-by-side');
    // The stored preference is unchanged — a narrow container must not downgrade a wide one.
    expect(narrow.effectiveMode).toBe('unified');
    expect(resolveGitPanelLayout(1400, 'side-by-side').effectiveMode).toBe('side-by-side');
  });
});
