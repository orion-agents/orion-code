export function countCtrlCEvents(value: string): number {
  return value.split('\x03').length - 1;
}

export function deleteActionFromRawInput(rawInput: string): 'backspace' | 'delete' {
  return rawInput.includes('\x1b[3~') ? 'delete' : 'backspace';
}

export function hasDeletionRawInput(rawInput: string): boolean {
  return rawInput.includes('\x7f') || rawInput.includes('\x08') || rawInput.includes('\x1b[3~');
}
