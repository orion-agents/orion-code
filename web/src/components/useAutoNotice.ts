/**
 * v0.3.15 T1 — transient resource notices.
 *
 * Success/info notices fade out on their own after a short delay instead of
 * squatting on the panel forever; error notices persist until replaced, so a
 * failed save never disappears unread. Pure state management — no DOM.
 */
import { useEffect, useRef, useState } from 'react';

export type ResourceNoticeTone = 'success' | 'info' | 'error';

export interface ResourceNotice {
  readonly text: string;
  readonly tone: ResourceNoticeTone;
}

const AUTO_FADE_MS = 4_000;

export function useAutoNotice(): {
  readonly notice: ResourceNotice | null;
  readonly showNotice: (text: string, tone?: ResourceNoticeTone) => void;
  readonly clearNotice: () => void;
} {
  const [notice, setNotice] = useState<ResourceNotice | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const showNotice = (text: string, tone: ResourceNoticeTone = 'info') => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setNotice({ text, tone });
    // Errors must survive until the user acts; everything else self-clears.
    if (tone !== 'error') {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setNotice(current => (current?.text === text ? null : current));
      }, AUTO_FADE_MS);
    }
  };

  const clearNotice = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setNotice(null);
  };

  return { notice, showNotice, clearNotice };
}
