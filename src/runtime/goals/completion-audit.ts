/**
 * v0.2.24 — Goal Completion & Blocked Audit.
 *
 * Two-phase terminal-state audit. Model requests complete/blocked via
 * update_goal tool; Coordinator runs audit after turn persistence.
 */

import type { GoalCompletionAudit, GoalBlocker } from './types';

export interface CompletionAuditInput {
  objective: string;
  evidenceRefs: string[];
  verificationSummary: string;
}

export function auditCompletion(input: CompletionAuditInput): GoalCompletionAudit {
  const now = Date.now();
  const passed = input.evidenceRefs.length > 0 && input.verificationSummary.length > 0;
  return {
    requestedAt: now,
    auditedAt: now,
    passed,
    verificationSummary: input.verificationSummary || 'No verification evidence provided.',
    remainingRequirements: passed ? [] : ['Verification evidence required before completion.'],
    evidenceRefs: input.evidenceRefs,
  };
}

export interface BlockedAuditInput {
  blocker: GoalBlocker;
  noProgressCount: number;
}

export function auditBlocked(input: BlockedAuditInput): {
  allowed: boolean;
  reason: string;
} {
  if (input.blocker.consecutiveTurns < 3) {
    return {
      allowed: false,
      reason: `Blocker seen ${input.blocker.consecutiveTurns}/3 required turns.`,
    };
  }
  if (input.noProgressCount < 3) {
    return {
      allowed: false,
      reason: 'Progress was made in recent turns; blocking not justified.',
    };
  }
  return { allowed: true, reason: `Blocker persisted for ${input.blocker.consecutiveTurns} consecutive turns with no progress.` };
}

export function blockerFingerprint(category: string, resource: string, reason: string): string {
  return `${category}:${resource}:${reason}`;
}

export function blockersMatch(a: GoalBlocker | undefined, fingerprint: string): boolean {
  if (!a) return false;
  return a.fingerprint === fingerprint;
}