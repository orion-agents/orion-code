/**
 * Tool Result Serializer unit tests
 */

import { serializeToolResult, parseToolResultEnvelope, TOOL_RESULT_SCHEMA_VERSION } from '../src/framework/tool-serializer';

describe('tool-serializer', () => {
  test('TOOL_RESULT_SCHEMA_VERSION is 1', () => {
    expect(TOOL_RESULT_SCHEMA_VERSION).toBe(1);
  });

  test('serializeToolResult produces v1 envelope', () => {
    const result = serializeToolResult({
      success: true,
      output: 'hello',
      summary: 'done',
      outputBytes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe('hello');
    expect(parsed.summary).toBe('done');
  });

  test('parseToolResultEnvelope recognizes v1 envelope', () => {
    const serialized = serializeToolResult({
      success: true,
      output: 'result',
      artifactRef: { id: 'tool-1-abc', outputBytes: 50000 },
    });

    const envelope = parseToolResultEnvelope(serialized);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.success).toBe(true);
    expect(envelope.output).toBe('result');
    expect(envelope.artifactRef).toEqual({ id: 'tool-1-abc', outputBytes: 50000 });
  });

  test('parseToolResultEnvelope handles legacy JSON (no schemaVersion)', () => {
    const legacy = JSON.stringify({
      success: true,
      output: 'legacy result',
    });

    const envelope = parseToolResultEnvelope(legacy);
    expect(envelope.schemaVersion).toBeUndefined();
    expect(envelope.success).toBe(true);
    expect(envelope.output).toBe('legacy result');
  });

  test('parseToolResultEnvelope handles non-JSON strings', () => {
    const envelope = parseToolResultEnvelope('plain text output');
    expect(envelope.success).toBe(true);
    expect(envelope.output).toBe('plain text output');
    expect(envelope.outputBytes).toBeGreaterThan(0);
  });

  test('parseToolResultEnvelope handles failure envelope', () => {
    const serialized = serializeToolResult({
      success: false,
      output: '',
      error: 'File not found',
    });

    const envelope = parseToolResultEnvelope(serialized);
    expect(envelope.success).toBe(false);
    expect(envelope.error).toBe('File not found');
  });

  test('round-trip: serialize → parse preserves all fields', () => {
    const original = {
      success: true,
      output: 'full output',
      summary: 'compact',
      outputBytes: 11,
      artifactRef: { id: 'art-1', outputBytes: 50000 },
      metadata: { candidates: [{ index: 0, line: 1 }] },
    };

    const serialized = serializeToolResult(original);
    const parsed = parseToolResultEnvelope(serialized);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe('full output');
    expect(parsed.summary).toBe('compact');
    expect(parsed.artifactRef).toEqual({ id: 'art-1', outputBytes: 50000 });
  });
});
