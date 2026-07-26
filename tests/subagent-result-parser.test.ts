import { parseSubtaskResult, extractJsonObject } from '../src/runtime/subagents/result-parser';
import type { SubtaskUsage } from '../src/runtime/subagents/types';

const USAGE: SubtaskUsage = { modelRequests: 3, toolCalls: 5, promptTokens: 100, completionTokens: 50, durationMs: 2000 };

describe('subagent result parser', () => {
  describe('extractJsonObject', () => {
    it('extracts a JSON object surrounded by prose', () => {
      const text = 'Here is my result:\n{"summary":"ok","findings":[]}\nDone.';
      expect(extractJsonObject(text)).toEqual({ summary: 'ok', findings: [] });
    });
    it('extracts a nested object', () => {
      const text = '{"a":{"b":{"c":1}}}';
      expect(extractJsonObject(text)).toEqual({ a: { b: { c: 1 } } });
    });
    it('handles strings containing braces', () => {
      const text = '{"summary":"has a } inside"}';
      expect(extractJsonObject(text)).toEqual({ summary: 'has a } inside' });
    });
    it('returns null for non-JSON text', () => {
      expect(extractJsonObject('no json here')).toBeNull();
      expect(extractJsonObject('')).toBeNull();
    });
  });

  describe('parseSubtaskResult completed', () => {
    it('parses a well-formed result', () => {
      const content = JSON.stringify({
        summary: 'Found 3 cancel handlers',
        findings: [
          { severity: 'high', title: 'Missing cleanup in supervisor', evidence: 'src/x.ts:42', file: 'src/x.ts', line: 42 },
          { title: 'Minor race', evidence: 'src/y.ts:10' },
        ],
        files: ['src/x.ts', 'src/y.ts'],
        commands: [{ command: 'npm test', purpose: 'verify' }],
        verification: ['run the cancel test'],
        risks: ['untested on windows'],
      });
      const result = parseSubtaskResult({ id: 't1', role: 'research', content, status: 'completed', usage: USAGE });
      expect(result.status).toBe('completed');
      expect(result.summary).toBe('Found 3 cancel handlers');
      expect(result.findings).toHaveLength(2);
      expect(result.findings[0]).toMatchObject({ severity: 'high', file: 'src/x.ts', line: 42 });
      expect(result.findings[1].severity).toBeUndefined();
      expect(result.files).toEqual(['src/x.ts', 'src/y.ts']);
      expect(result.commands[0]).toMatchObject({ command: 'npm test', executed: false });
      expect(result.usage).toEqual(USAGE);
    });

    it('forces commands.executed to false even if child claims true', () => {
      const content = JSON.stringify({ summary: 's', commands: [{ command: 'rm -rf /', purpose: 'cleanup', executed: true }] });
      const result = parseSubtaskResult({ id: 't1', role: 'research', content, status: 'completed' });
      expect(result.commands[0].executed).toBe(false);
    });

    it('drops invalid severity values', () => {
      const content = JSON.stringify({ summary: 's', findings: [{ title: 't', evidence: 'e', severity: 'catastrophic' }] });
      const result = parseSubtaskResult({ id: 't1', role: 'review', content, status: 'completed' });
      expect(result.findings[0].severity).toBeUndefined();
    });

    it('caps the number of findings and files', () => {
      const findings = Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, evidence: 'e' }));
      const files = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
      const content = JSON.stringify({ summary: 's', findings, files });
      const result = parseSubtaskResult({ id: 't1', role: 'research', content, status: 'completed' });
      expect(result.findings.length).toBeLessThanOrEqual(20);
      expect(result.files.length).toBeLessThanOrEqual(50);
    });
  });

  describe('parseSubtaskResult failure modes', () => {
    it('marks non-JSON completed output as failed', () => {
      const result = parseSubtaskResult({ id: 't1', role: 'research', content: 'I could not find anything', status: 'completed' });
      expect(result.status).toBe('failed');
      expect(result.risks).toContain('child returned non-JSON output');
    });

    it('marks completed output missing summary as failed', () => {
      const content = JSON.stringify({ findings: [] });
      const result = parseSubtaskResult({ id: 't1', role: 'research', content, status: 'completed' });
      expect(result.status).toBe('failed');
      expect(result.risks[0]).toMatch(/summary/);
    });

    it('summarizes timeout with partial output', () => {
      const result = parseSubtaskResult({ id: 't1', role: 'research', content: 'partial work', status: 'timed_out' });
      expect(result.status).toBe('timed_out');
      expect(result.summary).toMatch(/timed out/);
      expect(result.summary).toMatch(/partial work/);
      expect(result.risks).toContain('child did not complete: timed_out');
    });

    it('summarizes cancellation', () => {
      const result = parseSubtaskResult({ id: 't1', role: 'research', content: '', status: 'cancelled' });
      expect(result.status).toBe('cancelled');
      expect(result.summary).toMatch(/cancelled/);
    });

    it('summarizes generic failure', () => {
      const result = parseSubtaskResult({ id: 't1', role: 'research', content: 'provider error 500', status: 'failed' });
      expect(result.status).toBe('failed');
      expect(result.summary).toMatch(/provider error 500/);
    });

    it('uses empty usage when not provided', () => {
      const result = parseSubtaskResult({ id: 't1', role: 'research', content: '{}', status: 'completed' });
      expect(result.usage.modelRequests).toBe(0);
    });
  });
});

describe('extractJsonObject robustness (bug-hunt round 5)', () => {
  it('skips a leading non-JSON brace fragment and parses the later valid object', () => {
    // A child may emit "{ result above }" style prose before the real JSON.
    // The first balanced brace pair is "{ result above }" which is not valid
    // JSON; the parser must continue scanning and return the real object.
    const text = 'Here is the { result above } output: {"summary":"ok","findings":[]}';
    expect(extractJsonObject(text)).toEqual({ summary: 'ok', findings: [] });
  });

  it('skips multiple non-JSON brace fragments before the valid object', () => {
    const text = 'noise { a } more { b } then {"summary":"done"}';
    expect(extractJsonObject(text)).toEqual({ summary: 'done' });
  });
});
