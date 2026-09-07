/**
 * v0.3.13 S1 — pure navigation model for the conversation history rail.
 *
 * The rail can only navigate history that is already loaded in the browser.
 * This module derives a bounded set of stable "buckets" from the unified
 * order-sorted timeline anchors so the renderer never turns hundreds of
 * timeline rows into hundreds of focusable controls.
 *
 * Contract:
 * - `order` from the unified timeline is the ONLY sort key (never render
 *   index / DOM index / wall time).
 * - Bucketing is by anchor count in source order, never by rendered pixel
 *   height, so expanding a Markdown block cannot move history coordinates.
 * - user turns, assistant replies and errors are never silently dropped: every
 *   anchor belongs to exactly one bucket and each bucket records its member
 *   kinds plus `hasError`, so those priorities stay visible even when many
 *   low-value activity anchors share one bucket.
 * - Pure and defensive: empty input, single anchor, duplicated or negative
 *   orders, and huge inputs (1000+) all produce stable output.
 */
export type HistoryAnchorKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'edit'
  | 'subtask'
  | 'research'
  | 'system';

export type HistoryAnchorPriority = 'turn' | 'activity' | 'error';

export interface HistoryAnchor {
  /** Unified timeline order — the only coordinate the rail understands. */
  readonly order: number;
  /** Stable timeline key (entry id / call id / task id), never the render index. */
  readonly key: string;
  readonly kind: HistoryAnchorKind;
  /** Short, truncatable description used by tooltips and aria-valuetext. */
  readonly label: string;
  readonly priority: HistoryAnchorPriority;
}

export interface HistoryBucket {
  /** 0-based visual position from oldest to newest. */
  readonly index: number;
  /** Order of the first anchor in the bucket. */
  readonly startOrder: number;
  /** Order of the last anchor in the bucket. */
  readonly endOrder: number;
  /** Anchor orders in this bucket, oldest first. */
  readonly orders: readonly number[];
  /** Distinct kinds present in this bucket (renderer tick semantics). */
  readonly kinds: readonly HistoryAnchorKind[];
  readonly hasError: boolean;
  /**
   * Best scroll target for a click on this bucket: the newest error anchor,
   * else the newest turn (user/assistant), else the middle anchor.
   */
  readonly jumpOrder: number;
}

export interface HistoryNavigationModel {
  readonly anchors: readonly HistoryAnchor[];
  readonly buckets: readonly HistoryBucket[];
  /** Largest order across all buckets (the "latest" end of loaded history). */
  readonly maxOrder: number;
  /** Smallest order across all buckets (the "earliest" end of loaded history). */
  readonly minOrder: number;
}

export const HISTORY_DEFAULT_MAX_BUCKETS = 48;
export const HISTORY_MAX_BUCKETS_LIMIT = 64;

const ERRORISH_KINDS: ReadonlySet<HistoryAnchorKind> = new Set(['system']);
const TURN_KINDS: ReadonlySet<HistoryAnchorKind> = new Set(['user', 'assistant']);

export function buildHistoryNavigation(
  anchors: readonly HistoryAnchor[],
  options: { readonly maxBuckets?: number } = {}
): HistoryNavigationModel {
  const maxBuckets = clampBucketLimit(options.maxBuckets);
  const sorted = [...anchors]
    .filter(anchor => Number.isFinite(anchor.order))
    .sort((left, right) => left.order - right.order);

  if (sorted.length === 0) {
    return Object.freeze({
      anchors: Object.freeze([]),
      buckets: Object.freeze([]),
      minOrder: 0,
      maxOrder: 0,
    });
  }

  // One bucket per anchor until the window exceeds the visual limit, then a
  // stable count-based partition. Anchor count, not pixel height.
  const bucketCount = Math.min(sorted.length, maxBuckets);
  const perBucket = Math.ceil(sorted.length / bucketCount);
  const buckets: HistoryBucket[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const slice = sorted.slice(index * perBucket, (index + 1) * perBucket);
    if (slice.length === 0) break;
    buckets.push(bucketFromSlice(index, slice));
  }
  return Object.freeze({
    anchors: Object.freeze(sorted),
    buckets: Object.freeze(buckets),
    minOrder: buckets[0]?.startOrder ?? 0,
    maxOrder: buckets.at(-1)?.endOrder ?? 0,
  });
}

