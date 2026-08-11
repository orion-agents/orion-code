/** Handler implementations for the model-command-handlers boundary. */

import chalk from 'chalk';
import {
  AGENT_MODES,
  getModeDisplayText,
  type AgentMode,
  type CommandContext,
  type CommandResult,
} from './types';
import {
  createModelPickerState,
  createStatusSnapshot,
  type ModelPickerCandidate,
} from '../runtime/ui-view-model';
import { resolveProjectToolAllowlist } from '../services/tool-allowlist';
import { getAutoCompact } from '../services/compact/auto-compact';
import { resolveModelContext } from '../services/model-context';
import { maskSecret } from '../utils/mask';
import {
  getModelCatalogEntry,
  listModelCatalogEntries,
  resolveModelAlias,
} from '../services/model-catalog';
import { lookupProfile, type ResolvedModelProfile } from '../services/model-registry';
import { updateGlobalConfig } from '../services/global-config';
import { getProjectConfig, loadGlobalConfig, saveProjectConfig } from '../services/global-config';
import {
  isEffortPreference,
  resolveProfileEffort,
  type EffortPreference,
  type EffortScope,
} from '../services/effort';
import { updateSessionEffort } from '../services/session-storage';

// ============================================================================
// 颜色常量
// ============================================================================

const BRAND = chalk.hex('#FF6B35');

const ACCENT = chalk.hex('#00D4AA');

const DIM = chalk.dim;

const ERROR = chalk.red;

const WARN = chalk.yellow;

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

function handleModel(ctx: CommandContext, args: string): CommandResult {
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

  // /model list|ls|help 已移除，统一由 /models 承接（交互式选择切换）
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

  // 解析别名
  const registryProfile = resolveModelFromRegistry(ctx.config, args);
  const resolvedModel = registryProfile ? registryProfile.model : resolveModelAlias(args);
  const resolvedProfileId = registryProfile ? registryProfile.id : resolvedModel;

  ctx.llm.setModel(resolvedModel);
  if (registryProfile) {
    const provider = ctx.config.modelRegistry?.providers.get(registryProfile.provider);
    if (provider && typeof ctx.llm.setEffortContext === 'function') {
      ctx.llm.setEffortContext({
        preference: ctx.store.getSnapshot().effortPreference,
        protocol: provider.protocol,
        capability: registryProfile.reasoningCapability,
      });
    }
  }
  getCommandAutoCompact(ctx, resolvedModel);
  ctx.store.setState({ currentModel: resolvedProfileId });
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
 * /models — 交互式选择切换模型。
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

function handleMode(ctx: CommandContext, args: string): CommandResult {
  const current = ctx.store.getSnapshot().agentMode;
  const trimmed = args.trim();

  if (!trimmed || trimmed === '?' || trimmed === 'help') {
    return {
      success: true,
      output: [
        '',
        HEADER('Agent Mode'),
        DIM('─'.repeat(40)),
        `  Current  ${ACCENT(current)} ${DIM(getModeDisplayText(current))}`,
        '',
        `  ${ACCENT('/mode interactive')}    Normal agent workflow`,
        `  ${ACCENT('/mode plan')}           Plan first; block execution and edits`,
        `  ${ACCENT('/mode auto')}           Auto-run actions allowed by tool policy`,
        `  ${DIM('Tool approval is configured separately with /permissions.')}`,
        '',
      ].join('\n'),
    };
  }

  const normalized = trimmed.toLowerCase();
  if (['accept', 'acceptedits', 'accept-edits', 'edit'].includes(normalized)) {
    ctx.store.setPermissionMode('acceptEdits');
    return {
      success: true,
      output:
        'Legacy /mode accept-edits mapped to tool policy only. Agent mode was unchanged. Use /permissions allow-edits.',
    };
  }

  const next: AgentMode | null =
    normalized === 'next'
      ? AGENT_MODES[(AGENT_MODES.indexOf(current) + 1) % AGENT_MODES.length]
      : normalized === 'default'
        ? 'interactive'
        : normalized === 'readonly' || normalized === 'read-only'
          ? 'plan'
          : normalized === 'full-auto'
            ? 'auto'
            : AGENT_MODES.includes(normalized as AgentMode)
              ? (normalized as AgentMode)
              : null;

  if (!next) {
    return {
      success: false,
      error: `Unknown agent mode: ${trimmed}. Use one of: interactive, plan, auto, next.`,
    };
  }

  ctx.store.setAgentMode(next);
  const display = getModeDisplayText(next);
  return {
    success: true,
    output: `Mode changed to ${next}${display ? ` (${display})` : ''}.`,
  };
}

function handlePermissions(ctx: CommandContext, args: string): CommandResult {
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

  if (!['allow', 'ask', 'deny'].includes(value)) {
    return {
      success: false,
      error: `Unknown tool policy: ${value}. Use one of: show, ask, allow, deny, allow-edits, audit.`,
    };
  }

  const toolConfirmation = value as 'allow' | 'ask' | 'deny';
  updateGlobalConfig({ toolConfirmation });
  ctx.config.toolConfirmation = toolConfirmation;
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

function handleEffort(ctx: CommandContext, args: string): CommandResult {
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
    } else if (parsed.scope === 'project') {
      saveProjectConfig(ctx.cwd, {
        ...projectConfig,
        defaultEffort: parsed.preference === 'auto' ? undefined : parsed.preference,
      });
    } else {
      updateGlobalConfig({
        defaultEffort: parsed.preference === 'auto' ? undefined : parsed.preference,
      });
      ctx.config.defaultEffort = parsed.preference === 'auto' ? undefined : parsed.preference;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Effort ${parsed.scope} preference was not changed: ${message}`,
    };
  }

  const effective = resolveProfileEffort(profile, {
    session: parsed.scope === 'session' ? parsed.preference : session?.effortPreference,
    project: parsed.scope === 'project' ? parsed.preference : projectConfig.defaultEffort,
    global:
      parsed.scope === 'global'
        ? parsed.preference
        : (globalConfig.defaultEffort ?? ctx.config.defaultEffort),
  });
  const previous = ctx.store.getSnapshot().effortPreference;
  ctx.store.setEffort(parsed.preference, effective);
  if (provider && typeof ctx.llm?.setEffortContext === 'function') {
    ctx.llm?.setEffortContext({
      preference: parsed.preference,
      protocol: provider.protocol,
      capability: profile?.reasoningCapability,
    });
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

export { handleModel, handleModels, handleMode, handlePermissions, handleEffort, showConfig };
