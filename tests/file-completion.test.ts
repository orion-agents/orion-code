/**
 * File completion UI tests.
 */

describe('File Completion UI', () => {
  let writeSpy: jest.SpyInstance;
  let output: string[];

  beforeEach(() => {
    jest.resetModules();
    output = [];
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    jest.dontMock('../src/services/file-glob');
  });

  test('uses framed prompt renderer when configured', () => {
    const {
      setFileCompletionPromptRenderer,
      redrawInputWithFile,
    } = require('../src/ui/file-completion');

    setFileCompletionPromptRenderer('framed');
    redrawInputWithFile('@src');

    const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(rendered).toContain('› @src');
    expect(rendered).not.toContain('oh');
  });

  test('keeps the old v2 prompt renderer alias for compatibility', () => {
    const {
      setFileCompletionPromptRenderer,
      redrawInputWithFile,
    } = require('../src/ui/file-completion');

    setFileCompletionPromptRenderer('v2');
    redrawInputWithFile('@docs');

    const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(rendered).toContain('› @docs');
  });

  test('sanitizes filenames and input before rendering terminal output', () => {
    jest.doMock('../src/services/file-glob', () => ({
      matchFiles: () => [
        {
          path: 'safe\x1b[2J-file\x9b31m.txt',
          name: 'safe-file.txt',
          isDirectory: false,
          relativePath: 'safe-file.txt',
        },
      ],
    }));

    jest.isolateModules(() => {
      const completion =
        require('../src/ui/file-completion') as typeof import('../src/ui/file-completion');
      completion.showFileCompletion('', 'read ');
      completion.redrawInputWithFile('read @safe\x1b[2J-file');
      completion.hideFileCompletion();
    });

    const rendered = output.join('');
    expect(rendered).not.toContain('\x1b[2J-file');
    expect(rendered).not.toContain('\x9b');
    expect(rendered).toContain('safe-file.txt');
    expect(rendered).toContain('read @safe-file');
  });
});
