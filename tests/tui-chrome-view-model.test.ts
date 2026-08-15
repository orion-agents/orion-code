import { createTuiChromeViewModel } from '../src/tui-ui/chrome-view-model';
import { initialTuiUiState, tuiUiReducer } from '../src/tui-ui/state';

describe('TUI chrome permission visibility', () => {
  it('shows effective prompt-free network authorization in AUTO', () => {
    const state = tuiUiReducer(initialTuiUiState, {
      type: 'agentModeChanged',
      snapshot: { baseMode: 'auto', pendingBaseMode: null },
    });

    expect(
      createTuiChromeViewModel(state).segments.find(segment => segment.id === 'permission')?.label
    ).toBe('PERM allow · NET auto');
  });

  it('shows the selected network policy in BUILD and PLAN', () => {
    const withAsk = tuiUiReducer(initialTuiUiState, {
      type: 'setPermissionMode',
      value: 'ask',
    });
    const plan = tuiUiReducer(withAsk, {
      type: 'agentModeChanged',
      snapshot: { baseMode: 'plan', pendingBaseMode: null },
    });

    expect(
      createTuiChromeViewModel(withAsk).segments.find(segment => segment.id === 'permission')?.label
    ).toBe('PERM ask · NET ask');
    expect(
      createTuiChromeViewModel(plan).segments.find(segment => segment.id === 'permission')?.label
    ).toBe('PERM ask · NET ask');
  });
});
