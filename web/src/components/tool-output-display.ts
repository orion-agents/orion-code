/**
 * v0.3.13 S4 — safe presentation parsing for tool output previews.
 *
 * Tool runtimes frequently ship their structured result as a JSON-encoded
 * string envelope (`{"success":true,"output":"async function…\n…"}`). If the
 * browser prints that string verbatim the user sees escaped quotes and literal
 * `\n` noise instead of the real result. This helper unwraps such an envelope
 * ONLY when `JSON.parse` actually succeeds — never with a global
 * `replace(/\\n/g, "\n")`, which would corrupt genuine command output.
 *
 * Contract:
 * - plain / unparseable text stays byte-for-byte identical;
 * - an object with a string `output` field is unwrapped once (real newlines
 *   restored by the parser itself);
 * - other parseable JSON is pretty-printed safely;
 * - nothing here ever becomes HTML/Markdown; callers still sanitize the text
 *   before rendering and keep the original response available for copying.
 */
export type ToolPreviewFormat = 'plain' | 'json' | 'envelope';

export interface ToolPreviewResult {
  readonly format: ToolPreviewFormat;
  /** Text safe to render inside a <pre> after the caller's sanitization. */
  readonly displayText: string;
  readonly isEnvelope: boolean;
  readonly lineCount: number;
  /** Long results are collapsed by default on success. */
  readonly isLong: boolean;
}

export const TOOL_PREVIEW_LONG_LINE_LIMIT = 40;

function lineCountOf(value: string): number {
  if (value.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseToolPreview(raw: string | null | undefined): ToolPreviewResult | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0)
    return { format: 'plain', displayText: raw, isEnvelope: false, lineCount: 0, isLong: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      format: 'plain',
      displayText: raw,
      isEnvelope: false,
      lineCount: lineCountOf(raw),
      isLong: lineCountOf(raw) > TOOL_PREVIEW_LONG_LINE_LIMIT,
    };
  }

  if (isRecord(parsed) && typeof parsed.output === 'string') {
    // Known envelope: unwrap the inner string once — the JSON parser restores
    // real newlines. Never recurse or string-replace escapes here.
    const displayText = parsed.output;
    return {
      format: 'envelope',
      displayText,
      isEnvelope: true,
      lineCount: lineCountOf(displayText),
      isLong: lineCountOf(displayText) > TOOL_PREVIEW_LONG_LINE_LIMIT,
    };
  }

  // Ordinary JSON: safe pretty print (object/array/scalars).
  try {
    const pretty = JSON.stringify(parsed, null, 2);
    return {
      format: 'json',
      displayText: pretty,
      isEnvelope: false,
      lineCount: lineCountOf(pretty),
      isLong: lineCountOf(pretty) > TOOL_PREVIEW_LONG_LINE_LIMIT,
    };
  } catch {
    return {
      format: 'plain',
      displayText: raw,
      isEnvelope: false,
      lineCount: lineCountOf(raw),
      isLong: false,
    };
  }
}
