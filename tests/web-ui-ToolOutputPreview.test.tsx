/**
 * v0.3.13 S4 — ToolOutputPreview render contract (SSR markup).
 *
 * Short / envelope-unwrapped output renders directly with real newlines inside
 * a pre; long success output folds behind a details with a copy affordance.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolOutputPreview } from '../web/src/components/ToolOutputPreview';

const DOUBLE_ENCODED = JSON.stringify({
  success: true,
  output: 'async function probe() {\n  return Math.PI;\n}',
});

describe('ToolOutputPreview (v0.3.13 S4)', () => {
  it('renders nothing for empty input', () => {
    expect(renderToStaticMarkup(React.createElement(ToolOutputPreview, { text: null }))).toBe('');
  });

  it('unwraps the envelope and renders REAL newlines (not literal \\n)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolOutputPreview, { text: DOUBLE_ENCODED })
    );
    expect(html).not.toContain('\\n');
    // The markup contains the actual newline-joined body (pre line joins).
    expect(html).toContain('return Math.PI;');
    // Short output is not folded.
    expect(html).not.toContain('tool-output-fold');
    expect(html).toContain('tool-output-text');
  });

  it('folds long success output behind details with a copy control', () => {
    const longText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const html = renderToStaticMarkup(React.createElement(ToolOutputPreview, { text: longText }));
    expect(html).toContain('tool-output-fold');
    expect(html).toContain('60 行');
    expect(html).toContain('复制原始响应');
  });

  it('renders short plain text directly without folding', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolOutputPreview, { text: 'just fine' })
    );
    expect(html).not.toContain('tool-output-fold');
    expect(html).toContain('just fine');
  });
});
