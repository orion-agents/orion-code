/** Handler implementations for the model-command-handlers boundary. */

import { randomUUID } from 'crypto';
import chalk from 'chalk';
import type { CommandContext, CommandResult } from './types';
import {
  createModelPickerState,
  createStatusSnapshot,
  type ModelPickerCandidate,
} from '../runtime/ui-view-model';
import { resolveProjectToolAllowlist } from '../services/tool-allowlist';
import { getAutoCompact } from '../services/compact/auto-compact';
import { compactMessages } from '../services/compact';
import { createContextUsageSnapshot, resolveModelContext } from '../services/model-context';
import { maskSecret } from '../utils/mask';
import {
  getModelCatalogEntry,
  listModelCatalogEntries,
  resolveModelAlias,
} from '../services/model-catalog';
import { lookupProfile, type ResolvedModelProfile } from '../services/model-registry';
import { getProjectConfig, loadGlobalConfig } from '../services/global-config';
import type { SettingsOperationV1 } from '../services/settings-coordinator';
import {
  isEffortPreference,
  resolveProfileEffort,
  type EffortPreference,
  type EffortScope,
} from '../services/effort';
import {
  commitSessionCompactCheckpoint,
  prepareSessionCompactSourceReceipt,
  appendSessionTraceEvent,
  updateSessionModel,
  updateSessionEffort,
} from '../services/session-storage';
import { estimateMessagesTokens } from '../utils/token-estimate';
import type {
  ModelSwitchCompactPreflightReceipt,
  ModelSwitchCompactPreflightRequest,
} from '../runtime/model-coordinator';

// ============================================================================
// 颜色常量
// ============================================================================

const BRAND = chalk.hex('#FF6B35');

const ACCENT = chalk.hex('#00D4AA');

const DIM = chalk.dim;

const ERROR = chalk.red;

const WARN = chalk.yellow;

async function updateDurableSettings(
  ctx: CommandContext,
  command: string,
  operations: readonly SettingsOperationV1[]
) {
  if (!ctx.describeSettings || !ctx.updateSettings) {
    throw new Error('The product Settings coordinator is unavailable.');
  }
  const before = ctx.describeSettings();
  return ctx.updateSettings({
    requestId: `slash:${command}:${randomUUID()}`,
    expectedRevision: before.revision,
    operations,
  });
}

const SUCCESS = chalk.green;

const HEADER = chalk.cyan.bold;

