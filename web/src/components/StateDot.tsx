/**
 * Status indicator that never relies on colour alone (WCAG 1.4.1).
 *
 * Two redundant channels carry the state:
 *  1. **Shape** — via `data-tone`, styled in `styles.css`: square (idle), filled circle
 *     (success), pulsing ring (running), hollow ring (warning), triangle (danger).
 *  2. **Text** — a visually hidden label describing the tone, so assistive tech and
 *     colour-blind users get the same information the colour conveys.
 */

export type StateTone = 'idle' | 'running' | 'success' | 'warning' | 'danger';

const TONE_BY_STATE: Readonly<Record<string, StateTone>> = Object.freeze({
  activating: 'running',
  closed: 'danger',
  completed: 'success',
  connected: 'success',
  done: 'success',
  draining: 'warning',
  error: 'danger',
  failed: 'danger',
  live: 'running',
  offline: 'danger',
  passed: 'success',
  pending: 'running',
  queued: 'running',
  ready: 'success',
  rejected: 'danger',
  replay: 'warning',
  'replay-required': 'warning',
  running: 'running',
  skipped: 'warning',
  streaming: 'running',
  success: 'success',
  timedout: 'warning',
  warning: 'warning',
});

const LABEL_BY_TONE: Readonly<Record<StateTone, string>> = Object.freeze({
  danger: '失败',
  idle: '空闲',
  running: '进行中',
  success: '已完成',
  warning: '部分完成',
});

/** Maps a backend/UI status string onto one of the five visual tones. */
export function stateTone(state: string): StateTone {
  return TONE_BY_STATE[state.trim().toLowerCase()] ?? 'idle';
}

/** Human-readable, screen-reader-friendly label for a tone. */
export function stateToneLabel(tone: StateTone): string {
  return LABEL_BY_TONE[tone] ?? LABEL_BY_TONE.idle;
}

export interface StateDotProps {
  /** Raw status string, e.g. `running`, `state-failed`, `completed`. */
  readonly state: string;
  /** Extra classes on the visual dot (e.g. `rail-status-dot`). */
  readonly className?: string;
  /** Overrides the generated screen-reader label. */
  readonly label?: string;
  /**
   * Set to `false` only when adjacent visible text already states the same status
   * (e.g. a "正在分析" caption next to the dot).
   */
  readonly describe?: boolean;
}

export function StateDot({ state, className = '', label, describe = true }: StateDotProps) {
  const tone = stateTone(state);
  return (
    <>
      <span
        className={`state-dot state-${state}${className ? ` ${className}` : ''}`}
        data-tone={tone}
        aria-hidden="true"
      />
      {describe ? <span className="sr-only">{label ?? stateToneLabel(tone)}</span> : null}
    </>
  );
}
