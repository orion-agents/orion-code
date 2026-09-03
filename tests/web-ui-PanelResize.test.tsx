/**
 * PanelResizeHandle keyboard contract layer (v0.3.6 P0-B).
 *
 * The separator is keyboard reachable (WCAG 2.1.1) and exposes an adjustable
 * value (WAI-ARIA separator pattern). The width stepping logic is kept pure so
 * it can be verified without a DOM; these tests pin that contract.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  KEYBOARD_STEP_RATIO,
  KEYBOARD_STEP_RATIO_COARSE,
  PanelResizeHandle,
  clampPanelWidth,
  panelWidthPercent,
  resolvePanelResizeKeyWidth,
  type PanelResizeKeyIntent,
} from '../web/src/layout/PanelResizeHandle';

const BASE: PanelResizeKeyIntent = {
  key: 'ArrowRight',
  minWidth: 200,
  maxWidth: 800,
  defaultWidth: 320,
  currentWidth: 400,
  side: 'left',
};

function resolve(intent: Partial<PanelResizeKeyIntent>) {
  return resolvePanelResizeKeyWidth({ ...BASE, ...intent });
}

describe('clampPanelWidth', () => {
  it('clamps inside [min, max] and rounds', () => {
    expect(clampPanelWidth(100, 200, 800)).toBe(200);
    expect(clampPanelWidth(900, 200, 800)).toBe(800);
    expect(clampPanelWidth(400.4, 200, 800)).toBe(400);
  });

  it('falls back to min for non-finite input', () => {
    expect(clampPanelWidth(Number.NaN, 200, 800)).toBe(200);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY, 200, 800)).toBe(200);
  });
});

describe('panelWidthPercent', () => {
  it('maps a width to its 0-100 position inside the range', () => {
    expect(panelWidthPercent(200, 200, 800)).toBe(0);
    expect(panelWidthPercent(800, 200, 800)).toBe(100);
    expect(panelWidthPercent(500, 200, 800)).toBe(50);
  });

  it('is safe for degenerate zero-width ranges', () => {
    expect(panelWidthPercent(300, 300, 300)).toBe(0);
  });
});

describe('resolvePanelResizeKeyWidth', () => {
  it('returns null for unrelated keys so callers skip preventDefault', () => {
    expect(resolve({ key: 'Tab' })).toBeNull();
    expect(resolve({ key: 'a' })).toBeNull();
  });

  it('jumps to min on Home and max on End', () => {
    expect(resolve({ key: 'Home' })).toBe(200);
    expect(resolve({ key: 'End' })).toBe(800);
  });

  it('resets to the default width on Enter and Space', () => {
    expect(resolve({ key: 'Enter' })).toBe(320);
    expect(resolve({ key: ' ' })).toBe(320);
  });

  it('steps by 2% of the range with plain arrows', () => {
    const step = Math.max(1, Math.round(600 * KEYBOARD_STEP_RATIO)); // 12
    expect(resolve({ key: 'ArrowRight' })).toBe(400 + step);
    expect(resolve({ key: 'ArrowLeft' })).toBe(400 - step);
  });

  it('steps by 10% with Shift held', () => {
    const step = Math.max(1, Math.round(600 * KEYBOARD_STEP_RATIO_COARSE)); // 60
    expect(resolve({ key: 'ArrowRight', shiftKey: true })).toBe(400 + step);
    expect(resolve({ key: 'ArrowLeft', shiftKey: true })).toBe(400 - step);
  });

  it('grows the panel away from the handle, mirroring for a right panel', () => {
    // Left panel: ArrowRight widens it (400 + step). Right panel: ArrowLeft widens.
    const left = resolve({ key: 'ArrowRight', side: 'left' })!;
    const right = resolve({ key: 'ArrowLeft', side: 'right' })!;
    expect(left).toBe(400 + Math.round(600 * KEYBOARD_STEP_RATIO));
    expect(right).toBe(left);
  });

  it('never steps outside the configured range', () => {
    expect(resolve({ key: 'ArrowLeft', currentWidth: 205 })).toBe(200);
    expect(resolve({ key: 'ArrowRight', currentWidth: 795 })).toBe(800);
  });
});

describe('PanelResizeHandle separator semantics', () => {
  const sharedProps = {
    side: 'left' as const,
    minWidth: 200,
    maxWidth: 800,
    defaultWidth: 320,
    width: 500,
    controls: 'workspace-rail',
    label: '调整面板宽度',
    onPreview: () => undefined,
    onCommit: () => undefined,
  };

  it('is focusable and exposes separator semantics + aria-valuetext in px', () => {
    const html = renderToStaticMarkup(React.createElement(PanelResizeHandle, sharedProps));
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="50"'); // (500-200)/600 -> 50
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-controls="workspace-rail"');
  });

  it('is announced by its own label, not hidden from the tree', () => {
    const html = renderToStaticMarkup(React.createElement(PanelResizeHandle, sharedProps));
    expect(html).not.toContain('aria-hidden');
    expect(html).toContain('aria-label="调整面板宽度"');
  });
});
