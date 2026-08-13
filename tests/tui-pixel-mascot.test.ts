import { pixelHunterBadge, pixelHunterSprite } from '../src/tui-ui/pixel-mascot';

describe('Orion Pixel star hunter', () => {
  it('provides a stable pose for every runtime state', () => {
    const poses = ['ready', 'thinking', 'tool', 'waiting', 'success', 'error', 'paused'] as const;
    for (const pose of poses) {
      expect(pixelHunterBadge(pose)).not.toBe('');
      expect(pixelHunterSprite(pose)).toHaveLength(4);
    }
  });

  it('uses a bounded two-frame animation only for active poses', () => {
    expect(pixelHunterBadge('thinking', 0)).not.toBe(pixelHunterBadge('thinking', 1));
    expect(pixelHunterBadge('tool', 0)).not.toBe(pixelHunterBadge('tool', 1));
    expect(pixelHunterBadge('ready', 0)).toBe(pixelHunterBadge('ready', 1));
  });
});
