import {
  buildCommandSuggestions,
  renderCommandPalette,
  createPickerState,
  closePicker,
  movePickerSelection,
  getSelectedPickerItem,
  updatePickerItems,
  initialInputState,
  reduceInput,
  buildSessionSuggestions,
  renderSessionPicker,
  formatRelativeTime,
  renderV2Prompt,
  renderV2FooterHint,
  renderV2InputFrame,
  renderV2ShellHeader,
  renderV2StatusBadge,
  renderV2Shortcuts,
  renderV2StatusLine,
} from '../src/ui-v2';
import type { SlashCommand } from '../src/commands/types';
import type { SessionMeta } from '../src/services/session-storage';

const noop = () => ({ success: true });
const stripAnsi = (text: string) => text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

function command(name: string, description = `${name} command`, extras: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name,
    description,
    type: 'builtin',
    execute: noop,
    ...extras,
  };
}

describe('UI v2 suggestions', () => {
  test('limits default command suggestions and reports hidden count', () => {
    const commands = Array.from({ length: 10 }, (_, index) => command(`cmd${index}`));

    const result = buildCommandSuggestions(commands, '');

    expect(result.items).toHaveLength(8);
    expect(result.moreCount).toBe(2);
    expect(result.total).toBe(10);
  });

  test('filters commands by name and alias', () => {
    const result = buildCommandSuggestions([
      command('status', 'Show status', { aliases: ['s'] }),
      command('sessions', 'List sessions'),
      command('model', 'Show model'),
    ], 's');

    expect(result.items.map(item => item.label)).toEqual(['/status', '/sessions']);
    expect(result.items[0].shortcut).toBe('s');
  });

  test('keeps argument hints out of visible suggestion rows', () => {
    const result = buildCommandSuggestions([
      command('model', 'Show or change model', { argumentHint: '[model|list|help]' }),
    ], 'm');

    const lines = renderCommandPalette({
      title: 'Matching "m"',
      items: result.items,
      selectedIndex: 0,
      width: 80,
      theme: {
        accent: text => text,
        dim: text => text,
        selected: text => text,
      },
    });

    expect(lines.join('\n')).toContain('/model');
    expect(lines.join('\n')).not.toContain('[model|list|help]');
  });
});

describe('UI v2 picker state', () => {
  test('moves selection within bounds', () => {
    const state = createPickerState([
      { id: '1', kind: 'command', label: '/one' },
      { id: '2', kind: 'command', label: '/two' },
    ]);

    const moved = movePickerSelection(state, 'down');
    const movedAgain = movePickerSelection(moved, 'down');
    const selected = getSelectedPickerItem(movedAgain);

    expect(movedAgain.selectedIndex).toBe(1);
    expect(selected?.label).toBe('/two');
  });

  test('keeps picker visible when filtering to an empty list', () => {
    const state = createPickerState([
      { id: '1', kind: 'command', label: '/one' },
    ], '', true);

    const empty = updatePickerItems(state, [], 'zzz');
    const closed = closePicker(empty);

    expect(empty.visible).toBe(true);
    expect(empty.items).toHaveLength(0);
    expect(closed.visible).toBe(false);
  });
});

describe('UI v2 input reducer', () => {
  test('inserts text at the cursor and moves the cursor', () => {
    const initial = reduceInput(initialInputState, { type: 'set', value: 'helo', cursor: 2 });
    const next = reduceInput(initial, { type: 'insert', text: 'l' });

    expect(next.value).toBe('hello');
    expect(next.cursor).toBe(3);
  });

  test('handles backspace, delete, and cursor movement', () => {
    const initial = reduceInput(initialInputState, { type: 'set', value: 'abcd', cursor: 2 });
    const backspaced = reduceInput(initial, { type: 'backspace' });
    const deleted = reduceInput(backspaced, { type: 'delete' });
    const end = reduceInput(deleted, { type: 'move', direction: 'end' });

    expect(backspaced).toMatchObject({ value: 'acd', cursor: 1 });
    expect(deleted).toMatchObject({ value: 'ad', cursor: 1 });
    expect(end.cursor).toBe(2);
  });

  test('clears transient input state', () => {
    const dirty = {
      ...initialInputState,
      value: 'draft',
      cursor: 5,
      multiline: true,
      historyIndex: 1,
      searchQuery: 'dr',
    };

    expect(reduceInput(dirty, { type: 'clear' })).toEqual(initialInputState);
  });
});

