import { useEffect, useRef, type MutableRefObject } from 'react';
import { countCtrlCEvents } from '../runtime/raw-input';

export type CtrlCHandler = (options?: { allowRapidRepeat?: boolean }) => void;

export function useRawInputBridge(onCtrlC: CtrlCHandler): MutableRefObject<string> {
  const lastRawInputRef = useRef('');

  useEffect(() => {
    const onSignal = () => onCtrlC();
    const onData = (chunk: Buffer | string) => {
      const rawInput = String(chunk);
      lastRawInputRef.current = rawInput;
      const ctrlCCount = countCtrlCEvents(rawInput);
      for (let index = 0; index < ctrlCCount; index += 1) {
        onCtrlC({ allowRapidRepeat: index > 0 });
      }
    };

    process.on('SIGINT', onSignal);
    process.stdin.prependListener('data', onData);
    return () => {
      process.off('SIGINT', onSignal);
      process.stdin.off('data', onData);
    };
  }, [onCtrlC]);

  return lastRawInputRef;
}
