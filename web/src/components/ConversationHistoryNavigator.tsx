/**
 * v0.3.13 — the conversation history rail (S2/S3 discipline).
 *
 * A narrow overlay pinned to the left inside edge of the transcript stage:
 *
 * - It represents ONLY the history window currently loaded in the browser.
 * - Visual positions are BUCKET ORDINALS (`i / (bucketCount-1)`), never raw
 *   `order` numbers, so gaps or unevenly spaced persisted orders cannot create
 *   phantom blank stretches or unstable ticks.
 * - Decorative ticks are `aria-hidden`; exactly one `role="slider"` carries
 *   pointer + keyboard navigation (Arrow/Page/Home/End).
 * - Older history is signalled by a NON-INTERACTIVE top cap; the one complete,
 *   accessible "加载更早内容" entry lives at the top of the loaded transcript,
 *   never duplicated on the rail.
 * - Tooltips appear only on focus, drag or a short hover dwell, never on plain
 *   pointer movement, close on scroll, deduplicate generic labels, and render
 *   only when there is safe gutter space left of the message column.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  bucketIndexOfOrder,
  bucketOrdinalPosition,
  describeHistoryPosition,
  formatHistoryTooltip,
  resolveRailBucketFromY,
  resolveRailKeyIntent,
  type HistoryAnchor,
  type HistoryNavigationModel,
} from './history-navigation';

export interface HistoryViewportSpanView {
  readonly firstOrder: number;
  readonly lastOrder: number;
}

export interface ConversationHistoryNavigatorProps {
  readonly model: HistoryNavigationModel;
  readonly activeOrder: number | null;
  readonly span: HistoryViewportSpanView | null;
  /**
   * v0.3.13 — whether older (already-fetched or persisted-cursor) history is
   * available. The rail only draws a non-interactive top cap for it; the ONE
   * complete, accessible "加载更早内容" entry lives at the top of the loaded
   * transcript (`.load-history` in Conversation), never as a second control
   * here.
   */
  readonly hasEarlierHistory: boolean;
  readonly reduceMotion: boolean;
  /** Smooth/plain jump for clicks and keyboard. */
  readonly onJumpToOrder: (order: number, behavior: 'smooth' | 'auto') => void;
  readonly onJumpToLatest: () => void;
}

interface TooltipView {
  readonly label: string;
  readonly top: number;
}

const TOOLTIP_HOVER_DELAY_MS = 380;
const TOOLTIP_KEYBOARD_LINGER_MS = 1600;
/** Tooltip only renders when this much safe gutter exists to its right. */
const TOOLTIP_MIN_GUTTER_PX = 200;

