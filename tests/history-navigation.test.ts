/**
 * v0.3.13 S1 — pure conversation-history navigation model contracts.
 */
import {
  bucketIndexOfOrder,
  bucketOrdinalPosition,
  buildHistoryNavigation,
  describeHistoryPosition,
  formatHistoryTooltip,
  historyKindLabel,
  nearestAnchorOrder,
  pickActiveOrderFromBounds,
  resolveRailBucketFromY,
  resolveRailKeyIntent,
  type HistoryAnchor,
} from '../web/src/components/history-navigation';

function anchor(
  order: number,
  kind: HistoryAnchor['kind'],
  priority?: HistoryAnchor['priority']
): HistoryAnchor {
  return {
    order,
    key: `k${order}`,
    kind,
    label: `${kind}-${order}`,
    priority: priority ?? (kind === 'user' || kind === 'assistant' ? 'turn' : 'activity'),
  };
}

/** Generates an even mix of user/assistant/tool anchors for density tests. */
function mixed(count: number): HistoryAnchor[] {
  const anchors: HistoryAnchor[] = [];
  for (let index = 0; index < count; index += 1) {
    const turn = index % 3;
    anchors.push(
      anchor(
        index,
        turn === 0 ? 'user' : turn === 1 ? 'assistant' : 'tool',
        turn === 2 ? 'activity' : 'turn'
      )
    );
  }
  return anchors;
}

describe('buildHistoryNavigation ordering', () => {
  it('sorts anchors by order regardless of input order', () => {
    const model = buildHistoryNavigation([
      anchor(30, 'assistant'),
      anchor(10, 'user'),
      anchor(20, 'tool'),
    ]);
    expect(model.anchors.map(item => item.order)).toEqual([10, 20, 30]);
  });

  it('ignores non-finite orders defensively', () => {
    const model = buildHistoryNavigation([
      anchor(1, 'user'),
      { order: Number.NaN, key: 'bad', kind: 'tool', label: 'x', priority: 'activity' },
      anchor(2, 'assistant'),
    ]);
    expect(model.anchors.map(item => item.order)).toEqual([1, 2]);
  });
});

describe('buildHistoryNavigation bucket limits', () => {
  it('returns empty buckets for an empty timeline', () => {
    const model = buildHistoryNavigation([]);
    expect(model.buckets).toEqual([]);
    expect(model.minOrder).toBe(0);
    expect(model.maxOrder).toBe(0);
  });

  it('keeps a single anchor in a single bucket', () => {
    const model = buildHistoryNavigation([anchor(7, 'user')]);
    expect(model.buckets).toHaveLength(1);
    expect(model.buckets[0].jumpOrder).toBe(7);
    expect(model.minOrder).toBe(7);
    expect(model.maxOrder).toBe(7);
  });

  it('caps visual buckets at the default 48 for huge timelines', () => {
    const model = buildHistoryNavigation(mixed(1000));
    expect(model.anchors).toHaveLength(1000);
    expect(model.buckets.length).toBeLessThanOrEqual(48);
    expect(model.buckets[0].startOrder).toBe(0);
    expect(model.buckets.at(-1)?.endOrder).toBe(999);
  });

  it('honours a caller bucket ceiling within the 1..64 limit', () => {
    expect(
      buildHistoryNavigation(mixed(500), { maxBuckets: 64 }).buckets.length
    ).toBeLessThanOrEqual(64);
    expect(buildHistoryNavigation(mixed(500), { maxBuckets: 8 }).buckets.length).toBe(8);
    expect(
      buildHistoryNavigation(mixed(500), { maxBuckets: 999 }).buckets.length
    ).toBeLessThanOrEqual(64);
    expect(
      buildHistoryNavigation(mixed(500), { maxBuckets: Number.NaN }).buckets.length
    ).toBeLessThanOrEqual(48);
  });

  it('covers every anchor across buckets without gaps or overlaps in order', () => {
    const model = buildHistoryNavigation(mixed(500));
    const covered = model.buckets.flatMap(bucket => bucket.orders);
    expect(covered).toHaveLength(500);
    const seen = new Set(covered);
    expect(seen.size).toBe(500);
  });
});

