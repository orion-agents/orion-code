import type { TranscriptAppendEntry, TranscriptEntry } from '../types';

export interface TranscriptRecord extends TranscriptEntry {
  finalized: boolean;
}

export interface TranscriptState {
  entries: TranscriptRecord[];
  staticCount: number;
  generation: number;
}

export type TranscriptAction =
  | { type: 'append'; entry: TranscriptAppendEntry & { id: string } }
  | { type: 'update'; id: string; patch: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'finalize'; id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'remove'; id: string }
  | { type: 'replace'; entries: TranscriptEntry[] }
  | { type: 'clear' };

export const initialTranscriptState: TranscriptState = {
  entries: [],
  staticCount: 0,
  generation: 0,
};

export function isLiveTranscriptEntry(entry: TranscriptAppendEntry): boolean {
  return entry.live === true || entry.role === 'tool';
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'append': {
      const { live: _live, ...entry } = action.entry;
      void _live;
      return commitStaticPrefix({
        ...state,
        entries: [
          ...state.entries,
          {
            ...entry,
            finalized: !isLiveTranscriptEntry(action.entry),
          },
        ],
      });
    }

    case 'update':
      return {
        ...state,
        entries: state.entries.map(entry => (
          entry.id === action.id ? { ...entry, ...action.patch } : entry
        )),
      };

    case 'remove':
      return withCommittedPrefix({
        ...state,
        entries: state.entries.filter(entry => entry.id !== action.id),
      });

    case 'finalize':
      return commitStaticPrefix({
        ...state,
        entries: state.entries.map(entry => {
          if (entry.id !== action.id) return entry;
          return {
            ...entry,
            ...action.patch,
            finalized: true,
          };
        }),
      });

    case 'replace':
      return {
        entries: action.entries.map(entry => ({ ...entry, finalized: true })),
        staticCount: action.entries.length,
        generation: state.generation + 1,
      };

    case 'clear':
      return {
        ...initialTranscriptState,
        generation: state.generation + 1,
      };
  }
}

export function staticTranscriptEntries(state: TranscriptState): TranscriptEntry[] {
  return state.entries.slice(0, state.staticCount).map(stripTranscriptRecord);
}

export function liveTranscriptEntries(state: TranscriptState): TranscriptEntry[] {
  return state.entries.slice(state.staticCount).map(stripTranscriptRecord);
}

function commitStaticPrefix(state: TranscriptState): TranscriptState {
  let staticCount = state.staticCount;
  while (staticCount < state.entries.length && state.entries[staticCount]?.finalized) staticCount += 1;

  return staticCount === state.staticCount ? state : { ...state, staticCount };
}

function withCommittedPrefix(state: TranscriptState): TranscriptState {
  let staticCount = 0;
  while (staticCount < state.entries.length && state.entries[staticCount]?.finalized) staticCount += 1;
  return { ...state, staticCount };
}

function stripTranscriptRecord(entry: TranscriptRecord): TranscriptEntry {
  const { finalized: _finalized, ...transcriptEntry } = entry;
  void _finalized;
  return transcriptEntry;
}