export function ConversationHistoryNavigator({
  model,
  activeOrder,
  span,
  hasEarlierHistory,
  reduceMotion,
  onJumpToOrder,
  onJumpToLatest,
}: ConversationHistoryNavigatorProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const hoverYRef = useRef<number | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const lingerTimer = useRef<number | null>(null);
  const lastTooltipBucket = useRef<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipView | null>(null);
  const [focused, setFocused] = useState(false);

  const bucketCount = model.buckets.length;
  const loaded = bucketCount > 0;

  // 1-based slider position of the active reading anchor's bucket.
  const activePosition = useMemo(() => {
    if (activeOrder === null || bucketCount === 0) return 0;
    const bucketIndex = bucketIndexOfOrder(model, activeOrder);
    return bucketIndex !== null ? bucketIndex + 1 : 0;
  }, [activeOrder, model, bucketCount]);

  const activeBucketIndex = activePosition > 0 ? activePosition - 1 : null;
  const activeDescription = useMemo(
    () => (activeOrder === null ? null : describeHistoryPosition(model, activeOrder)),
    [activeOrder, model]
  );

  const topMarker = span !== null ? (bucketIndexOfOrder(model, span.firstOrder) ?? 0) : null;
  const bottomMarker =
    span !== null ? (bucketIndexOfOrder(model, span.lastOrder) ?? bucketCount - 1) : null;

  const clearTimers = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (lingerTimer.current !== null) {
      window.clearTimeout(lingerTimer.current);
      lingerTimer.current = null;
    }
  };

  const hideTooltip = useCallback(() => {
    clearTimers();
    lastTooltipBucket.current = null;
    setTooltip(null);
  }, []);

  /** False when the message column starts too close to the rail. */
  const hasTooltipSpace = useCallback((): boolean => {
    const rail = railRef.current;
    if (!rail) return false;
    const railRect = rail.getBoundingClientRect();
    const content = document.querySelector<HTMLElement>('.transcript-content');
    const contentLeft = content?.getBoundingClientRect().left;
    if (contentLeft === undefined) return false;
    return contentLeft - railRect.right >= TOOLTIP_MIN_GUTTER_PX;
  }, []);

  const showTooltipForBucket = useCallback(
    (bucketIndex: number, clientY?: number) => {
      if (!hasTooltipSpace()) {
        hideTooltip();
        return;
      }
      if (clientY === undefined && lastTooltipBucket.current === bucketIndex) return;
      const bucket = model.buckets[bucketIndex];
      if (!bucket) return;
      const anchor =
        model.anchors.find(item => item.order === bucket.jumpOrder) ?? ({} as HistoryAnchor);
      const rail = railRef.current;
      const rect = rail?.getBoundingClientRect();
      lastTooltipBucket.current = bucketIndex;
      setTooltip({
        label: formatHistoryTooltip(anchor),
        top:
          clientY !== undefined && rect
            ? Math.max(0, Math.min(rect.height - 4, clientY - rect.top))
            : rect
              ? bucketOrdinalPosition(bucketIndex, bucketCount) * rect.height
              : 0,
      });
    },
    [bucketCount, hasTooltipSpace, hideTooltip, model]
  );

  const showActiveTooltip = useCallback(() => {
    if (activeBucketIndex === null) return;
    showTooltipForBucket(activeBucketIndex);
  }, [activeBucketIndex, showTooltipForBucket]);

  // Close the tooltip on ANY scroll (capture phase sees inner-container
  // scrolls too) unless a drag we own is producing those scrolls.
  useEffect(() => {
    const onScrollCapture = () => {
      if (scrubbingRef.current) return;
      clearTimers();
      lastTooltipBucket.current = null;
      setTooltip(null);
    };
    window.addEventListener('scroll', onScrollCapture, true);
    return () => window.removeEventListener('scroll', onScrollCapture, true);
  }, []);

  useEffect(
    () => () => {
      clearTimers();
    },
    []
  );

  const jumpFromClientY = useCallback(
    (clientY: number, behavior: 'smooth' | 'auto') => {
      const rail = railRef.current;
      if (!rail) return undefined;
      const rect = rail.getBoundingClientRect();
      const bucketIndex = resolveRailBucketFromY({
        clientY,
        railTop: rect.top,
        railHeight: rect.height,
        bucketCount,
      });
      const bucket = model.buckets[bucketIndex];
      if (!bucket) return undefined;
      onJumpToOrder(bucket.jumpOrder, behavior);
      return bucketIndex;
    },
    [bucketCount, model, onJumpToOrder]
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerId.current !== null) return;
    event.preventDefault();
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.dataset.historyScrubbing = '1';
    scrubbingRef.current = true;
    setScrubbing(true);
    clearTimers();
    const bucketIndex = jumpFromClientY(event.clientY, 'auto');
    if (bucketIndex !== undefined) showTooltipForBucket(bucketIndex, event.clientY);
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerId.current = null;
    scrubbingRef.current = false;
    delete document.documentElement.dataset.historyScrubbing;
    setScrubbing(false);
    // Keep the tooltip visible briefly after a drag ends, then close.
    if (lingerTimer.current !== null) window.clearTimeout(lingerTimer.current);
    lingerTimer.current = window.setTimeout(hideTooltip, TOOLTIP_KEYBOARD_LINGER_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current === event.pointerId) {
      const bucketIndex = jumpFromClientY(event.clientY, 'auto');
      if (bucketIndex !== undefined) showTooltipForBucket(bucketIndex, event.clientY);
      return;
    }
    // Plain hover: only schedule a delayed dwell tooltip; never re-render per
    // pointer move.
    hoverYRef.current = event.clientY;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      const y = hoverYRef.current;
      if (y === null || pointerId.current !== null || scrubbingRef.current) return;
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const bucketIndex = resolveRailBucketFromY({
        clientY: y,
        railTop: rect.top,
        railHeight: rect.height,
        bucketCount,
      });
      showTooltipForBucket(bucketIndex, y);
    }, TOOLTIP_HOVER_DELAY_MS);
  };

  const onPointerLeave = () => {
    if (pointerId.current !== null) return;
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    hideTooltip();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const intent = resolveRailKeyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      currentIndex: activePosition - 1,
      bucketCount,
      model,
    });
    if (intent === null) return;
    event.preventDefault();
    onJumpToOrder(intent, reduceMotion ? 'auto' : 'smooth');
    const targetIndex = bucketIndexOfOrder(model, intent);
    if (targetIndex !== null) {
      showTooltipForBucket(targetIndex);
      if (lingerTimer.current !== null) window.clearTimeout(lingerTimer.current);
      lingerTimer.current = window.setTimeout(hideTooltip, TOOLTIP_KEYBOARD_LINGER_MS);
    }
  };

  const onFocus = () => {
    setFocused(true);
    showActiveTooltip();
  };

  const onBlur = () => {
    setFocused(false);
    hideTooltip();
  };

  if (!loaded) return null;

  const topPercent =
    topMarker !== null ? bucketOrdinalPosition(topMarker, bucketCount) * 100 : null;
  const bottomPercent =
    bottomMarker !== null ? bucketOrdinalPosition(bottomMarker, bucketCount) * 100 : null;
  const markerHeightPx =
    topPercent !== null && bottomPercent !== null ? Math.max(2, bottomPercent - topPercent) : null;

  return (
    <nav className="history-rail" aria-label="会话历史定位">
      <div className="history-rail-inner" ref={railRef}>
        <div
          className="history-slider"
          role="slider"
          aria-label="已加载会话历史位置"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, bucketCount - 1)}
          aria-valuenow={Math.max(0, activePosition - 1)}
          aria-valuetext={
            activeDescription
              ? `已加载 ${activeDescription.bucketIndex}/${activeDescription.bucketCount} 个关键节点，当前为${activeDescription.kindLabel}${hasEarlierHistory ? '；更早历史可在正文顶部加载' : ''}`
              : `已加载 ${bucketCount} 个关键节点${hasEarlierHistory ? '；更早历史可在正文顶部加载' : ''}`
          }
          tabIndex={loaded ? 0 : undefined}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onLostPointerCapture={endScrub}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onJumpToLatest}
        >
          {hasEarlierHistory ? (
            <span className="history-earlier-cap" aria-hidden="true" title="" />
          ) : null}
          <div className="history-ticks" aria-hidden="true">
            {model.buckets.map(bucket => (
              <span
                key={bucket.index}
                className={tickClass(bucket.hasError, bucket.kinds)}
                style={{
                  top: `${bucketOrdinalPosition(bucket.index, bucketCount) * 100}%`,
                }}
              />
            ))}
          </div>
          {topPercent !== null && markerHeightPx !== null ? (
            <div
              className="history-viewport-marker"
              aria-hidden="true"
              style={{ top: `${topPercent}%`, height: `${markerHeightPx}%` }}
            />
          ) : null}
          {activeBucketIndex !== null && (focused || scrubbing) ? (
            <div
              className="history-active-dot"
              aria-hidden="true"
              style={{
                top: `${bucketOrdinalPosition(activeBucketIndex, bucketCount) * 100}%`,
              }}
            />
          ) : null}
        </div>
        {tooltip ? (
          <div className="history-tooltip" style={{ top: tooltip.top }} aria-hidden="true">
            {tooltip.label}
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function tickClass(hasError: boolean, kinds: readonly string[]): string {
  if (hasError) return 'history-tick history-tick-error';
  if (kinds.includes('user')) return 'history-tick history-tick-user';
  if (kinds.includes('assistant')) return 'history-tick history-tick-assistant';
  return 'history-tick history-tick-activity';
}
