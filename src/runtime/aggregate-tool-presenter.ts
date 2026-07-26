/** Schema-guarded presentation for known aggregate tool results. */

import {
  tryParseAggregateOutput,
  type ToolAggregateView,
} from './tool-output-presentation';
import { redactTraceText } from '../services/redaction';

export interface PresentAggregateResult {
  view: ToolAggregateView;
  /** Human-readable summary line, for example `4/4 steps · 3.9 KB`. */
  headline: string;
}

/**
 * Normalize a known aggregate result. The shared parser remains the single
 * schema authority used by both the presenter and createToolOutputView().
 */
export function presentAggregateToolResult(
  toolName: string,
  rawOutput: string,
  outputBytes: number,
): PresentAggregateResult | null {
  const view = tryParseAggregateOutput(toolName, rawOutput);
  if (!view) return null;
  const unit = view.kind === 'subtask_batch' ? 'subtasks' : 'steps';
  const summary = aggregateSummary(rawOutput);
  return {
    view,
    headline: `${summary ?? `${view.succeeded}/${view.total} ${unit}`} · ${formatSize(outputBytes)}`,
  };
}

function aggregateSummary(rawOutput: string): string | undefined {
  try {
    const parsed = JSON.parse(rawOutput) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const summary = (parsed as Record<string, unknown>).summary;
    return typeof summary === 'string' && summary.trim()
      ? redactTraceText(summary.trim())
      : undefined;
  } catch {
    return undefined;
  }
}

function formatSize(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024) return `${safeBytes} B`;
  if (safeBytes < 1024 * 1024) return `${(safeBytes / 1024).toFixed(1)} KB`;
  return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
