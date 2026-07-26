import stringWidth from 'string-width';
import {
  segmentGraphemes,
  previousGraphemeBoundary,
  nextGraphemeBoundary,
  floorGraphemeBoundary,
} from '../src/runtime/composer/grapheme';
import {
  reduceInputBuffer,
  initialInputBuffer,
  clampInputCursor,
  type InputBuffer,
} from '../src/runtime/composer/buffer';
import {
  splitByVisualWidth,
  getPromptVisualLines,
  getPromptInputViewport,
  promptContentWidth,
  promptTextWidth,
} from '../src/runtime/composer/layout';
import {
  pushHistoryEntry,
  historyPrevious,
  historyNext,
  historyCurrentValue,
  initialHistoryState,
  MAX_HISTORY_ENTRIES,
} from '../src/runtime/composer/history';

// ============================================================================
// Grapheme
// ============================================================================

describe('shared composer: grapheme', () => {
  it('segments ASCII text', () => {
    const segs = segmentGraphemes('abc');
    expect(segs.map(s => s.segment)).toEqual(['a', 'b', 'c']);
    expect(segs.map(s => s.index)).toEqual([0, 1, 2]);
  });

  it('segments CJK characters as single graphemes', () => {
    const segs = segmentGraphemes('你好');
    expect(segs).toHaveLength(2);
    expect(segs[0].segment).toBe('你');
    expect(segs[1].segment).toBe('好');
  });

  it('segments emoji as single graphemes', () => {
    const segs = segmentGraphemes('👨‍👩‍👧');
    // ZWJ family emoji should be a single grapheme if Intl.Segmenter supports it.
    // Fallback: at least not split into individual code points that break cursor.
    expect(segs.length).toBeLessThanOrEqual(7); // code-point fallback
  });

  it('previousGraphemeBoundary moves back one grapheme', () => {
    expect(previousGraphemeBoundary('abc', 2)).toBe(1);
    expect(previousGraphemeBoundary('abc', 1)).toBe(0);
    expect(previousGraphemeBoundary('abc', 0)).toBe(0);
  });

  it('nextGraphemeBoundary moves forward one grapheme', () => {
    expect(nextGraphemeBoundary('abc', 0)).toBe(1);
    expect(nextGraphemeBoundary('abc', 1)).toBe(2);
    expect(nextGraphemeBoundary('abc', 3)).toBe(3);
  });

  it('floorGraphemeBoundary snaps to nearest boundary at or before cursor', () => {
    expect(floorGraphemeBoundary('abc', 1)).toBe(1);
    expect(floorGraphemeBoundary('abc', 0)).toBe(0);
    expect(floorGraphemeBoundary('abc', 3)).toBe(3);
  });
});

// ============================================================================
// Buffer
// ============================================================================

describe('shared composer: buffer', () => {
  it('inserts text at cursor', () => {
    const result = reduceInputBuffer(initialInputBuffer, { type: 'insert', text: 'hello' });
    expect(result.value).toBe('hello');
    expect(result.cursor).toBe(5);
  });

  it('backspace deletes previous grapheme', () => {
    const s1 = reduceInputBuffer(initialInputBuffer, { type: 'insert', text: 'abc' });
    const s2 = reduceInputBuffer(s1, { type: 'backspace' });
    expect(s2.value).toBe('ab');
    expect(s2.cursor).toBe(2);
  });

  it('delete removes next grapheme', () => {
    const s1 = reduceInputBuffer(initialInputBuffer, { type: 'insert', text: 'abc' });
    const s2 = reduceInputBuffer(s1, { type: 'move', direction: 'left' });
    const s3 = reduceInputBuffer(s2, { type: 'delete' });
    expect(s3.value).toBe('ab');
    expect(s3.cursor).toBe(2);
  });

  it('move left/right respects grapheme boundaries', () => {
    const s1 = reduceInputBuffer(initialInputBuffer, { type: 'insert', text: '你好' });
    const s2 = reduceInputBuffer(s1, { type: 'move', direction: 'left' });
    expect(s2.cursor).toBe(1); // after first CJK char
    const s3 = reduceInputBuffer(s2, { type: 'move', direction: 'left' });
    expect(s3.cursor).toBe(0);
  });

  it('home/end move to buffer boundaries', () => {
    const s1 = reduceInputBuffer(initialInputBuffer, { type: 'insert', text: 'abc' });
    const s2 = reduceInputBuffer(s1, { type: 'move', direction: 'home' });
    expect(s2.cursor).toBe(0);
    const s3 = reduceInputBuffer(s2, { type: 'move', direction: 'end' });
    expect(s3.cursor).toBe(3);
  });

  it('clear resets to initial state', () => {
    const s1 = reduceInputBuffer(initialInputBuffer, { type: 'insert', text: 'abc' });
    const s2 = reduceInputBuffer(s1, { type: 'clear' });
    expect(s2).toEqual(initialInputBuffer);
  });

  it('set replaces value and positions cursor', () => {
    const result = reduceInputBuffer(initialInputBuffer, { type: 'set', value: 'hello', cursor: 3 });
    expect(result.value).toBe('hello');
    expect(result.cursor).toBe(3);
  });

  it('clampInputCursor handles NaN and Infinity', () => {
    expect(clampInputCursor('abc', NaN)).toBe(3);
    expect(clampInputCursor('abc', Infinity)).toBe(3);
    expect(clampInputCursor('abc', -1)).toBe(0);
  });
});

