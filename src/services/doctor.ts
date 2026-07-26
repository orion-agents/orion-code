import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  getConfigHome,
  getGlobalConfigPath,
  getLegacyProjectMemoryDir,
  getProjectArtifactsDir,
  getProjectCheckpointsDir,
  getProjectMemoryDir,
  getProjectSessionsDir,
} from './config-dir';
import { isDeprecatedUIRenderer, isRecommendedBetaUIRenderer, isConfigured, type OpenHorseCLIConfig } from './config';
import { getMcpConfigPath, mcpManager } from '../tools/mcp';
import { getRuntimeTools } from '../tools';
import { loadProjectInstructionFiles } from './project-instructions';
import { refreshProjectInstructions } from './prompt-context';
import { listProjectSessions, resolveProjectPath, type SessionMeta } from './session-storage';
import { getSkillsRegistry } from '../skills';
import type { Store } from '../framework/store';
import type { LLMService } from './llm';
import type { OrionCodeRuntime } from '../init';
import { getWarningState } from '../core/warn-dedup';
import { getAutoCompact } from './compact/auto-compact';
import type { CompactCoordinator } from './compact/coordinator';
import { resolveModelContext } from './model-context';
import { diagnoseProviderConfig, redactProviderSecrets } from './provider-diagnostics';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  label: string;
  summary: string;
  detail?: string;
}

export interface DoctorReport {
  generatedAt: string;
  cwd: string;
  projectPath: string;
  configHome: string;
  checks: DoctorCheck[];
  totals: Record<DoctorStatus, number>;
}

export interface DoctorContext {
  cwd: string;
  config: OpenHorseCLIConfig;
  store: Store;
  llm: LLMService | null;
  runtime: OrionCodeRuntime;
  compactCoordinator?: CompactCoordinator;
  getSession?: () => SessionMeta | null;
}

function countStatuses(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return checks.reduce<Record<DoctorStatus, number>>(
    (totals, check) => {
      totals[check.status] += 1;
      return totals;
    },
    { ok: 0, warn: 0, fail: 0 }
  );
}

