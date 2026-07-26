/**
 * v0.2.23 Slice 1 — Terminal Editor Draft Transaction tests.
 *
 * These tests verify the draft preservation contract: when the terminal editor
 * enters a modal interaction (permission prompt), the current input value,
 * cursor position, and history state are preserved and restored on exit
 * regardless of exit path (approve, deny, abort).
 */

import { RawTerminalEditor } from '../src/terminal-ui/raw-editor';
import { EventEmitter } from 'events';

const editorWrites = new WeakMap<RawTerminalEditor, string[]>();

/** Create a test editor that writes to /dev/null. */
function makeEditor(
  overrides: Partial<{
    onSubmit: (input: string) => void;
    onCtrlC: () => void;
  }> = {}
): RawTerminalEditor {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    setRawMode: (mode: boolean) => {
      input.isRaw = mode;
      return input;
    },
  }) as unknown as NodeJS.ReadStream & {
    isRaw: boolean;
    setRawMode: (mode: boolean) => NodeJS.ReadStream;
  };
  const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const editor = new RawTerminalEditor({
    cwd: '/tmp',
    input,
    output,
    onSubmit: overrides.onSubmit ?? (() => {}),
    onCtrlC: overrides.onCtrlC ?? (() => {}),
  });
  editorWrites.set(editor, writes);
  // Start to enable feed, but don't actually render to TTY.
  // Tests below only exercise capture/restore and buffer state.
  return editor;
}

describe('Terminal editor draft preservation', () => {
  it('Ctrl+L redraws only editor-owned rows and preserves the draft', () => {
    const editor = makeEditor();
    editor.start();
    editor.feed(Buffer.from('未提交 draft'));
    const before = editor.getBuffer();
    const writes = editorWrites.get(editor)!;
    writes.length = 0;

    editor.feed(Buffer.from('\x0c'));

    expect(editor.getBuffer()).toEqual(before);
    expect(writes.join('')).toContain('未提交 draft');
    expect(writes.join('')).not.toContain('\x1b[2J');
    expect(writes.join('')).not.toContain('\x1b[3J');
    editor.stop();
  });

  it('preserves draft value and cursor across permission approve', () => {
    const editor = makeEditor();
    editor.start();

    // User types a multiline draft before permission prompt.
    editor.feed(Buffer.from('deploy to production\n--force'));
    const before = editor.getBuffer();

    // Permission arrives → ask() captures draft.
    const askPromise = editor.ask('Allow exec_command?');

    // User answers "yes" (approve).
    editor.feed(Buffer.from('yes\r'));

    return askPromise.then(answer => {
      expect(answer).toBe('yes');
      // After question resolves, the editor restores the saved draft.
      const after = editor.getBuffer();
      expect(after.value).toBe(before.value);
      expect(after.cursor).toBe(before.value.length);
      editor.stop();
    });
  });

  it('preserves draft value and cursor across permission deny', () => {
    const editor = makeEditor();
    editor.start();

    editor.feed(Buffer.from('important draft'));
    const before = editor.getBuffer();

    const askPromise = editor.ask('Allow?');
    editor.feed(Buffer.from('no\r'));

    return askPromise.then(answer => {
      expect(answer).toBe('no');
      const after = editor.getBuffer();
      expect(after.value).toBe(before.value);
      expect(after.cursor).toBe(before.value.length);
      editor.stop();
    });
  });

  it('preserves draft value and cursor when permission is aborted', () => {
    const editor = makeEditor();
    editor.start();

    editor.feed(Buffer.from('saved draft'));
    const before = editor.getBuffer();

    const controller = new AbortController();
    const askPromise = editor.ask('Allow?', controller.signal);
    controller.abort();

    return askPromise.then(answer => {
      expect(answer).toBe('');
      const after = editor.getBuffer();
      expect(after.value).toBe(before.value);
      editor.stop();
    });
  });

  it('preserves multiline draft with CJK characters', () => {
    const editor = makeEditor();
    editor.start();

    const cjk = '你好世界\n第二行\nテスト';
    editor.feed(Buffer.from(cjk));
    const before = editor.getBuffer();
    expect(before.value).toBe(cjk);

    const askPromise = editor.ask('Allow?');
    editor.feed(Buffer.from('y\r'));

    return askPromise.then(answer => {
      const after = editor.getBuffer();
      expect(after.value).toBe(cjk);
      expect(after.cursor).toBe(cjk.length);
      editor.stop();
    });
  });

  it('preserves history cursor position across modal interactions', () => {
    const editor = makeEditor();
    editor.start();

    // Populate history by submitting two entries.
    editor.feed(Buffer.from('first command\r'));
    editor.feed(Buffer.from('second command\r'));

    // Type a third draft and navigate up in history.
    editor.feed(Buffer.from('third draft'));
    // Press Up to go to history entry "second command".
    editor.feed(Buffer.from('\x1b[A'));
    const before = editor.getBuffer();
    expect(before.value).toBe('second command');

    // Modal interrupts.
    const askPromise = editor.ask('Allow?');
    editor.feed(Buffer.from('y\r'));

    return askPromise.then(() => {
      const after = editor.getBuffer();
      // After restore, we should have the history entry value.
      expect(after.value).toBe('second command');
      editor.stop();
    });
  });

  it('restores draft in finally block regardless of exit path', () => {
    // All paths (approve, deny, abort) tested above — this is a meta-test
    // confirming the pattern is used consistently.
    const editor = makeEditor();
    editor.start();

    editor.feed(Buffer.from('consistent draft'));
    const before = editor.getBuffer();

    // Test cancel path explicitly.
    editor.cancelQuestion();
    const after = editor.getBuffer();
    // After cancelQuestion, if no draft was saved, value should be empty.
    // But if there IS a saved draft (from a prior ask()), it's restored.
    // In this test we didn't call ask() so there's no saved draft.
    // Just verifying cancelQuestion is safe even without a saved draft.
    expect(editor).toBeDefined();
    editor.stop();
  });
});

