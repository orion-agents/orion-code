import React from 'react';
import { render } from 'ink';
import { App } from './App';
import { createNativeCursorController } from './runtime/native-cursor';
import type { OpenHorseUiRuntime } from './types';

type RawModeStream = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};

export function prepareInkStdin(stdin: RawModeStream = process.stdin): () => void {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return () => undefined;
  }

  const wasRaw = stdin.isRaw === true;
  stdin.setEncoding('utf8');
  stdin.resume();
  stdin.setRawMode(true);

  return () => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return;
    stdin.setRawMode(wasRaw);
    if (wasRaw) stdin.resume();
  };
}

export async function launchInkUI(runtime: OpenHorseUiRuntime): Promise<void> {
  const restoreStdin = prepareInkStdin(process.stdin);
  const cursorController = createNativeCursorController(process.stdout);
  let resizeEpoch = 0;
  let resizeSequence = 0;
  let resizeTimer: NodeJS.Timeout | undefined;
  let pendingResizeEpoch = 0;
  let renderInProgress = false;
  const RESIZE_COALESCE_MS = 80;

  const viewportReset = '\x1b[2J\x1b[H';
  const app = () => <App runtime={runtime} cursorController={cursorController} resizeEpoch={resizeEpoch} />;
  const instance = render(app(), {
    exitOnCtrlC: false,
    stdout: cursorController.wrapStdout(),
  });

  const doResizeRender = () => {
    resizeTimer = undefined;
    if (pendingResizeEpoch > resizeEpoch) {
      resizeEpoch = pendingResizeEpoch;
    }
    if (renderInProgress) return;
    renderInProgress = true;
    try {
      cursorController.resetForViewportClear();
      instance.clear();
      if (process.stdout.isTTY) {
        process.stdout.write(viewportReset);
      }
      cursorController.resetForViewportClear();
      instance.rerender(app());
    } finally {
      renderInProgress = false;
      // If another resize arrived while rendering, schedule one more cycle
      if (pendingResizeEpoch > resizeEpoch) {
        resizeTimer = setTimeout(doResizeRender, RESIZE_COALESCE_MS);
      }
    }
  };

  const handleResize = () => {
    pendingResizeEpoch = ++resizeSequence;
    if (resizeTimer) clearTimeout(resizeTimer);

    // Immediate pass: clear the visible area without rendering to prevent
    // stale frames from leaking into the next paint. The debounced rerender
    // applies the layout reflow.
    if (!renderInProgress) {
      cursorController.resetForViewportClear();
      if (process.stdout.isTTY) {
        process.stdout.write(viewportReset);
      }
    }

    resizeTimer = setTimeout(doResizeRender, RESIZE_COALESCE_MS);
  };

  if (typeof process.stdout.prependListener === 'function') {
    process.stdout.prependListener('resize', handleResize);
  } else {
    process.stdout.on?.('resize', handleResize);
  }

  try {
    await instance.waitUntilExit();
  } finally {
    process.stdout.off?.('resize', handleResize);
    if (resizeTimer) clearTimeout(resizeTimer);
    cursorController.disable();
    instance.clear();
    restoreStdin();
  }
}
