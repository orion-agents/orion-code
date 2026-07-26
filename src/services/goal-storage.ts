/**
 * v0.2.24 — Goal Storage.
 *
 * Atomic sidecar persistence for Session goals. Uses compare-and-swap
 * revision, temporary file + atomic rename, and corrupt quarantine.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getProjectSessionsDir } from '../services/config-dir';
import type { SessionGoalV1, GoalStatus } from '../runtime/goals/types';

// ============================================================================
// Sidecar path
// ============================================================================

function goalSidecarPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.goal.json`);
}

// ============================================================================
// Core operations
// ============================================================================

export type GoalStorageResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: 'not_found' | 'revision_stale' | 'corrupt' | 'io_error'; message: string };

export function loadGoal(projectPath: string, sessionId: string): GoalStorageResult<SessionGoalV1> {
  const path = goalSidecarPath(projectPath, sessionId);
  if (!existsSync(path)) {
    return { ok: false, error: 'not_found', message: `No goal sidecar at ${path}` };
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionGoalV1>;

    if (parsed.version !== 1 || typeof parsed.goalId !== 'string' || !parsed.goalId) {
      quarantineSidecar(path, 'invalid schema or missing goalId');
      return { ok: false, error: 'corrupt', message: 'Goal sidecar has invalid schema' };
    }
    if (parsed.sessionId !== sessionId) {
      quarantineSidecar(path, `sessionId mismatch: expected ${sessionId}, got ${parsed.sessionId}`);
      return { ok: false, error: 'corrupt', message: 'Goal sidecar sessionId mismatch' };
    }
    if (typeof parsed.objective !== 'string' || !parsed.objective.trim()) {
      quarantineSidecar(path, 'missing or empty objective');
      return { ok: false, error: 'corrupt', message: 'Goal sidecar has empty objective' };
    }

    return { ok: true, value: parsed as SessionGoalV1 };
  } catch (err) {
    quarantineSidecar(path, err instanceof Error ? err.message : String(err));
    return { ok: false, error: 'corrupt', message: 'Failed to parse goal sidecar' };
  }
}

export function saveGoal(
  projectPath: string,
  sessionId: string,
  goal: SessionGoalV1,
  expectedRevision?: number,
): GoalStorageResult {
  const path = goalSidecarPath(projectPath, sessionId);
  const dir = getProjectSessionsDir(projectPath);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* dir exists */ }

  // CAS: if expectedRevision is provided, validate before writing.
  if (expectedRevision !== undefined) {
    const existing = loadGoal(projectPath, sessionId);
    if (existing.ok) {
      if (existing.value.revision !== expectedRevision) {
        return { ok: false, error: 'revision_stale', message: `Expected revision ${expectedRevision}, got ${existing.value.revision}` };
      }
    } else if (existing.error !== 'not_found' && expectedRevision !== 0) {
      return { ok: false, error: 'revision_stale', message: 'Goal exists but is corrupt' };
    }
  }

  const tmpPath = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(goal, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, path);
    return { ok: true, value: undefined };
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    return { ok: false, error: 'io_error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function deleteGoal(projectPath: string, sessionId: string): GoalStorageResult {
  const path = goalSidecarPath(projectPath, sessionId);
  if (!existsSync(path)) return { ok: true, value: undefined };

  try {
    unlinkSync(path);
    // Also clean up any stale temp files.
    try {
      const dir = getProjectSessionsDir(projectPath);
      // Using require here would create a circular dependency, so we use a
      // simple readdirSync pattern that matches the tmp- prefix.
      const { readdirSync } = require('fs');
      for (const file of readdirSync(dir)) {
        if (file.startsWith(`${sessionId}.goal.json.tmp-`)) {
          try { unlinkSync(join(dir, file)); } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: 'io_error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function createGoal(projectPath: string, sessionId: string, objective: string): GoalStorageResult<SessionGoalV1> {
  const now = Date.now();
  const goal: SessionGoalV1 = {
    version: 1,
    goalId: randomUUID(),
    sessionId,
    revision: 0,
    objective: objective.trim(),
    status: 'active',
    tokensUsed: 0,
    timeUsedMs: 0,
    createdAt: now,
    updatedAt: now,
    activeSince: now,
    continuationCount: 0,
    noProgressCount: 0,
  };

  const result = saveGoal(projectPath, sessionId, goal);
  if (!result.ok) return result;
  return { ok: true, value: goal };
}

// ============================================================================
// Helpers
// ============================================================================

function quarantineSidecar(path: string, reason: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = `${path}.corrupt-${timestamp}`;
  try {
    renameSync(path, quarantinePath);
    console.warn(`[goal-storage] Quarantined corrupt goal sidecar: ${path} (${reason})`);
  } catch {
    console.warn(`[goal-storage] Failed to quarantine corrupt goal sidecar: ${path} (${reason})`);
  }
}

// ============================================================================
// Sidecar suffix for storage-maintenance
// ============================================================================

export const GOAL_SIDECAR_SUFFIX = '.goal.json';
export const GOAL_TMP_PREFIX = '.goal.json.tmp-';