describe('buildHistoryNavigation priority preservation', () => {
  it('flags error presence so errors stay visible inside dense activity buckets', () => {
    const model = buildHistoryNavigation([
      anchor(0, 'user'),
      anchor(1, 'tool'),
      { order: 2, key: 'e2', kind: 'system', label: '失败', priority: 'error' },
      anchor(3, 'tool'),
      anchor(4, 'assistant'),
    ]);
    const errorBucket = model.buckets.find(bucket => bucket.hasError);
    expect(errorBucket).toBeDefined();
    expect(errorBucket?.kinds).toContain('system');
  });

  it('prefers the newest error as the jump target of its bucket', () => {
    const model = buildHistoryNavigation(
      [
        anchor(0, 'user'),
        { order: 1, key: 'e1', kind: 'system', label: 'err1', priority: 'error' },
        { order: 2, key: 'e2', kind: 'system', label: 'err2', priority: 'error' },
        anchor(3, 'assistant'),
      ],
      { maxBuckets: 1 }
    );
    expect(model.buckets).toHaveLength(1);
    expect(model.buckets[0].hasError).toBe(true);
    expect(model.buckets[0].jumpOrder).toBe(2);
  });

  it('falls back to a turn, then the middle anchor when a bucket has no error', () => {
    const turns = buildHistoryNavigation(
      [
        anchor(0, 'tool'),
        anchor(1, 'tool'),
        anchor(2, 'user'),
        anchor(3, 'assistant'),
        anchor(4, 'tool'),
      ],
      { maxBuckets: 1 }
    );
    expect(turns.buckets[0].jumpOrder).toBe(3);
    const activitiesOnly = buildHistoryNavigation(
      [anchor(0, 'tool'), anchor(1, 'edit'), anchor(2, 'research'), anchor(3, 'tool')],
      { maxBuckets: 1 }
    );
    // Middle anchor of [0,1,2,3] → index 1 → order 1.
    expect(activitiesOnly.buckets[0].jumpOrder).toBe(1);
  });

  it('records distinct kinds per bucket without duplicates', () => {
    const model = buildHistoryNavigation(
      [anchor(0, 'user'), anchor(1, 'tool'), anchor(2, 'assistant'), anchor(3, 'tool')],
      { maxBuckets: 1 }
    );
    expect([...model.buckets[0].kinds].sort()).toEqual(['assistant', 'tool', 'user']);
  });
});

describe('bucket ordinal geometry (v0.3.13 S3)', () => {
  it('maps bucket index onto equal visual slots regardless of order gaps', () => {
    // Wide order gaps must not stretch any tick: 6 buckets are always at
    // 0/20/40/60/80/100 percent.
    expect(bucketOrdinalPosition(0, 6)).toBe(0);
    expect(bucketOrdinalPosition(2, 6)).toBeCloseTo(0.4);
    expect(bucketOrdinalPosition(5, 6)).toBe(1);
    expect(bucketOrdinalPosition(0, 1)).toBe(0.5);
    expect(bucketOrdinalPosition(0, 0)).toBe(0);
    expect(bucketOrdinalPosition(9, 6)).toBe(1); // clamps
  });

  it('resolves pointer y to a bucket index, clamped', () => {
    const rail = { railTop: 100, railHeight: 500, bucketCount: 6 };
    expect(resolveRailBucketFromY({ clientY: 100, ...rail })).toBe(0);
    expect(resolveRailBucketFromY({ clientY: 350, ...rail })).toBe(3);
    expect(resolveRailBucketFromY({ clientY: 600, ...rail })).toBe(5);
    expect(resolveRailBucketFromY({ clientY: 0, ...rail })).toBe(0);
    expect(resolveRailBucketFromY({ clientY: 900, ...rail })).toBe(5);
    expect(resolveRailBucketFromY({ clientY: 100, railTop: 0, railHeight: 0, bucketCount: 0 })).toBe(0);
  });

  it('locates the bucket that owns an order (and none outside)', () => {
    const model = buildHistoryNavigation([
      anchor(0, 'user'),
      anchor(500, 'assistant'),
      anchor(1000, 'tool'),
    ]);
    expect(bucketIndexOfOrder(model, 0)).toBe(0);
    expect(bucketIndexOfOrder(model, 500)).toBe(1);
    expect(bucketIndexOfOrder(model, 1000)).toBe(2);
    expect(bucketIndexOfOrder(model, 750)).toBeNull();
    expect(bucketIndexOfOrder(model, -5)).toBeNull();
  });
});

