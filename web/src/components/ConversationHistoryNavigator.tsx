/**
 * v0.3.13-plan-1 — the conversation history rail as a Codex-style mini-map.
 *
 * - One tick per loaded anchor (compacted past a density limit); tick LENGTH
 *   encodes static content weight, never DOM pixel heights.
 * - Monochrome ticks; the viewport range lights its ticks up as one continuous
 *   block; error ticks keep the single semantic color exception.
 * - Hovering a tick (120ms dwell) opens a Codex-style preview card to the
 *   right: bold topic line + a short plain-text excerpt of that row. The card
 *   is aria-hidden decoration; `aria-valuetext` stays the semantic channel.
 *   The card hides on leave, on scroll and during scrubs.
 * - While the runtime is processing, a white bar at the rail's latest end
 *   breathes to mark the live output position (static under reduced motion).
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

import { sanitizeDisplayText } from './Markdown';
import {
  bucketIndexOfOrder,
  bucketOrdinalPosition,
  buildHistoryTicks,
  describeHistoryPosition,
  resolveRailKeyIntent,
  resolveRailTickFromY,
  tickLengthClass,
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
  /** Whether older history exists (memory window or persistence cursor). */
  readonly hasEarlierHistory: boolean;
  /** Live output indicator on the rail's latest end. */
  readonly processing: boolean;
  readonly reduceMotion: boolean;
  /** Smooth/plain jump for clicks and keyboard. */
  readonly onJumpToOrder: (order: number, behavior: 'smooth' | 'auto') => void;
  readonly onJumpToLatest: () => void;
}