function summarizeMcpStatus(): DoctorCheck {
  const configPath = getMcpConfigPath();
  const hasConfig = existsSync(configPath);
  const status = mcpManager.getStatus();

  if (!hasConfig && status.length === 0) {
    return {
      id: 'mcp',
      status: 'ok',
      label: 'MCP',
      summary: 'No MCP servers configured',
      detail: configPath,
    };
  }

  if (hasConfig && status.length === 0) {
    return {
      id: 'mcp',
      status: 'warn',
      label: 'MCP',
      summary: 'MCP config exists but no servers are active',
      detail: configPath,
    };
  }

  const connected = status.filter(server => server.connected).length;
  const dead = status.filter(server => server.dead).length;
  const disconnected = status.filter(server => !server.connected && !server.dead).length;
  const tools = status.reduce((sum, server) => sum + server.toolCount, 0);
  const detail = status
    .map(server => `${server.name}: ${server.dead ? 'dead' : server.connected ? 'connected' : 'disconnected'} (${server.toolCount} tools)`)
    .join('\n');

  return {
    id: 'mcp',
    status: dead > 0 || disconnected > 0 ? 'fail' : 'ok',
    label: 'MCP',
    summary: `${connected}/${status.length} connected, ${tools} tools`,
    detail,
  };
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function summarizeAutoCompact(ctx: DoctorContext): DoctorCheck {
  const modelId = ctx.llm?.getModel() ?? ctx.config.model;
  const modelContext = resolveModelContext(modelId);
  if (ctx.compactCoordinator) {
    ctx.compactCoordinator.configure({
      modelId,
      llm: ctx.llm,
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
    });
  }
  const stats = (
    ctx.compactCoordinator?.getAutomatic() ?? getAutoCompact({ modelId })
  ).getStats();
  const sourceText = modelContext.source === 'fuzzy'
    ? `${modelContext.source}:${modelContext.matchedId}`
    : modelContext.source;

  return {
    id: 'auto-compact',
    status: modelContext.source === 'default' ? 'warn' : 'ok',
    label: 'Auto Compact',
    summary: `${stats.enabled ? 'enabled' : 'disabled'}, ${formatTokenCount(modelContext.contextWindow)} context, predict ${Math.round(stats.predictiveCompactThreshold * 100)}%, hard ${Math.round(stats.threshold * 100)}%`,
    detail: [
      `model=${modelId}`,
      `source=${sourceText}`,
      `lastTokenCount=${stats.lastTokenCount}`,
      `ctxPercent=${stats.ctxPercent}%`,
      `preCompactArmed=${stats.preCompactArmed}`,
      `compactCount=${stats.compactCount}`,
      `lastCompactMode=${stats.lastCompactMode ?? 'none'}`,
    ].join('\n'),
  };
}

function summarizeSkills(): DoctorCheck {
  try {
    const registry = getSkillsRegistry();
    const summary = registry.getSummary();
    const duplicateLines = summary.duplicates.slice(0, 10).map(duplicate => {
      const previous = duplicate.existingSource?.type ?? 'unknown';
      const incoming = duplicate.incomingSource.type;
      const selected = duplicate.selectedSourceType ?? 'unknown';
      return `duplicate ${duplicate.name}: ${previous} vs ${incoming}, selected ${selected} (${duplicate.reason})`;
    });
    const detail = [
      summary.names.slice(0, 20).join(', ') || 'No skills loaded',
      ...duplicateLines,
      summary.duplicates.length > duplicateLines.length
        ? `... ${summary.duplicates.length - duplicateLines.length} more duplicate skill diagnostics`
        : '',
    ].filter(Boolean).join('\n');
    return {
      id: 'skills',
      status: summary.count > 0 ? (summary.duplicateCount > 0 ? 'warn' : 'ok') : 'warn',
      label: 'Skills',
      summary: `${summary.count} loaded, ${summary.autoCount} auto-trigger${summary.duplicateCount > 0 ? `, ${summary.duplicateCount} duplicate` : ''}`,
      detail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: 'skills',
      status: 'fail',
      label: 'Skills',
      summary: 'Failed to load skills',
      detail: message,
    };
  }
}

function summarizeProjectInstructions(ctx: DoctorContext): DoctorCheck {
  const files = loadProjectInstructionFiles(ctx.cwd);
  refreshProjectInstructions(ctx.store, ctx.cwd);
  const promptChars = ctx.store.getSnapshot().projectInstructionsContent.length;

  return {
    id: 'project-instructions',
    status: files.length > 0 ? 'ok' : 'warn',
    label: 'Project Rules',
    summary: files.length > 0
      ? `${files.length} files, ${promptChars} prompt chars`
      : 'No AGENTS.md / CLAUDE.md / .orion-code instructions found',
    detail: files.map(file => `${file.path}${file.truncated ? ' (truncated)' : ''}`).join('\n') || undefined,
  };
}

function summarizeSessions(ctx: DoctorContext, projectPath: string): DoctorCheck {
  const active = ctx.getSession?.() ?? null;
  const sessions = listProjectSessions(projectPath, 20);
  return {
    id: 'sessions',
    status: active || sessions.length > 0 ? 'ok' : 'warn',
    label: 'Sessions',
    summary: active
      ? `Active ${active.id.slice(0, 8)}, ${sessions.length} recent project sessions`
      : `${sessions.length} recent project sessions, no active session`,
    detail: sessions.slice(0, 5).map(session =>
      `${session.id.slice(0, 8)} ${session.name || session.taskSummary || '(untitled)'} ${session.messageCount ?? 0} msgs`
    ).join('\n') || undefined,
  };
}

function summarizeHarness(ctx: DoctorContext): DoctorCheck {
  const harnessState = ctx.store.getSnapshot().harnessState;
  const objective = harnessState?.rootObjective || harnessState?.contract?.objective;
  const epoch = harnessState?.taskEpoch;
  return {
    id: 'harness',
    status: objective || harnessState?.capsule ? 'ok' : 'warn',
    label: 'Harness',
    summary: objective
      ? `epoch ${epoch ?? 0}: ${objective}`
      : 'No active objective captured yet',
    detail: harnessState?.capsule?.nextAction ? `Next: ${harnessState.capsule.nextAction}` : undefined,
  };
}

function summarizeArtifacts(projectPath: string): DoctorCheck {
  const artifactDir = getProjectArtifactsDir(projectPath);
  if (!existsSync(artifactDir)) {
    return { id: 'artifacts', status: 'ok', label: 'Artifacts', summary: 'No artifacts directory' };
  }
  const entries = readdirSync(artifactDir);
  let totalBytes = 0;
  for (const entry of entries) {
    try { totalBytes += statSync(join(artifactDir, entry)).size; } catch { /* skip */ }
  }
  const status = entries.length > 100 || totalBytes > 50_000_000 ? 'warn' : 'ok';
  return {
    id: 'artifacts',
    status,
    label: 'Artifacts',
    summary: `${entries.length} files, ${(totalBytes / 1024).toFixed(0)}KB`,
    detail: status === 'warn' ? 'Consider running cleanupArtifacts()' : undefined,
  };
}

function dirStats(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const visit = (current: string) => {
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          visit(fullPath);
        } else {
          files++;
          bytes += stat.size;
        }
      } catch {
        // ignore unreadable paths
      }
    }
  };
  visit(dir);
  return { files, bytes };
}

