import { renderFrameRows } from '../src/tui-core/frame';
import { PrintEventSink } from '../src/print-ui/launch';
import type { ResearchLifecycleEvent } from '../src/runtime/subagents/research-renderer';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { MAX_RESEARCH_EVENT_HISTORY } from '../src/runtime/ui-view-model';
import { TerminalEventSink } from '../src/terminal-ui/launch';
import { renderTuiUiFrame } from '../src/tui-ui/layout';
import {
  createTuiUiEventSink,
  initialTuiUiState,
  tuiUiReducer,
  type TuiUiState,
} from '../src/tui-ui/state';

function runtime(): OrionCodeUiRuntime {
  return {
    cwd: '/tmp/orion-research-ui',
    version: 'test',
    config: { model: 'test-model' } as OrionCodeUiRuntime['config'],
    store: {
      getSnapshot: () => ({ currentModel: 'test-model' }),
      setProcessing: jest.fn(),
    } as unknown as OrionCodeUiRuntime['store'],
    llm: null,
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
  };
}

function lifecycle(): ResearchLifecycleEvent[] {
  return [
    {
      type: 'research_started',
      packetId: 'pkt-ui',
      objective: 'verify UI sinks',
      mode: 'web',
    },
    {
      type: 'research_source',
      packetId: 'pkt-ui',
      sourceId: 'src-ok',
      status: 'retrieved',
      provider: 'ddg',
      kind: 'web_page',
      displayUrl: 'https://example.com/doc',
      contentHash: 'abcdef1234567890',
    },
    {
      type: 'research_source',
      packetId: 'pkt-ui',
      sourceId: 'src-bad',
      status: 'blocked',
      provider: 'ddg',
      kind: 'web_page',
      displayUrl: 'https://example.com/private',
      failureReason: 'redirect target blocked',
    },
    { type: 'research_conflict', packetId: 'pkt-ui', claimId: 'claim-1' },
    {
      type: 'research_completed',
      packetId: 'pkt-ui',
      stage: 'partial',
      auditStatus: 'partial',
      conclusion: 'one source was blocked',
      summary: {
        sourceCount: 2,
        retrievedCount: 1,
        partialCount: 0,
        failedCount: 0,
        blockedCount: 1,
        staleCount: 0,
        citationCount: 1,
        conflictCount: 1,
        evidenceCandidateCount: 1,
        riskCount: 2,
      },
    },
  ];
}

describe('research lifecycle real UI sinks (#89, #104)', () => {
  it('Terminal consumes ordered events and prints URL/hash/failure diagnostics', () => {
    const output: string[] = [];
    const sink = new TerminalEventSink(runtime(), { write: text => output.push(text) });

    lifecycle().forEach(event => sink.researchEvent(event));

    expect(sink.getResearchEvents().map(event => event.type)).toEqual([
      'research_started',
      'research_source',
      'research_source',
      'research_conflict',
      'research_completed',
    ]);
    expect(sink.getResearchProjection()).toEqual(
      expect.objectContaining({ packetId: 'pkt-ui', stage: 'partial' })
    );
    expect(output.join('')).toContain('source=https://example.com/doc');
    expect(output.join('')).toContain('hash=abcdef123456');
    expect(output.join('')).toContain('failure=redirect target blocked');
  });

  it('Print JSON result preserves the typed stream and projected source schema', () => {
    const sink = new PrintEventSink(runtime(), 'json');

    lifecycle().forEach(event => sink.researchEvent(event));
    const result = sink.result();

    expect(result.researchEvents.map(event => event.type)).toEqual([
      'research_started',
      'research_source',
      'research_source',
      'research_conflict',
      'research_completed',
    ]);
    expect(result.research).toEqual(
      expect.objectContaining({
        packetId: 'pkt-ui',
        stage: 'partial',
        sources: expect.arrayContaining([
          expect.objectContaining({
            id: 'src-ok',
            displayUrl: 'https://example.com/doc',
            contentHash: 'abcdef1234567890',
          }),
        ]),
      })
    );
    expect(result.research?.sources[0]).not.toHaveProperty('type');
    expect(result.research?.sources[0]).not.toHaveProperty('packetId');
  });

  it('TUI sink reduces the stream into a visible source/citation/risk projection', () => {
    let state: TuiUiState = initialTuiUiState;
    const sink = createTuiUiEventSink(action => {
      state = tuiUiReducer(state, action);
    });

    lifecycle().forEach(event => sink.researchEvent!(event));
    const rows = renderFrameRows(renderTuiUiFrame(state, { width: 180, height: 12 }));

    expect(state.researchEvents).toHaveLength(5);
    expect(state.research).toEqual(
      expect.objectContaining({ packetId: 'pkt-ui', stage: 'partial' })
    );
    expect(rows.join('\n')).toContain('research:partial src:1/2 fail:1 cite:1 risk:2');
  });

  it('bounds ordered research history and projected sources in every sink', () => {
    const terminal = new TerminalEventSink(runtime(), { write: () => {} });
    const print = new PrintEventSink(runtime(), 'json');
    let tuiState: TuiUiState = initialTuiUiState;
    const tui = createTuiUiEventSink(action => {
      tuiState = tuiUiReducer(tuiState, action);
    });

    for (let index = 0; index < MAX_RESEARCH_EVENT_HISTORY + 8; index += 1) {
      const event: ResearchLifecycleEvent = {
        type: 'research_source',
        packetId: 'pkt-bounded',
        sourceId: `src-${index}`,
        status: 'retrieved',
        provider: 'local',
        kind: 'file',
        projectPath: `src/${index}.ts`,
      };
      terminal.researchEvent(event);
      print.researchEvent(event);
      tui.researchEvent!(event);
    }

    expect(terminal.getResearchEvents()).toHaveLength(MAX_RESEARCH_EVENT_HISTORY);
    expect(print.result().researchEvents).toHaveLength(MAX_RESEARCH_EVENT_HISTORY);
    expect(tuiState.researchEvents).toHaveLength(MAX_RESEARCH_EVENT_HISTORY);
    expect(terminal.getResearchEvents()[0]).toEqual(expect.objectContaining({ sourceId: 'src-8' }));
    expect(tuiState.research?.sources).toHaveLength(200);
  });
});
