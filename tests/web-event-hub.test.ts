import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';

import { WebEventHub } from '../src/web/event-hub';

const TEST_CONTEXT_REVISION = '10000000-0000-4000-8000-000000000001';
const TEST_WORKSPACE_ID = '20000000-0000-4000-8000-000000000002';

function workbenchState(workspace: string, activeSessionId: string | null) {
  return {
    type: 'workbench_state' as const,
    contextRevision: TEST_CONTEXT_REVISION,
    workspaceId: TEST_WORKSPACE_ID,
    workspace,
    activeSessionId,
  };
}

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
    const first = hub.emit(workbenchState('/repo', null));
    const transient = hub.emitRuntime({ type: 'status_changed', message: 'working' });
    const second = hub.emit(workbenchState('/repo', 'session-1'));

    expect(first.eventId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.cursor).toBe(1);
    expect(transient.cursor).toBe(2);
    expect(transient.durable).toBe(false);
    expect(second.cursor).toBe(3);

    const sink = responseSink();
    hub.attach(sink.response, 1);
    expect(sink.writes.join('')).toContain('id: 3');
    expect(sink.writes.join('')).not.toContain('id: 2');
    expect(sink.writes.join('')).not.toContain('id: 1\n');
  });

  test('requests a snapshot when a cursor falls outside retained history', () => {
    const hub = new WebEventHub({ maxEvents: 1, maxBytes: 1024 * 1024 });
    hub.emit(workbenchState('/one', null));
    hub.emit(workbenchState('/two', null));
    hub.emit(workbenchState('/three', null));

    const sink = responseSink();
    const detach = hub.attach(sink.response, 1);
    expect(sink.writes.join('')).toContain('"type":"replay_reset"');
    expect(sink.writes.join('')).toContain('id: 3');
    expect(sink.end).toHaveBeenCalledTimes(1);

    hub.emit(workbenchState('/four', null));
    expect(sink.writes.join('')).not.toContain('/four');
    expect(() => {
      detach();
      detach();
    }).not.toThrow();

    const fresh = responseSink();
    hub.attach(fresh.response, 0);
    expect(fresh.writes.join('')).toContain('"type":"replay_reset"');
    expect(fresh.end).toHaveBeenCalledTimes(1);
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
    const baseline = hub.emit(workbenchState('/workspace', 'session-1'));
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

    const reconnected = responseSink();
    hub.attach(reconnected.response, baseline.cursor);
    expect(reconnected.writes.join('')).toContain('"type":"settings_invalidated"');
    expect(reconnected.writes.join('')).toContain(revision);
  });

  test('replays a bounded Workspace resource invalidation without retaining resource payloads', () => {
    const hub = new WebEventHub({ now: () => 1_700_000_000_000 });
    const sink = responseSink();
    hub.attach(sink.response, 0);
    const envelope = hub.emit(
      {
        type: 'workspace_resource_invalidated',
        workspaceId: TEST_WORKSPACE_ID,
        resources: ['files', 'git', 'review'],
        reason: 'filesystem-change',
      },
      false
    );

    expect(envelope).toMatchObject({
      type: 'workspace_resource_invalidated',
      durable: false,
      sessionId: null,
      threadId: null,
      payload: {
        workspaceId: TEST_WORKSPACE_ID,
        resources: ['files', 'git', 'review'],
        reason: 'filesystem-change',
      },
    });
    expect(sink.writes.join('')).toContain('workspace_resource_invalidated');
    expect(hub.snapshot().retained).toBe(1);
    const reconnected = responseSink();
    hub.attach(reconnected.response, 0);
    expect(reconnected.writes.join('')).toContain('workspace_resource_invalidated');
    expect(reconnected.writes.join('')).not.toContain('path');
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

  test('removes opaque credential fields from permission and tool event arguments', () => {
    const hub = new WebEventHub();
    const marker = 'ORION_OPAQUE_CREDENTIAL_MARKER';
    const envelope = hub.emitRuntime({
      type: 'permission_requested',
      request: {
        id: randomUUID(),
        name: 'exec_command',
        args: {
          command: 'safe-command',
          token: marker,
          clientSecret: marker,
          privateKey: marker,
          env: { ORION_CREDENTIAL: marker },
          connectionString: marker,
          databaseUrl: marker,
          dsn: marker,
          pwd: marker,
          auth: marker,
          accountKey: marker,
        },
      },
    });

    expect(envelope).toMatchObject({
      payload: {
        value: {
          request: { args: { command: 'safe-command' } },
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(marker);

    const status = hub.emitRuntime({
      type: 'status_changed',
      message:
        `provider failed: token=${marker}; signingKey=${marker}; ` +
        `AccountKey=${marker}; postgres://user:${marker}@localhost/db`,
    });
    expect(JSON.stringify(status)).not.toContain(marker);
    expect(status).toMatchObject({
      payload: {
        value: {
          message: expect.not.stringContaining(marker),
        },
      },
    });
  });

  test('does not let ephemeral transcript deltas evict durable replay history', () => {
    const hub = new WebEventHub({ maxEvents: 2, maxBytes: 2_000 });
    const durable = hub.emit(workbenchState('/workspace', 'session-1'));
    for (let index = 0; index < 50; index += 1) {
      hub.emitRuntime({
        type: 'transcript_update',
        id: 'entry-1',
        patch: { content: 'x'.repeat(500) },
      });
    }

    const sink = responseSink();
    hub.attach(sink.response, durable.cursor);
    expect(sink.writes.join('')).not.toContain('"type":"replay_reset"');

    hub.emitRuntime({
      type: 'transcript_finalize',
      id: 'entry-1',
      patch: { content: 'complete' },
    });
    expect(sink.writes.join('')).toContain('"type":"transcript_finalize"');
  });

  test('replays across sparse ephemeral cursors unless a durable event was actually missed', () => {
    const hub = new WebEventHub({ maxEvents: 1, maxBytes: 1024 * 1024 });
    hub.emit(workbenchState('/one', 'session-1'));
    for (let index = 0; index < 25; index += 1) {
      hub.emitRuntime({ type: 'status_changed', message: `working-${index}` });
    }
    const latest = hub.emit(workbenchState('/two', 'session-2'));

    const caughtUp = responseSink();
    hub.attach(caughtUp.response, 10);
    expect(caughtUp.writes.join('')).not.toContain('"type":"replay_reset"');
    expect(caughtUp.writes.join('')).toContain(`id: ${latest.cursor}`);

    const missedDurable = responseSink();
    hub.attach(missedDurable.response, 0);
    expect(missedDurable.writes.join('')).toContain('"type":"replay_reset"');
  });

  test('sends cumulative transcript growth as bounded content deltas to live clients', () => {
    const hub = new WebEventHub();
    const baseline = hub.emit(workbenchState('/workspace', 'session-1'));
    const sink = responseSink();
    hub.attach(sink.response, baseline.cursor);
    for (let index = 1; index <= 500; index += 1) {
      hub.emitRuntime({
        type: 'transcript_update',
        id: 'entry-1',
        patch: { content: 'x'.repeat(index * 100) },
      });
    }
    hub.emitRuntime({
      type: 'transcript_finalize',
      id: 'entry-1',
      patch: { content: 'x'.repeat(50_000) },
    });

    const wireBytes = Buffer.byteLength(sink.writes.join(''));
    expect(wireBytes).toBeLessThan(400_000);
    expect(sink.writes.join('')).toContain('"contentDelta":"xxx');
    expect(sink.writes.join('')).toContain('"contentStart":100');
  });

  test('marks a transcript delta with the exact baseline after a client misses updates', () => {
    const hub = new WebEventHub();
    const baseline = hub.emit(workbenchState('/workspace', 'session-1'));
    const first = responseSink();
    const detach = hub.attach(first.response, baseline.cursor);
    hub.emitRuntime({
      type: 'transcript_update',
      id: 'entry-1',
      patch: { content: 'abc' },
    });
    detach();
    hub.emitRuntime({
      type: 'transcript_update',
      id: 'entry-1',
      patch: { content: 'abcDEF' },
    });

    const reconnected = responseSink();
    hub.attach(reconnected.response, baseline.cursor);
    hub.emitRuntime({
      type: 'transcript_update',
      id: 'entry-1',
      patch: { content: 'abcDEFGHI' },
    });

    const wire = reconnected.writes.join('');
    expect(wire).toContain('"contentDelta":"GHI"');
    expect(wire).toContain('"contentStart":6');
  });
});
