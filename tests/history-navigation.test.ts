/**
 * v0.3.13 S1 — pure conversation-history navigation model contracts.
 */
import {
  anchorWeight,
  bucketIndexOfOrder,
  bucketOrdinalPosition,
  buildHistoryNavigation,
  buildHistoryTicks,
  describeHistoryPosition,
  historyKindLabel,
  nearestAnchorOrder,
  pickActiveOrderFromBounds,
  resolveRailKeyIntent,
  resolveRailTickFromY,
  tickLengthClass,
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

  it('resolves pointer y to a tick index, clamped', () => {
    const rail = { railTop: 100, railHeight: 500, tickCount: 6 };
    expect(resolveRailTickFromY({ clientY: 100, ...rail })).toBe(0);
    expect(resolveRailTickFromY({ clientY: 350, ...rail })).toBe(3);
    expect(resolveRailTickFromY({ clientY: 600, ...rail })).toBe(5);
    expect(resolveRailTickFromY({ clientY: 0, ...rail })).toBe(0);
    expect(resolveRailTickFromY({ clientY: 900, ...rail })).toBe(5);
    expect(resolveRailTickFromY({ clientY: 100, railTop: 0, railHeight: 0, tickCount: 0 })).toBe(0);
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

describe('buildHistoryTicks (v0.3.13-plan-1)', () => {
  it('emits one tick per anchor below the density limit', () => {
    const ticks = buildHistoryTicks(mixed(50));
    expect(ticks).toHaveLength(50);
    expect(ticks[0].orders).toEqual([0]);
    expect(ticks[49].orders).toEqual([49]);
  });

  it('compacts huge timelines to the tick limit preserving order', () => {
    const ticks = buildHistoryTicks(mixed(1000));
    expect(ticks.length).toBeLessThanOrEqual(220);
    expect(ticks[0].orders[0]).toBe(0);
    expect(ticks.at(-1)?.orders.at(-1)).toBe(999);
    const covered = ticks.flatMap(t => t.orders);
    expect(new Set(covered).size).toBe(1000);
  });

  it('never loses errors through compaction (OR per group)', () => {
    const anchors = [
      ...Array.from({ length: 300 }, (_, i) =>
        anchor(i, i % 2 ? 'tool' : 'assistant', i % 2 ? 'activity' : 'turn')
      ),
      { order: 300, key: 'err', kind: 'system', label: 'boom', priority: 'error' } as HistoryAnchor,
      ...Array.from({ length: 300 }, (_, i) => anchor(301 + i, 'tool', 'activity')),
    ];
    const ticks = buildHistoryTicks(anchors, { maxTicks: 30 });
    expect(ticks.some(t => t.hasError)).toBe(true);
    const errorTick = ticks.find(t => t.hasError)!;
    expect(errorTick.orders).toContain(300);
    expect(errorTick.jumpOrder).toBe(300);
  });

  it('aligns every tick to exactly one bucket via jumpOrder', () => {
    const anchors = mixed(500);
    const model = buildHistoryNavigation(anchors);
    for (const tick of buildHistoryTicks(anchors)) {
      expect(bucketIndexOfOrder(model, tick.jumpOrder)).not.toBeNull();
    }
  });

  it('keeps jump target priority: newest error > newest turn > newest', () => {
    const anchors = [
      anchor(0, 'user'),
      anchor(1, 'tool'),
      { order: 2, key: 'e', kind: 'system', label: 'x', priority: 'error' } as HistoryAnchor,
      anchor(3, 'assistant'),
      anchor(4, 'tool'),
    ];
    const ticks = buildHistoryTicks(anchors, { maxTicks: 1 });
    expect(ticks).toHaveLength(1);
    expect(ticks[0].jumpOrder).toBe(2);
    const noError = buildHistoryNavigation(
      [anchor(0, 'tool'), anchor(1, 'user'), anchor(2, 'assistant'), anchor(3, 'tool')],
      { maxBuckets: 1 }
    );
    void noError;
    const turnTicks = buildHistoryTicks(
      [anchor(0, 'tool'), anchor(1, 'user'), anchor(2, 'assistant'), anchor(3, 'tool')],
      { maxTicks: 1 }
    );
    expect(turnTicks[0].jumpOrder).toBe(2);
  });

  it('weights long assistant content above short activity rows', () => {
    const longTurn = anchor(0, 'assistant');
    (longTurn as { label: string }).label = 'x'.repeat(600);
    const shortTool = anchor(1, 'tool');
    expect(anchorWeight(longTurn)).toBeGreaterThan(anchorWeight(shortTool));
    const ticks = buildHistoryTicks([longTurn, shortTool]);
    expect(tickLengthClass(ticks[0].weight)).toBe('history-tick-l');
    expect(tickLengthClass(ticks[1].weight)).toBe('history-tick-s');
  });

  it('handles empty and single inputs', () => {
    expect(buildHistoryTicks([])).toEqual([]);
    const single = buildHistoryTicks([anchor(5, 'user')]);
    expect(single).toHaveLength(1);
    expect(single[0].jumpOrder).toBe(5);
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
