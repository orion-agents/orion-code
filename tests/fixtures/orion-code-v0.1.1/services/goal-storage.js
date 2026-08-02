"use strict";
/**
 * v0.2.24 — Goal Storage.
 *
 * Atomic sidecar persistence for Session goals. Uses compare-and-swap
 * revision, temporary file + atomic rename, and corrupt quarantine.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GOAL_TMP_PREFIX = exports.GOAL_SIDECAR_SUFFIX = void 0;
exports.loadGoal = loadGoal;
exports.saveGoal = saveGoal;
exports.deleteGoal = deleteGoal;
exports.createGoal = createGoal;
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
const config_dir_1 = require("../services/config-dir");
// ============================================================================
// Sidecar path
// ============================================================================
function goalSidecarPath(projectPath, sessionId) {
    return (0, path_1.join)((0, config_dir_1.getProjectSessionsDir)(projectPath), `${sessionId}.goal.json`);
}
function loadGoal(projectPath, sessionId) {
    const path = goalSidecarPath(projectPath, sessionId);
    if (!(0, fs_1.existsSync)(path)) {
        return { ok: false, error: 'not_found', message: `No goal sidecar at ${path}` };
    }
    try {
        const raw = (0, fs_1.readFileSync)(path, 'utf8');
        const parsed = JSON.parse(raw);
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
        return { ok: true, value: parsed };
    }
    catch (err) {
        quarantineSidecar(path, err instanceof Error ? err.message : String(err));
        return { ok: false, error: 'corrupt', message: 'Failed to parse goal sidecar' };
    }
}
function saveGoal(projectPath, sessionId, goal, expectedRevision) {
    const path = goalSidecarPath(projectPath, sessionId);
    const dir = (0, config_dir_1.getProjectSessionsDir)(projectPath);
    try {
        (0, fs_1.mkdirSync)(dir, { recursive: true, mode: 0o700 });
    }
    catch { /* dir exists */ }
    // CAS: if expectedRevision is provided, validate before writing.
    if (expectedRevision !== undefined) {
        const existing = loadGoal(projectPath, sessionId);
        if (existing.ok) {
            if (existing.value.revision !== expectedRevision) {
                return { ok: false, error: 'revision_stale', message: `Expected revision ${expectedRevision}, got ${existing.value.revision}` };
            }
        }
        else if (existing.error !== 'not_found' && expectedRevision !== 0) {
            return { ok: false, error: 'revision_stale', message: 'Goal exists but is corrupt' };
        }
    }
    const tmpPath = `${path}.tmp-${(0, crypto_1.randomUUID)().slice(0, 8)}`;
    try {
        (0, fs_1.writeFileSync)(tmpPath, JSON.stringify(goal, null, 2), { encoding: 'utf8', mode: 0o600 });
        (0, fs_1.renameSync)(tmpPath, path);
        return { ok: true, value: undefined };
    }
    catch (err) {
        try {
            (0, fs_1.unlinkSync)(tmpPath);
        }
        catch { /* best effort */ }
        return { ok: false, error: 'io_error', message: err instanceof Error ? err.message : String(err) };
    }
}
function deleteGoal(projectPath, sessionId) {
    const path = goalSidecarPath(projectPath, sessionId);
    if (!(0, fs_1.existsSync)(path))
        return { ok: true, value: undefined };
    try {
        (0, fs_1.unlinkSync)(path);
        // Also clean up any stale temp files.
        try {
            const dir = (0, config_dir_1.getProjectSessionsDir)(projectPath);
            // Using require here would create a circular dependency, so we use a
            // simple readdirSync pattern that matches the tmp- prefix.
            const { readdirSync } = require('fs');
            for (const file of readdirSync(dir)) {
                if (file.startsWith(`${sessionId}.goal.json.tmp-`)) {
                    try {
                        (0, fs_1.unlinkSync)((0, path_1.join)(dir, file));
                    }
                    catch { /* ok */ }
                }
            }
        }
        catch { /* ok */ }
        return { ok: true, value: undefined };
    }
    catch (err) {
        return { ok: false, error: 'io_error', message: err instanceof Error ? err.message : String(err) };
    }
}
function createGoal(projectPath, sessionId, objective) {
    const now = Date.now();
    const goal = {
        version: 1,
        goalId: (0, crypto_1.randomUUID)(),
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
    if (!result.ok)
        return result;
    return { ok: true, value: goal };
}
// ============================================================================
// Helpers
// ============================================================================
function quarantineSidecar(path, reason) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = `${path}.corrupt-${timestamp}`;
    try {
        (0, fs_1.renameSync)(path, quarantinePath);
        console.warn(`[goal-storage] Quarantined corrupt goal sidecar: ${path} (${reason})`);
    }
    catch {
        console.warn(`[goal-storage] Failed to quarantine corrupt goal sidecar: ${path} (${reason})`);
    }
}
// ============================================================================
// Sidecar suffix for storage-maintenance
// ============================================================================
exports.GOAL_SIDECAR_SUFFIX = '.goal.json';
exports.GOAL_TMP_PREFIX = '.goal.json.tmp-';
//# sourceMappingURL=goal-storage.js.map
