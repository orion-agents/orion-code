/**
 * v0.3.13 S4 — shared, foldable tool output preview used by both `ToolCard`
 * and `StandaloneToolActivity` so the two render paths cannot drift again.
 *
 * - Unwraps a JSON envelope via `parseToolPreview` (real newlines restored),
 *   keeps plain text intact, never renders HTML/Markdown.
 * - Long output is folded behind a `<details>`; success folds by default,
 *   error states pass `defaultOpen` to expand.
 * - The raw response stays reachable and copyable; truncation notes and
 *   sanitization remain the caller's concern.
 * - Text uses `white-space: pre-wrap` so real newlines show without forcing a
 *   one-line horizontal scroll; parameter/raw JSON areas elsewhere keep their
 *   independent horizontal scrolling.
 */
import { useEffect, useRef, useState } from 'react';

import { sanitizeDisplayText } from './Markdown';
import { parseToolPreview } from './tool-output-display';

export interface ToolOutputPreviewProps {
  /** Raw preview text (already the activity/body/summary choice of the caller). */
  readonly text: string | null | undefined;
  /** Error tool calls default to expanded. */
  readonly defaultOpen?: boolean;
  /** Extra copy appended inside the folded area (truncation note etc.). */
  readonly note?: string | null;
}

export function ToolOutputPreview({
  text,
  defaultOpen = false,
  note = null,
}: ToolOutputPreviewProps) {
  const result = parseToolPreview(text);
  const initialOpen = defaultOpen || (result?.isLong ? false : true);
  const [open, setOpen] = useState(initialOpen);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    []
  );

  if (result === null) return null;
  const safe = sanitizeDisplayText(result.displayText);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.displayText);
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard denial must not break reading; the text stays selectable.
    }
  };

  const previewBody = (
    <pre className="tool-output-text" tabIndex={0}>
      {safe}
    </pre>
  );

  if (!result.isLong || defaultOpen) {
    // Short output (or an explicitly expanded error) renders directly.
    return (
      <div className="tool-output-preview tool-output-preview-open">
        {previewBody}
        {note ? <p className="truncation-note">{note}</p> : null}
      </div>
    );
  }

  const lineLabel = `${result.lineCount} 行 · ${result.format === 'envelope' ? '已解包' : '文本'}`;
  return (
    <div className="tool-output-preview">
      <details
        className="tool-output-fold"
        open={open}
        onToggle={event => setOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary>
          <span>
            {lineLabel}
            {result.isEnvelope ? ' · 输出已安全还原换行' : ''}
          </span>
          <button
            type="button"
            className="text-button"
            onClick={event => {
              event.preventDefault();
              void copy();
            }}
          >
            {copied ? '已复制' : '复制原始响应'}
          </button>
        </summary>
        {previewBody}
        {note ? <p className="truncation-note">{note}</p> : null}
      </details>
    </div>
  );
}
