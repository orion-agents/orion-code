/**
 * v0.2.24 Phase 1 — Goal command tests.
 */

import { parseTargetCommand } from '../src/commands/target-command';
import { GOAL_INVARIANTS } from '../src/runtime/goals/types';

describe('/target command parsing', () => {
  describe('show', () => {
    it('bare /target shows current goal', () => {
      const result = parseTargetCommand('/target');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.action).toBe('show');
    });

    it('/target status shows current goal', () => {
      const result = parseTargetCommand('/target status');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.action).toBe('show');
    });

    it('/goal is a compatible alias', () => {
      const result = parseTargetCommand('/goal');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.action).toBe('show');
    });
  });

  describe('create', () => {
    it('creates goal from objective text', () => {
      const result = parseTargetCommand('/target fix all failing tests');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('create');
        expect(result.input.payload?.objective).toBe('fix all failing tests');
      }
    });

    it('rejects empty objective', () => {
      // After /target, if rest is empty, it shows status.
      const result = parseTargetCommand('/target ');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.action).toBe('show');
    });

    it('rejects objective exceeding 4000 chars', () => {
      const long = 'x'.repeat(4001);
      const result = parseTargetCommand(`/target ${long}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('too long');
    });
  });

  describe('control commands', () => {
    it('pause', () => {
      const result = parseTargetCommand('/target pause');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.action).toBe('pause');
    });

    it('resume', () => {
      const result = parseTargetCommand('/target resume');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.action).toBe('resume');
    });

    it('edit', () => {
      const result = parseTargetCommand('/target edit new objective text');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('edit');
        expect(result.input.payload?.objective).toBe('new objective text');
      }
    });

    it('replace', () => {
      const result = parseTargetCommand('/target replace completely new goal');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('replace');
        expect(result.input.payload?.objective).toBe('completely new goal');
      }
    });

    it('clear without confirmation', () => {
      const result = parseTargetCommand('/target clear');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('clear');
        expect(result.input.payload?.confirmed).toBe(false);
      }
    });

    it('clear with confirmation', () => {
      const result = parseTargetCommand('/target clear --yes');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('clear');
        expect(result.input.payload?.confirmed).toBe(true);
      }
    });
  });

  describe('budget', () => {
    it('sets a token budget', () => {
      const result = parseTargetCommand('/target budget 50000');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('set_budget');
        expect(result.input.payload?.tokenBudget).toBe(50000);
      }
    });

    it('clears budget with off', () => {
      const result = parseTargetCommand('/target budget off');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('set_budget');
        expect(result.input.payload?.tokenBudget).toBeNull();
      }
    });

    it('rejects zero budget', () => {
      const result = parseTargetCommand('/target budget 0');
      expect(result.ok).toBe(false);
    });

    it('rejects negative budget', () => {
      const result = parseTargetCommand('/target budget -100');
      expect(result.ok).toBe(false);
    });

    it('rejects non-integer budget', () => {
      const result = parseTargetCommand('/target budget 1.5');
      expect(result.ok).toBe(false);
    });
  });

  describe('/goal alias', () => {
    it('/goal pause works', () => {
      const result = parseTargetCommand('/goal pause');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.action).toBe('pause');
    });

    it('/goal create works', () => {
      const result = parseTargetCommand('/goal finish the project');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('create');
        expect(result.input.payload?.objective).toBe('finish the project');
      }
    });
  });
});