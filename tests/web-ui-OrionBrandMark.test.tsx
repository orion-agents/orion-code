/**
 * v0.3.13 §9 — OrionBrandMark render contract.
 *
 * The mark is one decorative inline SVG: a single 20×20 artboard, three
 * vertical bars, aria-hidden, and no interactive affordances (no link, button,
 * tabindex or event handler). Brand copy stays text next to the mark.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrionBrandMark } from '../web/src/components/OrionBrandMark';

describe('OrionBrandMark (v0.3.13 §9)', () => {
  it('renders exactly one decorative SVG with the 20×20 artboard', () => {
    const html = renderToStaticMarkup(React.createElement(OrionBrandMark, { size: 20 }));
    expect((html.match(/<svg/gu) ?? []).length).toBe(1);
    expect(html).toContain('viewBox="0 0 20 20"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('draws three vertical bars', () => {
    const html = renderToStaticMarkup(React.createElement(OrionBrandMark, {}));
    expect((html.match(/<rect/gu) ?? []).length).toBe(3);
    // Bars carry distinct x positions and rounded corners (the Orion clue).
    expect(html).toContain('x="2"');
    expect(html).toContain('x="8"');
    expect(html).toContain('x="14"');
  });

  it('is not an interactive control of any kind', () => {
    const html = renderToStaticMarkup(React.createElement(OrionBrandMark, {}));
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('onclick');
  });

  it('sizes the wrapper to the requested pixel size and keeps the artboard scale', () => {
    const nav = renderToStaticMarkup(
      React.createElement(OrionBrandMark, { className: 'brand-mark', size: 20 })
    );
    expect(nav).toContain('orion-brand-mark brand-mark');
    expect(nav).toContain('width:20px');
    expect(nav).toContain('height:20px');
    const boot = renderToStaticMarkup(
      React.createElement(OrionBrandMark, { className: 'boot-mark', size: 34 })
    );
    expect(boot).toContain('orion-brand-mark boot-mark');
    expect(boot).toContain('width:34px');
    expect(boot).toContain('viewBox="0 0 20 20"');
  });

  it('keeps gradient stops distinct so the mark can reference theme tokens', () => {
    const html = renderToStaticMarkup(React.createElement(OrionBrandMark, {}));
    expect(html).toContain('orion-mark-stop-primary');
    expect(html).toContain('orion-mark-stop-secondary');
  });
});
