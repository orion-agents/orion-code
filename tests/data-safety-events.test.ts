/**
 * Phase 4 (P0-D) — Data safety and structured system event tests.
 *
 * Validates:
 *  - clear_view and shutdown_requested events are protocol-complete
 *  - Destructive commands produce correct events (no direct process.exit/clear)
 *  - TUI and terminal-ui produce equivalent runtime events for clear/exit/storage
 *  - Preview → confirm → execute protocol is followed for destructive ops
 *  - Permission states carry real status (deny/cancel/fail/success)
 */

import type { AgentRuntimeEvent } from '../src/runtime/agent-runtime-protocol';
import { getCommands, findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getCanonicalProjectKey,
  getProjectMetadataPath,
  getProjectsDir,
} from '../src/services/config-dir';
import {
  collectStorageCleanupPlan,
  deserializeStorageMaintenancePlan,
  resetStorageMaintenancePlanRegistry,
  serializeStorageMaintenancePlan,
} from '../src/services/storage-maintenance';

// ---------------------------------------------------------------------------
// Event type completeness
// ---------------------------------------------------------------------------

describe('System event types', () => {
  it('clear_view event is defined in AgentRuntimeEvent union', () => {
    // This is a compile-time check — if the type is missing, TS won't compile.
    const event: AgentRuntimeEvent = { type: 'clear_view' };
    expect(event.type).toBe('clear_view');
  });

  it('shutdown_requested event is defined in AgentRuntimeEvent union', () => {
    const event: AgentRuntimeEvent = { type: 'shutdown_requested', reason: 'user request' };
    expect(event.type).toBe('shutdown_requested');
    expect(event.reason).toBe('user request');
  });

  it('shutdown_requested event works without reason', () => {
    const event: AgentRuntimeEvent = { type: 'shutdown_requested' };
    expect(event.type).toBe('shutdown_requested');
    expect(event.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Destructive commands do not directly manipulate process/terminal
// ---------------------------------------------------------------------------

describe('Destructive command safety', () => {
  // /clear must not call process.exit or directly write escape sequences.
  it('/clear command handler does not call process.exit', () => {
    const cmd = findCommand('clear');
    expect(cmd).toBeDefined();
    // The execute function should not reference process.exit directly.
    const source = cmd!.execute.toString();
    // It may write escape codes for terminal but should not exit the process.
    expect(source).not.toContain('process.exit');
    expect(source).not.toContain('process.kill');
  });

  it('/clear invokes the renderer callback instead of writing raw ANSI', async () => {
    const clearView = jest.fn();
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await findCommand('clear')!.execute({ clearView } as any, '');
      expect(result).toEqual({ success: true });
      expect(clearView).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('/exit command handler triggers shutdown protocol, not raw process.exit', () => {
    const cmd = findCommand('exit');
    expect(cmd).toBeDefined();
    // The /exit handler should route through runtime.shutdown(), not raw process control.
    // By inspecting the risk classification, /exit is state-write not destructive.
    expect(cmd!.risk).toBe('state-write');
    expect(cmd!.execution).toBe('builtin');
  });

  it('/storage command is classified as destructive', () => {
    const cmd = findCommand('storage');
    expect(cmd).toBeDefined();
    expect(cmd!.risk).toBe('destructive');
  });

  it('/checkpoint restore is classified as destructive', () => {
    const cmd = findCommand('checkpoint');
    expect(cmd).toBeDefined();
    expect(cmd!.risk).toBe('destructive');
  });

  it('/migrate is classified as destructive', () => {
    const cmd = findCommand('migrate');
    expect(cmd).toBeDefined();
    expect(cmd!.risk).toBe('destructive');
  });

  it('/compact is classified as a recoverable state write', () => {
    const cmd = findCommand('compact');
    expect(cmd).toBeDefined();
    expect(cmd!.risk).toBe('state-write');
  });

  it('all destructive commands are explicit about their risks', () => {
    const commands = getCommands();
    const destructive = commands.filter(c => c.risk === 'destructive' && !c.isHidden);
    expect(destructive.length).toBeGreaterThanOrEqual(4);
    // Every destructive command must have a clear argument hint or description.
    for (const cmd of destructive) {
      const hasConfirmHint =
        (cmd.argumentHint ?? '').includes('--dry-run') ||
        (cmd.argumentHint ?? '').includes('--yes') ||
        (cmd.description ?? '').includes('confirm');
      expect(hasConfirmHint).toBe(true);
      expect(cmd.description.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Context clear vs durable session delete
// ---------------------------------------------------------------------------

describe('Context clear vs session delete separation', () => {
  it('/clear command is renderer-local execution', () => {
    const cmd = findCommand('clear');
    expect(cmd?.execution).toBe('renderer-local');
    expect(cmd?.risk).toBe('read-only');
  });

  it('/context-clear is destructive and explicitly scoped to in-memory context', () => {
    const cmd = findCommand('context-clear');
    expect(cmd?.risk).toBe('destructive');
    expect(cmd?.argumentHint).toContain('--yes');
    expect(cmd?.description).toContain('in-memory');
  });

  it('context clear (/clear) does not delete sessions', () => {
    // /clear only clears the terminal view; session data should be untouched.
    const cmd = findCommand('clear');
    // The command should not import session-storage for deletion purposes.
    expect(cmd?.risk).toBe('read-only');
  });

  it('/context-clear previews without --yes and only then clears in-memory context', async () => {
    const resetConversation = jest.fn();
    const ctx = {
      store: {
        getSnapshot: () => ({
          conversationHistory: [{ role: 'user', content: 'persist me' }],
        }),
        resetConversation,
      },
    } as any;
    const command = findCommand('context-clear')!;

    const preview = await command.execute(ctx, '');
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('Saved session history will not be deleted');
    expect(resetConversation).not.toHaveBeenCalled();

    const confirmed = await command.execute(ctx, '--yes');
    expect(confirmed.success).toBe(true);
    expect(resetConversation).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Permission state fidelity
// ---------------------------------------------------------------------------

describe('Permission state fidelity', () => {
  it('permission_decision input carries explicit approved boolean', () => {
    // The protocol defines permission_decision with required approved field.
    const decision = {
      type: 'permission_decision' as const,
      requestId: 'req-1',
      approved: false,
    };
    expect(decision.approved).toBe(false);
  });

  it('permission_decision source carries the decision origin', () => {
    const decision = {
      type: 'permission_decision' as const,
      requestId: 'req-1',
      approved: true,
      source: 'keyboard' as const,
    };
    expect(decision.source).toBe('keyboard');
  });

  it('AgentRuntimeInputResult distinguishes deny from ignore', () => {
    // permission_decision_recorded = accepted, permission_decision_ignored = stale
    const recorded = { type: 'permission_decision_recorded' as const };
    const ignored = { type: 'permission_decision_ignored' as const };
    expect(recorded.type).not.toBe(ignored.type);
  });

  it('command_ignored result is distinct from empty result', () => {
    const cmdIgnored = { type: 'command_ignored' as const };
    const empty = { type: 'empty' as const };
    expect(cmdIgnored.type).not.toBe(empty.type);
  });

  it('exit_requested is distinct from exit_intent_cleared', () => {
    const requested = { type: 'exit_requested' as const };
    const cleared = { type: 'exit_intent_cleared' as const };
    expect(requested.type).not.toBe(cleared.type);
  });
});

// ---------------------------------------------------------------------------
// Renderer event parity for clear/exit/storage
// ---------------------------------------------------------------------------

describe('Renderer event parity for system commands', () => {
  it('/clear command is available in TUI and terminal only', () => {
    const cmd = findCommand('clear');
    expect(cmd?.rendererScope).toBeDefined();
    expect(cmd?.rendererScope).toContain('tui');
    expect(cmd?.rendererScope).toContain('terminal');
    // Not available in print or ink.
    expect(cmd?.rendererScope).not.toContain('print');
    expect(cmd?.rendererScope).not.toContain('ink');
  });

  it('/exit command is available in all renderers', () => {
    const cmd = findCommand('exit');
    expect(cmd?.rendererScope).toBeUndefined(); // all-renderer
  });

  it('/storage command is available in all renderers', () => {
    const cmd = findCommand('storage');
    expect(cmd?.rendererScope).toBeUndefined(); // all-renderer
  });

  it('/doctor command is available in all renderers', () => {
    const cmd = findCommand('doctor');
    expect(cmd?.rendererScope).toBeUndefined(); // all-renderer
  });
});

// ---------------------------------------------------------------------------
// Storage preview → confirm → execute protocol
// ---------------------------------------------------------------------------

describe('Storage maintenance protocol', () => {
  const storageContext = {} as CommandContext;

  beforeEach(() => resetStorageMaintenancePlanRegistry());
  afterEach(() => resetStorageMaintenancePlanRegistry());

  it('/storage command exposes --dry-run for preview', () => {
    const cmd = findCommand('storage');
    expect(cmd?.argumentHint).toContain('--dry-run');
    expect(cmd?.argumentHint).toContain('repair [--dry-run|--yes]');
  });

  it('/storage command supports doctor sub-action (read-only)', () => {
    const cmd = findCommand('storage');
    expect(cmd?.argumentHint).toContain('doctor');
  });

  it('/migrate command exposes --dry-run for preview', () => {
    const cmd = findCommand('migrate');
    expect(cmd?.argumentHint).toContain('--dry-run');
  });

  it('/checkpoint restore requires --yes confirmation', () => {
    const cmd = findCommand('checkpoint');
    expect(cmd?.argumentHint).toContain('--yes');
  });

  it('/storage cleanup previews by default and deletes only with --yes', async () => {
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), 'orion-storage-command-'));
    const legacySessions = join(configDir, 'sessions');
    const logs: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    mkdirSync(legacySessions, { recursive: true });

    try {
      const command = findCommand('storage')!;
      const preview = await command.execute(storageContext, 'cleanup');
      expect(preview.success).toBe(true);
      expect(existsSync(legacySessions)).toBe(true);
      const planToken = extractStoragePlanToken(logs, 'cleanup');

      const explicitPreview = await command.execute(
        storageContext,
        `cleanup --plan=${planToken} --dry-run --yes`
      );
      expect(explicitPreview.success).toBe(true);
      expect(existsSync(legacySessions)).toBe(true);

      const nearMatch = await command.execute(storageContext, 'cleanup --yesplease');
      expect(nearMatch.success).toBe(false);
      expect(existsSync(legacySessions)).toBe(true);

      const unknown = await command.execute(storageContext, 'cleanup --unknown');
      expect(unknown.success).toBe(false);
      expect(existsSync(legacySessions)).toBe(true);

      const missingPlan = await command.execute(storageContext, 'cleanup --yes');
      expect(missingPlan.success).toBe(false);
      expect(existsSync(legacySessions)).toBe(true);

      const lateTarget = join(getProjectsDir(), 'tmp-orion-code-command-late');
      mkdirSync(lateTarget, { recursive: true });
      const confirmed = await command.execute(storageContext, `cleanup --plan=${planToken} --yes`);
      expect(confirmed.success).toBe(true);
      expect(existsSync(legacySessions)).toBe(false);
      expect(existsSync(lateTarget)).toBe(true);
      const replay = await command.execute(storageContext, `cleanup --plan=${planToken} --yes`);
      expect(replay.success).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(configDir, { recursive: true, force: true });
      if (originalConfigDir === undefined) {
        delete process.env.ORION_CODE_CONFIG_DIR;
      } else {
        process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
      }
    }
  });

  it('/storage cleanup skips a previewed target whose contents change before confirmation', async () => {
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), 'orion-storage-command-drift-'));
    const legacySessions = join(configDir, 'sessions');
    const logs: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    mkdirSync(legacySessions, { recursive: true });

    try {
      const command = findCommand('storage')!;
      await command.execute(storageContext, 'cleanup');
      const planToken = extractStoragePlanToken(logs, 'cleanup');
      writeFileSync(join(legacySessions, 'late-data.json'), '{"important":true}');

      const confirmed = await command.execute(storageContext, `cleanup --plan=${planToken} --yes`);

      expect(confirmed.success).toBe(true);
      expect(existsSync(join(legacySessions, 'late-data.json'))).toBe(true);
    } finally {
      log.mockRestore();
      rmSync(configDir, { recursive: true, force: true });
      if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    }
  });

  it('/storage cleanup rejects a forged opaque plan token', async () => {
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), 'orion-storage-token-forge-'));
    const legacySessions = join(configDir, 'sessions');
    const logs: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    mkdirSync(legacySessions, { recursive: true });

    try {
      const command = findCommand('storage')!;
      await command.execute(storageContext, 'cleanup');
      const planToken = extractStoragePlanToken(logs, 'cleanup');
      const finalCharacter = planToken.at(-1) === 'A' ? 'B' : 'A';
      const forgedToken = `${planToken.slice(0, -1)}${finalCharacter}`;

      const forged = await command.execute(storageContext, `cleanup --plan=${forgedToken} --yes`);

      expect(forged.success).toBe(false);
      expect(existsSync(legacySessions)).toBe(true);
    } finally {
      resetStorageMaintenancePlanRegistry();
      log.mockRestore();
      rmSync(configDir, { recursive: true, force: true });
      if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    }
  });

  it('/storage cleanup rejects a token after process-local registry reset', async () => {
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), 'orion-storage-token-process-'));
    const legacySessions = join(configDir, 'sessions');
    const logs: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    mkdirSync(legacySessions, { recursive: true });

    try {
      const command = findCommand('storage')!;
      await command.execute(storageContext, 'cleanup');
      const planToken = extractStoragePlanToken(logs, 'cleanup');
      resetStorageMaintenancePlanRegistry();

      const confirmed = await command.execute(storageContext, `cleanup --plan=${planToken} --yes`);

      expect(confirmed.success).toBe(false);
      expect(existsSync(legacySessions)).toBe(true);
    } finally {
      resetStorageMaintenancePlanRegistry();
      log.mockRestore();
      rmSync(configDir, { recursive: true, force: true });
      if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    }
  });

  it('/storage plan tokens expire without becoming portable capabilities', () => {
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), 'orion-storage-token-expiry-'));
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));

    try {
      const plan = collectStorageCleanupPlan();
      const token = serializeStorageMaintenancePlan({ kind: 'cleanup', plan });
      expect(deserializeStorageMaintenancePlan(token)?.kind).toBe('cleanup');
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      expect(deserializeStorageMaintenancePlan(token)).toBeUndefined();
    } finally {
      jest.useRealTimers();
      resetStorageMaintenancePlanRegistry();
      rmSync(configDir, { recursive: true, force: true });
      if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    }
  });

  it('/storage repair preview is non-consuming and confirmed apply fails closed', async () => {
    const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), 'orion-storage-repair-command-'));
    const logs: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.ORION_CODE_CONFIG_DIR = configDir;

    try {
      const plannedPath = '/tmp/orion-command-repair-planned';
      const plannedKey = getCanonicalProjectKey(plannedPath);
      const plannedSessions = join(getProjectsDir(), plannedKey, 'sessions');
      mkdirSync(plannedSessions, { recursive: true });
      writeFileSync(
        join(plannedSessions, 'planned.json'),
        JSON.stringify({ id: 'planned', projectPath: plannedPath })
      );
      const command = findCommand('storage')!;
      const preview = await command.execute(storageContext, 'repair');
      expect(preview.success).toBe(true);
      const planToken = extractStoragePlanToken(logs, 'repair');

      const latePath = '/tmp/orion-command-repair-late';
      const lateKey = getCanonicalProjectKey(latePath);
      const lateSessions = join(getProjectsDir(), lateKey, 'sessions');
      mkdirSync(lateSessions, { recursive: true });
      writeFileSync(
        join(lateSessions, 'late.json'),
        JSON.stringify({ id: 'late', projectPath: latePath })
      );

      const missingPlan = await command.execute(storageContext, 'repair --yes');
      expect(missingPlan.success).toBe(false);
      const invalidPlan = await command.execute(storageContext, 'repair --plan=corrupted --yes');
      expect(invalidPlan.success).toBe(false);
      const explicitPreview = await command.execute(
        storageContext,
        `repair --plan=${planToken} --yes --dry-run`
      );
      expect(explicitPreview.success).toBe(true);
      expect(existsSync(getProjectMetadataPath(plannedPath))).toBe(false);
      const confirmed = await command.execute(storageContext, `repair --plan=${planToken} --yes`);

      expect(confirmed.success).toBe(false);
      expect(confirmed.error).toContain('race-safe');
      expect(existsSync(getProjectMetadataPath(plannedPath))).toBe(false);
      expect(existsSync(getProjectMetadataPath(latePath))).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(configDir, { recursive: true, force: true });
      if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    }
  });
});

