import { readFileSync } from 'fs';
import { join } from 'path';

import { themeColorForAppearance } from '../web/src/themes/theme-color';

describe('Web appearance theme color', () => {
  test.each([
    ['orion-blocksmith', 'dark', true, '#15191b'],
    ['orion-blocksmith', 'light', false, '#d7d0c1'],
    ['orion-blocksmith', 'system', true, '#d7d0c1'],
    ['orion-blocksmith', 'system', false, '#15191b'],
    ['classic', 'dark', true, '#090b10'],
    ['classic', 'light', false, '#f4f5f8'],
    ['classic', 'system', true, '#f4f5f8'],
    ['classic', 'system', false, '#090b10'],
  ] as const)('%s + %s resolves browser chrome color', (style, theme, prefersLight, expected) => {
    expect(themeColorForAppearance(style, theme, prefersLight)).toBe(expected);
  });

  test.each([
    ":root[data-ui-style='orion-blocksmith'][data-theme='light']",
    ":root[data-ui-style='orion-blocksmith'][data-theme='system']",
  ])('%s keeps small muted text above WCAG AA contrast', selector => {
    const css = readFileSync(
      join(__dirname, '..', 'web', 'src', 'themes', 'orion-blocksmith.tokens.css'),
      'utf8'
    );
    const block = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)) + 1);
    const muted = cssHexToken(block, '--muted');
    for (const background of ['--bg', '--surface', '--surface-2', '--surface-3']) {
      expect(contrastRatio(muted, cssHexToken(block, background))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function cssHexToken(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'iu'));
  if (!match) throw new Error(`Missing ${name} token.`);
  return match[1];
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: string): number {
  const channels = color
    .slice(1)
    .match(/.{2}/gu)!
    .map(channel => Number.parseInt(channel, 16) / 255)
    .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
