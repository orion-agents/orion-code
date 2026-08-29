import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import { WORK_PANEL_DEFAULT_WIDTH, clampWorkPanelWidth } from '../state/layout-preferences';

export interface WorkPanelResizeHandleProps {
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

/** Pointer-only IDE splitter. Keyboard users use the adjacent expand/collapse control. */
export function WorkPanelResizeHandle({ onPreview, onCommit }: WorkPanelResizeHandleProps) {
  const latestWidth = useRef(WORK_PANEL_DEFAULT_WIDTH);
  const pointerId = useRef<number | null>(null);

  useEffect(
    () => () => {
      pointerId.current = null;
      delete document.documentElement.dataset.workPanelResizing;
    },
    []
  );

  const preview = (clientX: number) => {
    const width = clampWorkPanelWidth(window.innerWidth - clientX, window.innerWidth);
    latestWidth.current = width;
    onPreview(width);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerId.current !== null) return;
    event.preventDefault();
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.dataset.workPanelResizing = 'true';
    preview(event.clientX);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    preview(event.clientX);
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    delete document.documentElement.dataset.workPanelResizing;
    onCommit(latestWidth.current);
  };

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    delete document.documentElement.dataset.workPanelResizing;
    onCommit(latestWidth.current);
  };

  return (
    <div
      className="work-panel-resize-handle"
      aria-hidden="true"
      title="拖动调整工作面板宽度；双击恢复默认宽度"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={() => {
        latestWidth.current = clampWorkPanelWidth(WORK_PANEL_DEFAULT_WIDTH, window.innerWidth);
        onPreview(latestWidth.current);
        onCommit(latestWidth.current);
      }}
    >
      <span />
    </div>
  );
}