function countInvalidHarnessSidecars(projectPath: string): number {
  const sessionsDir = getProjectSessionsDir(projectPath);
  if (!existsSync(sessionsDir)) return 0;
  let invalid = 0;
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith('.harness.json')) continue;
    try {
      const content = readFileSync(join(sessionsDir, entry), 'utf8');
      const parsed = JSON.parse(content);
      if (parsed?.version !== 2 || !parsed.state) invalid++;
    } catch {
      invalid++;
    }
  }
  return invalid;
}

function summarizeStorageLayout(projectPath: string): DoctorCheck {
  const canonicalMemory = getProjectMemoryDir(projectPath);
  const legacyMemory = getLegacyProjectMemoryDir(projectPath);
  const artifacts = getProjectArtifactsDir(projectPath);
  const checkpoints = getProjectCheckpointsDir(projectPath);
  const legacyArtifacts = join(getProjectSessionsDir(projectPath), '_artifacts');
  const legacyCheckpoints = join(getProjectSessionsDir(projectPath), '_checkpoints');

  const canonicalMemoryStats = dirStats(canonicalMemory);
  const legacyMemoryStats = dirStats(legacyMemory);
  const artifactStats = dirStats(artifacts);
  const checkpointStats = dirStats(checkpoints);
  const legacyArtifactStats = dirStats(legacyArtifacts);
  const legacyCheckpointStats = dirStats(legacyCheckpoints);
  const invalidHarness = countInvalidHarnessSidecars(projectPath);

  const hasLegacy = legacyMemoryStats.files > 0 || legacyArtifactStats.files > 0 || legacyCheckpointStats.files > 0;
  const largeStorage = artifactStats.bytes + legacyArtifactStats.bytes + checkpointStats.bytes + legacyCheckpointStats.bytes > 100_000_000;
  const status: DoctorStatus = invalidHarness > 0 || hasLegacy || largeStorage ? 'warn' : 'ok';

  return {
    id: 'storage-layout',
    status,
    label: 'Storage Layout',
    summary: `${canonicalMemoryStats.files} memory, ${artifactStats.files + legacyArtifactStats.files} artifacts, ${checkpointStats.files + legacyCheckpointStats.files} checkpoint files`,
    detail: [
      `memory=${canonicalMemory}`,
      legacyMemoryStats.files > 0 ? `legacy memory=${legacyMemory} (${legacyMemoryStats.files} files)` : '',
      `artifacts=${artifactStats.files} files ${(artifactStats.bytes / 1024).toFixed(0)}KB`,
      legacyArtifactStats.files > 0 ? `legacy artifacts=${legacyArtifactStats.files} files ${(legacyArtifactStats.bytes / 1024).toFixed(0)}KB` : '',
      `checkpoints=${checkpointStats.files} files ${(checkpointStats.bytes / 1024).toFixed(0)}KB`,
      legacyCheckpointStats.files > 0 ? `legacy checkpoints=${legacyCheckpointStats.files} files ${(legacyCheckpointStats.bytes / 1024).toFixed(0)}KB` : '',
      invalidHarness > 0 ? `invalid harness sidecars=${invalidHarness}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function summarizePromptCache(ctx: DoctorContext): DoctorCheck {
  const snapshot = ctx.store.getSnapshot();
  const history = snapshot.conversationHistory;
  const hasCacheMarked = history.some(m => m.role === 'system' && (m as any).cacheControl);
  return {
    id: 'prompt-cache',
    status: hasCacheMarked ? 'ok' : 'warn',
    label: 'Prompt Cache',
    summary: hasCacheMarked ? 'Static system prefix marked for caching' : 'No cache-marked messages yet (starts on first turn)',
  };
}

function summarizeWarningDedup(): DoctorCheck {
  const state = getWarningState();
  if (state.size === 0) {
    return { id: 'warn-dedup', status: 'ok', label: 'Warning Dedup', summary: 'No warnings recorded' };
  }
  let suppressed = 0;
  for (const [, wc] of state) {
    if (wc.count > 1) suppressed += wc.count - 1;
  }
  const status = suppressed > 10 ? 'warn' : 'ok';
  return {
    id: 'warn-dedup',
    status,
    label: 'Warning Dedup',
    summary: `${state.size} unique warnings, ${suppressed} duplicates suppressed`,
    detail: suppressed > 0 ? [...state.values()].map(wc => `[x${wc.count}] ${wc.message}`).join('\n') : undefined,
  };
}

function summarizeProviderConfig(ctx: DoctorContext): DoctorCheck {
  const diagnostic = diagnoseProviderConfig({
    apiKey: ctx.config.apiKey,
    baseUrl: ctx.config.apiBaseUrl,
    fallbackModel: ctx.config.fallbackModel,
    model: ctx.llm?.getModel() ?? ctx.config.model,
  });

  return {
    id: 'provider-config',
    status: diagnostic.status,
    label: 'Provider Config',
    summary: diagnostic.summary,
    detail: diagnostic.detail.join('\n'),
  };
}

export function collectDoctorReport(ctx: DoctorContext): DoctorReport {
  const projectPath = resolveProjectPath(ctx.cwd);
  const snapshot = ctx.store.getSnapshot();
  const tools = snapshot.tools.length > 0 ? snapshot.tools : getRuntimeTools();
  const staticTools = tools.filter(tool => !tool.name.startsWith('mcp__')).length;
  const mcpTools = tools.length - staticTools;

  const checks: DoctorCheck[] = [
    {
      id: 'config',
      status: isConfigured(ctx.config) ? 'ok' : 'fail',
      label: 'Config',
      summary: isConfigured(ctx.config)
        ? `API key present, model ${ctx.config.model}`
        : 'Missing API key',
      detail: `config=${getGlobalConfigPath()}\nbaseUrl=${redactProviderSecrets(ctx.config.apiBaseUrl || '(default OpenAI-compatible endpoint)')}`,
    },
    {
      id: 'llm',
      status: ctx.llm && isConfigured(ctx.config) ? 'ok' : 'fail',
      label: 'LLM',
      summary: ctx.llm ? `Initialized ${ctx.llm.getModel()}` : 'LLM service is not initialized',
    },
    summarizeProviderConfig(ctx),
    summarizeAutoCompact(ctx),
    {
      id: 'permissions',
      status: 'ok',
      label: 'Permissions',
      summary: `toolConfirmation=${ctx.config.toolConfirmation}, ui=${ctx.config.ui?.renderer}/${ctx.config.ui?.confirmations}`,
      detail: ctx.config.toolConfirmation === 'ask'
        ? `Interactive tool confirmation is routed through the shared runtime permission protocol.${isDeprecatedUIRenderer(ctx.config.ui?.renderer) ? ' This renderer is deprecated; consider switching to --ui tui.' : isRecommendedBetaUIRenderer(ctx.config.ui?.renderer) ? ' TUI is the recommended beta renderer; terminal remains the stable default.' : ''}`
        : undefined,
    },
    {
      id: 'tools',
      status: tools.length > 0 ? 'ok' : 'fail',
      label: 'Tools',
      summary: `${tools.length} available (${staticTools} built-in, ${mcpTools} MCP)`,
    },
    summarizeMcpStatus(),
    summarizeSkills(),
    summarizeProjectInstructions(ctx),
    summarizeSessions(ctx, projectPath),
    summarizeHarness(ctx),
    summarizeArtifacts(projectPath),
    summarizeStorageLayout(projectPath),
    summarizePromptCache(ctx),
    summarizeWarningDedup(),
    {
      id: 'context-size',
      status: snapshot.projectInstructionsContent.length > 120_000 || snapshot.skillsContent.length > 120_000 ? 'warn' : 'ok',
      label: 'Context Size',
      summary: `project rules ${snapshot.projectInstructionsContent.length} chars, skills index ${snapshot.skillsContent.length} chars, memory ${snapshot.memoryContent.length} chars`,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    projectPath,
    configHome: getConfigHome(),
    checks,
    totals: countStatuses(checks),
  };
}

export function hasDoctorFailures(report: DoctorReport): boolean {
  return report.totals.fail > 0;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    'Orion Code Doctor',
    '─'.repeat(40),
    `Generated  ${report.generatedAt}`,
    `Project    ${report.projectPath}`,
    `CWD        ${report.cwd}`,
    `Config     ${report.configHome}`,
    '',
    `Summary    ${report.totals.ok} ok, ${report.totals.warn} warn, ${report.totals.fail} fail`,
    '',
  ];

  const statusIcon: Record<DoctorStatus, string> = {
    ok: '✓',
    warn: '!',
    fail: '✗',
  };

  for (const check of report.checks) {
    lines.push(`${statusIcon[check.status]} ${check.label}: ${check.summary}`);
    if (check.detail) {
      for (const line of check.detail.split('\n')) {
        lines.push(`  ${line}`);
      }
    }
  }

  return lines.join('\n');
}
