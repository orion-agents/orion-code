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
  });

  test('uses framed prompt renderer when configured', () => {
    const { setFileCompletionPromptRenderer, redrawInputWithFile } = require('../src/ui/file-completion');

    setFileCompletionPromptRenderer('framed');
    redrawInputWithFile('@src');

    const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(rendered).toContain('› @src');
    expect(rendered).not.toContain('oh');
  });

  test('keeps the old v2 prompt renderer alias for compatibility', () => {
    const { setFileCompletionPromptRenderer, redrawInputWithFile } = require('../src/ui/file-completion');

    setFileCompletionPromptRenderer('v2');
    redrawInputWithFile('@docs');

    const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(rendered).toContain('› @docs');
  });
});
