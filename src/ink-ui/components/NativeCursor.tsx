import { useLayoutEffect, type RefObject } from 'react';
import { getPromptInputViewport } from '../runtime/prompt-layout';
import {
  nativeCursorAnchorFromNode,
  type InkDomNodeLike,
  type NativeCursorController,
} from '../runtime/native-cursor';

export interface NativeCursorProps {
  cursorController: NativeCursorController;
  value: string;
  terminalWidth: number;
  promptRef?: RefObject<InkDomNodeLike>;
  cursor?: number;
  maxRows?: number;
}

export function NativeCursor({
  cursorController,
  value,
  terminalWidth,
  promptRef,
  cursor = value.length,
  maxRows = 6,
}: NativeCursorProps): null {
  useLayoutEffect(() => {
    const viewport = getPromptInputViewport(value, terminalWidth, maxRows, cursor);
    const declaredAnchor = nativeCursorAnchorFromNode(promptRef?.current, {
      cursorColumn: viewport.cursorColumn,
      cursorLineIndex: viewport.cursorLineIndex,
    });
    const anchor = declaredAnchor ?? {
      column: viewport.cursorColumn,
      rowsUp: viewport.rowsUpFromPromptBottom,
      row: undefined,
    };

    cursorController.setState({
      enabled: true,
      column: anchor.column,
      rowsUp: anchor.rowsUp,
      row: anchor.row,
      cursorLineIndex: viewport.cursorLineIndex,
    });
    cursorController.restore();
  }, [value, terminalWidth, cursor, maxRows, promptRef, cursorController]);

  useLayoutEffect(() => {
    return () => {
      cursorController.disable();
    };
  }, [cursorController]);

  return null;
}
