import {
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_MAX_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from '../state/layout-preferences';
import { PanelResizeHandle } from './PanelResizeHandle';

export interface WorkPanelResizeHandleProps {
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

export function WorkPanelResizeHandle({ onPreview, onCommit }: WorkPanelResizeHandleProps) {
  return (
    <PanelResizeHandle
      side="right"
      minWidth={WORK_PANEL_MIN_WIDTH}
      maxWidth={WORK_PANEL_MAX_WIDTH}
      defaultWidth={WORK_PANEL_DEFAULT_WIDTH}
      label="拖动调整工作面板宽度"
      onPreview={onPreview}
      onCommit={onCommit}
    />
  );
}
