import { RuntimeEventBufferV1 } from '../src/runtime/runtime-event-buffer';
import type { RuntimeEventEnvelopeV1 } from '../src/runtime/protocol/runtime-protocol-v1';

const THREAD_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '10000000-0000-4000-8000-000000000002';
const STEP_ID = '10000000-0000-4000-8000-000000000003';
const ITEM_ID = '10000000-0000-4000-8000-000000000004';

function durable(seq: number, suffix = seq): RuntimeEventEnvelopeV1 {
  return {
    protocolVersion: 1,
    eventId: `20000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    seq,
    threadId: THREAD_ID,
    durability: 'durable',
    timestamp: seq,
    payload: { type: 'thread.resumed', data: { fromSeq: Math.max(0, seq - 1) } },
  };
}

function delta(text: string, suffix: number, seq = 1): RuntimeEventEnvelopeV1 {
  return {
    protocolVersion: 1,
    eventId: `30000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    seq,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    stepId: STEP_ID,
    itemId: ITEM_ID,
    durability: 'ephemeral',
    timestamp: suffix,
    payload: { type: 'item.delta', data: { delta: text, channel: 'content' } },
  };
}

describe('RuntimeEventBufferV1', () => {
  test('coalesces adjacent ephemeral deltas without advancing durable cursor', () => {
    const buffer = new RuntimeEventBufferV1(THREAD_ID, { maxItems: 4, maxBytes: 4096 });
    expect(buffer.offer(durable(1))).toMatchObject({ status: 'buffered' });
    expect(buffer.offer(delta('hel', 1))).toMatchObject({ status: 'buffered' });
    expect(buffer.offer(delta('lo', 2))).toMatchObject({ status: 'coalesced' });

    const read = buffer.read();
    expect(read.status).toBe('events');
    if (read.status !== 'events') return;
    expect(read.events).toHaveLength(2);
    expect(read.events[1]).toMatchObject({
      seq: 1,
      durability: 'ephemeral',
      payload: { type: 'item.delta', data: { delta: 'hello' } },
    });
    expect(buffer.getSnapshot()).toMatchObject({
      acknowledgedCursor: 0,
      latestDurableCursor: 1,
      bufferedItems: 2,
    });
  });

  test('evicts ephemeral data before accepting a durable event', () => {
    const buffer = new RuntimeEventBufferV1(THREAD_ID, { maxItems: 2, maxBytes: 4096 });
    buffer.offer(durable(1));
    buffer.offer(delta('stream', 1));
    expect(buffer.offer(durable(2))).toMatchObject({
      status: 'buffered',
      droppedEphemeral: 1,
      bufferedItems: 2,
    });
    const read = buffer.read();
    expect(read.status === 'events' ? read.events.map(event => event.seq) : []).toEqual([1, 2]);
  });

  test('requires replay instead of dropping durable overflow', () => {
    const buffer = new RuntimeEventBufferV1(THREAD_ID, { maxItems: 1, maxBytes: 4096 });
    buffer.offer(durable(1));
    expect(buffer.offer(durable(2))).toEqual({
      status: 'replay_required',
      cursor: 0,
      latestAvailableCursor: 2,
      reason: 'durable_overflow',
    });
    expect(buffer.offer(delta('ignored', 1, 2))).toEqual({
      status: 'dropped_ephemeral',
      reason: 'replay_required',
    });
    expect(() => buffer.resetAfterReplay(1)).toThrow('has not reached 2');
    expect(buffer.resetAfterReplay(2)).toMatchObject({
      acknowledgedCursor: 2,
      latestDurableCursor: 2,
      bufferedItems: 0,
    });
    expect(buffer.offer(durable(3))).toMatchObject({ status: 'buffered' });
  });

  test('detects sequence gaps and resumes only after cursor replay', () => {
    const buffer = new RuntimeEventBufferV1(THREAD_ID, { initialCursor: 4 });
    expect(buffer.offer(durable(6))).toEqual({
      status: 'replay_required',
      cursor: 4,
      latestAvailableCursor: 6,
      reason: 'sequence_gap',
    });
    buffer.resetAfterReplay(6);
    expect(buffer.offer(durable(7))).toMatchObject({ status: 'buffered' });
    expect(buffer.offer(durable(7, 99))).toEqual({ status: 'duplicate', cursor: 7 });
  });

  test('retains events until renderer acknowledgement', () => {
    const buffer = new RuntimeEventBufferV1(THREAD_ID);
    buffer.offer(durable(1));
    buffer.offer(durable(2));
    expect(buffer.acknowledgeThrough(1)).toMatchObject({
      acknowledgedCursor: 1,
      latestDurableCursor: 2,
      bufferedItems: 1,
    });
    expect(() => buffer.acknowledgeThrough(3)).toThrow('outside 1..2');
    const read = buffer.read();
    expect(read.status === 'events' ? read.events.map(event => event.seq) : []).toEqual([2]);
  });
});
