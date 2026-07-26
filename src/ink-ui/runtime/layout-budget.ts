export interface InkLayoutBudget {
  terminalWidth: number;
  terminalHeight: number;
  layoutWidth: number;
  maxLiveTranscriptItems: number;
  maxOverlayItems: number;
  maxPromptRows: number;
}

export function fitCount(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getInkLayoutBudget(
  terminalWidth: number,
  terminalHeight: number,
  options: { overlayVisible?: boolean } = {}
): InkLayoutBudget {
  const height = Math.max(8, terminalHeight || 24);
  const width = Math.max(20, terminalWidth || 80);
  const maxPromptRows = fitCount(Math.floor(height / 4), 1, 6);
  const maxLiveTranscriptItems = options.overlayVisible
    ? 1
    : fitCount(height - 10, 1, 8);
  const maxOverlayItems = fitCount(height - maxPromptRows - maxLiveTranscriptItems - 10, 1, 10);

  return {
    terminalWidth: width,
    terminalHeight: height,
    layoutWidth: Math.max(20, width - 1),
    maxLiveTranscriptItems,
    maxOverlayItems,
    maxPromptRows,
  };
}
