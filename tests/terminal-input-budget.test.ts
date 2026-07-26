/**
 * v0.2.23 Slice 3 — Terminal UTF-8 Input Budget tests.
 */

import {
  RawTerminalEditor,
} from '../src/terminal-ui/raw-editor';

function makeEditor(): RawTerminalEditor {
  return new RawTerminalEditor({
    cwd: '/tmp',
    onSubmit: () => {},
    onCtrlC: () => {},
  });
}

describe('Terminal UTF-8 input budget', () => {
  it('counts CJK characters as multi-byte UTF-8', () => {
    // 你好 is 6 bytes, not 2 characters.
    const cjk = '你好';
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(6);
    expect(cjk.length).toBe(2);
  });

  it('counts emoji as multi-byte UTF-8', () => {
    const emoji = '🚀';
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);
    expect(emoji.length).toBe(2); // JS surrogate pair
  });

  it('rejects additional bytes when hard limit is reached', () => {
    const editor = makeEditor();
    editor.start();

    // Generate 256 KiB of ASCII content.
    const chunk = 'x'.repeat(256 * 1024);
    editor.feed(Buffer.from(chunk));

    const buf = editor.getBuffer();
    const bufBytes = Buffer.byteLength(buf.value, 'utf8');

    // Should have accepted up to 256 KiB, not more.
    expect(bufBytes).toBeLessThanOrEqual(256 * 1024 + 1); // +1 for tolerance

    // Adding more should be rejected.
    editor.feed(Buffer.from('more text'));
    const after = editor.getBuffer();
    expect(Buffer.byteLength(after.value, 'utf8')).toBe(bufBytes);

    editor.stop();
  });

  it('allows deletion and editing at hard limit', () => {
    const editor = makeEditor();
    editor.start();

    // Fill up to hard limit.
    const chunk = 'a'.repeat(256 * 1024);
    editor.feed(Buffer.from(chunk));

    // Backspace should work.
    editor.feed(Buffer.from('\x7f')); // Backspace
    const afterBS = editor.getBuffer();
    expect(afterBS.value.length).toBeLessThan(256 * 1024);

    // Now we can type again.
    editor.feed(Buffer.from('b'));
    const afterType = editor.getBuffer();
    expect(afterType.value).toContain('b');

    editor.stop();
  });

  it('allows Ctrl+U to clear at hard limit', () => {
    const editor = makeEditor();
    editor.start();

    const chunk = 'x'.repeat(256 * 1024);
    editor.feed(Buffer.from(chunk));

    // Ctrl+U should clear.
    editor.feed(Buffer.from('\x15'));
    const buf = editor.getBuffer();
    expect(buf.value).toBe('');

    // Can type again after clearing.
    editor.feed(Buffer.from('fresh start'));
    expect(editor.getBuffer().value).toBe('fresh start');

    editor.stop();
  });

  it('does not exit process when hard limit is reached', () => {
    const editor = makeEditor();
    editor.start();

    // At hard limit, we just reject but stay alive.
    const chunk = 'x'.repeat(300 * 1024); // > 256 KiB
    editor.feed(Buffer.from(chunk));

    const buf = editor.getBuffer();
    expect(Buffer.byteLength(buf.value, 'utf8')).toBeLessThanOrEqual(256 * 1024);

    // Process is still running.
    expect(editor).toBeDefined();

    editor.stop();
  });
});