import type { RuntimeToolStartedEvent, RuntimeToolFinishedEvent } from '../src/runtime/ui-events';

let defaultSeq = 0;

/** Reset the default sequence counter (call in beforeEach if needed). */
export function resetToolEventSequence(start = 0): void {
  defaultSeq = start;
}

/**
 * Create a RuntimeToolStartedEvent with sensible defaults.
 * `sequence` defaults to `1` and increments for each call within the same test
 * unless explicitly overridden. Call {@link resetToolEventSequence} in beforeEach
 * to start fresh each test.
 */
export function makeToolStartedEvent(
  overrides: Partial<RuntimeToolStartedEvent> & { callId: string; name: string },
): RuntimeToolStartedEvent {
  return {
    args: {},
    ...overrides,
    sequence: overrides.sequence ?? ++defaultSeq,
  };
}

/**
 * Create a RuntimeToolFinishedEvent with sensible defaults.
 * `sequence` does NOT auto-increment — pass an explicit `sequence` if you
 * want to pair it with the value from {@link makeToolStartedEvent}.
 * The default is the current counter value (the last sequence handed out).
 */
export function makeToolFinishedEvent(
  overrides: Partial<RuntimeToolFinishedEvent> & { callId: string; name: string },
): RuntimeToolFinishedEvent {
  return {
    args: {},
    success: true,
    duration: 10,
    ...overrides,
    sequence: overrides.sequence ?? defaultSeq,
  };
}
