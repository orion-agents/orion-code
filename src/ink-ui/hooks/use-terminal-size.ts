import { useEffect, useState } from 'react';

export interface TerminalSize {
  width: number;
  height: number;
}

export function readTerminalSize(
  stdout?: Pick<NodeJS.WriteStream, 'columns' | 'rows'>,
  fallback: Pick<NodeJS.WriteStream, 'columns' | 'rows'> = process.stdout
): TerminalSize {
  return {
    width: stdout?.columns || fallback.columns || 80,
    height: stdout?.rows || fallback.rows || 24,
  };
}

export function useTerminalSize(stdout?: NodeJS.WriteStream): TerminalSize {
  const [terminalSize, setTerminalSize] = useState(() => readTerminalSize(stdout));
  const latestSize = readTerminalSize(stdout);

  useEffect(() => {
    const output = stdout ?? process.stdout;
    const updateSize = () => setTerminalSize(readTerminalSize(output));

    updateSize();
    output.on?.('resize', updateSize);
    if (output !== process.stdout) {
      process.stdout.on?.('resize', updateSize);
    }

    return () => {
      output.off?.('resize', updateSize);
      if (output !== process.stdout) {
        process.stdout.off?.('resize', updateSize);
      }
    };
  }, [stdout]);

  return terminalSize.width === latestSize.width && terminalSize.height === latestSize.height
    ? terminalSize
    : latestSize;
}
