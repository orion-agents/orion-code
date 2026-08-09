import React from 'react';
import { ReplScreen } from './screens/ReplScreen';
import type { NativeCursorController } from './runtime/native-cursor';
import type { OrionCodeUiRuntime } from './types';

export interface AppProps {
  runtime: OrionCodeUiRuntime;
  cursorController: NativeCursorController;
  resizeEpoch?: number;
}

export function App({ runtime, cursorController, resizeEpoch = 0 }: AppProps): JSX.Element {
  return <ReplScreen runtime={runtime} cursorController={cursorController} resizeEpoch={resizeEpoch} />;
}