export function ConversationHistoryNavigator({
  model,
  activeOrder,
  span,
  hasEarlierHistory,
  processing,
  reduceMotion,
  onJumpToOrder,
  onJumpToLatest,
}: ConversationHistoryNavigatorProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const hoverTimer = useRef<number | null>(null);
  const hoverYRef = useRef<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [hover, setHover] = useState<{
    readonly title: string;
    readonly preview: string | null;
    readonly top: number;
  } | null>(null);

  const ticks = useMemo(() => buildHistoryTicks(model.anchors), [model.anchors]);
  const tickCount = ticks.length;

  // Keyboard ordinal stays on the bucket model; ticks align to it by jumpOrder.
  const activePosition = useMemo(() => {
    if (activeOrder === null || tickCount === 0) return 0;
    const bucketIndex = bucketIndexOfOrder(model, activeOrder);
    return bucketIndex !== null ? bucketIndex + 1 : 0;
  }, [activeOrder, model, tickCount]);

  const activeDescription = useMemo(
    () => (activeOrder === null ? null : describeHistoryPosition(model, activeOrder)),
    [activeOrder, model]
  );

  // Viewport highlight: the bucket range covering the visible span, applied to
  // every tick whose jumpOrder falls inside it — one continuous lit block.
  const firstVisibleBucket =
    span !== null ? (bucketIndexOfOrder(model, span.firstOrder) ?? 0) : null;
  const lastVisibleBucket =
    span !== null ? (bucketIndexOfOrder(model, span.lastOrder) ?? model.buckets.length - 1) : null;

  const tickBucketIndexes = useMemo(
    () => ticks.map(tick => bucketIndexOfOrder(model, tick.jumpOrder)),
    [model, ticks]
  );

  const hidePreview = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHover(null);
  }, []);

  const showPreviewAt = useCallback(
    (clientY: number) => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const tickIndex = resolveRailTickFromY({
        clientY,
        railTop: rect.top,
        railHeight: rect.height,
        tickCount,
      });
      const tick = ticks[tickIndex];
      if (!tick) return;
      const anchor = model.anchors.find(item => item.order === tick.jumpOrder);
      // Codex pairing: a user row previews the assistant reply that follows it.
      let preview = anchor?.preview;
      if (anchor?.kind === 'user') {
        const reply = model.anchors.find(
          item => item.order > anchor.order && item.kind === 'assistant'
        );
        const replyText = reply?.preview;
        if (replyText) preview = preview ? `${preview}\n\n${replyText}` : replyText;
      }
      const ordinalTop = bucketOrdinalPosition(tickIndex, tickCount) * rect.height;
      setHover({
        title: sanitizeDisplayText(anchor?.label ?? ''),
        preview: preview ? sanitizeDisplayText(preview) : null,
        top: Math.max(8, Math.min(rect.height - 140, ordinalTop)),
      });
    },
    [model, tickCount, ticks]
  );

  const schedulePreview = useCallback(
    (clientY: number) => {
      hoverYRef.current = clientY;
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null;
        const y = hoverYRef.current;
        if (y === null || pointerId.current !== null || scrubbingRef.current) return;
        showPreviewAt(y);
      }, 120);
    },
    [showPreviewAt]
  );

  // Any transcript scroll closes the card unless a drag we own scrolls it.
  useEffect(() => {
    const onScrollCapture = () => {
      if (scrubbingRef.current) return;
      hidePreview();
    };
    window.addEventListener('scroll', onScrollCapture, true);
    return () => window.removeEventListener('scroll', onScrollCapture, true);
  }, [hidePreview]);

  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    },
    []
  );

  const jumpFromClientY = useCallback(
    (clientY: number, behavior: 'smooth' | 'auto') => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const tickIndex = resolveRailTickFromY({
        clientY,
        railTop: rect.top,
        railHeight: rect.height,
        tickCount,
      });
      const tick = ticks[tickIndex];
      if (!tick) return;
      onJumpToOrder(tick.jumpOrder, behavior);
    },
    [onJumpToOrder, tickCount, ticks]
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerId.current !== null) return;
    event.preventDefault();
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.dataset.historyScrubbing = '1';
    scrubbingRef.current = true;
    setScrubbing(true);
    hidePreview();
    jumpFromClientY(event.clientY, 'auto');
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
    hidePreview();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const intent = resolveRailKeyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      currentIndex: activePosition - 1,
      bucketCount: model.buckets.length,
      model,
    });
    if (intent === null) return;
    event.preventDefault();
    onJumpToOrder(intent, reduceMotion ? 'auto' : 'smooth');
  };

  if (tickCount === 0) return null;

  return (
    <nav className="history-rail" aria-label="会话历史定位">
      <div className="history-rail-inner" ref={railRef}>
        <div
          className="history-slider"
          role="slider"
          aria-label="已加载会话历史位置"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, model.buckets.length - 1)}
          aria-valuenow={Math.max(0, activePosition - 1)}
          aria-valuetext={
            activeDescription
              ? `已加载 ${activeDescription.bucketIndex}/${activeDescription.bucketCount} 个关键节点，当前为${activeDescription.kindLabel}${hasEarlierHistory ? '；更早历史可在正文顶部加载' : ''}`
              : `已加载 ${model.buckets.length} 个关键节点${hasEarlierHistory ? '；更早历史可在正文顶部加载' : ''}`
          }
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={event => {
            if (pointerId.current === event.pointerId) {
              jumpFromClientY(event.clientY, 'auto');
              return;
            }
            schedulePreview(event.clientY);
          }}
          onPointerLeave={hidePreview}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onLostPointerCapture={endScrub}
          onDoubleClick={onJumpToLatest}
        >
          <div className="history-ticks" aria-hidden="true">
            {ticks.map((tick, index) => {
              const ownerBucket = tickBucketIndexes[index];
              const inViewport =
                ownerBucket !== null &&
                firstVisibleBucket !== null &&
                lastVisibleBucket !== null &&
                ownerBucket >= firstVisibleBucket &&
                ownerBucket <= lastVisibleBucket;
              return (
                <span
                  key={tick.index}
                  className={[
                    'history-tick',
                    tickLengthClass(tick.weight),
                    inViewport ? 'is-viewport' : '',
                    tick.hasError ? 'is-error' : '',
                    scrubbing ? 'is-scrubbing' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    top: `${bucketOrdinalPosition(tick.index, tickCount) * 100}%`,
                  }}
                />
              );
            })}
          </div>
          {processing ? <span className="history-live-bar" aria-hidden="true" /> : null}
        </div>
        {hover ? (
          <div className="history-preview-card" style={{ top: hover.top }} aria-hidden="true">
            <strong>{hover.title}</strong>
            {hover.preview ? <p>{hover.preview}</p> : null}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
