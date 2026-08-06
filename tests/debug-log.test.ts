/**
 * Tests for the swallowed-error diagnostics boundary (#9).
 *
 * The contract that matters: silent by default, informative when opted in,
 * and never able to throw out of the catch block it instruments.
 */

import { debugError, formatError, isDebugEnabled, DEBUG_ENV_VAR } from '../src/utils/debug-log';

describe('debug-log', () => {
  const originalValue = process.env[DEBUG_ENV_VAR];
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    stderr.mockRestore();
    if (originalValue === undefined) {
      delete process.env[DEBUG_ENV_VAR];
    } else {
      process.env[DEBUG_ENV_VAR] = originalValue;
    }
  });

  describe('isDebugEnabled', () => {
    it('is off unless explicitly enabled', () => {
      delete process.env[DEBUG_ENV_VAR];
      expect(isDebugEnabled()).toBe(false);

      process.env[DEBUG_ENV_VAR] = '0';
      expect(isDebugEnabled()).toBe(false);

      process.env[DEBUG_ENV_VAR] = 'no';
      expect(isDebugEnabled()).toBe(false);
    });

    it('accepts both "1" and "true"', () => {
      process.env[DEBUG_ENV_VAR] = '1';
      expect(isDebugEnabled()).toBe(true);

      process.env[DEBUG_ENV_VAR] = 'true';
      expect(isDebugEnabled()).toBe(true);
    });

    it('re-reads the environment on every call', () => {
      delete process.env[DEBUG_ENV_VAR];
      expect(isDebugEnabled()).toBe(false);
      process.env[DEBUG_ENV_VAR] = '1';
      expect(isDebugEnabled()).toBe(true);
    });
  });

  describe('formatError', () => {
    it('keeps the message and a bounded slice of the stack', () => {
      const formatted = formatError(new Error('boom'));
      expect(formatted).toContain('boom');
      expect(formatted.split('\n')).toHaveLength(1);
    });

    it('handles non-Error throwables', () => {
      expect(formatError('plain string')).toBe('plain string');
      expect(formatError(undefined)).toBe('(no error value)');
      expect(formatError({ code: 'ENOENT' })).toBe('{"code":"ENOENT"}');
    });

    it('does not throw on circular structures', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => formatError(circular)).not.toThrow();
    });
  });

  describe('debugError', () => {
    it('writes nothing when diagnostics are disabled', () => {
      delete process.env[DEBUG_ENV_VAR];
      debugError('scope.test', new Error('boom'));
      expect(stderr).not.toHaveBeenCalled();
    });

    it('reports scope, detail and message when enabled', () => {
      process.env[DEBUG_ENV_VAR] = '1';
      debugError('auth.load', new Error('bad json'), '/tmp/auth.json');

      expect(stderr).toHaveBeenCalledTimes(1);
      const line = stderr.mock.calls[0][0] as string;
      expect(line).toContain('[orion:debug]');
      expect(line).toContain('auth.load');
      expect(line).toContain('/tmp/auth.json');
      expect(line).toContain('bad json');
    });

    it('omits the detail segment when none is given', () => {
      process.env[DEBUG_ENV_VAR] = '1';
      debugError('auth.load', new Error('bad json'));
      expect(stderr.mock.calls[0][0]).not.toContain('[]');
    });

    it('never propagates a failure from the logger itself', () => {
      process.env[DEBUG_ENV_VAR] = '1';
      stderr.mockImplementation(() => {
        throw new Error('EPIPE');
      });
      expect(() => debugError('scope.test', new Error('boom'))).not.toThrow();
    });
  });
});
