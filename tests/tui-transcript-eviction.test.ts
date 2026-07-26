import {
  acknowledgeTranscriptCommit,
  initialTuiUiState,
  markTranscriptQueued,
  tuiUiReducer,
} from '../src/tui-ui/state';

function stateWithCommittedPrefix() {
  let state = tuiUiReducer(initialTuiUiState, {
    type: 'appendTranscript', entry: { id: 'a', role: 'assistant', content: 'A' },
  });
  state = tuiUiReducer(state, {
    type: 'appendTranscript', entry: { id: 'b', role: 'assistant', content: 'B' },
  });
  return markTranscriptQueued(state, 2);
}

describe('TUI transcript eviction', () => {
  it('releases the exact finalized prefix after acknowledgement', () => {
    const state = stateWithCommittedPrefix();
    const result = acknowledgeTranscriptCommit(state, {
      generation: state.transcriptGeneration,
      recordIds: ['a', 'b'],
    });
    expect(result.accepted).toBe(true);
    expect(result.state.transcript).toHaveLength(0);
    expect(result.state.queuedTranscriptCount).toBe(0);
  });

  it('does not evict before acknowledgement or on stale/mismatched acknowledgement', () => {
    const state = stateWithCommittedPrefix();
    expect(state.transcript).toHaveLength(2);
    expect(acknowledgeTranscriptCommit(state, {
      generation: state.transcriptGeneration + 1,
      recordIds: ['a', 'b'],
    }).accepted).toBe(false);
    expect(acknowledgeTranscriptCommit(state, {
      generation: state.transcriptGeneration,
      recordIds: ['b', 'a'],
    }).accepted).toBe(false);
    expect(state.transcript).toHaveLength(2);
  });

  it('never evicts a non-finalized live record', () => {
    let state = tuiUiReducer(initialTuiUiState, {
      type: 'appendTranscript', entry: { id: 'live', role: 'assistant', content: 'stream', live: true },
    });
    state = { ...state, queuedTranscriptCount: 1, committableTranscriptCount: 1 };
    const result = acknowledgeTranscriptCommit(state, {
      generation: state.transcriptGeneration,
      recordIds: ['live'],
    });
    expect(result.accepted).toBe(false);
    expect(result.state.transcript[0].content).toBe('stream');
  });

  it('retains at most 512 lightweight tool detail records', () => {
    let state = initialTuiUiState;
    for (let index = 0; index < 600; index += 1) {
      state = tuiUiReducer(state, {
        type: 'toolFinished',
        event: {
          callId: `call-${index}`, name: 'read_file', args: {}, success: true,
          duration: 1, sequence: index + 1, outputBytes: 100,
        },
      });
    }
    expect(state.recentToolDetails).toHaveLength(512);
    expect(state.recentToolDetails[0].callId).toBe('call-88');
  });
});
