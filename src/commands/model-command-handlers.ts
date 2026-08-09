/** Handler implementations for the model-command-handlers boundary. */

import chalk from 'chalk';
import {
  PERMISSION_MODES,
  getModeDisplayText,
  getNextPermissionMode,
  type CommandContext,
  type CommandResult,
  type PermissionMode,
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
    console.log(HEADER('  Project allowedTools:'));
    for (const rule of allowlist.rules) {
      console.log(
        `  ${ACCENT(rule.effect.padEnd(6))} ${DIM(rule.tool)}${DIM(rule.pattern ? `(${rule.pattern})` : '')}`
      );
    }
    for (const entry of allowlist.invalid) {
      console.log(`  ${WARN('invalid')} ${DIM(entry)}`);
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

  // 显示当前模型
  if (!args || trimmedArgs === '?' || trimmedArgs === 'info') {
    console.log();
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
      console.log(HEADER('Current Model'));
      console.log(DIM('─'.repeat(40)));
      console.log(`  Model    ${BRAND(currentModel)}`);
      if (profile) {
        console.log(
          `  Alias    ${ACCENT(profile.aliases?.[0] ? `(${profile.aliases[0]})` : 'none')}`
        );
        const provider = ctx.config.modelRegistry?.providers.get(profile.provider);
        console.log(`  Provider ${DIM(provider?.displayName || profile.provider)}`);
      } else if (aliasEntry) {
        console.log(`  Alias    ${ACCENT(aliasEntry.alias)}`);
        console.log(`  Provider ${DIM(aliasEntry.provider)}`);
      }
      console.log(`  Context  ${DIM(`${formatTokenCount(contextInfo.contextWindow)} tokens`)}`);
      if (contextInfo.maxOutputTokens) {
        console.log(`  Output   ${DIM(`${formatTokenCount(contextInfo.maxOutputTokens)} tokens`)}`);
      }
      console.log(
        `  Source   ${DIM(`${contextInfo.source}${contextInfo.source === 'fuzzy' ? `:${contextInfo.matchedId}` : ''}`)}`
      );
      console.log(
        `  Compact  ${compactStats.enabled ? SUCCESS('auto') : WARN('off')} ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}`)}`
      );
    } else {
      console.log(ERROR('LLM not initialized. Set ORION_CODE_API_KEY first.'));
    }
    console.log();
    return { success: true };
  }

  // /model list|ls|help 已移除，统一由 /models 承接（交互式选择切换）
  if (trimmedArgs === 'list' || trimmedArgs === 'ls' || trimmedArgs === 'help') {
    console.log();
    console.log(WARN(`/model ${trimmedArgs} was removed.`));
    console.log(DIM('Use /models to switch models interactively,'));
    console.log(DIM('or /model <name|alias> to switch directly, e.g. /model sonnet'));
    console.log();
    return { success: true };
  }

  // 设置模型
  if (!ctx.llm) {
    console.log(ERROR('LLM not initialized. Set ORION_CODE_API_KEY first.'));
    console.log();
    return { success: false };
  }

  // 解析别名
  const registryProfile = resolveModelFromRegistry(ctx.config, args);
  const resolvedModel = registryProfile ? registryProfile.model : resolveModelAlias(args);
  const resolvedProfileId = registryProfile ? registryProfile.id : resolvedModel;

  ctx.llm.setModel(resolvedModel);
  getCommandAutoCompact(ctx, resolvedModel);
  ctx.store.setState({ currentModel: resolvedProfileId });
  console.log(SUCCESS(`✔ Model changed to ${BRAND(resolvedProfileId)}`));
  const contextInfo = registryProfile
    ? {
        contextWindow: registryProfile.resolvedContextWindow,
        maxOutputTokens: registryProfile.resolvedMaxOutputTokens,
        source: 'resolved',
      }
    : resolveModelContext(resolvedModel);
  console.log(
    DIM(
      `  Context window ${formatTokenCount(contextInfo.contextWindow)} tokens (${contextInfo.source})`
    )
  );
  console.log();
  return { success: true };
}

/**
 * /models — 交互式选择切换模型。
 * 交互式渲染器返回结构化 modelPicker 请求（渲染器弹出选择层，选中即 /model <id>）；
 * 非交互式渲染器直接打印候选列表并提示 /model <name|alias>。
 */
function handleModels(ctx: CommandContext, _args: string): CommandResult {
  console.log();
  const currentModel = ctx.store.getSnapshot().currentModel || ctx.llm?.getModel() || '';
  const configuredModels = listConfiguredModelCatalogEntries(ctx.config.modelRegistry);

  const candidates: ModelPickerCandidate[] =
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

  // 非交互式渲染器：打印候选列表
  console.log(HEADER('Available Models'));
  console.log(DIM('─'.repeat(40)));
  const modelPicker = createModelPickerState({ currentModel, models: candidates });
  for (const item of modelPicker.visibleItems) {
    const marker = item.isCurrent ? SUCCESS('●') : DIM('○');
    const alias = item.alias ? `(${item.alias})` : '';
    const context = `${formatTokenCount(item.contextWindow ?? 0)} ctx`;
    const current = item.isCurrent ? BRAND('(current)') : '';
    console.log(`  ${marker} ${ACCENT(item.name)} ${DIM(alias)} ${DIM(context)} ${current}`);
    console.log(`      ${DIM(item.provider ?? 'unknown')}`);
  }
  console.log();
  console.log(DIM('Use /model <name|alias> to switch, e.g. /model sonnet'));
  console.log();
  return { success: true };
}

function normalizePermissionMode(raw: string): PermissionMode | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (
    value === 'accept' ||
    value === 'acceptedits' ||
    value === 'accept-edits' ||
    value === 'edit'
  ) {
    return 'acceptEdits';
  }
  if (value === 'default' || value === 'ask') return 'default';
  if (value === 'plan' || value === 'readonly' || value === 'read-only') return 'plan';
  if (value === 'auto' || value === 'full-auto') return 'auto';
  return null;
}

function handleMode(ctx: CommandContext, args: string): CommandResult {
  const current = ctx.store.getSnapshot().permissionMode;
  const trimmed = args.trim();

  if (!trimmed || trimmed === '?' || trimmed === 'help') {
    console.log();
    console.log(HEADER('Permission Mode'));
    console.log(DIM('─'.repeat(40)));
    console.log(
      `  Current  ${ACCENT(current)} ${DIM(getModeDisplayText(current) || 'ask before sensitive actions')}`
    );
    console.log();
    console.log(`  ${ACCENT('/mode next')}           Cycle to the next mode`);
    console.log(`  ${ACCENT('/mode default')}        Ask before sensitive actions`);
    console.log(`  ${ACCENT('/mode accept-edits')}   Auto-accept file edits`);
    console.log(`  ${ACCENT('/mode plan')}           Plan first, avoid executing edits`);
    console.log(`  ${ACCENT('/mode auto')}           Auto-run allowed actions`);
    console.log();
    return { success: true };
  }

  const next =
    trimmed === 'next' ? getNextPermissionMode(current) : normalizePermissionMode(trimmed);

  if (!next || !PERMISSION_MODES.includes(next)) {
    return {
      success: false,
      error: `Unknown mode: ${trimmed}. Use one of: default, accept-edits, plan, auto, next.`,
    };
  }

  ctx.store.setPermissionMode(next);
  const display = getModeDisplayText(next);
  return {
    success: true,
    output: `Mode changed to ${next}${display ? ` (${display})` : ''}.`,
  };
}

export { handleModel, handleModels, handleMode, showConfig };
