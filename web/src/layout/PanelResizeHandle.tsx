import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

export type PanelResizeScope = 'workbench' | 'resource-split';

export interface PanelResizeHandleProps {
  readonly side: 'left' | 'right';
  readonly className?: string;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly defaultWidth: number;
  readonly label: string;
  /**
   * Current rendered width in px. Drives `aria-valuenow` and the starting point of
   * keyboard stepping. Omit only when the caller cannot observe the live width.
   */
  readonly width?: number;
  /** Id of the region the separator resizes, for `aria-controls`. */
  readonly controls?: string;
  /**
   * v0.3.13 — measurement root for an inner (resource-split) separator. When
   * provided, pointer x is interpreted against this element's box instead of
   * the nearest `.workbench-shell`; with `side="right"` that distance is the
   * navigator column width, exactly what the resource panels resize.
   */
  readonly boundsRef?: RefObject<HTMLElement | null>;
  /**
   * v0.3.13 — distinguishes the drag marker written to
   * `document.documentElement.dataset.panelResizing`. `resource-split` keeps
   * the shared `col-resize` cursor while staying distinguishable from the
   * outer workbench splitters in CSS/DOM.
   */
  readonly resizingScope?: PanelResizeScope;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

/** Fine/coarse keyboard step, as a fraction of the available width range. */
export const KEYBOARD_STEP_RATIO = 0.02;
export const KEYBOARD_STEP_RATIO_COARSE = 0.1;

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : minWidth;
  return Math.min(maxWidth, Math.max(minWidth, finite));
}

export interface PointerResizeMeasurement {
  readonly side: 'left' | 'right';
  readonly clientX: number;
  /** Measurement box — for the outer splitters the `.workbench-shell`, for an
   * inner resource split the split root itself. */
  readonly bounds: { readonly left: number; readonly right: number };
  readonly minWidth: number;
  readonly maxWidth: number;
}

/**
 * Pure pointer → width resolver. `side="right"` measures from the right edge of
 * the bounds box, which is exactly a right-hand navigator column's width; a
 * caller-provided bounds box is what makes inner separators behave without
 * inheriting the workbench-wide coordinate space.
 */
export function resolvePointerResizeWidth({
  side,
  clientX,
  bounds,
  minWidth,
  maxWidth,
}: PointerResizeMeasurement): number {
  const raw = side === 'left' ? clientX - bounds.left : bounds.right - clientX;
  return clampPanelWidth(raw, minWidth, maxWidth);
}

/** Normalised 0–100 position of `width` inside `[minWidth, maxWidth]`. */
export function panelWidthPercent(width: number, minWidth: number, maxWidth: number): number {
  const span = maxWidth - minWidth;
  if (span <= 0) return 0;
  const ratio = (clampPanelWidth(width, minWidth, maxWidth) - minWidth) / span;
  return Math.round(ratio * 100);
}

export interface PanelResizeKeyIntent {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly defaultWidth: number;
  readonly currentWidth: number;
  readonly side: 'left' | 'right';
}

/**
 * Pure keyboard resolver for the resize separator. Returns `null` when the key is not
 * a resize intent, so callers can leave the event alone (no `preventDefault`).
 */
export function resolvePanelResizeKeyWidth(intent: PanelResizeKeyIntent): number | null {
  const { key, minWidth, maxWidth, defaultWidth, currentWidth, side } = intent;
  const clamp = (value: number) => clampPanelWidth(value, minWidth, maxWidth);
  if (key === 'Home') return clamp(minWidth);
  if (key === 'End') return clamp(maxWidth);
  if (key === 'Enter' || key === ' ') return clamp(defaultWidth);
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const ratio = intent.shiftKey ? KEYBOARD_STEP_RATIO_COARSE : KEYBOARD_STEP_RATIO;
  const step = Math.max(1, Math.round((maxWidth - minWidth) * ratio));
  // The arrow key moves the separator itself: growing the panel means pushing the
  // handle away from the panel it belongs to (right for a left panel, left for a
  // right panel).
  const direction = (key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1);
  return clamp(currentWidth + direction * step);
}

/**
 * IDE splitter with pointer dragging and full keyboard parity (WCAG 2.1.1).
 * Keyboard: ←/→ ±2%, Shift+←/→ ±10%, Home min, End max, Enter/Space reset.
 */
export function PanelResizeHandle({
  side,
  className,
  minWidth,
  maxWidth,
  defaultWidth,
  label,
  width,
  controls,
  boundsRef,
  resizingScope = 'workbench',
  onPreview,
  onCommit,
}: PanelResizeHandleProps) {
  const latestWidth = useRef(clampPanelWidth(width ?? defaultWidth, minWidth, maxWidth));
  const pointerId = useRef<number | null>(null);
  const pendingWidth = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  const clearFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const clearResizeState = () => {
    pointerId.current = null;
    pendingWidth.current = null;
    clearFrame();
    delete document.documentElement.dataset.panelResizing;
  };

  useEffect(() => clearResizeState, []);

  // Keep the stepping origin in sync with the live width, except while a pointer drag
  // owns the value (the parent only commits on release).
  useEffect(() => {
    if (width === undefined || pointerId.current !== null) return;
    latestWidth.current = clampPanelWidth(width, minWidth, maxWidth);
  }, [width, minWidth, maxWidth]);

  const emitPreview = (nextWidth: number) => {
    latestWidth.current = nextWidth;
    pendingWidth.current = nextWidth;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const pending = pendingWidth.current;
      pendingWidth.current = null;
      if (pending !== null) onPreview(pending);
    });
  };

  const widthFromPointer = (event: ReactPointerEvent<HTMLDivElement>): number => {
    let bounds: { left: number; right: number };
    if (boundsRef?.current) {
      const rect = boundsRef.current.getBoundingClientRect();
      bounds = { left: rect.left, right: rect.right };
    } else {
      const shell = event.currentTarget.closest('.workbench-shell');
      bounds = shell?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth };
    }
    return resolvePointerResizeWidth({ side, clientX: event.clientX, bounds, minWidth, maxWidth });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerId.current !== null) return;
    event.preventDefault();
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const marker = resizingScope === 'resource-split' ? 'resource-split' : side;
    document.documentElement.dataset.panelResizing = marker;
    emitPreview(widthFromPointer(event));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    emitPreview(widthFromPointer(event));
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const committed = pendingWidth.current ?? latestWidth.current;
    clearResizeState();
    onPreview(committed);
    onCommit(committed);
  };

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    const committed = pendingWidth.current ?? latestWidth.current;
    clearResizeState();
    onPreview(committed);
    onCommit(committed);
  };

  const commitWidth = (nextWidth: number) => {
    latestWidth.current = nextWidth;
    onPreview(nextWidth);
    onCommit(nextWidth);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nextWidth = resolvePanelResizeKeyWidth({
      key: event.key,
      shiftKey: event.shiftKey,
      minWidth,
      maxWidth,
      defaultWidth,
      currentWidth: latestWidth.current,
      side,
    });
    if (nextWidth === null) return;
    event.preventDefault();
    commitWidth(nextWidth);
  };

  const percent = panelWidthPercent(latestWidth.current, minWidth, maxWidth);

  return (
    <div
      className={`panel-resize-handle panel-resize-handle-${side}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${latestWidth.current} 像素`}
      aria-controls={controls}
      tabIndex={0}
      title={`${label}；方向键调整，Shift 加速，Enter 恢复默认，双击亦可恢复`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
      onDoubleClick={() => commitWidth(clampPanelWidth(defaultWidth, minWidth, maxWidth))}
    >
      <span />
    </div>
  );
}
