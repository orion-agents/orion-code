/**
 * v0.3.13 S2/S3 — the conversation history rail.
 *
 * A narrow overlay on the left inside `.transcript-viewport` that represents
 * ONLY the history window currently loaded in the browser:
 *
 * - Vertical ticks are decorative (`aria-hidden`, not focusable) and map to
 *   the pure navigation model's stable buckets.
 * - A single `role="slider"` provides the accessible + pointer interaction:
 *   Arrow/Page/Home/End move between bucket jump targets, pointer drag scrubs
 *   the viewport with `resolveRailOrderFromY`.
 * - The top control only triggers the existing paginated `loadEarlier`; it
 *   never fabricates access to unloaded remote history.
 * - Dragging starts only on the slider element with pointer capture; it sets a
 *   document-level scrubbing marker so text selection and the outer workbench
 *   splitters stay inert during the gesture.
 *
 * This component owns no state about sessions, transcripts or runtime; every
 * piece of data comes from props.
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
  describeHistoryPosition,
  historyKindLabel,
  nearestAnchorOrder,
  resolveRailKeyIntent,
  resolveRailOrderFromY,
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
  /** Remaining already-fetched rows not yet rendered (`> 0` shows "剩 N 项"). */
  readonly earlierInMemory: number;
  /** Whether older history still exists behind a persistence cursor. */
  readonly hasRemoteEarlier: boolean;
  /** Disable the load-earlier control while an action is in flight. */
  readonly loadBusy: boolean;
  readonly reduceMotion: boolean;
  readonly onLoadEarlier: () => void;
  /** Smooth/plain jump for clicks and keyboard. */
  readonly onJumpToOrder: (order: number, behavior: 'smooth' | 'auto') => void;
  readonly onJumpToLatest: () => void;
}

function orderFraction(order: number, minOrder: number, maxOrder: number): number {
  if (maxOrder <= minOrder) return 0;
  return Math.max(0, Math.min(1, (order - minOrder) / (maxOrder - minOrder)));
}

export function ConversationHistoryNavigator({
  model,
  activeOrder,
  span,
  earlierInMemory,
  hasRemoteEarlier,
  loadBusy,
  reduceMotion,
  onLoadEarlier,
  onJumpToOrder,
  onJumpToLatest,
}: ConversationHistoryNavigatorProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [tooltip, setTooltip] = useState<{
    readonly order: number;
    readonly label: string;
    readonly top: number;
  } | null>(null);

  const bucketCount = model.buckets.length;
  const loaded = bucketCount > 0;
  const minOrder = model.minOrder;
  const maxOrder = model.maxOrder;

  // 1-based slider position of the active reading anchor.
  const activePosition = useMemo(() => {
    if (activeOrder === null || bucketCount === 0) return 0;
    const bucketIndex = model.buckets.findIndex(
      bucket => activeOrder >= bucket.startOrder && activeOrder <= bucket.endOrder
    );
    return bucketIndex >= 0 ? bucketIndex + 1 : 0;
  }, [activeOrder, model.buckets, bucketCount]);

  const topMarker = span ? orderFraction(span.firstOrder, minOrder, maxOrder) * 100 : null;
  const bottomMarker = span ? orderFraction(span.lastOrder, minOrder, maxOrder) * 100 : null;
  const activeFraction =
    activeOrder !== null ? orderFraction(activeOrder, minOrder, maxOrder) * 100 : null;
  const activeDescription = useMemo(
    () => (activeOrder === null ? null : describeHistoryPosition(model, activeOrder)),
    [activeOrder, model]
  );

  const jumpFromClientY = useCallback(
    (clientY: number, behavior: 'smooth' | 'auto') => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const rawOrder = resolveRailOrderFromY({
        clientY,
        railTop: rect.top,
        railHeight: rect.height,
        minOrder,
        maxOrder,
      });
      const resolved = nearestAnchorOrder(model, rawOrder);
      if (resolved === null) return;
      onJumpToOrder(resolved, behavior);
    },
    [maxOrder, minOrder, model, onJumpToOrder]
  );

  const scrubPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    jumpFromClientY(event.clientY, 'auto');
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerId.current !== null) return;
    event.preventDefault();
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.dataset.historyScrubbing = '1';
    setScrubbing(true);
    jumpFromClientY(event.clientY, 'auto');
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerId.current = null;
    delete document.documentElement.dataset.historyScrubbing;
    setScrubbing(false);
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
  };

  // Tooltip over the scrubbing surface: derive the hovered bucket for a
  // pointer position, keyed off the same y→order mapping the drag uses.
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current === event.pointerId) {
      scrubPointer(event);
      return;
    }
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const rawOrder = resolveRailOrderFromY({
      clientY: event.clientY,
      railTop: rect.top,
      railHeight: rect.height,
      minOrder,
      maxOrder,
    });
    const resolved = nearestAnchorOrder(model, rawOrder);
    if (resolved === null) return;
    const bucket = model.buckets.find(b => resolved >= b.startOrder && resolved <= b.endOrder);
    if (!bucket) return;
    const anchor = model.anchors.find(item => item.order === bucket.jumpOrder);
    setTooltip({
      order: resolved,
      label: `${historyKindLabel(anchor?.kind ?? 'system')}${anchor?.label ? ` · ${truncate(anchor.label, 40)}` : ''}`,
      top: Math.max(0, Math.min(rect.height - 4, event.clientY - rect.top)),
    });
  };

  useEffect(() => {
    if (!scrubbing) setTooltip(null);
  }, [scrubbing]);

  if (!loaded) return null;

  const canLoadEarlier = earlierInMemory > 0 || hasRemoteEarlier;
  const loadLabel =
    earlierInMemory > 0 ? `加载更早 · 剩 ${earlierInMemory} 项` : '从持久记录加载更早内容';

  return (
    <nav className="history-rail" aria-label="会话历史定位">
      <div className="history-rail-inner" ref={railRef}>
        {canLoadEarlier ? (
          <button
            type="button"
            className="history-load-earlier"
            onClick={onLoadEarlier}
            disabled={loadBusy}
          >
            {loadLabel}
          </button>
        ) : null}
        <div
          className="history-slider"
          role="slider"
          aria-label="已加载会话历史位置"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, bucketCount - 1)}
          aria-valuenow={Math.max(0, activePosition - 1)}
          aria-valuetext={
            activeDescription
              ? `已加载 ${activeDescription.bucketIndex}/${activeDescription.bucketCount} 个关键节点，当前为${activeDescription.kindLabel}`
              : `已加载 ${bucketCount} 个关键节点`
          }
          tabIndex={loaded ? 0 : undefined}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onLostPointerCapture={endScrub}
          onDoubleClick={onJumpToLatest}
        >
          <div className="history-ticks" aria-hidden="true">
            {model.buckets.map(bucket => (
              <span
                key={bucket.index}
                className={tickClass(bucket.hasError, bucket.kinds)}
                style={{
                  top: `${orderFraction(bucket.jumpOrder, minOrder, maxOrder) * 100}%`,
                }}
              />
            ))}
          </div>
          {topMarker !== null && bottomMarker !== null ? (
            <div
              className="history-viewport-marker"
              aria-hidden="true"
              style={{ top: `${topMarker}%`, height: `${Math.max(2, bottomMarker - topMarker)}%` }}
            />
          ) : null}
          {activeFraction !== null ? (
            <div
              className="history-active-dot"
              aria-hidden="true"
              style={{ top: `${activeFraction}%` }}
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

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}
