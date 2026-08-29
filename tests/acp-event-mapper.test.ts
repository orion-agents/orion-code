import { OrionAcpEventMapper } from '../src/acp/event-mapper';
import type { OrionAcpSessionUpdate } from '../src/acp/runtime-port';

describe('OrionAcpEventMapper', () => {
  test('turns cumulative UTF-16 transcript updates into ordered suffix deltas', async () => {
    const updates: OrionAcpSessionUpdate[] = [];
    const mapper = new OrionAcpEventMapper(() => ({
      update: async update => {
        updates.push(update);
      },
      requestPermission: async () => false,
    }));

    const id = mapper.append({ role: 'assistant', content: '🙂a', live: true });
    mapper.update(id, { content: '🙂ab' });
    mapper.finalize(id, { content: 'replacement' });
    await mapper.drain();

    expect(updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: id,
        content: { type: 'text', text: '🙂a' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: id,
        content: { type: 'text', text: 'b' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: `${id}:r1`,
        content: { type: 'text', text: 'replacement' },
      },
    ]);
  });

  test('keeps the runtime invocation id through tool start and finish', async () => {
    const updates: OrionAcpSessionUpdate[] = [];
    const mapper = new OrionAcpEventMapper(() => ({
      update: async update => {
        updates.push(update);
      },
      requestPermission: async () => false,
    }));

    mapper.toolStarted?.({
      callId: 'invocation-7',
      name: 'write_file',
      args: { path: 'a.ts' },
      sequence: 1,
    });
    mapper.toolFinished?.({
      callId: 'invocation-7',
      name: 'write_file',
      args: { path: 'a.ts' },
      success: true,
      duration: 10,
      summary: 'updated',
      sequence: 1,
    });
    await mapper.drain();

    expect(updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'invocation-7',
        status: 'in_progress',
      }),
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'invocation-7',
        status: 'completed',
      }),
    ]);
  });

  test('propagates observer failures when the prompt drains', async () => {
    const mapper = new OrionAcpEventMapper(() => ({
      update: async () => {
        throw new Error('connection closed');
      },
      requestPermission: async () => false,
    }));
    mapper.append({ role: 'assistant', content: 'hello' });
    await expect(mapper.drain()).rejects.toThrow('connection closed');
  });
});