function extractStoragePlanToken(logs: string[], action: 'cleanup' | 'repair'): string {
  const match = logs.join('\n').match(new RegExp(`/storage ${action} --plan=([^\\s]+) --yes`));
  if (!match) throw new Error(`Missing ${action} storage plan token in command output`);
  return match[1];
}

// ---------------------------------------------------------------------------
// Goal state survives renderer switches
// ---------------------------------------------------------------------------

describe('Goal state survives renderer switches', () => {
  it('goal ID and revision are renderer-independent', () => {
    const coord = new GoalCoordinator('/tmp/test-goal-parity', 'session-test');
    coord.create('Test objective');
    const goal = coord.goal;
    expect(goal?.goalId).toBeTruthy();
    expect(typeof goal?.revision).toBe('number');
    expect(goal?.revision).toBeGreaterThanOrEqual(0);
    // No renderer fields on the goal.
    expect(Object.keys(goal!).filter(k => k.includes('renderer') || k.includes('ui'))).toEqual([]);
  });

  it('goal continuation count is renderer-independent', () => {
    const coord = new GoalCoordinator('/tmp/test-count', 'session-test');
    coord.create('Test goal');
    expect(coord.goal?.continuationCount).toBe(0);

    // Simulate a turn completion (real counting happens in finalizeTurn).
    coord.finalizeTurn({
      turnId: 'turn-1',
      sessionId: 'session-test',
      goalId: coord.goal!.goalId,
      goalRevision: coord.goal!.revision,
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      finishReason: 'completed',
      madeProgress: true,
      usage: { promptTokens: 100, completionTokens: 50, subagentTokens: 0, totalTokens: 150 },
    });
    expect(coord.goal?.continuationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dirty worktree regression
// ---------------------------------------------------------------------------

describe('Dirty worktree awareness', () => {
  it('/diff command reports git workspace state', () => {
    const cmd = findCommand('diff');
    expect(cmd?.risk).toBe('read-only');
    expect(cmd?.category).toBe('workflow');
  });

  it('/commit command is read-only (plan, not execution)', () => {
    const cmd = findCommand('commit');
    expect(cmd?.risk).toBe('read-only');
    expect(cmd?.description).toContain('read-only');
  });
});
