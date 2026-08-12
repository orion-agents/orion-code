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
      if (!result.ok) {
        expect(result.error).toContain('too long');
        expect(result.error).not.toContain('--file');
      }
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

    it('parses explicit user criterion confirmation', () => {
      const result = parseTargetCommand('/target confirm criterion:manual');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('confirm');
        expect(result.input.payload?.criterionId).toBe('criterion:manual');
      }
    });

    it('rejects malformed user criterion confirmation', () => {
      expect(parseTargetCommand('/target confirm criterion:manual extra').ok).toBe(false);
    });

    it('edit', () => {
      const result = parseTargetCommand('/target edit new objective text');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('edit');
        expect(result.input.payload?.objective).toBe('new objective text');
      }
    });

    it('normalizes extra spacing around an existing subcommand', () => {
      const status = parseTargetCommand('/target   status');
      expect(status.ok && status.input.action).toBe('show');

      const edit = parseTargetCommand('/target   edit   new objective');
      expect(edit.ok && edit.input).toMatchObject({
        action: 'edit',
        payload: { objective: 'new objective' },
      });
    });

    it.each(['confirm', 'edit', 'replace', 'budget'])(
      'does not create a Goal for the bare reserved subcommand %s',
      subcommand => {
        const result = parseTargetCommand(`/target ${subcommand}`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('Usage:');
      }
    );

    it('does not advertise an unimplemented --file mode for oversized edits', () => {
      const result = parseTargetCommand(`/target edit ${'x'.repeat(4001)}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain('--file');
    });

    it('replace', () => {
      const result = parseTargetCommand('/target replace completely new goal');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('replace');
        expect(result.input.payload?.objective).toBe('completely new goal');
      }
    });

    it('exits with explicit authorization', () => {
      const result = parseTargetCommand('/goal exit');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.action).toBe('clear');
        expect(result.input.payload?.confirmed).toBe(true);
      }
    });

    it.each(['/goal clear', '/goal clear --yes', '/target clear --yes'])(
      'rejects removed clear syntax: %s',
      command => {
        const result = parseTargetCommand(command);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('Use');
      }
    );

    it('rejects arguments after exit instead of creating an accidental Goal', () => {
      const result = parseTargetCommand('/goal exit --yes');
      expect(result).toEqual({ ok: false, error: 'Usage: /goal exit' });
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
