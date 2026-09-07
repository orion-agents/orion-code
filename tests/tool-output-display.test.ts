/**
 * v0.3.13 S4 — safe tool-output parsing contracts.
 */
import { parseToolPreview } from '../web/src/components/tool-output-display';

const ENVELOPE = JSON.stringify({
  success: true,
  output: 'async function greet() {\n  return "hi";\n}',
});

describe('parseToolPreview (v0.3.13 S4)', () => {
  it('keeps plain text byte-for-byte identical', () => {
    const plain = 'No JSON here.\nJust two lines.\n\tindented';
    const result = parseToolPreview(plain)!;
    expect(result.format).toBe('plain');
    expect(result.displayText).toBe(plain);
    expect(result.isEnvelope).toBe(false);
  });

  it('returns null for empty / absent input', () => {
    expect(parseToolPreview(null)).toBeNull();
    expect(parseToolPreview(undefined)).toBeNull();
    expect(parseToolPreview('   ')).not.toBeNull();
  });

  it('unwraps a JSON envelope exactly once and restores real newlines', () => {
    const result = parseToolPreview(ENVELOPE)!;
    expect(result.format).toBe('envelope');
    expect(result.isEnvelope).toBe(true);
    expect(result.displayText).toContain('function greet() {');
    expect(result.displayText).toContain('\n  return "hi";');
    // No literal escape sequences survive unwrapping.
    expect(result.displayText).not.toContain('\\n');
  });

  it('never string-replaces escapes in genuine command output', () => {
    // A real command may legitimately contain backslash-n text; plain passthrough must keep it.
    const literal = 'grep found path\\nvalue';
    const result = parseToolPreview(literal)!;
    expect(result.format).toBe('plain');
    expect(result.displayText).toBe(literal);
  });

  it('pretty-prints ordinary parseable JSON', () => {
    const result = parseToolPreview('{"a":1,"b":[2,3]}')!;
    expect(result.format).toBe('json');
    expect(result.displayText).toContain('\n  "a": 1');
    expect(result.displayText).toContain('\n  "b": [');
  });

  it('does not crash on invalid JSON and falls back to plain text', () => {
    const broken = '{"output": "unterminated';
    const result = parseToolPreview(broken)!;
    expect(result.format).toBe('plain');
    expect(result.displayText).toBe(broken);
  });

  it('treats an object without a string output as ordinary JSON', () => {
    const result = parseToolPreview('{"success":true,"items":42}')!;
    expect(result.format).toBe('json');
    expect(result.isEnvelope).toBe(false);
  });

  it('flags long results by line count for default folding', () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const long = parseToolPreview(manyLines)!;
    expect(long.isLong).toBe(true);
    const short = parseToolPreview('one line')!;
    expect(short.isLong).toBe(false);
  });
});
