/**
 * v0.3.13 S1/S2 — browser binding between the loaded conversation timeline and
 * the history rail.
 *
 * Everything DOM-dependent lives here; the navigation math (bucket model,
 * drag mapping, keyboard resolution, active-anchor picking) is pure in
 * `history-navigation.ts`. The hook:
 *
 * - registers every rendered timeline `<li>` by its `order`;
 * - watches the `.transcript-viewport` with an IntersectionObserver and keeps
 *   a rAF-throttled `{ firstOrder, lastOrder, activeOrder }` sample — never a
 *   per-scroll full re-measure or re-render;
 * - exposes `scrollToOrder` that only mutates the viewport's scrollTop;
 * - resets observers/registry/state when the active session changes;
 * - degrades silently when IntersectionObserver is unavailable (the rail keeps
 *   working for clicks on the top load-earlier control and jump-to-latest; the
 *   viewport marker simply stays null).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  nearestAnchorOrder,
  pickActiveOrderFromBounds,
  type HistoryNavigationModel,
} from './history-navigation';

export interface HistoryViewportSpan {
  readonly firstOrder: number;
  readonly lastOrder: number;
}

export interface HistoryNavigatorController {
  /** Order of the top-most visible timeline row (reading position). */
  readonly activeOrder: number | null;
  /** First/last loaded order currently intersecting the viewport. */
  readonly span: HistoryViewportSpan | null;
  /** Call from the `<li>` ref callback; a null element unregisters. */
  readonly registerItem: (order: number, element: HTMLElement | null) => void;
  /** Scrolls the transcript viewport so the order sits near its top. */
  readonly scrollToOrder: (order: number, behavior?: 'smooth' | 'auto') => void;
}

interface ObserverSample {
  readonly order: number;
  readonly topInViewport: number;
}

const SCROLL_TARGET_PAD_PX = 10;

export function useConversationHistoryNavigator(options: {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly model: HistoryNavigationModel;
  readonly activeSessionId: string | null;
  /** Invoked when the user explicitly navigates away from the live bottom. */
  readonly onUserNavigate?: () => void;
}): HistoryNavigatorController {
  const { viewportRef, model, activeSessionId, onUserNavigate } = options;
  const registry = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pendingSamples = useRef<ObserverSample[]>([]);
  const rafRef = useRef<number | null>(null);
  const [activeOrder, setActiveOrder] = useState<number | null>(null);
  const [span, setSpan] = useState<HistoryViewportSpan | null>(null);
  const onNavigateRef = useRef(onUserNavigate);
  onNavigateRef.current = onUserNavigate;
  const sessionRef = useRef(activeSessionId);
  const modelRef = useRef(model);
  modelRef.current = model;

  const flush = () => {
    rafRef.current = null;
    if (pendingSamples.current.length === 0) return;
    const samples = pendingSamples.current;
    pendingSamples.current = [];
    if (samples.length === 0) return;
    const viewport = viewportRef.current;
    const rootTop = viewport?.getBoundingClientRect().top ?? 0;
    // Reading anchor: the top-most visible row at/inside the viewport top.
    const nextActive = pickActiveOrderFromBounds(samples, rootTop);
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const sample of samples) {
      if (sample.topInViewport >= rootTop - 1) {
        if (sample.order < first) first = sample.order;
        if (sample.order > last) last = sample.order;
      }
    }
    setActiveOrder(current => (current === nextActive ? current : nextActive));
    setSpan(current => {
      if (!Number.isFinite(first) || !Number.isFinite(last)) return current;
      const next = { firstOrder: first, lastOrder: last };
      return current?.firstOrder === next.firstOrder && current?.lastOrder === next.lastOrder
        ? current
        : next;
    });
  };

  const scheduleFlush = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(flush);
  };

  const disconnect = () => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingSamples.current = [];
    registry.current.clear();
    setActiveOrder(null);
    setSpan(null);
  };

  // Session switch: drop observers/registry and start clean (no prefetch, no
  // runtime activation — this hook never calls any Host API).
  useEffect(() => {
    if (sessionRef.current === activeSessionId && observerRef.current) return undefined;
    sessionRef.current = activeSessionId;
    disconnect();
    const viewport = viewportRef.current;
    if (!viewport || !model.anchors.length || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(
      entries => {
        const viewport = viewportRef.current;
        const rootTop = viewport?.getBoundingClientRect().top ?? 0;
        for (const entry of entries) {
          const order = Number((entry.target as HTMLElement).dataset.order);
          if (!Number.isFinite(order)) continue;
          if (entry.isIntersecting) {
            pendingSamples.current.push({
              order,
              topInViewport: entry.boundingClientRect.top - rootTop,
            });
          }
        }
        scheduleFlush();
      },
      { root: viewport, threshold: [0, 0.2, 0.6] }
    );
    observerRef.current = observer;
    // Re-collect rendered rows from the DOM. Session switches reuse the same
    // `<li>` nodes (stable keys), so ref callbacks may NOT fire again — the
    // registry has to be rebuilt from what is actually rendered, keeping this
    // independent of React reconciliation.
    registry.current.clear();
    viewport
      .querySelectorAll<HTMLElement>('li[data-order]')
      .forEach(element => {
        const order = Number(element.dataset.order);
        if (Number.isFinite(order)) {
          registry.current.set(order, element);
          observer.observe(element);
        }
      });
    return () => disconnect();
    // Re-binding when the loaded window grows (load-earlier) is intentional;
    // onUserNavigate is read through a ref so it needs no dependency here.
  }, [
    viewportRef,
    activeSessionId,
    model.anchors.length,
    model.anchors[model.anchors.length - 1]?.order,
  ]);

  const registerItem = useCallback((order: number, element: HTMLElement | null) => {
    if (element) {
      if (registry.current.get(order) === element) return;
      registry.current.set(order, element);
      observerRef.current?.observe(element);
      return;
    }
    const previous = registry.current.get(order);
    if (previous) {
      observerRef.current?.unobserve(previous);
      registry.current.delete(order);
    }
  }, []);

  const scrollToOrder = (order: number, behavior: 'smooth' | 'auto' = 'smooth') => {
    const viewport = viewportRef.current;
    const resolved = nearestAnchorOrder(modelRef.current, order);
    const element = resolved !== null ? registry.current.get(resolved) : undefined;
    if (!viewport || !element) {
      // No measured row yet (e.g. observer fallback): fall back to the bucket
      // order arithmetic so the rail still moves the viewport.
      if (!viewport || modelRef.current.anchors.length === 0) return;
      const ratio =
        (order - modelRef.current.minOrder) /
        (modelRef.current.maxOrder - modelRef.current.minOrder || 1);
      viewport.scrollTo({
        top: Math.max(0, Math.min(1, ratio)) * (viewport.scrollHeight - viewport.clientHeight),
        behavior,
      });
      onNavigateRef.current?.();
      return;
    }
    const target =
      element.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop -
      SCROLL_TARGET_PAD_PX;
    viewport.scrollTo({ top: Math.max(0, target), behavior });
    onNavigateRef.current?.();
  };

  return { activeOrder, span, registerItem, scrollToOrder };
}
