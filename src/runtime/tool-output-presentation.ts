/**
 * v0.2.23 — Tool Output Presentation Policy.
 *
 * Renderer-neutral pure function that creates a ToolOutputView from raw
 * tool output. Terminal adapter continues to use full output; only TUI
 * applies the adaptive/collapsed/full collapse policy.
 */

import { redactTraceText } from '../services/redaction';

// ============================================================================
// Types
// ============================================================================

export type ToolOutputViewMode = 'inline' | 'preview' | 'collapsed';

export type ToolOutputContentKind =
  | 'text'
  | 'json'
  | 'diff'
  | 'log'
  | 'table'
  | 'batch'
  | 'unknown';

export interface ToolOutputDetailRef {
  callId: string;
  sequence: number;
  turnId?: string;
  artifactId?: string;
  traceSessionId?: string;
  outputBytes: number;
  outputLines: number;
}

export interface ToolOutputStepSummary {
  index: number;
  toolName: string;
  state: 'success' | 'error' | 'skipped';
  target?: string;
  summary: string;
  outputBytes: number;
  detailRef?: ToolOutputDetailRef;
}

export interface ToolAggregateView {
  version: 1;
  kind: 'batch_read' | 'subtask_batch' | 'generic_batch';
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  steps: ToolOutputStepSummary[];
}

export interface ToolOutputView {
  mode: ToolOutputViewMode;
  contentKind: ToolOutputContentKind;
  summary: string;
  preview: string;
  previewBytes: number;
  omittedBytes: number;
  omittedLines: number;
  detailRef?: ToolOutputDetailRef;
  aggregate?: ToolAggregateView;
}

export type ToolTranscriptViewMode = 'adaptive' | 'collapsed' | 'full';

export interface ResolvedToolOutputPolicy {
  mode: ToolTranscriptViewMode;
  inlineMaxLines: number;
  inlineMaxBytes: number;
  previewMaxLines: number;
  previewMaxBytes: number;
  errorPreviewMaxLines: number;
  errorPreviewMaxBytes: number;
}

export const DEFAULT_TOOL_OUTPUT_POLICY: ResolvedToolOutputPolicy = {
  mode: 'adaptive',
  inlineMaxLines: 3,
  inlineMaxBytes: 512,
  previewMaxLines: 4,
  previewMaxBytes: 1024,
  errorPreviewMaxLines: 8,
  errorPreviewMaxBytes: 2048,
};

// ============================================================================
// Known noisy aggregate tool names — always collapsed.
// ============================================================================

const ALWAYS_COLLAPSE_TOOLS = new Set([
  'batch_read',
  'batch_write',
  'batch_edit',
]);

// ============================================================================
// Presentation
// ============================================================================

export interface CreateToolOutputViewInput {
  toolName: string;
  success: boolean;
  summary?: string;
  rawOutput: string;
  outputBytes: number;
  artifactRef?: { id: string; outputBytes: number };
  callId: string;
  sequence: number;
  turnId?: string;
  policy: ResolvedToolOutputPolicy;
}

export function createToolOutputView(input: CreateToolOutputViewInput): ToolOutputView {
  const { toolName, success, summary, rawOutput, outputBytes, callId, sequence, policy } = input;

  const contentKind = classifyContent(toolName, rawOutput);
  const sanitized = sanitizeForPreview(rawOutput);
  const outputLines = countLines(sanitized);

  const detailRef: ToolOutputDetailRef = {
    callId,
    sequence,
    turnId: input.turnId,
    artifactId: input.artifactRef?.id,
    outputBytes,
    outputLines,
  };

  const defaultSummary = redactTraceText(summary ?? `${success ? '✓' : '✗'} ${toolName}`);

  const aggregate = tryParseAggregateOutput(toolName, rawOutput, detailRef);

  // Full mode: everything inline.
  if (policy.mode === 'full') {
    return {
      mode: 'inline',
      contentKind,
      summary: defaultSummary,
      preview: sanitized,
      previewBytes: outputBytes,
      omittedBytes: 0,
      omittedLines: 0,
      detailRef,
      aggregate: aggregate ?? undefined,
    };
  }

  // Collapsed mode: no preview.
  if (policy.mode === 'collapsed') {
    return {
      mode: 'collapsed',
      contentKind,
      summary: defaultSummary,
      preview: '',
      previewBytes: 0,
      omittedBytes: outputBytes,
      omittedLines: outputLines,
      detailRef,
      aggregate: aggregate ?? undefined,
    };
  }

  // Adaptive mode: decide based on size and tool type.
  const view = computeAdaptiveView({
    toolName,
    success,
    defaultSummary,
    sanitized,
    outputBytes,
    outputLines,
    detailRef,
    policy,
  });
  return aggregate ? { ...view, contentKind: 'batch', aggregate } : view;
}

