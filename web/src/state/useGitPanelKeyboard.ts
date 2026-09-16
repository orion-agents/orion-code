/**
 * v0.3.17 S6 — the Git panel's keyboard behaviour (plan §4.3).
 *
 * Rules this hook exists to enforce, all from the plan:
 *   - arrow keys move within a list; Enter opens; **Space only toggles the focused checkbox**
 *     and is never bound to a Git write;
 *   - F7 / Shift+F7 jump to the next / previous change while the diff has focus, and the
 *     toolbar offers the equivalent buttons;
 *   - Escape unwinds one layer at a time (search → detail → back), and never steals a key from
 *     an input, a textarea or a dialog.
 */
import { useEffect } from 'react';

import type { GitPanelSessionState } from './git-panel-state';

export interface GitPanelKeyboardHandlers {
  readonly enabled: boolean;
  readonly session: GitPanelSessionState;
  readonly setSession: (patch: Partial<GitPanelSessionState>) => void;
  /** Ordered file ids of the visible change list. */
  readonly fileIds: readonly string[];
  /** Ordered change anchors of the open document. */
  readonly anchorLineIds: readonly string[];
  readonly onOpenSelection: () => void;
  readonly onEscapeFallback: () => void;
}

/** True when the event target is a place where our shortcuts must stay out of the way. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  // A dialog owns its own keys; Escape there belongs to the dialog.
  return target.closest('[role="dialog"]') !== null;
}

export function useGitPanelKeyboard(handlers: GitPanelKeyboardHandlers): void {
  const {
    enabled,
    session,
    setSession,
    fileIds,
    anchorLineIds,
    onOpenSelection,
    onEscapeFallback,
  } = handlers;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;

      // F7 / Shift+F7 — change navigation, mirrored by toolbar buttons.
      if (event.key === 'F7' && anchorLineIds.length > 0) {
        event.preventDefault();
        const current = session.anchorLineId ? anchorLineIds.indexOf(session.anchorLineId) : -1;
        const step = event.shiftKey ? -1 : 1;
        const next =
          current < 0
            ? step > 0
              ? 0
              : anchorLineIds.length - 1
            : Math.min(anchorLineIds.length - 1, Math.max(0, current + step));
        setSession({ anchorLineId: anchorLineIds[next] });
        return;
      }

      if (event.key === 'Escape') {
        // Unwind one layer: search, then the line selection, then let the panel close.
        if (session.query) {
          event.preventDefault();
          setSession({ query: '', selectedFileId: null });
          return;
        }
        if (session.selectedLineIds.length > 0) {
          event.preventDefault();
          setSession({ selectedLineIds: [] });
          return;
        }
        onEscapeFallback();
        return;
      }

      if (fileIds.length === 0) return;
      const index = session.selectedFileId ? fileIds.indexOf(session.selectedFileId) : -1;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next =
          index < 0
            ? step > 0
              ? 0
              : fileIds.length - 1
            : Math.min(fileIds.length - 1, Math.max(0, index + step));
        setSession({ selectedFileId: fileIds[next], selectedSource: null, anchorLineId: null });
        return;
      }

      if (event.key === 'Enter' && index >= 0) {
        event.preventDefault();
        onOpenSelection();
        return;
      }

      if (event.key === ' ') {
        // Space is deliberately NOT a write. It only tickles the row's own checkbox, which the
        // browser already handles natively when the checkbox has focus; with focus elsewhere we
        // toggle the current row's multi-select, which is still not a Git operation.
        if (index < 0) return;
        event.preventDefault();
        const fileId = fileIds[index];
        setSession({
          selectedFileIds: session.selectedFileIds.includes(fileId)
            ? session.selectedFileIds.filter(id => id !== fileId)
            : [...session.selectedFileIds, fileId],
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    enabled,
    session.query,
    session.selectedFileId,
    session.selectedLineIds,
    session.anchorLineId,
    session.selectedFileIds,
    setSession,
    fileIds,
    anchorLineIds,
    onOpenSelection,
    onEscapeFallback,
  ]);
}
