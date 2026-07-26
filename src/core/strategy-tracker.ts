/**
 * orion code - Strategy Tracker
 *
 * Tracks attempted strategies during agent loop to support
 * alternative approaches when failures occur.
 */

// ============================================================================
// Types
// ============================================================================

/** Result of a strategy attempt */
export type StrategyResult = 'success' | 'failed' | 'timeout' | 'pending';

/** Single strategy attempt */
export interface StrategyAttempt {
  /** Unique ID */
  id: string;
  /** Approach description (e.g., tool name or method) */
  approach: string;
  /** Tools used in this attempt */
  toolsUsed: string[];
  /** Result status */
  result: StrategyResult;
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  duration: number;
  /** Timestamp */
  timestamp: number;
}

/** Strategy tracker configuration */
export interface StrategyTrackerConfig {
  /** Maximum attempts before suggesting alternatives */
  maxAttempts: number;
  /** Callback when alternatives should be suggested */
  onExhausted?: (attempts: StrategyAttempt[]) => void;
}

// ============================================================================
// Strategy Tracker
// ============================================================================

export class StrategyTracker {
  private attempts: StrategyAttempt[] = [];
  private config: StrategyTrackerConfig;
  private currentApproach: string | null = null;

  constructor(config: StrategyTrackerConfig) {
    this.config = config;
  }

  /** Start tracking a new approach */
  startApproach(approach: string): string {
    const id = `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.currentApproach = approach;

    this.attempts.push({
      id,
      approach,
      toolsUsed: [],
      result: 'pending',
      duration: 0,
      timestamp: Date.now(),
    });

    return id;
  }

  /** Add tool to current attempt */
  addTool(attemptId: string, toolName: string): void {
    const attempt = this.attempts.find(a => a.id === attemptId);
    if (attempt) {
      attempt.toolsUsed.push(toolName);
    }
  }

  /** Record result of an attempt */
  recordResult(attemptId: string, result: StrategyResult, error?: string, duration?: number): void {
    const attempt = this.attempts.find(a => a.id === attemptId);
    if (attempt) {
      attempt.result = result;
      attempt.error = error;
      attempt.duration = duration ?? Date.now() - attempt.timestamp;
    }

    // Check if exhausted
    if (this.isExhausted()) {
      this.config.onExhausted?.(this.attempts);
    }
  }

  /** Get all attempts */
  getAttempts(): StrategyAttempt[] {
    return [...this.attempts];
  }

  /** Get failed attempts */
  getFailedAttempts(): StrategyAttempt[] {
    return this.attempts.filter(a => a.result === 'failed');
  }

  /** Get successful attempts */
  getSuccessfulAttempts(): StrategyAttempt[] {
    return this.attempts.filter(a => a.result === 'success');
  }

  /** Check if max attempts reached */
  isExhausted(): boolean {
    const failedCount = this.getFailedAttempts().length;
    return failedCount >= this.config.maxAttempts;
  }

  /** Generate alternative suggestion */
  suggestAlternative(): string | null {
    if (!this.isExhausted()) return null;

    const failed = this.getFailedAttempts();
    if (failed.length === 0) return null;

    // Analyze what approaches failed
    const failedTools = new Set<string>();
    for (const attempt of failed) {
      for (const tool of attempt.toolsUsed) {
        failedTools.add(tool);
      }
    }

    // Suggest avoiding failed tools
    if (failedTools.size > 0) {
      return `Previous attempts using ${Array.from(failedTools).join(', ')} failed. Consider alternative approaches.`;
    }

    return `Multiple approaches have failed. Consider simplifying the task or breaking it into smaller steps.`;
  }

  /** Get summary of attempts */
  getSummary(): string {
    const lines: string[] = [];

    const successful = this.getSuccessfulAttempts();
    const failed = this.getFailedAttempts();
    const pending = this.attempts.filter(a => a.result === 'pending');

    lines.push(`Strategy Summary: ${successful.length} success, ${failed.length} failed, ${pending.length} pending`);

    if (failed.length > 0) {
      lines.push('');
      lines.push('Failed attempts:');
      for (const f of failed) {
        lines.push(`  - ${f.approach}: ${f.error || 'unknown error'}`);
      }
    }

    return lines.join('\n');
  }

  /** Clear all attempts (start fresh) */
  reset(): void {
    this.attempts = [];
    this.currentApproach = null;
  }
}

// ============================================================================
// Factory
// ============================================================================

/** Create a default strategy tracker */
export function createStrategyTracker(config?: Partial<StrategyTrackerConfig>): StrategyTracker {
  return new StrategyTracker({
    maxAttempts: config?.maxAttempts ?? 3,
    onExhausted: config?.onExhausted,
  });
}