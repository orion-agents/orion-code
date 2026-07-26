import { parseInput, buildCommandSuggestions, createCompleter } from '../src/commands/parser';

describe('parseInput', () => {
  test('parses slash command', () => {
    const result = parseInput('/help');
    expect(result.isCommand).toBe(true);
    expect(result.name).toBe('help');
    expect(result.args).toBe('');
  });

  test('parses slash command with args', () => {
    const result = parseInput('/model gpt-4o');
    expect(result.isCommand).toBe(true);
    expect(result.name).toBe('model');
    expect(result.args).toBe('gpt-4o');
  });

  test('parses non-slash input as chat', () => {
    const result = parseInput('hello world');
    expect(result.isCommand).toBe(false);
    expect(result.name).toBe('');
    expect(result.args).toBe('hello world');
  });

  test('parses an absolute path followed by a question as chat', () => {
    const input = '/Users/hope/linux2010/my-skills/vendor/skills 做啥的？';
    const result = parseInput(input);

    expect(result).toEqual({ isCommand: false, name: '', args: input });
  });

  test('does not treat a slash-prefixed markdown skill locator as a command', () => {
    const input = '/[$chronicle](/Users/hope/.codex/skills/chronicle/SKILL.md)';

    expect(parseInput(input)).toEqual({ isCommand: false, name: '', args: input });
  });

  test('parses a root-level file path as chat', () => {
    const input = '/README.md explain this';

    expect(parseInput(input)).toEqual({ isCommand: false, name: '', args: input });
  });

  test('keeps unknown simple slash names as commands', () => {
    expect(parseInput('/unknown argument')).toEqual({
      isCommand: true,
      name: 'unknown',
      args: 'argument',
    });
  });

  test('handles empty input', () => {
    const result = parseInput('');
    expect(result.isCommand).toBe(false);
    expect(result.name).toBe('');
    expect(result.args).toBe('');
  });

  test('handles whitespace only', () => {
    const result = parseInput('   ');
    expect(result.isCommand).toBe(false);
    expect(result.name).toBe('');
    expect(result.args).toBe('');
  });

  test('handles Chinese input', () => {
    const result = parseInput('你好世界');
    expect(result.isCommand).toBe(false);
    expect(result.args).toBe('你好世界');
  });

  test('handles slash with leading spaces in input', () => {
    const result = parseInput('/  help');
    expect(result.isCommand).toBe(true);
    // After removing '/' and splitting by whitespace, first element is ''
    expect(result.name).toBe('');
    expect(result.args).toBe('help');
  });
});

describe('buildCommandSuggestions', () => {
  test('returns all commands for empty partial', () => {
    const suggestions = buildCommandSuggestions('');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toContain('help');
    expect(suggestions).toContain('status');
    expect(suggestions).toContain('exit');
  });

  test('filters by partial match', () => {
    const suggestions = buildCommandSuggestions('st');
    expect(suggestions).toContain('status');
    expect(suggestions).not.toContain('help');
  });

  test('returns exact match', () => {
    const suggestions = buildCommandSuggestions('help');
    expect(suggestions).toContain('help');
  });

  test('returns empty for no match', () => {
    const suggestions = buildCommandSuggestions('xyz');
    expect(suggestions).toEqual([]);
  });
});

describe('createCompleter', () => {
  test('completes slash commands', () => {
    const completer = createCompleter();
    const [completions, line] = completer('/st');
    expect(completions).toContain('/status');
    expect(line).toBe('/st');
  });

  test('returns empty for non-slash input', () => {
    const completer = createCompleter();
    const [completions, line] = completer('hello');
    expect(completions).toEqual([]);
    expect(line).toBe('hello');
  });

  test('does not complete absolute paths as commands', () => {
    const completer = createCompleter();
    const [completions, line] = completer('/Users/hope');

    expect(completions).toEqual([]);
    expect(line).toBe('/Users/hope');
  });

  test('returns all commands for just slash', () => {
    const completer = createCompleter();
    const [completions, line] = completer('/');
    expect(completions.length).toBeGreaterThan(0);
    expect(completions[0]).toMatch(/^\/\w+/);
  });
});
