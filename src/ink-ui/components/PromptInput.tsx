import React from 'react';
import { Box, Text } from 'ink';
import { formatPromptVisualLine, getPromptInputViewport, type PromptVisualLine } from '../runtime/prompt-layout';
import type { DOMElement } from 'ink/build/dom';
import { createPromptState } from '../../runtime/ui-view-model';

export interface PromptInputProps {
  value: string;
  running: boolean;
  modeText?: string;
  width?: number;
  maxRows?: number;
  cursor?: number;
}

const INPUT_BACKGROUND = '#50545c';

export function formatPromptLine(line: string, index: number, width: number): string {
  return formatPromptVisualLine({ logicalIndex: index, wrapIndex: 0, content: line, start: 0, end: line.length }, width);
}

export const PromptInput = React.forwardRef<DOMElement, PromptInputProps>(function PromptInput(
  { value, running, modeText, width = 80, maxRows = 6, cursor = value.length },
  ref
): JSX.Element {
  const prompt = createPromptState({ value, cursor, running, modeText });
  const { lines, hiddenRows, showHiddenIndicator } = getPromptInputViewport(
    prompt.value,
    width,
    maxRows,
    prompt.cursor
  );

  return (
    <Box flexDirection="column">
      <Text color="gray">
        / commands   @ files   ? shortcuts   Alt+Enter newline   Ctrl+C {prompt.running ? 'interrupt' : 'twice exits'}
        {prompt.modeText ? `   ${prompt.modeText}` : ''}
      </Text>
      <Box ref={ref} width={width} borderStyle="single" borderColor={running ? 'yellow' : 'gray'} paddingX={1} flexDirection="column">
        {showHiddenIndicator && hiddenRows > 0 ? (
          <Text color="gray" wrap="truncate">
            {`  ... ${hiddenRows} hidden input line${hiddenRows === 1 ? '' : 's'}`}
          </Text>
        ) : null}
        {lines.map((line: PromptVisualLine, index) => {
          return (
            <Text key={`${line.logicalIndex}:${line.wrapIndex}:${index}`} backgroundColor={INPUT_BACKGROUND} color="white" wrap="truncate">
              {formatPromptVisualLine(line, width)}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
});