function computeAdaptiveView(input: {
  toolName: string;
  success: boolean;
  defaultSummary: string;
  sanitized: string;
  outputBytes: number;
  outputLines: number;
  detailRef: ToolOutputDetailRef;
  policy: ResolvedToolOutputPolicy;
}): ToolOutputView {
  const { toolName, success, defaultSummary, sanitized, outputBytes, outputLines, detailRef, policy } = input;

  // Empty output.
  if (!sanitized || outputBytes === 0) {
    return {
      mode: 'collapsed',
      contentKind: 'text',
      summary: defaultSummary,
      preview: '',
      previewBytes: 0,
      omittedBytes: 0,
      omittedLines: 0,
      detailRef,
    };
  }

  // Always collapse known noisy tools.
  if (ALWAYS_COLLAPSE_TOOLS.has(toolName)) {
    const preview = truncatePreview(sanitized, policy.previewMaxLines, policy.previewMaxBytes);
    return {
      mode: 'collapsed',
      contentKind: 'batch',
      summary: defaultSummary,
      preview,
      previewBytes: Buffer.byteLength(preview, 'utf8'),
      omittedBytes: Math.max(0, outputBytes - Buffer.byteLength(preview, 'utf8')),
      omittedLines: Math.max(0, outputLines - countLines(preview)),
      detailRef,
    };
  }

  // Error: larger preview.
  if (!success) {
    const maxLines = policy.errorPreviewMaxLines;
    const maxBytes = policy.errorPreviewMaxBytes;
    const preview = truncatePreview(sanitized, maxLines, maxBytes);
    const previewBytes = Buffer.byteLength(preview, 'utf8');
    return {
      mode: 'preview',
      contentKind: classifyContent(toolName, sanitized),
      summary: defaultSummary,
      preview,
      previewBytes,
      omittedBytes: Math.max(0, outputBytes - previewBytes),
      omittedLines: Math.max(0, outputLines - countLines(preview)),
      detailRef,
    };
  }

  // Small output: inline full.
  if (outputLines <= policy.inlineMaxLines && outputBytes <= policy.inlineMaxBytes) {
    return {
      mode: 'inline',
      contentKind: classifyContent(toolName, sanitized),
      summary: defaultSummary,
      preview: sanitized,
      previewBytes: outputBytes,
      omittedBytes: 0,
      omittedLines: 0,
      detailRef,
    };
  }

  // Large output: preview.
  const preview = truncatePreview(sanitized, policy.previewMaxLines, policy.previewMaxBytes);
  const previewBytes = Buffer.byteLength(preview, 'utf8');
  return {
    mode: 'preview',
    contentKind: classifyContent(toolName, sanitized),
    summary: defaultSummary,
    preview,
    previewBytes,
    omittedBytes: Math.max(0, outputBytes - previewBytes),
    omittedLines: Math.max(0, outputLines - countLines(preview)),
    detailRef,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function classifyContent(toolName: string, output: string): ToolOutputContentKind {
  if (ALWAYS_COLLAPSE_TOOLS.has(toolName)) return 'batch';
  if (!output.trim()) return 'text';
  const trimmed = output.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('diff ') || trimmed.includes('\n@@ ')) return 'diff';
  return 'text';
}

/**
 * Strip terminal control sequences but preserve safe SGR.
 * OSC, cursor movement, erase, and alternate-screen sequences are removed.
 */
function sanitizeForPreview(text: string): string {
  return redactTraceText(text)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, match => {
      // Keep only SGR (final 'm').
      if (match.endsWith('m')) return match;
      return '';
    })
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

/**
 * Truncate text to fit within line and byte limits without splitting
 * grapheme clusters or producing lone surrogates.
 */
function truncatePreview(text: string, maxLines: number, maxBytes: number): string {
  if (!text) return '';

  // Truncate by lines first.
  const lines = text.split('\n');
  const visibleLines = lines.slice(0, maxLines);
  const result = visibleLines.join('\n');

  // Truncate by bytes.
  let byteCount = 0;
  let output = '';
  for (const char of result) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (byteCount + charBytes > maxBytes) break;
    output += char;
    byteCount += charBytes;
  }

  // Avoid lone surrogate at boundary.
  if (output.length > 0) {
    const lastCode = output.charCodeAt(output.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      output = output.slice(0, -1);
    }
  }

  return output;
}

