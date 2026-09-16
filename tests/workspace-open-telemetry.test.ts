/**
 * v0.3.17 — open-path telemetry contract: monotonic stage offsets, bounded
 * retention, and no path/label/content in a trace.
 */
import { WorkspaceOpenTelemetryV1 } from '../src/web/workspace-open-telemetry';

function clock() {
  let now = 0;
  return {
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe('WorkspaceOpenTelemetryV1', () => {
  it('records stage offsets relative to the span start', () => {
    const time = clock();
    const telemetry = new WorkspaceOpenTelemetryV1({ now: time.now });
    const span = telemetry.start('req-1', 'inspect');

    time.advance(40);
    span.mark('inspect_fs');
    time.advance(50);
    span.mark('inspect_session_count');
    telemetry.record(span.finish('success'));

    const [trace] = telemetry.snapshot().recent;
    expect(trace).toMatchObject({
      requestId: 'req-1',
      operation: 'inspect',
      outcome: 'success',
      totalMs: 90,
      stages: { inspect_fs: 40, inspect_session_count: 90 },
    });
  });

  it('keeps the first mark for a stage and ignores marks after finish', () => {
    const time = clock();
    const telemetry = new WorkspaceOpenTelemetryV1({ now: time.now });
    const span = telemetry.start('req-2', 'pick-directory');

    time.advance(10);
    span.mark('picker_launch');
    time.advance(10);
    span.mark('picker_launch');
    telemetry.record(span.finish('cancelled'));
    span.mark('picker_result');

    const [trace] = telemetry.snapshot().recent;
    expect(trace.stages.picker_launch).toBe(10);
    expect(trace.stages.picker_result).toBeUndefined();
    expect(trace.outcome).toBe('cancelled');
  });

  it('carries a failure code and bounds the ring buffer', () => {
    const time = clock();
    const telemetry = new WorkspaceOpenTelemetryV1({ limit: 2, now: time.now });
    for (const id of ['a', 'b', 'c']) {
      const span = telemetry.start(id, 'activate');
      telemetry.record(span.finish('failed', 'context_revision_conflict'));
    }

    const snapshot = telemetry.snapshot();
    expect(snapshot.retained).toBe(2);
    expect(snapshot.recent.map(trace => trace.requestId)).toEqual(['b', 'c']);
    expect(snapshot.recent[0].errorCode).toBe('context_revision_conflict');
  });

  it('never stores a path, label or file content', () => {
    const time = clock();
    const telemetry = new WorkspaceOpenTelemetryV1({ now: time.now });
    const span = telemetry.start('req-3', 'activate');
    span.mark('runtime_install');
    telemetry.record(span.finish('success'));

    const serialized = JSON.stringify(telemetry.snapshot());
    expect(serialized).not.toMatch(/\/Users\/|\/tmp\/|\.env/);
    expect(Object.keys(telemetry.snapshot().recent[0]).sort()).toEqual([
      'operation',
      'outcome',
      'requestId',
      'stages',
      'totalMs',
    ]);
  });
});
