/**
 * v0.2.25 Phase 3-4 — Stream recovery + Circuit breaker tests.
 */

import {
  reconcileStreamOverlap,
  buildRecoveryInstruction,
  isSemanticDelta,
  isPartialToolCall,
} from '../src/services/provider-resilience/stream-recovery';
import { ProviderCircuitBreaker } from '../src/services/provider-resilience/circuit-breaker';

describe('Stream recovery', () => {
  describe('reconcileStreamOverlap', () => {
    it('finds exact suffix-prefix overlap', () => {
      const result = reconcileStreamOverlap('hello world', 'world is good');
      expect(result.overlapFound).toBe(true);
      expect(result.suffix).toBe(' is good');
      expect(result.overlapText).toBe('world');
    });

    it('returns full recovery text when no overlap', () => {
      const result = reconcileStreamOverlap('hello', 'completely different');
      expect(result.overlapFound).toBe(false);
      expect(result.suffix).toContain('[stream recovered]');
      expect(result.suffix).toContain('completely different');
    });

    it('handles empty previous text', () => {
      const result = reconcileStreamOverlap('', 'fresh start');
      expect(result.overlapFound).toBe(false);
      expect(result.suffix).toBe('fresh start');
    });

    it('handles CJK overlap', () => {
      const result = reconcileStreamOverlap('你好世界', '世界很大');
      expect(result.overlapFound).toBe(true);
      expect(result.suffix).toBe('很大');
    });

    it('respects maxWindow', () => {
      const longText = 'x'.repeat(3000) + 'end marker';
      const result = reconcileStreamOverlap(longText, 'end marker continues', 100);
      expect(result.overlapFound).toBe(true);
      expect(result.suffix).toBe(' continues');
    });
  });

  describe('isSemanticDelta', () => {
    it('text content is semantic', () => {
      expect(isSemanticDelta({ content: 'hello' })).toBe(true);
    });

    it('empty content is not semantic', () => {
      expect(isSemanticDelta({ content: '' })).toBe(false);
    });

    it('tool call is semantic', () => {
      expect(isSemanticDelta({ tool_calls: [{}] })).toBe(true);
    });

    it('null is not semantic', () => {
      expect(isSemanticDelta(null)).toBe(false);
    });
  });

  describe('isPartialToolCall', () => {
    it('no tool delta is not partial', () => {
      expect(isPartialToolCall({
        toolCallDeltaSeen: false,
        partialToolCalls: new Map(),
      })).toBe(false);
    });

    it('missing name is partial', () => {
      expect(isPartialToolCall({
        toolCallDeltaSeen: true,
        partialToolCalls: new Map([[0, { name: undefined, arguments: '{}' }]]),
      })).toBe(true);
    });

    it('valid JSON args is complete', () => {
      expect(isPartialToolCall({
        toolCallDeltaSeen: true,
        partialToolCalls: new Map([[0, { name: 'read_file', arguments: '{"path":"a"}' }]]),
      })).toBe(false);
    });

    it('invalid JSON args is partial', () => {
      expect(isPartialToolCall({
        toolCallDeltaSeen: true,
        partialToolCalls: new Map([[0, { name: 'read_file', arguments: '{"path":"' }]]),
      })).toBe(true);
    });
  });

  describe('buildRecoveryInstruction', () => {
    it('produces non-empty instruction', () => {
      const inst = buildRecoveryInstruction('partial text');
      expect(inst).toContain('Stream Recovery');
      expect(inst).toContain('partial');
    });
  });
});

describe('Circuit breaker', () => {
  let cb: ProviderCircuitBreaker;

  beforeEach(() => {
    cb = new ProviderCircuitBreaker();
  });

  it('starts closed', () => {
    expect(cb.currentState).toBe('closed');
    expect(cb.allowRequest()).toBe(true);
  });

  it('opens after threshold failures', () => {
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    expect(cb.currentState).toBe('open');
    expect(cb.allowRequest()).toBe(false);
  });

  it('success resets failures', () => {
    for (let i = 0; i < 4; i++) cb.recordFailure();
    cb.recordSuccess();
    // Still closed with 0 failures after success.
    expect(cb.currentState).toBe('closed');
  });

  it('reset clears state', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.currentState).toBe('open');
    cb.reset();
    expect(cb.currentState).toBe('closed');
    expect(cb.allowRequest()).toBe(true);
  });
});