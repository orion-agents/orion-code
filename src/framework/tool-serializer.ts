/**
 * orion code - Tool Result Serializer
 *
 * Unified envelope for tool results. All tool outputs go through this
 * serializer so that the LLM-facing format is consistent and forward-compatible.
 */

import type { ToolResult } from '../framework/tool';

export const TOOL_RESULT_SCHEMA_VERSION = 1;

/**
 * Serialize a ToolResult to a JSON string with schema version.
 */
export function serializeToolResult(result: ToolResult): string {
  return JSON.stringify({
    schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
    success: result.success,
    output: result.output,
    error: result.error,
    summary: result.summary,
    outputBytes: result.outputBytes,
    artifactRef: result.artifactRef,
    metadata: result.metadata,
  });
}

/**
 * Parse a tool result string into a ToolResult envelope.
 * Handles both serialized envelope (v1) and legacy raw JSON formats.
 * Non-JSON strings are wrapped as success with output.
 */
export function parseToolResultEnvelope(raw: string): ToolResult & { schemaVersion?: number } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Recognize v1 envelope
    if (typeof parsed.success === 'boolean' && parsed.schemaVersion === 1) {
      return {
        schemaVersion: 1,
        success: parsed.success,
        output: typeof parsed.output === 'string' ? parsed.output : '',
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        outputBytes: typeof parsed.outputBytes === 'number' ? parsed.outputBytes : undefined,
        artifactRef: typeof parsed.artifactRef === 'object' ? parsed.artifactRef as { id: string; outputBytes: number } : undefined,
        metadata: typeof parsed.metadata === 'object' ? parsed.metadata as Record<string, unknown> : undefined,
      };
    }

    // Legacy JSON (no schemaVersion) — treat as raw result with success=true
    return {
      success: parsed.success === true,
      output: typeof parsed.output === 'string' ? parsed.output : raw,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      outputBytes: typeof parsed.outputBytes === 'number' ? parsed.outputBytes : Buffer.byteLength(raw, 'utf8'),
      artifactRef: typeof parsed.artifactRef === 'object' ? parsed.artifactRef as { id: string; outputBytes: number } : undefined,
    };
  } catch {
    // Non-JSON output — wrap as success
    return {
      success: true,
      output: raw,
      outputBytes: Buffer.byteLength(raw, 'utf8'),
    };
  }
}
