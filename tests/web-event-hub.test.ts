import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';

import { WebEventHub } from '../src/web/event-hub';

function responseSink(options: { readonly backpressure?: boolean } = {}): {
  readonly response: ServerResponse;
  readonly writes: string[];
  readonly end: jest.Mock;
  readonly destroy: jest.Mock;
} {
  const writes: string[] = [];
  const end = jest.fn();
  const destroy = jest.fn();
  const response = {
    destroyed: false,
    writableEnded: false,
    write: (value: string) => {
      writes.push(value);
      return !options.backpressure;
    },
    end,
    destroy,
  } as unknown as ServerResponse;
  return { response, writes, end, destroy };
}

describe('WebEventHub', () => {
  test('assigns UUID event identities and monotonic reconnect cursors', () => {
    const hub = new WebEventHub({ now: () => 1_700_000_000_000 });
    const first = hub.emit({ type: 'workbench_state', workspace: '/repo', activeSessionId: null });
    const second = hub.emitRuntime({ type: 'status_changed', message: 'working' });

    expect(first.eventId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.cursor).toBe(1);
    expect(second.cursor).toBe(2);
    expect(second.durable).toBe(false);

    const sink = responseSink();
    hub.attach(sink.response, 1);
    expect(sink.writes.join('')).toContain('id: 2');
    expect(sink.writes.join('')).not.toContain('id: 1\n');
  });

  test('requests a snapshot when a cursor falls outside retained history', () => {
    const hub = new WebEventHub({ maxEvents: 1, maxBytes: 1024 * 1024 });
    hub.emit({ type: 'workbench_state', workspace: '/one', activeSessionId: null });
    hub.emit({ type: 'workbench_state', workspace: '/two', activeSessionId: null });
    hub.emit({ type: 'workbench_state', workspace: '/three', activeSessionId: null });

    const sink = responseSink();
    hub.attach(sink.response, 1);
    expect(sink.writes.join('')).toContain('"type":"replay_reset"');
    expect(sink.writes.join('')).toContain('id: 3');

    const fresh = responseSink();
    hub.attach(fresh.response, 0);
    expect(fresh.writes.join('')).toContain('"type":"replay_reset"');
  });

  test('redacts committed events and cleanly ends a backpressured client for replay', () => {
    const hub = new WebEventHub();
    const sink = responseSink({ backpressure: true });
    hub.attach(sink.response, 0);

    hub.emitThread(
      {
        protocolVersion: 1,
        eventId: randomUUID(),
        seq: 1,
        threadId: randomUUID(),
        durability: 'durable',
        timestamp: Date.now(),
        payload: {
          type: 'thread.started',
          data: { projectPath: 'sk-secret-value-123456' },
        },
      },
      'session-1'
    );

    expect(sink.writes.join('')).toContain('[REDACTED_SECRET]');
    expect(sink.writes.join('')).not.toContain('secret-value');
    expect(sink.end).toHaveBeenCalledTimes(1);
    expect(sink.destroy).not.toHaveBeenCalled();
  });

  test('projects Settings invalidation as a secret-free non-durable envelope', () => {
    const hub = new WebEventHub({ now: () => 1_700_000_000_000 });
    const revision = `hmac-sha256:${'b'.repeat(64)}`;
    const envelope = hub.emit(
      {
        type: 'settings_invalidated',
        revision,
        reason: 'external-edit',
        state: 'ready',
      },
      false
    );

    expect(envelope).toMatchObject({
      type: 'settings_invalidated',
      durable: false,
      payload: { revision, reason: 'external-edit', state: 'ready' },
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /api[-_]?key|authorization|password|credentialValue/i
    );
  });

  test('whitelists only structured tool authorization while redacting nested auth material', () => {
    const hub = new WebEventHub();
    const envelope = hub.emitRuntime({
      type: 'tool_finished',
      event: {
        callId: randomUUID(),
        name: 'write_file',
        args: {
          path: 'fixture.txt',
          authorization: 'Bearer should-never-reach-the-browser',
        },
        success: true,
        duration: 12,
        sequence: 1,
        authorization: {
          approved: true,
          source: 'config_allow',
          behavior: 'ask',
          reason: 'Project authority approved sk-secret-value-123456.',
        },
      },
    });

    expect(envelope).toMatchObject({
      type: 'runtime_event',
      payload: {
        value: {
          type: 'tool_finished',
          event: {
            args: { path: 'fixture.txt' },
            authorization: {
              approved: true,
              source: 'config_allow',
              behavior: 'ask',
              reason: 'Project authority approved [REDACTED_SECRET].',
            },
          },
        },
      },
    });
    const encoded = JSON.stringify(envelope);
    expect(encoded).not.toContain('Bearer should-never-reach-the-browser');
    expect(encoded).not.toContain('secret-value');
  });
});
