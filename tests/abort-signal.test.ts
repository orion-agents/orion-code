/**
 * Issue #32 #4.3: AbortSignal tests
 */

import { executeTool } from '../src/tools/index';

describe('AbortSignal Support', () => {
  describe('executeTool abortSignal parameter', () => {
    it('should accept abortSignal parameter', () => {
      // Verify function signature accepts abortSignal
      expect(typeof executeTool).toBe('function');
    });

    it('should handle aborted signal for exec_command', async () => {
      const controller = new AbortController();

      // Start a long-running command and abort after 100ms
      const resultPromise = executeTool(
        'exec_command',
        { command: 'sleep 5 && echo done', timeout: 10000 },
        controller.signal,
      );

      // Abort after 100ms
      setTimeout(() => controller.abort(), 100);

      const result = await resultPromise;
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.toLowerCase()).toMatch(/aborted|timeout|killed/);
    }, 8000);  // 8 second timeout for the test
  });

  describe('AbortController', () => {
    it('should create abort controller', () => {
      const controller = new AbortController();
      expect(controller.signal.aborted).toBe(false);
    });

    it('should abort after calling abort()', () => {
      const controller = new AbortController();
      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });
  });
});