function commandUICapabilities(ctx: CommandContext) {
  return createStatusSnapshot({
    renderer: ctx.uiRenderer ?? ctx.config.ui?.renderer ?? 'terminal',
    capabilities: ctx.uiCapabilities,
  }).renderer.capabilities;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function formatThreshold(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function getProfileByModelId(
  registry: CommandContext['config']['modelRegistry'],
  modelId: string
): ResolvedModelProfile | undefined {
  if (!registry) return undefined;

  const normalized = modelId.trim();
  if (!normalized) return undefined;

  if (registry.profiles.has(normalized)) return registry.profiles.get(normalized)!;

  for (const profile of registry.profiles.values()) {
    if (modelId === profile.model) return profile;
  }
  return undefined;
}

function resolveModelFromRegistry(
  config: CommandContext['config'],
  selector: string
): ResolvedModelProfile | undefined {
  if (!config.modelRegistry) return undefined;

  const trimmed = selector.trim();
  if (!trimmed) return undefined;

  return lookupProfile(config.modelRegistry, trimmed) ?? undefined;
}

function listConfiguredModelCatalogEntries(registry: CommandContext['config']['modelRegistry']) {
  if (!registry) return [];
  return registry.enabledProfiles.map(profile => {
    const provider = registry.providers.get(profile.provider);
    return {
      name: profile.id,
      alias: profile.aliases?.[0],
      provider: provider?.displayName ?? profile.provider,
      contextWindow: profile.resolvedContextWindow,
      maxOutputTokens: profile.resolvedMaxOutputTokens,
      source: `${profile.contextSource}/${profile.outputSource}`,
      effortSupportedLevels: profile.reasoningCapability?.supportedLevels,
    };
  });
}

function getCommandAutoCompact(ctx: CommandContext, modelId: string) {
  if (ctx.compactCoordinator) {
    ctx.compactCoordinator.configure({
      modelId,
      llm: ctx.llm,
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
    });
    return ctx.compactCoordinator.getAutomatic();
  }
  return getAutoCompact({ modelId });
}

async function commitModelSwitchCompact(
  ctx: CommandContext,
  request: ModelSwitchCompactPreflightRequest
): Promise<ModelSwitchCompactPreflightReceipt> {
  const history = ctx.store.getSnapshot().conversationHistory;
  const currentTokens = estimateMessagesTokens(history);
  if (currentTokens <= request.safeInputBudget) {
    return { status: 'not_needed', currentTokens };
  }

  const session = ctx.getSession?.() ?? ctx.ensureSession?.();
  if (!session) {
    return {
      status: 'rejected',
      error: 'A durable session is required before compacting for a model switch.',
    };
  }
  const prepareSource = prepareSessionCompactSourceReceipt(session.id);
  const sourceMessageCount = prepareSource.sourceMessageCount;

  const result = await compactMessages(history, {
    maxMessages: 20,
    contextCapsule: ctx.store.getSnapshot().harnessState?.capsule,
    harnessState: ctx.store.getSnapshot().harnessState,
    goalObjective: ctx.getActiveGoal?.()?.objective,
    llm: ctx.llm ?? undefined,
    compactMode: 'manual',
    safeInputBudget: request.safeInputBudget,
    targetRatio: 0.65,
  });
  if (result.afterTokens > request.targetTokens) {
    return {
      status: 'rejected',
      error: `Compact candidate uses ${result.afterTokens} tokens; target is ${request.targetTokens}.`,
    };
  }

  const afterUsage = {
    ...createContextUsageSnapshot({
      modelId: request.to.id,
      usedTokens: result.afterTokens,
      source: 'estimated',
      outputReserveTokens: request.to.resolvedMaxOutputTokens,
    }),
    contextWindow: request.to.resolvedContextWindow,
    safeInputBudget: request.safeInputBudget,
    percent: Math.min(100, Math.floor((result.afterTokens / request.safeInputBudget) * 100)),
    rawPercent: Math.min(
      100,
      Math.floor((result.afterTokens / request.to.resolvedContextWindow) * 100)
    ),
  };
  const goal = ctx.getActiveGoal?.();
  const traceTurnId = String(ctx.turnId ?? 'command:model-switch');
  const traceDetails = {
    model: request.to.id,
    compactMode: 'manual' as const,
    compactStrategy: 'model-switch-semantic-v2',
    compactCandidateFingerprint: result.fingerprint,
    compactBeforeTokens: result.beforeTokens,
    compactAfterTokens: result.afterTokens,
    compactTargetTokens: result.plan.targetTokens,
    compactTargetRatio: result.plan.targetRatio,
    compactDiagnosticsCount: result.diagnostics.length,
    compactSourceMessageCount: sourceMessageCount,
  };
  appendSessionTraceEvent(session.id, {
    turnId: traceTurnId,
    type: 'compact_prepare',
    ...traceDetails,
  });
  let checkpoint: ReturnType<typeof commitSessionCompactCheckpoint>;
  try {
    checkpoint = commitSessionCompactCheckpoint({
      sessionId: session.id,
      mode: 'manual',
      modelId: request.to.id,
      sourceMessageCount,
      transcriptStartMessageIndex: Math.max(0, sourceMessageCount - 20),
      modelHistory: result.messages,
      summary: {
        text: result.summary,
        generatedAt: result.summaryGeneratedAt,
        source: result.summarySource,
      },
      beforeUsage: createContextUsageSnapshot({
        modelId: request.from.id,
        usedTokens: currentTokens,
        source: 'estimated',
        outputReserveTokens: request.from.resolvedMaxOutputTokens,
      }),
      afterUsage,
      strategy: 'model-switch-semantic-v2',
      harnessState: ctx.store.getSnapshot().harnessState,
      goalBinding: goal ? { goalId: goal.goalId, revision: goal.revision, state: goal } : undefined,
      prepareSource,
      candidate: {
        fingerprint: result.fingerprint,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        plan: result.plan,
        semanticSummary: result.semanticSummary,
        diagnostics: result.diagnostics,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendSessionTraceEvent(session.id, {
      turnId: traceTurnId,
      type: 'compact_rollback',
      success: false,
      error: message,
      ...traceDetails,
    });
    appendSessionTraceEvent(session.id, {
      turnId: traceTurnId,
      type: 'compact_failed',
      success: false,
      error: message,
      ...traceDetails,
    });
    throw error;
  }
  appendSessionTraceEvent(session.id, {
    turnId: traceTurnId,
    type: 'compact_validate',
    checkpointId: checkpoint.checkpointId,
    success: true,
    ...traceDetails,
  });
  appendSessionTraceEvent(session.id, {
    turnId: traceTurnId,
    type: 'compact_commit',
    checkpointId: checkpoint.checkpointId,
    success: true,
    ...traceDetails,
  });

  ctx.store.setState({ conversationHistory: checkpoint.modelHistory });
  ctx.store.setContextUsage(afterUsage);
  appendSessionTraceEvent(session.id, {
    turnId: traceTurnId,
    type: 'compact_boundary',
    checkpointId: checkpoint.checkpointId,
    success: true,
    ...traceDetails,
  });
  appendSessionTraceEvent(session.id, {
    turnId: traceTurnId,
    type: 'compact_completed',
    checkpointId: checkpoint.checkpointId,
    success: true,
    ...traceDetails,
  });
  return {
    status: 'committed',
    afterTokens: checkpoint.candidateReceipt.afterTokens,
    candidateFingerprint: checkpoint.candidateReceipt.candidateFingerprint,
  };
}

function showConfig(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Configuration'));
  console.log(DIM('─'.repeat(40)));

  const allowlist = resolveProjectToolAllowlist(ctx.cwd);
  const allowlistSummary =
    allowlist.rules.length === 0 && allowlist.invalid.length === 0
      ? '(none)'
      : `${allowlist.rules.length} rule(s)` +
        (allowlist.invalid.length > 0 ? `, ${allowlist.invalid.length} invalid (ignored)` : '');

  const summary = {
    name: ctx.config.name,
    model: ctx.config.model,
    apiBaseUrl: ctx.config.apiBaseUrl || '(default OpenAI)',
    apiKey: maskSecret(ctx.config.apiKey),
    mode: ctx.config.mode,
    logLevel: ctx.config.logLevel,
    toolConfirmation: ctx.config.toolConfirmation,
    allowedTools: allowlistSummary,
  };

  const llmSummary = ctx.llm?.getConfigSummary() ?? {};

  for (const [key, val] of Object.entries(summary)) {
    console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
  }
  if (allowlist.rules.length > 0 || allowlist.invalid.length > 0) {
    console.log();
    for (const [label, parsed] of [
      ['Machine-wide allowedTools', allowlist.global],
      ['Project allowedTools', allowlist.project],
    ] as const) {
      if (parsed.rules.length === 0 && parsed.invalid.length === 0) continue;
      console.log(HEADER(`  ${label}:`));
      for (const rule of parsed.rules) {
        console.log(
          `  ${ACCENT(rule.effect.padEnd(6))} ${DIM(rule.tool)}${DIM(rule.pattern ? `(${rule.pattern})` : '')}`
        );
      }
      for (const entry of parsed.invalid) {
        console.log(`  ${WARN('invalid')} ${DIM(entry)}`);
      }
    }
  }
  console.log();
  console.log(HEADER('  LLM Settings:'));
  for (const [key, val] of Object.entries(llmSummary)) {
    console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
  }
  console.log();
  return { success: true };
}

async function handleModel(ctx: CommandContext, args: string): Promise<CommandResult> {
  const trimmedArgs = args.trim().toLowerCase();
  if (!trimmedArgs) return handleModels(ctx, args);
  const lines: string[] = [];
  const write = (line = ''): void => {
    lines.push(line);
  };
  const result = (success: boolean): CommandResult => ({
    success,
    ...(lines.length > 0 ? { output: lines.join('\n') } : {}),
  });

  const modelTokens = args.trim().split(/\s+/u).filter(Boolean);
  const defaultFlagIndex = modelTokens.findIndex(token => token.toLowerCase() === '--default');
  if (defaultFlagIndex >= 0) {
    const selectorTokens = modelTokens.filter((_, index) => index !== defaultFlagIndex);
    if (selectorTokens.length > 1) {
      return { success: false, error: 'Usage: /model [model] --default.' };
    }
    const selector = selectorTokens[0] ?? ctx.store.getSnapshot().currentModel;
    const profile = resolveModelFromRegistry(ctx.config, selector);
    if (ctx.config.modelRegistry && !profile) {
      return {
        success: false,
        error: `Model ${selector} is not enabled in the configured registry.`,
      };
    }
    const defaultModel = profile?.id ?? resolveModelAlias(selector);
    try {
      await updateDurableSettings(ctx, 'model-default', [
        { op: 'set', key: 'defaults.model', value: defaultModel },
      ]);
    } catch (error) {
      return {
        success: false,
        error: `Default model was not changed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      success: true,
      output: `Default model changed to ${defaultModel}. Existing sessions keep their current model.`,
    };
  }

  // 显示当前模型
  if (trimmedArgs === '?' || trimmedArgs === 'info') {
    write();
    if (ctx.llm) {
      const currentModel = ctx.store.getSnapshot().currentModel || ctx.llm.getModel();
      const profile = getProfileByModelId(ctx.config.modelRegistry, currentModel);
      const aliasEntry = getModelCatalogEntry(currentModel);
      const contextInfo = profile
        ? {
            id: profile.model,
            label: profile.displayName || profile.id,
            contextWindow: profile.resolvedContextWindow,
            maxOutputTokens: profile.resolvedMaxOutputTokens,
            source: 'config',
            matchedId: profile.model,
          }
        : resolveModelContext(currentModel);
      const compactStats = getCommandAutoCompact(ctx, currentModel).getStats();
      write(HEADER('Current Model'));
      write(DIM('─'.repeat(40)));
      write(`  Model    ${BRAND(currentModel)}`);
      if (profile) {
        write(`  Alias    ${ACCENT(profile.aliases?.[0] ? `(${profile.aliases[0]})` : 'none')}`);
        const provider = ctx.config.modelRegistry?.providers.get(profile.provider);
        write(`  Provider ${DIM(provider?.displayName || profile.provider)}`);
      } else if (aliasEntry) {
        write(`  Alias    ${ACCENT(aliasEntry.alias)}`);
        write(`  Provider ${DIM(aliasEntry.provider)}`);
      }
      write(`  Context  ${DIM(`${formatTokenCount(contextInfo.contextWindow)} tokens`)}`);
      if (contextInfo.maxOutputTokens) {
        write(`  Output   ${DIM(`${formatTokenCount(contextInfo.maxOutputTokens)} tokens`)}`);
      }
      write(
        `  Source   ${DIM(`${contextInfo.source}${contextInfo.source === 'fuzzy' ? `:${contextInfo.matchedId}` : ''}`)}`
      );
      write(
        `  Compact  ${compactStats.enabled ? SUCCESS('auto') : WARN('off')} ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}`)}`
      );
    } else {
      write(ERROR('LLM not initialized. Set ORION_CODE_API_KEY first.'));
    }
    write();
    return result(true);
  }

  // /model list|ls|help 已移除；无参数 /model 统一打开交互式选择器。
  if (trimmedArgs === 'list' || trimmedArgs === 'ls' || trimmedArgs === 'help') {
    write();
    write(WARN(`/model ${trimmedArgs} was removed.`));
    write(DIM('Use /model without arguments to open the model picker,'));
    write(DIM('or /model <name|alias> to switch directly, e.g. /model sonnet'));
    write();
    return result(true);
  }

  // 设置模型
  if (!ctx.llm) {
    return { success: false, error: 'LLM not initialized. Configure a provider first.' };
  }

  if (ctx.sessionComposerControls) {
    try {
      const receipt = await ctx.sessionComposerControls.selectModel({ modelId: args.trim() });
      const selected = ctx.sessionComposerControls.describe().model;
      write(SUCCESS(`✔ Model changed to ${BRAND(selected.modelId)}`));
      write(
        DIM(
          `  Context window ${formatTokenCount(selected.contextWindow)} tokens (${selected.providerLabel ?? 'configured provider'})`
        )
      );
      if (receipt.compacted) write(DIM('  Context compacted before switching models.'));
      write();
      return result(true);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // 解析别名
  const registryProfile = resolveModelFromRegistry(ctx.config, args);
  const resolvedModel = registryProfile ? registryProfile.model : resolveModelAlias(args);
  const resolvedProfileId = registryProfile ? registryProfile.id : resolvedModel;
  const activeSession = ctx.getSession?.() ?? ctx.ensureSession?.();
  const previousCoordinatorModel = ctx.modelCoordinator?.getCurrent()?.id;

  if (registryProfile && ctx.modelCoordinator) {
    const switchResult = await ctx.modelCoordinator.switchToWithCompactPreflight(
      registryProfile.id,
      request => commitModelSwitchCompact(ctx, request)
    );
    if (!switchResult.success) {
      return { success: false, error: switchResult.error ?? 'Model switch failed.' };
    }
  }

  if (activeSession) {
    try {
      const persisted = updateSessionModel(activeSession.id, resolvedProfileId);
      if (!persisted) {
        if (previousCoordinatorModel) ctx.modelCoordinator?.initModel(previousCoordinatorModel);
        return {
          success: false,
          error: `Session ${activeSession.id} is no longer available; model was not changed.`,
        };
      }
      activeSession.model = persisted.model;
      activeSession.updatedAt = persisted.updatedAt;
      activeSession.updatedAtIso = persisted.updatedAtIso;
    } catch (error) {
      if (previousCoordinatorModel) ctx.modelCoordinator?.initModel(previousCoordinatorModel);
      return {
        success: false,
        error: `Session model was not changed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const effort = resolveProfileEffort(registryProfile, {
    session: activeSession?.effortPreference,
    project: getProjectConfig(ctx.cwd).defaultEffort,
    global: loadGlobalConfig().defaultEffort ?? ctx.config.defaultEffort,
  });

  if (registryProfile) {
    const provider = ctx.config.modelRegistry?.providers.get(registryProfile.provider);
    if (provider && ctx.config.modelClientPool && 'setProviderClient' in ctx.llm) {
      ctx.llm.setProviderClient(ctx.config.modelClientPool.getClient(provider));
    }
  }
  ctx.llm.setModel(resolvedModel);
  if (registryProfile) {
    const provider = ctx.config.modelRegistry?.providers.get(registryProfile.provider);
    if (provider && typeof ctx.llm.setEffortContext === 'function') {
      ctx.llm.setEffortContext({
        preference: effort.requested,
        protocol: provider.protocol,
        capability: registryProfile.reasoningCapability,
      });
    }
  }
  getCommandAutoCompact(ctx, resolvedModel);
  ctx.store.setState({ currentModel: resolvedProfileId });
  ctx.store.setEffort(effort.requested, effort);
  write(SUCCESS(`✔ Model changed to ${BRAND(resolvedProfileId)}`));
  const contextInfo = registryProfile
    ? {
        contextWindow: registryProfile.resolvedContextWindow,
        maxOutputTokens: registryProfile.resolvedMaxOutputTokens,
        source: 'resolved',
      }
    : resolveModelContext(resolvedModel);
  write(
    DIM(
      `  Context window ${formatTokenCount(contextInfo.contextWindow)} tokens (${contextInfo.source})`
    )
  );
  write();
  return result(true);
}

/**
 * No-argument `/model` — 交互式选择切换模型。
 * 交互式渲染器返回结构化 modelPicker 请求（渲染器弹出选择层，选中即 /model <id>）；
 * 非交互式渲染器直接打印候选列表并提示 /model <name|alias>。
 */
function handleModels(ctx: CommandContext, _args: string): CommandResult {
  const currentModel = ctx.store.getSnapshot().currentModel || ctx.llm?.getModel() || '';
  const configuredModels = listConfiguredModelCatalogEntries(ctx.config.modelRegistry);

  const baseCandidates: ModelPickerCandidate[] =
    configuredModels.length > 0
      ? configuredModels
      : listModelCatalogEntries().map(model => {
          const contextInfo = resolveModelContext(model.name);
          return {
            name: model.name,
            alias: model.alias,
            provider: model.provider,
            contextWindow: contextInfo.contextWindow,
            maxOutputTokens: contextInfo.maxOutputTokens,
            source: contextInfo.source,
          };
        });
  const currentEffort = ctx.store.getSnapshot().resolvedEffort;
  const candidates = baseCandidates.map(candidate =>
    candidate.name === currentModel && currentEffort
      ? { ...candidate, effortCurrent: currentEffort.requested }
      : candidate
  );

  const ui = commandUICapabilities(ctx);
  if (ui.structuredPickers) {
    return {
      success: true,
      modelPicker: {
        models: candidates,
        currentModel,
        title: 'Switch Model',
        maxVisibleItems: 12,
      },
    };
  }

  // Non-interactive renderers consume the same structured text result.
  const lines = ['', HEADER('Available Models'), DIM('─'.repeat(40))];
  const modelPicker = createModelPickerState({ currentModel, models: candidates });
  for (const item of modelPicker.visibleItems) {
    const marker = item.isCurrent ? SUCCESS('●') : DIM('○');
    const alias = item.alias ? `(${item.alias})` : '';
    const context = `${formatTokenCount(item.contextWindow ?? 0)} ctx`;
    const current = item.isCurrent ? BRAND('(current)') : '';
    lines.push(`  ${marker} ${ACCENT(item.name)} ${DIM(alias)} ${DIM(context)} ${current}`);
    lines.push(`      ${DIM(item.provider ?? 'unknown')}`);
  }
  lines.push('', DIM('Use /model <name|alias> to switch, e.g. /model sonnet'), '');
  return { success: true, output: lines.join('\n') };
}

async function handlePermissions(ctx: CommandContext, args: string): Promise<CommandResult> {
  const value = args.trim().toLowerCase();
  const snapshot = ctx.store.getSnapshot();
  if (!value || value === '?' || value === 'help' || value === 'show' || value === 'audit') {
    const allowlist = resolveProjectToolAllowlist(ctx.cwd);
    return {
      success: true,
      output: [
        `Tool confirmation: ${ctx.config.toolConfirmation}`,
        `Edit policy: ${snapshot.permissionMode === 'acceptEdits' ? 'allow-edits' : 'confirm'}`,
        `Agent mode: ${snapshot.agentMode}`,
        `Machine-wide tool rules: ${allowlist.global.rules.length} (${allowlist.global.invalid.length} invalid)`,
        `Project tool rules: ${allowlist.project.rules.length} (${allowlist.project.invalid.length} invalid)`,
        'Interactive approval: once | this project | all projects | deny',
      ].join('\n'),
    };
  }

  if (value === 'allow-edits') {
    ctx.store.setPermissionMode('acceptEdits');
    return { success: true, output: 'Tool edit policy changed to allow-edits.' };
  }

  if (!['allow', 'ask', 'deny', 'inherit', 'default'].includes(value)) {
    return {
      success: false,
      error: `Unknown tool policy: ${value}. Use one of: show, ask, allow, deny, inherit, allow-edits, audit.`,
    };
  }

  const toolConfirmation = ['inherit', 'default'].includes(value)
    ? null
    : (value as 'allow' | 'ask' | 'deny');
  if (ctx.sessionComposerControls) {
    try {
      const receipt = await ctx.sessionComposerControls.setPermissionOverride(toolConfirmation);
      if (snapshot.permissionMode === 'acceptEdits') ctx.store.setPermissionMode('default');
      return {
        success: true,
        output: `Session tool confirmation changed to ${receipt.current.effective} (${receipt.current.source}).`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Tool confirmation was not changed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (toolConfirmation === null) {
    return { success: false, error: 'Session permission inheritance is unavailable.' };
  }
  try {
    await updateDurableSettings(ctx, 'permissions', [
      { op: 'set', key: 'permissions.toolConfirmation', value: toolConfirmation },
    ]);
  } catch (error) {
    return {
      success: false,
      error: `Tool confirmation was not changed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (snapshot.permissionMode === 'acceptEdits') ctx.store.setPermissionMode('default');
  return { success: true, output: `Tool confirmation changed to ${toolConfirmation}.` };
}

function activeEffortProfile(ctx: CommandContext): ResolvedModelProfile | undefined {
  return getProfileByModelId(ctx.config.modelRegistry, ctx.store.getSnapshot().currentModel);
}

function parseEffortArgs(
  args: string
): { preference: EffortPreference | 'status'; scope: EffortScope } | { error: string } {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let scope: EffortScope = 'session';
  if (tokens.includes('--project') && tokens.includes('--global')) {
    return { error: 'Choose only one effort scope: --project or --global.' };
  }
  if (tokens.includes('--project')) scope = 'project';
  if (tokens.includes('--global')) scope = 'global';
  const values = tokens.filter(token => token !== '--project' && token !== '--global');
  if (values.length > 1) return { error: 'Usage: /effort <level> [--project|--global].' };
  const value = values[0]?.toLowerCase() ?? 'status';
  if (value === 'status') return { preference: 'status', scope };
  if (!isEffortPreference(value)) {
    return {
      error: `Unknown effort: ${value}. Use auto, none, minimal, low, medium, high, xhigh, or max.`,
    };
  }
  return { preference: value, scope };
}

async function handleEffort(ctx: CommandContext, args: string): Promise<CommandResult> {
  const parsed = parseEffortArgs(args);
  if ('error' in parsed) return { success: false, error: parsed.error };

  const profile = activeEffortProfile(ctx);
  const provider = profile ? ctx.config.modelRegistry?.providers.get(profile.provider) : undefined;
  const session = ctx.getSession?.() ?? null;
  const projectConfig = getProjectConfig(ctx.cwd);
  const globalConfig = loadGlobalConfig();
  const current = resolveProfileEffort(profile, {
    session: session?.effortPreference ?? ctx.store.getSnapshot().effortPreference,
    project: projectConfig.defaultEffort,
    global: globalConfig.defaultEffort ?? ctx.config.defaultEffort,
  });
  const previous = ctx.store.getSnapshot().effortPreference;

  if (parsed.preference === 'status') {
    return {
      success: true,
      output: [
        `Model: ${profile?.id ?? ctx.store.getSnapshot().currentModel}`,
        `Provider/protocol: ${provider?.id ?? 'legacy'}/${provider?.protocol ?? 'unknown'}`,
        `Requested/effective: ${current.requested}/${current.effective ?? 'provider-default'}`,
        `Supported: ${current.supported ? current.supportedLevels.join(', ') : 'unavailable'}`,
        ...(current.warning ? [`Reason: ${current.warning}`] : []),
      ].join('\n'),
      effortEvent: current.supported
        ? {
            type: 'effort_resolved',
            model: profile?.id ?? ctx.store.getSnapshot().currentModel,
            provider: provider?.id ?? 'legacy',
            requested: current.requested,
            effective: current.effective,
            supportedLevels: current.supportedLevels,
          }
        : {
            type: 'effort_unavailable',
            model: profile?.id ?? ctx.store.getSnapshot().currentModel,
            provider: provider?.id ?? 'legacy',
            requested: current.requested,
            reason: current.warning ?? 'capability not configured',
          },
    };
  }

  const next = resolveProfileEffort(profile, {
    ...(parsed.scope === 'session' ? { session: parsed.preference } : {}),
    ...(parsed.scope === 'project' ? { project: parsed.preference } : {}),
    ...(parsed.scope === 'global' ? { global: parsed.preference } : {}),
  });
  if (parsed.preference !== 'auto' && !next.supported) {
    return {
      success: false,
      error: `Effort is unavailable for ${profile?.id ?? 'the active model'}: ${next.warning ?? 'capability not configured'}.`,
    };
  }

  try {
    if (parsed.scope === 'session') {
      if (ctx.sessionComposerControls) {
        await ctx.sessionComposerControls.setEffort(parsed.preference);
      } else {
        const activeSession = session ?? ctx.ensureSession?.();
        if (!activeSession) {
          return { success: false, error: 'Cannot persist effort without an active session.' };
        }
        const persisted = updateSessionEffort(activeSession.id, parsed.preference);
        if (!persisted) {
          return { success: false, error: `Session ${activeSession.id} is no longer available.` };
        }
        if (persisted.effortPreference === undefined) delete activeSession.effortPreference;
        else activeSession.effortPreference = persisted.effortPreference;
      }
    } else {
      const key =
        parsed.scope === 'project'
          ? ('defaults.effort' as const)
          : ('defaults.globalEffort' as const);
      await updateDurableSettings(
        ctx,
        `effort-${parsed.scope}`,
        parsed.preference === 'auto'
          ? [{ op: 'unset', key }]
          : [{ op: 'set', key, value: parsed.preference }]
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Effort ${parsed.scope} preference was not changed: ${message}`,
    };
  }

  let effective = ctx.store.getSnapshot().resolvedEffort ?? current;
  if (parsed.scope === 'session' && !ctx.sessionComposerControls) {
    effective = resolveProfileEffort(profile, {
      session: parsed.preference,
      project: projectConfig.defaultEffort,
      global: globalConfig.defaultEffort ?? ctx.config.defaultEffort,
    });
    ctx.store.setEffort(effective.requested, effective);
    if (provider && typeof ctx.llm?.setEffortContext === 'function') {
      ctx.llm.setEffortContext({
        preference: effective.requested,
        protocol: provider.protocol,
        capability: profile?.reasoningCapability,
      });
    }
  }
  return {
    success: true,
    output: `Effort ${parsed.scope} preference changed to ${parsed.preference}; effective ${effective.effective ?? 'provider-default'}. Applies to the next logical request.`,
    effortEvent: {
      type: 'effort_changed',
      requested: parsed.preference,
      scope: parsed.scope,
      previous,
      effective: effective.effective,
      appliesFrom: 'next-logical-request',
    },
  };
}

export { handleModel, handleModels, handlePermissions, handleEffort, showConfig };
