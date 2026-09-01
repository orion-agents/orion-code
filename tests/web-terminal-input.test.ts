import {
  requiresTerminalPasteConfirmation,
  summarizeTerminalPaste,
} from '../web/src/components/terminal/terminal-input';

describe('Web terminal input safety', () => {
  test.each([
    ['single line', false],
    ['single line with spaces', false],
    ['printf one\nprintf two', true],
    ['printf one\rprintf two', true],
    ['printf one\r\nprintf two', true],
    ['\u001b[31mcontrol sequence', true],
  ])('classifies %p confirmation as %p', (text, expected) => {
    expect(requiresTerminalPasteConfirmation(text)).toBe(expected);
  });

  test('summarizes content without returning its text', () => {
    expect(summarizeTerminalPaste('one\r\ntwo\n三')).toEqual({
      lineCount: 3,
      characterCount: 10,
    });
    expect(summarizeTerminalPaste('')).toEqual({ lineCount: 0, characterCount: 0 });
  });
});
