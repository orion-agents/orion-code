import { canonicalRuntimeJson } from './protocol/canonical';
import {
  assertRuntimeEventEnvelopeV1,
  type RuntimeEventEnvelopeV1,
} from './protocol/runtime-protocol-v1';

export interface RuntimeEventBufferOptionsV1 {
  readonly maxItems?: number;
  readonly maxBytes?: number;
  /** Last durable cursor already rendered by this consumer. */
  readonly initialCursor?: number;
}

export type RuntimeEventBufferOfferV1 =
  | {
      readonly status: 'buffered';
      readonly bufferedItems: number;
      readonly bufferedBytes: number;
      readonly droppedEphemeral: number;
    }
  | {
      readonly status: 'coalesced';
      readonly bufferedItems: number;
      readonly bufferedBytes: number;
    }
  | { readonly status: 'dropped_ephemeral'; readonly reason: 'capacity' | 'replay_required' }
  | { readonly status: 'duplicate'; readonly cursor: number }
  | RuntimeReplayRequiredV1;

export interface RuntimeReplayRequiredV1 {
  readonly status: 'replay_required';
  /** Replay durable events strictly after this acknowledged cursor. */
  readonly cursor: number;
  readonly latestAvailableCursor: number;
  readonly reason: 'durable_overflow' | 'sequence_gap';
}

export type RuntimeEventBufferReadV1 =
  | {
      readonly status: 'events';
      readonly events: readonly RuntimeEventEnvelopeV1[];
      readonly acknowledgedCursor: number;
    }
  | RuntimeReplayRequiredV1;

export interface RuntimeEventBufferSnapshotV1 {
  readonly threadId: string;
  readonly acknowledgedCursor: number;
  readonly latestDurableCursor: number;
  readonly bufferedItems: number;
  readonly bufferedBytes: number;
  readonly replayRequired?: Omit<RuntimeReplayRequiredV1, 'status'>;
}

interface BufferedRuntimeEventV1 {
  readonly event: RuntimeEventEnvelopeV1;
  readonly bytes: number;
}

const DEFAULT_MAX_ITEMS = 256;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Per-consumer delivery buffer for semantic runtime events.
 *
 * Durable overflow never silently drops facts: the consumer is detached from
 * live delivery and must replay from its last acknowledged durable cursor.
 * Ephemeral deltas may be coalesced or dropped to keep memory bounded.
 */
export class RuntimeEventBufferV1 {
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly items: BufferedRuntimeEventV1[] = [];
  private bufferedBytes = 0;
  private acknowledgedCursor: number;
  private latestDurableCursor: number;
  private replayRequired: Omit<RuntimeReplayRequiredV1, 'status'> | undefined;

  constructor(
    readonly threadId: string,
    options: RuntimeEventBufferOptionsV1 = {}
  ) {
    this.maxItems = positiveInteger(options.maxItems ?? DEFAULT_MAX_ITEMS, 'maxItems');
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
    this.acknowledgedCursor = nonNegativeInteger(options.initialCursor ?? 0, 'initialCursor');
    this.latestDurableCursor = this.acknowledgedCursor;
  }

  offer(event: RuntimeEventEnvelopeV1): RuntimeEventBufferOfferV1 {
    assertRuntimeEventEnvelopeV1(event);
    if (event.threadId !== this.threadId) {
      throw new Error(
        `Runtime event belongs to thread ${event.threadId}, expected ${this.threadId}`
      );
    }

    if (this.replayRequired) {
      if (event.durability === 'durable') {
        this.replayRequired = {
          ...this.replayRequired,
          latestAvailableCursor: Math.max(this.replayRequired.latestAvailableCursor, event.seq),
        };
        return this.replayResult();
      }
      return { status: 'dropped_ephemeral', reason: 'replay_required' };
    }

    if (event.durability === 'ephemeral') return this.offerEphemeral(event);
    if (event.seq <= this.latestDurableCursor) {
      return { status: 'duplicate', cursor: this.latestDurableCursor };
    }
    if (event.seq !== this.latestDurableCursor + 1) {
      return this.requireReplay('sequence_gap', event.seq);
    }

    const bytes = eventBytes(event);
    const droppedEphemeral = this.evictEphemeralUntilFits(bytes);
    if (bytes > this.maxBytes || !this.fits(bytes)) {
      return this.requireReplay('durable_overflow', event.seq);
    }
    this.items.push({ event, bytes });
    this.bufferedBytes += bytes;
    this.latestDurableCursor = event.seq;
    return {
      status: 'buffered',
      bufferedItems: this.items.length,
      bufferedBytes: this.bufferedBytes,
      droppedEphemeral,
    };
  }

  read(maxItems = this.maxItems): RuntimeEventBufferReadV1 {
    if (this.replayRequired) return this.replayResult();
    const limit = positiveInteger(maxItems, 'read maxItems');
    return deepFreeze({
      status: 'events' as const,
      events: this.items.slice(0, limit).map(item => item.event),
      acknowledgedCursor: this.acknowledgedCursor,
    });
  }

  /**
   * Acknowledge renderer delivery through a durable cursor. Events remain
   * queued until this call, so a failed writer can reconnect and replay.
   */
  acknowledgeThrough(cursor: number): RuntimeEventBufferSnapshotV1 {
    const nextCursor = nonNegativeInteger(cursor, 'acknowledgement cursor');
    if (this.replayRequired) {
      throw new Error('Cannot acknowledge live events while durable replay is required');
    }
    if (nextCursor < this.acknowledgedCursor || nextCursor > this.latestDurableCursor) {
      throw new Error(
        `Acknowledgement cursor ${nextCursor} is outside ${this.acknowledgedCursor}..${this.latestDurableCursor}`
      );
    }
    this.acknowledgedCursor = nextCursor;
    this.removeWhere(item => item.event.seq <= nextCursor);
    return this.getSnapshot();
  }