// ============================================================================
// Aggregate tool presenter
// ============================================================================

export interface AggregateBatchReadResult {
  steps: Array<{
    tool: string;
    target: string;
    success: boolean;
    summary: string;
    outputBytes: number;
  }>;
}

/**
 * Try to parse a known aggregate tool result into a structured view.
 * Returns null if the output doesn't match any known schema.
 */
export function tryParseAggregateOutput(
  toolName: string,
  rawOutput: string,
  detailRef?: ToolOutputDetailRef,
): ToolAggregateView | null {
  if (toolName === 'batch_read') {
    return parseBatchReadOutput(rawOutput, detailRef);
  }
  if (toolName === 'subtask' || toolName === 'subtask_batch') {
    return parseSubtaskBatchOutput(rawOutput, detailRef);
  }
  return null;
}

function parseBatchReadOutput(
  rawOutput: string,
  parentDetailRef?: ToolOutputDetailRef,
): ToolAggregateView | null {
  try {
    const parsed = JSON.parse(rawOutput);
    if (!parsed || typeof parsed !== 'object') return null;

    // Expected shape: { success: boolean, output: string, summary: string, steps?: [...] }
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    if (steps.length === 0 && !parsed.summary) return null;

    const stepSummaries: ToolOutputStepSummary[] = steps.map(
      (step: Record<string, unknown>, index: number) => {
        const skipped = step.skipped === true || step.state === 'skipped';
        const success = !skipped && step.success !== false;
        const args = isRecord(step.args) ? step.args : undefined;
        const target = firstString(step.target, args?.path, args?.filePath, args?.directory);
        const output = typeof step.output === 'string' ? step.output : '';
        return {
          index: typeof step.index === 'number' ? step.index : index + 1,
          toolName: String(step.tool ?? step.toolName ?? 'unknown'),
          state: skipped ? 'skipped' : success ? 'success' : 'error',
          target: target ? redactTraceText(target) : undefined,
          summary: redactTraceText(String(step.summary ?? summarizeOutput(output))),
          outputBytes: typeof step.outputBytes === 'number'
            ? step.outputBytes
            : Buffer.byteLength(output, 'utf8'),
          detailRef: parentDetailRef,
        };
      }
    );

    const succeeded = stepSummaries.filter(s => s.state === 'success').length;
    const failed = stepSummaries.filter(s => s.state === 'error').length;
    const skipped = stepSummaries.filter(s => s.state === 'skipped').length;

    return {
      version: 1,
      kind: 'batch_read',
      total: stepSummaries.length,
      succeeded,
      failed,
      skipped,
      steps: stepSummaries,
    };
  } catch {
    return null;
  }
}

function parseSubtaskBatchOutput(
  rawOutput: string,
  parentDetailRef?: ToolOutputDetailRef,
): ToolAggregateView | null {
  try {
    const parsed = JSON.parse(rawOutput) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.results)) return null;
    const steps: ToolOutputStepSummary[] = parsed.results.map((value, index) => {
      const result = isRecord(value) ? value : {};
      const status = String(result.status ?? 'completed');
      const state: ToolOutputStepSummary['state'] = status === 'skipped'
        ? 'skipped'
        : status === 'completed' || status === 'success'
          ? 'success'
          : 'error';
      const summary = typeof result.summary === 'string' ? result.summary : status;
      return {
        index: index + 1,
        toolName: String(result.role ?? 'subtask'),
        state,
        target: typeof result.id === 'string' ? redactTraceText(result.id) : undefined,
        summary: redactTraceText(summarizeOutput(summary)),
        outputBytes: Buffer.byteLength(summary, 'utf8'),
        detailRef: parentDetailRef,
      };
    });
    return {
      version: 1,
      kind: 'subtask_batch',
      total: steps.length,
      succeeded: steps.filter(step => step.state === 'success').length,
      failed: steps.filter(step => step.state === 'error').length,
      skipped: steps.filter(step => step.state === 'skipped').length,
      steps,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim().length > 0) as
    | string
    | undefined;
}

function summarizeOutput(output: string): string {
  return output.split(/\r?\n/u).find(line => line.trim())?.trim().slice(0, 160) ?? '';
}
