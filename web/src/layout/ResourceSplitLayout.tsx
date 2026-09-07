/**
 * v0.3.13 S2/S3 — reusable content | splitter | navigator shell for the
 * Files / Git / Review resource panels.
 *
 * The three panels all render one wide readable surface (file preview, Git or
 * review diff) and one narrower navigator (tree, change list, review files).
 * This shell owns the shared drag/keyboard behaviour and the per-workspace +
 * per-panel navigator width persistence:
 *
 * - Children are written `navigator` first, `content` second (the panels'
 *   historical DOM order); the shell RENDERS `content → splitter → navigator`
 *   so visual, reading and keyboard order all lead with the content without
 *   relying on a CSS-only column swap.
 * - The separator measures pointer x against THIS root (boundsRef), not the
 *   `.workbench-shell`, so dragging an inner splitter can never move the outer
 *   Right Workspace or the central conversation.
 * - During a drag only a live width is previewed (CSS variable); the value is
 *   persisted on pointer-up via `onNavigatorWidthCommit`.
 * - A ResizeObserver tracks the root width so the dynamic ceiling
 *   (min(420, 48%, width-280)) stays honest while the window changes.
 *
 * The shell deliberately owns no data lifecycle state: file/diff requests,
 * selection and refresh stay in the panel that renders into the children.
 */
import { Children, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import {
  RESOURCE_NAVIGATOR_DEFAULT_WIDTH,
  RESOURCE_NAVIGATOR_MIN_WIDTH,
  clampResourceNavigatorWidth,
  resolveResourceNavigatorMaxWidth,
  type ResourceSplitPanelId,
} from '../state/right-workspace-preferences';
import { PanelResizeHandle } from './PanelResizeHandle';

export interface ResourceSplitLayoutProps {
  readonly panelId: ResourceSplitPanelId;
  /** Persisted navigator width for this workspace + panel (rendered, re-clamped). */
  readonly navigatorWidthPx: number;
  /** Pointer-up / keyboard commit. Persists one panel of the current workspace. */
  readonly onNavigatorWidthCommit: (width: number) => void;
  readonly contentLabel: string;
  readonly navigatorLabel: string;
  /** Separator label, e.g. "调整文件目录宽度". */
  readonly handleLabel: string;
  /** Extra classes carried onto the region wrappers (e.g. `file-preview`). */
  readonly contentClassName?: string;
  readonly navigatorClassName?: string;
  /** Child 0 = navigator, child 1 = content (panel source order). */
  readonly children: readonly [ReactNode, ReactNode];
}

export function ResourceSplitLayout({
  panelId,
  navigatorWidthPx,
  onNavigatorWidthCommit,
  contentLabel,
  navigatorLabel,
  handleLabel,
  contentClassName = '',
  navigatorClassName = '',
  children,
}: ResourceSplitLayoutProps) {
  const [navigatorNode, contentNode] = Children.toArray(children) as [ReactNode, ReactNode];
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootWidth, setRootWidth] = useState(0);
  /** Live drag preview; null means "render the persisted preference". */
  const [liveWidth, setLiveWidth] = useState<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setRootWidth(width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const dynamicMax = resolveResourceNavigatorMaxWidth(rootWidth);
  const rendered = Math.min(clampResourceNavigatorWidth(liveWidth ?? navigatorWidthPx), dynamicMax);

  const commit = (width: number) => {
    setLiveWidth(null);
    onNavigatorWidthCommit(Math.min(width, dynamicMax));
  };

  const contentId = `${panelId}-split-content`;
  const navigatorId = `${panelId}-split-navigator`;

  return (
    <div
      ref={rootRef}
      className="resource-split-layout"
      style={{ '--resource-navigator-width': `${rendered}px` } as CSSProperties}
    >
      <section
        id={contentId}
        className={`resource-split-content${contentClassName ? ` ${contentClassName}` : ''}`}
        aria-label={contentLabel}
      >
        {contentNode}
      </section>
      <PanelResizeHandle
        side="right"
        className="resource-split-handle"
        minWidth={RESOURCE_NAVIGATOR_MIN_WIDTH}
        maxWidth={Math.max(RESOURCE_NAVIGATOR_MIN_WIDTH, dynamicMax)}
        defaultWidth={RESOURCE_NAVIGATOR_DEFAULT_WIDTH}
        label={handleLabel}
        width={rendered}
        controls={navigatorId}
        boundsRef={rootRef}
        resizingScope="resource-split"
        onPreview={setLiveWidth}
        onCommit={commit}
      />
      <section
        id={navigatorId}
        className={`resource-split-navigator${navigatorClassName ? ` ${navigatorClassName}` : ''}`}
        aria-label={navigatorLabel}
      >
        {navigatorNode}
      </section>
    </div>
  );
}
