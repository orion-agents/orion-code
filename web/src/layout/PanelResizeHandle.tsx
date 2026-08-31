import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface PanelResizeHandleProps {
  readonly side: 'left' | 'right';
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly defaultWidth: number;
  readonly label: string;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

/** Pointer-only IDE splitter. Keyboard users use the adjacent expand/collapse control. */
export function PanelResizeHandle({
  side,
  minWidth,
  maxWidth,
  defaultWidth,
  label,
  onPreview,
  onCommit,
}: PanelResizeHandleProps) {
  const latestWidth = useRef(defaultWidth);
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

  const emitPreview = (width: number) => {
    latestWidth.current = width;
    pendingWidth.current = width;
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
    return Math.min(maxWidth, Math.max(minWidth, Math.round(raw)));
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
    const width = pendingWidth.current ?? latestWidth.current;
    clearResizeState();
    onPreview(width);
    onCommit(width);
  };

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    const width = pendingWidth.current ?? latestWidth.current;
    clearResizeState();
    onPreview(width);
    onCommit(width);
  };

  return (
    <div
      className={`panel-resize-handle panel-resize-handle-${side}`}
      aria-hidden="true"
      title={`${label}；双击恢复默认宽度`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={() => {
        const width = Math.min(maxWidth, Math.max(minWidth, defaultWidth));
        latestWidth.current = width;
        onPreview(width);
        onCommit(width);
      }}
    >
      <span />
    </div>
  );
}
