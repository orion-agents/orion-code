import { createToolEventPresenter } from '../src/runtime/chat-presentation';
import type {
  RuntimeToolFinishedEvent,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from '../src/runtime/ui-events';

describe('tool authorization provenance', () => {
  it('survives the running entry, final transcript, and runtime event', () => {
    const appended: TranscriptAppendEntry[] = [];
    const updates: Array<Partial<Omit<TranscriptEntry, 'id'>>> = [];
    const finalized: Array<Partial<Omit<TranscriptEntry, 'id'>> | undefined> = [];
    const finished: RuntimeToolFinishedEvent[] = [];
    const partialSink: Pick<UiEventSink, 'append' | 'update' | 'finalize' | 'toolFinished'> = {
      append: entry => {
        appended.push(entry);
        return 'tool-1';
      },
      update: (_id, patch) => updates.push(patch),
      finalize: (_id, patch) => finalized.push(patch),
      toolFinished: event => finished.push(event),
    };
    const sink = partialSink as UiEventSink;
    const presenter = createToolEventPresenter(sink);

    presenter.start({
      type: 'tool_call',
      callId: 'call-1',
      name: 'web_search',
      args: { query: 'orion' },
    });
    presenter.permission({
      type: 'permission_decision',
      callId: 'call-1',
      name: 'web_search',
      args: { query: 'orion' },
      decision: {
        approved: true,
        behavior: 'ask',
        source: 'mode_auto',
        reason: 'Auto mode fully authorized this invocation after hard policy checks.',
      },
    });
    presenter.finish({
      type: 'tool_result',
      callId: 'call-1',
      name: 'web_search',
      args: { query: 'orion' },
      result: JSON.stringify({ success: true, output: 'result' }),
      modelVisibleResult: JSON.stringify({ success: true, output: 'result' }),
      success: true,
      duration: 3,
    });

    expect(appended[0].toolActivity?.authorization).toBeUndefined();
    expect(updates.at(-1)?.toolActivity?.authorization).toMatchObject({
      approved: true,
      source: 'mode_auto',
    });
    expect(finalized.at(-1)?.toolActivity?.authorization).toMatchObject({
      approved: true,
      source: 'mode_auto',
    });
    expect(finished.at(-1)?.authorization).toMatchObject({
      approved: true,
      source: 'mode_auto',
    });
  });
});