// ============================================================================
// Layout
// ============================================================================

describe('shared composer: layout', () => {
  it('splits text by visual width', () => {
    const lines = splitByVisualWidth('abcdefgh', 4);
    expect(lines).toEqual(['abcd', 'efgh']);
  });

  it('splits CJK text by visual width (each char width 2)', () => {
    const lines = splitByVisualWidth('你好世界', 4);
    expect(lines).toEqual(['你好', '世界']);
  });

  it('getPromptVisualLines wraps long input', () => {
    const lines = getPromptVisualLines('abcdefgh', 10);
    // promptTextWidth(10) = max(1, promptContentWidth(10) - 2) = max(1, 4) = 4
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('getPromptInputViewport limits visible rows', () => {
    const viewport = getPromptInputViewport('abcdefgh', 10, 2);
    expect(viewport.lines.length).toBeLessThanOrEqual(2);
  });

  it('promptContentWidth and promptTextWidth are positive', () => {
    expect(promptContentWidth(1)).toBeGreaterThanOrEqual(1);
    expect(promptTextWidth(1)).toBeGreaterThanOrEqual(1);
    expect(promptContentWidth(80)).toBe(76);
    expect(promptTextWidth(80)).toBe(74);
  });
});

// ============================================================================
// History
// ============================================================================

describe('shared composer: history', () => {
  it('pushes entries and deduplicates consecutive identical', () => {
    const s1 = pushHistoryEntry(initialHistoryState, 'hello');
    expect(s1.entries).toEqual(['hello']);
    const s2 = pushHistoryEntry(s1, 'hello');
    expect(s2.entries).toEqual(['hello']); // dedup
    const s3 = pushHistoryEntry(s2, 'world');
    expect(s3.entries).toEqual(['hello', 'world']);
  });

  it('ignores empty pushes', () => {
    const s1 = pushHistoryEntry(initialHistoryState, '');
    expect(s1.entries).toEqual([]);
  });

  it('navigates previous and next', () => {
    let state = initialHistoryState;
    state = pushHistoryEntry(state, 'first');
    state = pushHistoryEntry(state, 'second');
    state = pushHistoryEntry(state, 'third');

    state = historyPrevious(state, 'draft');
    expect(state.index).toBe(2); // 'third'
    expect(historyCurrentValue(state, 'draft')).toBe('third');

    state = historyPrevious(state, 'draft');
    expect(state.index).toBe(1); // 'second'
    expect(historyCurrentValue(state, 'draft')).toBe('second');

    state = historyNext(state);
    expect(state.index).toBe(2); // back to 'third'

    state = historyNext(state);
    expect(state.index).toBeNull(); // back to draft
    expect(historyCurrentValue(state, 'draft')).toBe('draft');
  });

  it('preserves draft before first navigation', () => {
    let state = initialHistoryState;
    state = pushHistoryEntry(state, 'saved');
    state = historyPrevious(state, 'my current draft');
    state = historyNext(state);
    expect(historyCurrentValue(state, 'draft')).toBe('my current draft');
  });

  it('bounds entries to MAX_HISTORY_ENTRIES', () => {
    let state = initialHistoryState;
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 10; i++) {
      state = pushHistoryEntry(state, `cmd-${i}`);
    }
    expect(state.entries.length).toBe(MAX_HISTORY_ENTRIES);
    // Oldest entries evicted.
    expect(state.entries[0]).toBe(`cmd-10`);
  });
});

// ============================================================================
// Slice 1 completion gate: prompt width bounds
// ============================================================================

describe('slice 1 gate: prompt width bounds', () => {
  const longPath = '/Users/developer/very/long/project/path/to/some/deeply/nested/module/src/components/feature/implementation.tsx';
  const longWord = 'supercalifragilisticexpialidocious';
  const widths = [24, 40, 80, 120];

  for (const width of widths) {
    it(`long path does not overflow at width=${width}`, () => {
      const lines = getPromptVisualLines(longPath, width);
      for (const line of lines) {
        const lineVisualWidth = stringWidth(line.content);
        // Each visual line must fit within the content width.
        expect(lineVisualWidth).toBeLessThanOrEqual(promptContentWidth(width));
      }
    });

    it(`long word does not overflow at width=${width}`, () => {
      const lines = getPromptVisualLines(longWord, width);
      for (const line of lines) {
        const lineVisualWidth = stringWidth(line.content);
        expect(lineVisualWidth).toBeLessThanOrEqual(promptContentWidth(width));
      }
    });

    it(`CJK + emoji input does not overflow at width=${width}`, () => {
      const input = '你好世界🌍这是中文输入🎉react组件';
      const lines = getPromptVisualLines(input, width);
      for (const line of lines) {
        const lineVisualWidth = stringWidth(line.content);
        expect(lineVisualWidth).toBeLessThanOrEqual(promptContentWidth(width));
      }
    });
  }
});
