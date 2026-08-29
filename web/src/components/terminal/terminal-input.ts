export interface TerminalPasteSummaryV1 {
  readonly lineCount: number;
  readonly characterCount: number;
}

/** Pasted text that could execute or inject terminal control sequences requires confirmation. */
export function requiresTerminalPasteConfirmation(text: string): boolean {
  return /[\r\n\u001b]/u.test(text);
}

export function summarizeTerminalPaste(text: string): TerminalPasteSummaryV1 {
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  return Object.freeze({
    lineCount: normalized ? normalized.split('\n').length : 0,
    characterCount: [...text].length,
  });
}