function bucketFromSlice(index: number, slice: readonly HistoryAnchor[]): HistoryBucket {
  const kinds: HistoryAnchorKind[] = [];
  const seen = new Set<HistoryAnchorKind>();
  let hasError = false;
  let best: HistoryAnchor | null = null;
  for (const anchor of slice) {
    if (!seen.has(anchor.kind)) {
      seen.add(anchor.kind);
      kinds.push(anchor.kind);
    }
    if (anchor.priority === 'error') {
      hasError = true;
      // Newest error wins the jump target; ties keep the first seen.
      if (!best || anchor.priority === 'error') best = anchor;
    }
  }
  if (!best) {
    // Newest turn (user/assistant) wins; otherwise the middle anchor.
    let turn: HistoryAnchor | null = null;
    for (const anchor of slice) {
      if (TURN_KINDS.has(anchor.kind)) turn = anchor;
    }
    best = turn ?? slice[Math.floor((slice.length - 1) / 2)];
  }
  return Object.freeze({
    index,
    startOrder: slice[0].order,
    endOrder: slice.at(-1)!.order,
    orders: Object.freeze(slice.map(anchor => anchor.order)),
    kinds: Object.freeze(kinds),
    hasError,
    jumpOrder: best.order,
  });
}

function clampBucketLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HISTORY_DEFAULT_MAX_BUCKETS;
  return Math.min(HISTORY_MAX_BUCKETS_LIMIT, Math.max(1, Math.round(value)));
}

export function kindIsError(kind: HistoryAnchorKind): boolean {
  return ERRORISH_KINDS.has(kind);
}

/** Stable, short Chinese label used by tooltips / aria-valuetext. */
export function historyKindLabel(kind: HistoryAnchorKind): string {
  switch (kind) {
    case 'user':
      return '用户任务';
    case 'assistant':
      return 'Orion 回复';
    case 'tool':
      return '工具活动';
    case 'edit':
      return '文件修改';
    case 'subtask':
      return '子任务';
    case 'research':
      return '研究';
    case 'system':
      return '系统/错误';
  }
}

/**
 * Positional description for aria-valuetext / screen-reader announcements:
 * "已加载 12/48 个关键节点，当前为 工具活动" style data, kept pure.
 */
export function describeHistoryPosition(
  model: HistoryNavigationModel,
  order: number
): { readonly bucketIndex: number; readonly bucketCount: number; readonly kindLabel: string } {
  const index = model.buckets.findIndex(
    bucket => order >= bucket.startOrder && order <= bucket.endOrder
  );
  const bucket = index >= 0 ? model.buckets[index] : undefined;
  const kind = bucket?.kinds.includes('assistant')
    ? 'assistant'
    : bucket?.kinds.includes('user')
      ? 'user'
      : (bucket?.kinds[0] ?? 'system');
  return {
    bucketIndex: index >= 0 ? index + 1 : 0,
    bucketCount: model.buckets.length,
    kindLabel: kind ? historyKindLabel(kind) : '未知',
  };
}

/**
 * The rail's visual coordinate is the BUCKET ORDINAL, never the raw `order`
 * number: row gaps or wildly spaced persisted orders would otherwise draw
 * phantom blank stretches and unstable tick positions. These helpers map
 * clientY and orders onto `[0, bucketCount - 1]` positions (0 = oldest
 * loaded bucket, n-1 = newest).
 */

/** 0..1 visual position of the i-th bucket along the rail. */
export function bucketOrdinalPosition(index: number, bucketCount: number): number {
  if (bucketCount <= 0) return 0;
  if (bucketCount === 1) return 0.5;
  const clamped = Math.max(0, Math.min(bucketCount - 1, index));
  return clamped / (bucketCount - 1);
}

/** Index of the bucket containing `order`, or null when outside loaded history. */
export function bucketIndexOfOrder(model: HistoryNavigationModel, order: number): number | null {
  const index = model.buckets.findIndex(
    bucket => order >= bucket.startOrder && order <= bucket.endOrder
  );
  return index >= 0 ? index : null;
}

