import {
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_MAX_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from '../state/layout-preferences';
import { PanelResizeHandle } from './PanelResizeHandle';

export interface WorkPanelResizeHandleProps {
  readonly width: number;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

export function WorkPanelResizeHandle({ width, onPreview, onCommit }: WorkPanelResizeHandleProps) {
  return (
    <PanelResizeHandle
      side="right"
      className="work-panel-resize-handle"
      minWidth={WORK_PANEL_MIN_WIDTH}
      maxWidth={WORK_PANEL_MAX_WIDTH}
      defaultWidth={WORK_PANEL_DEFAULT_WIDTH}
      label="拖动或按方向键调整工作面板宽度"
      width={width}
      controls="work-panel-detail"
      onPreview={onPreview}
      onCommit={onCommit}
    />
  );
}
