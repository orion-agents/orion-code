/** Orion Pixel's original "star hunter" state language. */
export type PixelHunterPose =
  | 'ready'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'success'
  | 'error'
  | 'paused';

const COMPACT_POSES: Record<PixelHunterPose, string> = {
  ready: '◇',
  thinking: '◆',
  tool: '⚒',
  waiting: '◈',
  success: '✦',
  error: '×',
  paused: 'Ⅱ',
};

const FULL_POSES: Record<PixelHunterPose, readonly string[]> = {
  ready: ['  ✦  ', ' ▄█▄ ', '▐▣ ▣▌', ' ╱ ╲ '],
  thinking: [' ·✦· ', ' ▄█▄ ', '▐◉ ◉▌', ' ╱ ╲ '],
  tool: ['  ⚒  ', ' ▄█▄ ', '▐▣ ▣▌', ' ╱ ╲ '],
  waiting: ['  ◇  ', ' ▄█▄ ', '▐─ ─▌', ' ╱ ╲ '],
  success: [' ✦✦✦ ', ' ▄█▄ ', '▐^ ^▌', ' ╱ ╲ '],
  error: ['  ×  ', ' ▄█▄ ', '▐! !▌', ' ╱ ╲ '],
  paused: [' Ⅱ  ', ' ▄█▄ ', '▐─ ─▌', ' ╱ ╲ '],
};

export function pixelHunterBadge(pose: PixelHunterPose, frame = 0): string {
  if (frame % 2 === 1 && pose === 'thinking') return '◇';
  if (frame % 2 === 1 && pose === 'tool') return '⚙';
  return COMPACT_POSES[pose];
}

export function pixelHunterSprite(pose: PixelHunterPose): readonly string[] {
  return FULL_POSES[pose];
}