describe('UI v2 session picker', () => {
  const now = Date.UTC(2026, 5, 15, 8, 0, 0);

  function session(id: string, updates: Partial<SessionMeta> = {}): SessionMeta {
    return {
      id,
      projectPath: '/Users/hope/ai-project/openhorse',
      model: 'gpt-4o',
      startTime: now - 60_000,
      updatedAt: now - 120_000,
      messageCount: 3,
      tokenCount: 0,
      cost: 0,
      ...updates,
    };
  }

  test('builds compact session suggestions with stable numbering', () => {
    const suggestions = buildSessionSuggestions([
      session('abcdef123456', { name: 'api cleanup' }),
      session('fedcba654321', { taskSummary: 'Fix tests' }),
    ], { now });

    expect(suggestions[0]).toMatchObject({
      id: 'session:abcdef123456',
      kind: 'session',
      label: '#1 api cleanup',
      value: 'abcdef123456',
    });
    expect(suggestions[0].detail).toContain('abcdef12');
    expect(suggestions[0].detail).toContain('3 msg');
    expect(suggestions[1].label).toBe('#2 Fix tests');
  });

  test('renders a session picker without leaking raw JSON details', () => {
    const lines = renderSessionPicker({
      title: 'Pick a Session',
      sessions: [session('abcdef123456', { name: 'api cleanup' })],
      width: 80,
      theme: {
        accent: text => text,
        dim: text => text,
        selected: text => text,
      },
    });

    const rendered = lines.join('\n');
    expect(rendered).toContain('Pick a Session');
    expect(rendered).toContain('#1 api cleanup');
    expect(rendered).toContain('abcdef12');
    expect(rendered).not.toContain('projectPath');
  });

  test('formats relative times for picker details', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('now');
    expect(formatRelativeTime(now - 120_000, now)).toBe('2m ago');
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });
});

describe('UI v2 shell', () => {
  test('renders a visible v2 header with project and model tokens', () => {
    const header = stripAnsi(renderV2ShellHeader({
      provider: 'Alibaba Cloud',
      model: 'glm-5',
      projectPath: '/Users/hope/ai-project/openhorse',
      status: 'ready',
      version: '0.1.20',
      width: 80,
    }));

    expect(header).toContain('Orion Code v0.1.20');
    expect(header).toContain('model=glm-5');
    expect(header).toContain('provider=Qwen');
    expect(header).toContain('project=openhorse');
  });

  test('renders v2 prompt and status line', () => {
    const prompt = stripAnsi(renderV2Prompt('[Search: s]'));
    const status = stripAnsi(renderV2StatusLine({
      model: 'glm-5',
      tokens: 3984,
      promptTokens: 3901,
      completionTokens: 83,
      cost: 0.0004,
      ctxPercent: 2,
      mcpConnected: 1,
      mcpTotal: 2,
      sessionId: 'abcdef123456',
      width: 80,
    }));

    expect(prompt).toContain('› [Search: s]');
    expect(prompt).not.toContain('oh');
    expect(status).not.toContain('ui-v2');
    expect(status).toContain('model=glm-5');
    expect(status).toContain('session=abcdef12');
    expect(status).toContain('tokens=4.0K');
  });

  test('renders live input as gray rows without transcript separators', () => {
    const frame = renderV2InputFrame({
      input: 'first line\nsecond line',
      width: 48,
    });
    const rendered = stripAnsi(frame.output);
    const lines = rendered.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('› first line');
    expect(lines[0]).not.toContain('oh');
    expect(lines[0]).not.toContain('─');
    expect(lines[1]).toContain('  second line');
    expect(lines[1]).not.toContain('─');
    expect(lines[1]).not.toContain('│');
    expect(lines[0].indexOf('first line')).toBe(lines[1].indexOf('second line'));
    expect(lines[0]).not.toContain('[');
    expect(lines[0]).not.toContain(']');
    expect(lines[1]).not.toContain('[');
    expect(lines[1]).not.toContain(']');
    expect(frame.cursorRow).toBe(1);
    expect(frame.cursorColumn).toBeGreaterThan(1);
  });

  test('renders fixed status on the input frame bottom-right', () => {
    const status = renderV2StatusBadge({
      model: 'glm-5',
      tokens: 4400,
      promptTokens: 4000,
      completionTokens: 400,
      cost: 0.0012,
      ctxPercent: 2,
      mcpConnected: 0,
      mcpTotal: 0,
      sessionId: 'f6bcadcf1234',
      width: 80,
    });
    const frame = renderV2InputFrame({
      input: '',
      width: 90,
      statusText: status,
    });
    const lines = stripAnsi(frame.output).split('\n');
    const bottom = lines[lines.length - 1];

    expect(lines[0]).toContain('›');
    expect(lines.join('\n')).not.toContain('─');
    expect(bottom).toContain('model=glm-5');
    expect(bottom).toContain('session=f6bcadcf');
    expect(bottom).toContain('tokens=4.4K');
    expect(bottom).not.toContain('cost=');
    expect(bottom).not.toContain('$0.0012');
    expect(bottom).toContain('ctx=2%');
    expect(bottom.endsWith('ctx=2% ')).toBe(true);
  });

  test('renders Codex-like footer hints and shortcut panel', () => {
    const footer = stripAnsi(renderV2FooterHint(80));
    const shortcuts = stripAnsi(renderV2Shortcuts(80));

    expect(footer).toContain('/ commands');
    expect(footer).toContain('Ctrl+L clear view');
    expect(shortcuts).toContain('Shortcuts');
    expect(shortcuts).toContain('Ctrl+R');
    expect(shortcuts).toContain('history');
  });
});