  /** Resume live delivery after the consumer has replayed through cursor. */
  resetAfterReplay(cursor: number): RuntimeEventBufferSnapshotV1 {
    const nextCursor = nonNegativeInteger(cursor, 'replay cursor');
    if (!this.replayRequired) throw new Error('Runtime event buffer does not require replay');
    if (nextCursor < this.replayRequired.latestAvailableCursor) {
      throw new Error(
        `Replay cursor ${nextCursor} has not reached ${this.replayRequired.latestAvailableCursor}`
      );
    }
    this.items.splice(0);
    this.bufferedBytes = 0;
    this.acknowledgedCursor = nextCursor;
    this.latestDurableCursor = nextCursor;
    this.replayRequired = undefined;
    return this.getSnapshot();
  }

  getSnapshot(): RuntimeEventBufferSnapshotV1 {
    return deepFreeze({
      threadId: this.threadId,
      acknowledgedCursor: this.acknowledgedCursor,
      latestDurableCursor: this.latestDurableCursor,
      bufferedItems: this.items.length,
      bufferedBytes: this.bufferedBytes,
      replayRequired: this.replayRequired ? { ...this.replayRequired } : undefined,
    });
  }

  private offerEphemeral(event: RuntimeEventEnvelopeV1): RuntimeEventBufferOfferV1 {
    if (event.seq < this.acknowledgedCursor || event.seq > this.latestDurableCursor) {
      return { status: 'dropped_ephemeral', reason: 'capacity' };
    }
    const previous = this.items.at(-1);
    if (previous && canCoalesce(previous.event, event)) {
      const merged = mergeDeltas(previous.event, event);
      const bytes = eventBytes(merged);
      if (bytes <= this.maxBytes && this.bufferedBytes - previous.bytes + bytes <= this.maxBytes) {
        this.items[this.items.length - 1] = { event: merged, bytes };
        this.bufferedBytes += bytes - previous.bytes;
        return {
          status: 'coalesced',
          bufferedItems: this.items.length,
          bufferedBytes: this.bufferedBytes,
        };
      }
      return { status: 'dropped_ephemeral', reason: 'capacity' };
    }

    const bytes = eventBytes(event);
    if (bytes > this.maxBytes || !this.fits(bytes)) {
      return { status: 'dropped_ephemeral', reason: 'capacity' };
    }
    this.items.push({ event, bytes });
    this.bufferedBytes += bytes;
    return {
      status: 'buffered',
      bufferedItems: this.items.length,
      bufferedBytes: this.bufferedBytes,
      droppedEphemeral: 0,
    };
  }

  private evictEphemeralUntilFits(incomingBytes: number): number {
    let dropped = 0;
    while (!this.fits(incomingBytes)) {
      const index = this.items.findIndex(item => item.event.durability === 'ephemeral');
      if (index < 0) break;
      this.bufferedBytes -= this.items[index].bytes;
      this.items.splice(index, 1);
      dropped += 1;
    }
    return dropped;
  }

  private fits(incomingBytes: number): boolean {
    return (
      this.items.length + 1 <= this.maxItems && this.bufferedBytes + incomingBytes <= this.maxBytes
    );
  }

  private requireReplay(
    reason: RuntimeReplayRequiredV1['reason'],
    latestAvailableCursor: number
  ): RuntimeReplayRequiredV1 {
    this.items.splice(0);
    this.bufferedBytes = 0;
    this.replayRequired = {
      cursor: this.acknowledgedCursor,
      latestAvailableCursor: Math.max(this.latestDurableCursor, latestAvailableCursor),
      reason,
    };
    return this.replayResult();
  }

  private replayResult(): RuntimeReplayRequiredV1 {
    if (!this.replayRequired) throw new Error('Replay state is missing');
    return { status: 'replay_required', ...this.replayRequired };
  }

  private removeWhere(predicate: (item: BufferedRuntimeEventV1) => boolean): void {
    const retained: BufferedRuntimeEventV1[] = [];
    let retainedBytes = 0;
    for (const item of this.items) {
      if (!predicate(item)) {
        retained.push(item);
        retainedBytes += item.bytes;
      }
    }
    this.items.splice(0, this.items.length, ...retained);
    this.bufferedBytes = retainedBytes;
  }
}

function canCoalesce(left: RuntimeEventEnvelopeV1, right: RuntimeEventEnvelopeV1): boolean {
  return (
    left.durability === 'ephemeral' &&
    right.durability === 'ephemeral' &&
    left.payload.type === 'item.delta' &&
    right.payload.type === 'item.delta' &&
    left.turnId === right.turnId &&
    left.stepId === right.stepId &&
    left.itemId === right.itemId &&
    left.payload.data.channel === right.payload.data.channel
  );
}

function mergeDeltas(
  left: RuntimeEventEnvelopeV1,
  right: RuntimeEventEnvelopeV1
): RuntimeEventEnvelopeV1 {
  if (left.payload.type !== 'item.delta' || right.payload.type !== 'item.delta') {
    throw new Error('Only item.delta events can be coalesced');
  }
  return deepFreeze({
    ...right,
    payload: {
      type: 'item.delta' as const,
      data: {
        delta: left.payload.data.delta + right.payload.data.delta,
        channel: right.payload.data.channel,
      },
    },
  });
}

function eventBytes(event: RuntimeEventEnvelopeV1): number {
  return Buffer.byteLength(canonicalRuntimeJson(event), 'utf8');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
