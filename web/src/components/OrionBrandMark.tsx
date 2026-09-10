/**
 * v0.3.13 §9 — the single Orion brand glyph used by the project navigator and
 * the boot screen.
 *
 * Three vertical energy bars on a shared 20×20 artboard, previously three
 * empty `<span>`s whose heights lived in two duplicate CSS rule sets. Keeping
 * the geometry in one inline SVG removes the duplication while preserving the
 * recognizable shape at every theme.
 *
 * The mark is decorative by contract: `aria-hidden`, never a link/button, no
 * tabindex and no click handler. Colour comes from theme tokens with an
 * explicit forced-colors fallback so the glyph cannot disappear if gradients
 * are stripped.
 */
import { Fragment, useId } from 'react';

export interface OrionBrandMarkProps {
  /** Render size in px; the artboard stays 20×20 and scales. */
  readonly size?: number;
  readonly className?: string;
  /**
   * v0.3.15 — pixel-art rendering: square blocks with crisp edges instead of
   * rounded bars, so the glyph matches the blocksmith (pixel) UI style. The
   * geometry is unchanged, so the classic theme keeps the same orion-code mark.
   */
  readonly pixel?: boolean;
}

export function OrionBrandMark({ size = 20, className, pixel = false }: OrionBrandMarkProps) {
  const gradientId = useId();
  const gradientA = `orion-bar-a-${gradientId}`;
  const gradientB = `orion-bar-b-${gradientId}`;
  const gradientC = `orion-bar-c-${gradientId}`;
  return (
    <span
      className={
        className
          ? `orion-brand-mark ${pixel ? 'orion-brand-mark-pixel ' : ''}${className}`
          : `orion-brand-mark${pixel ? ' orion-brand-mark-pixel' : ''}`
      }
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 20 20"
        width={size}
        height={size}
        focusable="false"
        role="presentation"
        shapeRendering={pixel ? 'crispEdges' : undefined}
      >
        <defs>
          <linearGradient id={gradientA} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="orion-mark-stop orion-mark-stop-primary" />
            <stop offset="1" className="orion-mark-stop orion-mark-stop-secondary" />
          </linearGradient>
          <linearGradient id={gradientB} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="orion-mark-stop orion-mark-stop-primary" />
            <stop offset="1" className="orion-mark-stop orion-mark-stop-secondary" />
          </linearGradient>
          <linearGradient id={gradientC} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="orion-mark-stop orion-mark-stop-primary" />
            <stop offset="1" className="orion-mark-stop orion-mark-stop-secondary" />
          </linearGradient>
        </defs>
        {pixel
          ? (
              // v0.3.15 — pixel-art rendering: solid two-tone bars with a 1px
              // base shadow for the classic pixel 3D look, no gradient.
              [
                { x: 2, y: 9, h: 9 },
                { x: 8, y: 4, h: 14 },
                { x: 14, y: 7, h: 11 },
              ].map(bar => (
                <Fragment key={bar.x}>
                  <rect
                    x={bar.x}
                    y={bar.y}
                    width="4"
                    height={Math.max(1, bar.h - 1)}
                    rx={0}
                    style={{ fill: 'var(--accent)' }}
                  />
                  {bar.h > 1 ? (
                    <rect
                      x={bar.x}
                      y={bar.y + bar.h - 1}
                      width="4"
                      height="1"
                      rx={0}
                      style={{ fill: 'var(--accent-2)' }}
                    />
                  ) : null}
                </Fragment>
              ))
            )
          : (
              <>
                <rect
                  className="orion-mark-bar"
                  x="2"
                  y="9"
                  width="4"
                  height="9"
                  rx={2}
                  fill={`url(#${gradientA})`}
                />
                <rect
                  className="orion-mark-bar"
                  x="8"
                  y="4"
                  width="4"
                  height="14"
                  rx={2}
                  fill={`url(#${gradientB})`}
                />
                <rect
                  className="orion-mark-bar"
                  x="14"
                  y="7"
                  width="4"
                  height="11"
                  rx={2}
                  fill={`url(#${gradientC})`}
                />
              </>
            )}
      </svg>
    </span>
  );
}
