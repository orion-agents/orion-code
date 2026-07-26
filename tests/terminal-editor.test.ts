import { existsSync, writeFileSync } from 'fs';
import { openExternalEditor, selectEditor } from '../src/terminal-ui/editor';

describe('terminal external editor', () => {
  it('selects VISUAL before EDITOR and falls back to vi', () => {
    expect(selectEditor({ VISUAL: 'code --wait', EDITOR: 'vim' })).toBe('code --wait');
    expect(selectEditor({ EDITOR: 'nano' })).toBe('nano');
    expect(selectEditor({})).toBe('vi');
  });

  it('returns edited content and cleans up the temp file', () => {
    let editedPath = '';
    const result = openExternalEditor({
      initialContent: 'draft',
      env: { EDITOR: 'mock-editor' },
      spawnSync: (_command, args) => {
        editedPath = args[0];
        expect(existsSync(editedPath)).toBe(true);
        writeFileSync(editedPath, 'final prompt\n', 'utf8');
        return { status: 0, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });

    expect(result).toEqual({ content: 'final prompt' });
    expect(existsSync(editedPath)).toBe(false);
  });

  it('cancels when the saved file is empty', () => {
    const result = openExternalEditor({
      env: { EDITOR: 'mock-editor' },
      spawnSync: (_command, args) => {
        writeFileSync(args[0], '   \n', 'utf8');
        return { status: 0, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });

    expect(result).toEqual({ cancelled: true });
  });

  it('returns an error when editor exits non-zero', () => {
    const result = openExternalEditor({
      env: { EDITOR: 'mock-editor' },
      spawnSync: () => ({ status: 2, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    });

    expect(result.error).toContain('status 2');
  });
});
