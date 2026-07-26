/**
 * Multiline input state tests.
 */

import {
  addMultilineLine,
  enterMultiline,
  getMultilineInput,
  getMultilineLines,
  isMultilineActive,
  resetMultiline,
  shouldEnterMultiline,
} from '../src/ui/multiline-input';

describe('Multiline input', () => {
  beforeEach(() => {
    resetMultiline();
  });

  afterEach(() => {
    resetMultiline();
  });

  test('keeps multiline mode active while continuation lines end with backslash', () => {
    expect(shouldEnterMultiline('first \\')).toBe(true);

    enterMultiline('first \\');
    expect(isMultilineActive()).toBe(true);
    expect(getMultilineLines()).toEqual(['first ']);

    addMultilineLine('second \\');
    expect(isMultilineActive()).toBe(true);
    expect(getMultilineLines()).toEqual(['first ', 'second ']);

    addMultilineLine('third');
    expect(isMultilineActive()).toBe(false);
    expect(getMultilineInput()).toBe('first \nsecond \nthird');
  });
});