describe('formatHistoryTooltip (v0.3.13 S3)', () => {
  it('collapses generic labels that echo the kind', () => {
    expect(formatHistoryTooltip({ order: 1, key: 'k', kind: 'assistant', label: 'Orion 回复', priority: 'turn' })).toBe('Orion 回复');
    expect(formatHistoryTooltip({ order: 1, key: 'k', kind: 'user', label: '用户任务', priority: 'turn' })).toBe('用户任务');
  });

  it('keeps real content and never duplicates the kind', () => {
    const label = formatHistoryTooltip({ order: 1, key: 'k', kind: 'assistant', label: '  修复超时并重试连接  ', priority: 'turn' });
    expect(label).toBe('Orion 回复 · 修复超时并重试连接');
    expect(formatHistoryTooltip({ order: 1, key: 'k', kind: 'tool', label: '', priority: 'activity' })).toBe('工具活动');
  });

  it('truncates long labels to a single line', () => {
    const long = 'x'.repeat(120);
    const label = formatHistoryTooltip({ order: 1, key: 'k', kind: 'tool', label: long, priority: 'activity' });
    expect(label.length).toBeLessThan(60);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('resolveRailKeyIntent', () => {
  const model = buildHistoryNavigation(mixed(200));
  const bucketCount = model.buckets.length;
  const intent = (key: string, currentIndex: number, shiftKey = false) =>
    resolveRailKeyIntent({ key, currentIndex, bucketCount, model, shiftKey });

  it('steps one bucket with Arrow keys and five with Page/Shift', () => {
    expect(intent('ArrowDown', 3)).toBe(model.buckets[4].jumpOrder);
    expect(intent('ArrowUp', 3)).toBe(model.buckets[2].jumpOrder);
    expect(intent('ArrowRight', 3)).toBe(model.buckets[4].jumpOrder);
    expect(intent('PageDown', 3)).toBe(model.buckets[8].jumpOrder);
    expect(intent('PageUp', 10)).toBe(model.buckets[5].jumpOrder);
    expect(intent('ArrowDown', 3, true)).toBe(model.buckets[8].jumpOrder);
  });

  it('clamps to the loaded edges and supports Home/End', () => {
    expect(intent('ArrowUp', 0)).toBe(model.buckets[0].jumpOrder);
    expect(intent('ArrowDown', bucketCount - 1)).toBe(model.buckets.at(-1)?.jumpOrder);
    expect(intent('Home', 5)).toBe(model.buckets[0].jumpOrder);
    expect(intent('End', 5)).toBe(model.buckets.at(-1)?.jumpOrder);
  });

  it('returns null for unrelated keys so callers skip preventDefault', () => {
    expect(intent('Enter', 3)).toBeNull();
    expect(intent(' ', 3)).toBeNull();
    expect(intent('a', 3)).toBeNull();
  });
});

describe('pickActiveOrderFromBounds', () => {
  it('chooses the top-most visible row as the reading anchor', () => {
    const samples = [
      { order: 1, topInViewport: -40 },
      { order: 2, topInViewport: 12 },
      { order: 3, topInViewport: 220 },
    ];
    expect(pickActiveOrderFromBounds(samples, 0)).toBe(2);
  });

  it('ignores rows scrolled above the viewport', () => {
    const samples = [
      { order: 1, topInViewport: -100 },
      { order: 2, topInViewport: 4 },
      { order: 3, topInViewport: 60 },
    ];
    expect(pickActiveOrderFromBounds(samples, 0)).toBe(2);
  });

  it('returns null when nothing is visible', () => {
    expect(pickActiveOrderFromBounds([], 0)).toBeNull();
    expect(pickActiveOrderFromBounds([{ order: 9, topInViewport: -5 }], 0)).toBeNull();
  });
});

describe('nearestAnchorOrder', () => {
  it('maps an order to the nearest loaded anchor', () => {
    const model = buildHistoryNavigation([
      anchor(10, 'user'),
      anchor(20, 'assistant'),
      anchor(40, 'tool'),
    ]);
    expect(nearestAnchorOrder(model, 12)).toBe(10);
    expect(nearestAnchorOrder(model, 21)).toBe(20);
    expect(nearestAnchorOrder(model, 39)).toBe(40);
    expect(nearestAnchorOrder(model, 5)).toBe(10);
  });

  it('prefers the later anchor on exact ties', () => {
    const model = buildHistoryNavigation([anchor(10, 'user'), anchor(30, 'assistant')]);
    expect(nearestAnchorOrder(model, 20)).toBe(30);
  });

  it('returns null for an empty model', () => {
    expect(nearestAnchorOrder(buildHistoryNavigation([]), 5)).toBeNull();
  });
});

describe('position labels', () => {
  it('describes the active position with a stable 1-based index', () => {
    const model = buildHistoryNavigation(mixed(120));
    const midOrder = model.buckets[10].startOrder;
    const description = describeHistoryPosition(model, midOrder);
    expect(description.bucketCount).toBe(model.buckets.length);
    expect(description.bucketIndex).toBe(11);
    expect(description.kindLabel).toBeTruthy();
  });

  it('handles an order outside loaded history without throwing', () => {
    const model = buildHistoryNavigation([anchor(5, 'user')]);
    const description = describeHistoryPosition(model, 999);
    expect(description.bucketIndex).toBe(0);
  });

  it('maps every kind to a Chinese label', () => {
    for (const kind of [
      'user',
      'assistant',
      'tool',
      'edit',
      'subtask',
      'research',
      'system',
    ] as const) {
      expect(historyKindLabel(kind).length).toBeGreaterThan(0);
    }
  });
});
