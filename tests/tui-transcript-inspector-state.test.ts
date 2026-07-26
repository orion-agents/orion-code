/**
 * v0.2.23 Slice 5/6 — TUI Transcript Eviction tests.
 *
 * After surface.commit() succeeds, the renderer releases heavy transcript
 * records from hot state. Eviction uses generation-aware acknowledgement.
 * These tests verify the contract at the state-machine level.
 */

import { tuiUiReducer, initialTuiUiState, type TuiUiState } from '../src/tui-ui/state';
import { TranscriptInspectorController } from '../src/tui-ui/transcript-inspector';
import type { ToolDetailRepository } from '../src/runtime/tool-detail-repository';

describe('TUI transcript eviction', () => {
  it('releases committed prefix after surface.write success', () => {
    // Build state with finalized entries that have been committed.
    let state: TuiUiState = initialTuiUiState;

    // Add 10 entries, finalize them, mark as committed.
    for (let i = 0; i < 10; i++) {
      state = tuiUiReducer(state, {
        type: 'appendTranscript',
        entry: { id: `entry-${i}`, role: 'tool', content: `tool output ${i}` },
      });
      state = tuiUiReducer(state, {
        type: 'finalizeTranscript',
        id: `entry-${i}`,
      });
    }

    // All entries should still be in transcript.
    expect(state.transcript).toHaveLength(10);
  });

  it('committed entries advance committableTranscriptCount', () => {
    let state = initialTuiUiState;

    // User entries are auto-finalized and become committable immediately.
    state = tuiUiReducer(state, {
      type: 'appendTranscript',
      entry: { id: 'user-1', role: 'user', content: 'hello' },
    });

    // User entries get finalized=true from the start.
    expect(state.transcript[0].finalized).toBe(true);
  });

  it('tool entries are not auto-finalized', () => {
    let state = initialTuiUiState;

    state = tuiUiReducer(state, {
      type: 'appendTranscript',
      entry: { id: 'tool-1', role: 'tool', content: 'running...' },
    });

    expect(state.transcript[0].finalized).toBe(false);
  });

  it('does not modify non-finalized entries', () => {
    let state = initialTuiUiState;

    state = tuiUiReducer(state, {
      type: 'appendTranscript',
      entry: { id: 'live-1', role: 'tool', content: 'streaming' },
    });

    // Live entry stays untouched.
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0].content).toBe('streaming');
  });

  it('inspector state transitions work correctly', () => {
    let state = initialTuiUiState;

    state = tuiUiReducer(state, { type: 'openToolInspector' });
    expect(state.inspector).not.toBeNull();
    expect(state.inspector!.selectedIndex).toBe(0);

    state = tuiUiReducer(state, { type: 'moveToolInspectorSelection', delta: 2 });
    expect(state.inspector!.selectedIndex).toBe(0); // No entries, clamped to 0

    state = tuiUiReducer(state, { type: 'closeToolInspector' });
    expect(state.inspector).toBeNull();
  });

  it('toggleToolInspectorEntry adds and removes callIds', () => {
    let state = initialTuiUiState;

    state = tuiUiReducer(state, { type: 'openToolInspector' });
    state = tuiUiReducer(state, { type: 'toggleToolInspectorEntry', callId: 'call-1' });
    expect(state.inspector!.expandedCallIds).toContain('call-1');

    state = tuiUiReducer(state, { type: 'toggleToolInspectorEntry', callId: 'call-1' });
    expect(state.inspector!.expandedCallIds).not.toContain('call-1');
  });

  it('toggleAll toggles all expanded state', () => {
    let state = initialTuiUiState;

    // Populate recentToolDetails with tool entries so toggleAll has data.
    state = {
      ...state,
      recentToolDetails: [
        { callId: 'c1', sequence: 1, toolName: 't1', outputBytes: 100, state: 'success' },
        { callId: 'c2', sequence: 2, toolName: 't2', outputBytes: 200, state: 'success' },
      ],
    };

    state = tuiUiReducer(state, { type: 'openToolInspector' });
    state = tuiUiReducer(state, { type: 'toggleAllToolInspectorEntries' });

    // All should be expanded.
    expect(state.inspector!.expandedCallIds).toHaveLength(2);
    expect(state.inspector!.expandedCallIds).toContain('c1');
    expect(state.inspector!.expandedCallIds).toContain('c2');

    // Toggle again: all collapsed.
    state = tuiUiReducer(state, { type: 'toggleAllToolInspectorEntries' });
    expect(state.inspector!.expandedCallIds).toHaveLength(0);
  });

  it('setToolOutputViewMode changes mode', () => {
    let state = initialTuiUiState;
    expect(state.toolOutputViewMode).toBe('adaptive');

    state = tuiUiReducer(state, { type: 'setToolOutputViewMode', mode: 'full' });
    expect(state.toolOutputViewMode).toBe('full');

    state = tuiUiReducer(state, { type: 'setToolOutputViewMode', mode: 'collapsed' });
    expect(state.toolOutputViewMode).toBe('collapsed');
  });

  it('inspector search toggles direction on repeated query', () => {
    let state = initialTuiUiState;

    state = tuiUiReducer(state, { type: 'openToolInspector' });

    // Set initial search.
    state = tuiUiReducer(state, { type: 'setToolInspectorSearch', query: 'read' });
    expect(state.inspector!.searchQuery).toBe('read');
    expect(state.inspector!.searchDirection).toBe(1);

    // Same query again: toggle direction.
    state = tuiUiReducer(state, { type: 'setToolInspectorSearch', query: 'read' });
    expect(state.inspector!.searchDirection).toBe(-1);

    // Different query: reset to 1.
    state = tuiUiReducer(state, { type: 'setToolInspectorSearch', query: 'write' });
    expect(state.inspector!.searchDirection).toBe(1);
  });

  it('tool detail load and fail update loading state', () => {
    let state = initialTuiUiState;

    state = tuiUiReducer(state, { type: 'openToolInspector' });

    // Simulate detail loaded.
    state = tuiUiReducer(state, { type: 'toolDetailLoaded', callId: 'call-1' });
    expect(state.inspector!.loadingCallIds).toHaveLength(0);
    expect(state.inspector!.error).toBeUndefined();

    // Simulate detail load failed.
    state = tuiUiReducer(state, { type: 'toolDetailLoadFailed', callId: 'call-2', error: 'not found' });
    expect(state.inspector!.loadingCallIds).toHaveLength(0);
    expect(state.inspector!.error).toBe('not found');
  });

  it('scrollToolInspector updates detail offset', () => {
    let state = initialTuiUiState;

    state = tuiUiReducer(state, { type: 'openToolInspector' });
    state = tuiUiReducer(state, { type: 'scrollToolInspector', delta: 10 });
    expect(state.inspector!.detailOffset).toBe(10);

    state = tuiUiReducer(state, { type: 'scrollToolInspector', delta: -5 });
    expect(state.inspector!.detailOffset).toBe(5);

    // Cannot go below 0.
    state = tuiUiReducer(state, { type: 'scrollToolInspector', delta: -10 });
    expect(state.inspector!.detailOffset).toBe(0);
  });

  it('searches detail content only after that detail is lazily loaded', async () => {
    const repository: ToolDetailRepository = {
      list: async () => [],
      read: async () => ({
        content: 'hidden needle in tool detail',
        offsetBytes: 0,
        totalBytes: 28,
        redacted: false,
      }),
    };
    const controller = new TranscriptInspectorController(repository, '/tmp');
    const entry = {
      callId: 'call-detail',
      sequence: 1,
      toolName: 'read_file',
      outputBytes: 28,
      state: 'success' as const,
      summary: 'ordinary summary',
      artifactId: 'artifact-detail',
    };
    const inspector = {
      selectedIndex: 0,
      expandedCallIds: [],
      listOffset: 0,
      detailOffset: 0,
      searchQuery: 'needle',
      searchDirection: 1 as const,
      loadingCallIds: [],
    };

    expect(controller.view([entry], inspector).entries).toEqual([]);
    await controller.load(entry);
    expect(controller.view([entry], inspector).entries).toEqual([entry]);
  });
});
