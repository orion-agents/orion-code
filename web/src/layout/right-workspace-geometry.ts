/**
 * v0.3.12 S1 — pure geometry for the wide Right Workspace.
 *
 * Desktop (container >= 1024): the detail surface docks between a 360px
 * minimum and `min(80vw, available - 320px)` so the conversation never drops
 * below its 320px safety minimum; the left project column concedes to a rail
 * first. Tablet/compact (768–1023) renders the detail as an overlay drawer
 * when explicitly opened, and narrow (< 768) uses a full-height modal drawer.
 * All math is pure and unit-tested; components only translate these numbers.
 */
import { WORK_PANEL_RAIL_WIDTH } from '../state/layout-preferences';
import { sanitizeDetailWidth } from '../state/right-workspace-preferences';

export const CONVERSATION_SAFETY_MIN_WIDTH = 320;
export const DETAIL_MIN_WIDTH = 360;
export const DETAIL_DEFAULT_WIDTH = 560;
export const DETAIL_WIDE_WIDTH = 960;
export const DESKTOP_BREAKPOINT_PX = 1024;
export const COMPACT_BREAKPOINT_PX = 768;

export type RightWorkspaceMode = 'dock' | 'drawer' | 'rail';

export interface RightWorkspaceGeometry {
  readonly mode: RightWorkspaceMode;
  /** Detail surface width (excluding the 48px rail) when docked; 0 otherwise. */
  readonly detailWidthPx: number;
  readonly conversationWidthPx: number;
  /** True when the docked detail can expand further (used to hint resize affordances). */
  readonly canResize: boolean;
}

export interface RightWorkspaceGeometryInput {
  readonly containerWidth: number;
  /** Resolved left column: dock width in px, rail = 48, drawer = 0 (overlay). */
  readonly leftWidthPx: number;
  readonly expanded: boolean;
  readonly storedDetailWidthPx: number;
}

const MAXIMUM_DETAIL_VW_RATIO = 0.8;

function finiteWidth(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 1440;
}

/**
 * Largest detail width that keeps the conversation >= 320px and the detail
 * within 80% of the available container width.
 */
export function maxDockableDetailWidth(availableWidth: number): number {
  const vwCap = Math.floor(availableWidth * MAXIMUM_DETAIL_VW_RATIO);
  // Keep the 48px rail and a 320px conversation minimum when docked.
  const conversationCap = availableWidth - CONVERSATION_SAFETY_MIN_WIDTH - WORK_PANEL_RAIL_WIDTH;
  return Math.max(0, Math.min(vwCap, conversationCap));
}

/**
 * Snap a requested detail width to the nearest supported value that fits.
 * Order: 360 / 560 / 960 / max dockable.
 */
export function snapDetailWidth(requestedWidth: number, maxWidth: number): number {
  const sanitized = sanitizeDetailWidth(requestedWidth);
  if (maxWidth <= 0) return 0;
  const candidates = [DETAIL_MIN_WIDTH, DETAIL_DEFAULT_WIDTH, DETAIL_WIDE_WIDTH, maxWidth].filter(
    width => width <= maxWidth
  );
  let best = candidates[candidates.length - 1];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - sanitized);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return Math.max(DETAIL_MIN_WIDTH, best);
}

export function computeRightWorkspaceGeometry(
  input: RightWorkspaceGeometryInput
): RightWorkspaceGeometry {
  const container = finiteWidth(input.containerWidth);
  const left = Math.max(0, Math.round(input.leftWidthPx));
  const available = Math.max(0, container - left);

  if (container < COMPACT_BREAKPOINT_PX) {
    // Full-height modal drawer: conversation keeps the container, detail overlays.
    return Object.freeze({
      mode: 'drawer',
      detailWidthPx: 0,
      conversationWidthPx: available,
      canResize: false,
    });
  }

  if (container < DESKTOP_BREAKPOINT_PX) {
    // Compact: default to rail; an explicitly expanded panel opens as overlay drawer.
    if (!input.expanded) {
      return Object.freeze({
        mode: 'rail',
        detailWidthPx: 0,
        conversationWidthPx: available,
        canResize: false,
      });
    }
    return Object.freeze({
      mode: 'drawer',
      detailWidthPx: 0,
      conversationWidthPx: available,
      canResize: true,
    });
  }

  if (!input.expanded) {
    return Object.freeze({
      mode: 'rail',
      detailWidthPx: WORK_PANEL_RAIL_WIDTH,
      conversationWidthPx: available - WORK_PANEL_RAIL_WIDTH,
      canResize: false,
    });
  }

  const maxDetail = maxDockableDetailWidth(available);
  if (maxDetail < DETAIL_MIN_WIDTH) {
    // Not enough room for a usable detail surface; stay rail-only.
    return Object.freeze({
      mode: 'rail',
      detailWidthPx: WORK_PANEL_RAIL_WIDTH,
      conversationWidthPx: available - WORK_PANEL_RAIL_WIDTH,
      canResize: false,
    });
  }
  const detail = Math.max(
    DETAIL_MIN_WIDTH,
    Math.min(sanitizeDetailWidth(input.storedDetailWidthPx), maxDetail)
  );
  const conversation = available - detail - WORK_PANEL_RAIL_WIDTH;
  if (conversation < CONVERSATION_SAFETY_MIN_WIDTH) {
    return Object.freeze({
      mode: 'rail',
      detailWidthPx: WORK_PANEL_RAIL_WIDTH,
      conversationWidthPx: available - WORK_PANEL_RAIL_WIDTH,
      canResize: false,
    });
  }
  return Object.freeze({
    mode: 'dock',
    detailWidthPx: detail,
    conversationWidthPx: conversation,
    canResize: maxDetail > detail,
  });
}

export const DETAIL_SNAP_POINTS: readonly number[] = [
  DETAIL_MIN_WIDTH,
  DETAIL_DEFAULT_WIDTH,
  DETAIL_WIDE_WIDTH,
];
