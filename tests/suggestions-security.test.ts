describe('legacy command suggestions terminal boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    jest.dontMock('../src/commands/index');
  });

  it('strips command metadata and input control sequences before writing', () => {
    const writes: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    jest.doMock('../src/commands/index', () => ({
      getCommandNames: () => ['safe\x1b[2J-command'],
      findCommand: () => ({
        name: 'safe-command',
        description: 'description\x1b]0;hijack\x07',
        argumentHint: 'hint\x9b31m-owned',
      }),
    }));

    jest.isolateModules(() => {
      const suggestions =
        require('../src/ui/suggestions') as typeof import('../src/ui/suggestions');
      suggestions.updateSuggestions('/');
      suggestions.redrawInput('input\x1b[2J-safe', 'mode\x9b31m-safe');
    });

    const rendered = writes.join('');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toContain('\x1b]0;');
    expect(rendered).not.toContain('\x9b');
    expect(rendered).toContain('/safe-command');
    expect(rendered).toContain('description');
    expect(rendered).toContain('input-safe');
  });
});
