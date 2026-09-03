import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

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
    const shell = event.currentTarget.closest('.workbench-shell');
    const bounds = shell?.getBoundingClientRect() ?? {
      left: 0,
      right: window.innerWidth,
    };
    const raw = side === 'left' ? event.clientX - bounds.left : bounds.right - event.clientX;
    return clampPanelWidth(raw, minWidth, maxWidth);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerId.current !== null) return;
    event.preventDefault();
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.dataset.panelResizing = side;
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