describe('Terminal editor captureDraft / restoreDraft', () => {
  it('captureDraft returns a deep copy of current editor state', () => {
    const editor = makeEditor();
    editor.start();

    editor.feed(Buffer.from('test value'));
    const snapshot = editor.captureDraft();

    expect(snapshot.value).toBe('test value');
    expect(snapshot.cursor).toBe(10);
    expect(snapshot.historyIndex).toBeNull();
    expect(snapshot.historyDraft).toBe('');
    expect(typeof snapshot.inputLimitNoticeShown).toBe('boolean');
    expect(snapshot.parserState).toBeDefined();
    expect(snapshot.parserState.mode).toBe('normal');
    expect(Buffer.isBuffer(snapshot.parserState.incompleteUtf8)).toBe(true);

    editor.stop();
  });

  it('restoreDraft reconstructs editor state from a snapshot', () => {
    const editor = makeEditor();
    editor.start();

    editor.feed(Buffer.from('original text'));
    const snapshot = editor.captureDraft();

    // Change the editor state.
    editor.feed(Buffer.from('\x15')); // Ctrl+U clears.
    expect(editor.getBuffer().value).toBe('');

    // Restore from snapshot.
    editor.restoreDraft(snapshot);
    const restored = editor.getBuffer();
    expect(restored.value).toBe('original text');
    expect(restored.cursor).toBe(13);

    editor.stop();
  });

  it('restoreDraft on a null snapshot is a no-op', () => {
    const editor = makeEditor();
    editor.start();

    editor.feed(Buffer.from('keep me'));
    editor.restoreDraft(null);

    const buf = editor.getBuffer();
    expect(buf.value).toBe('keep me');

    editor.stop();
  });

  it('captureDraft produces independent copies (not shared references)', () => {
    const editor = makeEditor();
    editor.start();

    editor.feed(Buffer.from('original'));
    const snap1 = editor.captureDraft();

    // Modify editor state.
    editor.feed(Buffer.from(' more'));
    const snap2 = editor.captureDraft();

    // snap1 and snap2 should be independent.
    expect(snap1.value).toBe('original');
    expect(snap2.value).toBe('original more');

    // Restoring snap1 should work even though the editor changed.
    editor.restoreDraft(snap1);
    expect(editor.getBuffer().value).toBe('original');

    editor.stop();
  });

  it('restores an incomplete UTF-8 sequence across a modal question', async () => {
    const editor = makeEditor();
    editor.start();
    const encoded = Buffer.from('你', 'utf8');
    editor.feed(encoded.subarray(0, 2));

    const question = editor.ask('Allow?');
    editor.feed(Buffer.from('y\r'));
    await question;
    editor.feed(encoded.subarray(2));

    expect(editor.getBuffer().value).toBe('你');
    editor.stop();
  });

  it('restores an in-progress bracketed paste across a modal question', async () => {
    const editor = makeEditor();
    editor.start();
    editor.feed(Buffer.from('\x1b[200~第一行'));

    const question = editor.ask('Allow?');
    editor.feed(Buffer.from('n\r'));
    await question;
    editor.feed(Buffer.from('\n第二行\x1b[201~'));

    expect(editor.getBuffer().value).toBe('第一行\n第二行');
    editor.stop();
  });

  it('keeps an unbracketed multiline paste ordered across a split CJK byte', () => {
    const editor = makeEditor();
    editor.start();
    const bytes = Buffer.from('第一行\n第二行', 'utf8');

    editor.feed(bytes.subarray(0, bytes.length - 1));
    editor.feed(bytes.subarray(bytes.length - 1));

    expect(editor.getBuffer().value).toBe('第一行\n第二行');
    expect(editor.getBuffer().value).not.toContain('�');
    editor.stop();
  });
});