/**
 * Pointer coordinate → bucket index. Pure so drags can be unit tested: a
 * `clientY` inside the rail maps onto the bucket ordinals and clamps.
 */
export function resolveRailBucketFromY(options: {
  readonly clientY: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly bucketCount: number;
}): number {
  const { clientY, railTop, railHeight, bucketCount } = options;
  if (!Number.isFinite(railHeight) || railHeight <= 0 || bucketCount <= 0) return 0;
  const ratio = (clientY - railTop) / railHeight;
  return Math.max(0, Math.min(bucketCount - 1, Math.round(ratio * (bucketCount - 1))));
}

/**
 * One-line tooltip text for an anchor. Generic fallback labels that merely
 * echo the kind ("Orion 回复 · Orion 回复") collapse to the kind alone; real
 * content labels show as `kind · first-line` so the tooltip never duplicates
 * and never wraps.
 */
export function formatHistoryTooltip(anchor: HistoryAnchor): string {
  const typeLabel = historyKindLabel(anchor.kind);
  const cleaned = anchor.label.replace(/\s+/gu, ' ').trim();
  if (!cleaned || cleaned === typeLabel) return typeLabel;
  const line = cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
  return `${typeLabel} · ${line}`;
}

/**
 * Picks the active reading anchor from IntersectionObserver samples. The
 * reader's position is the top-most visible timeline row (its top inside the
 * viewport is >= 0); the first such row in viewport order wins.
 */
export function pickActiveOrderFromBounds(
  samples: readonly { readonly order: number; readonly topInViewport: number }[],
  viewportTop: number
): number | null {
  let best: { order: number; topInViewport: number } | null = null;
  for (const sample of samples) {
    if (sample.topInViewport < viewportTop - 1) continue; // scrolled out above
    if (!best || sample.topInViewport < best.topInViewport) best = sample;
  }
  return best?.order ?? null;
}

/**
 * Resolves an arbitrary order (e.g. a dragged y) to the nearest loaded anchor
 * so jumping always lands on a real row. Ties prefer the later anchor.
 */
export function nearestAnchorOrder(model: HistoryNavigationModel, order: number): number | null {
  if (model.anchors.length === 0) return null;
  let nearest = model.anchors[0].order;
  let distance = Number.POSITIVE_INFINITY;
  for (const anchor of model.anchors) {
    const delta = Math.abs(anchor.order - order);
    if (delta < distance || (delta === distance && anchor.order > nearest)) {
      nearest = anchor.order;
      distance = delta;
    }
  }
  return nearest;
}

export interface RailKeyIntent {
  readonly key: string;
  readonly shiftKey?: boolean;
  /** Current slider index into `bucketCount - 1` visual units. */
  readonly currentIndex: number;
  readonly bucketCount: number;
  readonly model: HistoryNavigationModel;
}

/**
 * Keyboard resolver for the history slider. ArrowUp/ArrowDown step to the
 * previous/next bucket jump target; Home/End go to the earliest/latest loaded
 * bucket. Returns null for unrelated keys so callers skip preventDefault.
 */
export function resolveRailKeyIntent(intent: RailKeyIntent): number | null {
  const { key, currentIndex, bucketCount, model } = intent;
  if (bucketCount <= 0) return null;
  const step = intent.shiftKey ? 5 : 1;
  if (key === 'Home') return model.buckets[0]?.jumpOrder ?? null;
  if (key === 'End') return model.buckets.at(-1)?.jumpOrder ?? null;
  let nextIndex: number;
  if (key === 'ArrowUp' || key === 'ArrowLeft') nextIndex = currentIndex - step;
  else if (key === 'ArrowDown' || key === 'ArrowRight') nextIndex = currentIndex + step;
  else if (key === 'PageUp') nextIndex = currentIndex - 5;
  else if (key === 'PageDown') nextIndex = currentIndex + 5;
  else return null;
  const clamped = Math.max(0, Math.min(bucketCount - 1, nextIndex));
  return model.buckets[clamped]?.jumpOrder ?? null;
}
