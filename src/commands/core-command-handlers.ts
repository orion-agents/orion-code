/** Core slash-command presentation backed only by explicit runtime state. */

import chalk from 'chalk';

import type { LoopStats } from '../framework/query';
import { getAutoCompact } from '../services/compact/auto-compact';
import { formatBytes } from '../services/format';
import { resolveModelContext } from '../services/model-context';
import { endSession, readSessionMessages, updateSessionSummary } from '../services/session-storage';
import { loadProjectInstructionFiles } from '../services/project-instructions';
import { refreshProjectInstructions } from '../services/prompt-context';
import { createStatusSnapshot } from '../runtime/ui-view-model';
import type { CommandCategory, CommandContext, CommandResult, SlashCommand } from './types';

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const ERROR = chalk.red;
const WARN = chalk.yellow;
const SUCCESS = chalk.green;
const HEADER = chalk.cyan.bold;

const CATEGORY_ORDER: CommandCategory[] = [
  'workflow',
  'session',
  'context',
  'tools',
  'model',
  'system',
  'diagnostics',
  'legacy',
];

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  workflow: 'Workflow',
  session: 'Session',
  context: 'Context',
  tools: 'Tools',
  model: 'Model',
  system: 'System',
  diagnostics: 'Diagnostics',
  legacy: 'Legacy',
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function formatThreshold(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDurationMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatRendererStatus(ctx: CommandContext): string {
  const snapshot = createStatusSnapshot({
    renderer: ctx.uiRenderer ?? ctx.config.ui?.renderer ?? 'terminal',
    capabilities: ctx.uiCapabilities,
  });
  const status =
    snapshot.renderer.status === 'deprecated'
      ? WARN('deprecated')
      : snapshot.renderer.status === 'product'
        ? SUCCESS('product')
        : DIM(snapshot.renderer.status);
  return `${BRAND(snapshot.renderer.name)} ${status} ${DIM(snapshot.renderer.capabilityLabels.join(', '))}`;
}

function formatLoopBudgetSource(stats: LoopStats): string {
  const source = stats.loopBudgetSource ?? 'unknown';
  return source === 'config' && stats.loopBudgetBaseProfile
    ? `config over ${stats.loopBudgetBaseProfile}`
    : source;
}

function formatLoopStatsLines(stats: LoopStats): string[] {
  const lines = [
    `Finish     ${stats.finishReason}`,
    `Requests   ${stats.llmRequests} LLM / ${stats.turnsStarted} turns`,
    `Tools      ${stats.toolCalls} total (${stats.readOnlyToolCalls} read-only, ${stats.unsafeToolCalls} unsafe)`,
    `Tool bytes ${formatBytes(stats.modelVisibleToolBytes)} model-visible / ${formatBytes(stats.toolResultBytes)} total`,
  ];
  if (stats.summarizedBytes > 0) {
    lines.push(`Saved      ${formatBytes(stats.summarizedBytes)} from model context`);
  }
  if (stats.compactTrigger) lines.push(`Compact    ${stats.compactTrigger}`);
  if (stats.budgetExceededReason) lines.push(`Budget     ${stats.budgetExceededReason}`);
  if ((stats.providerRetryCount ?? 0) > 0) {
    lines.push(
      `Provider   ${stats.providerRetryCount} retries, delay ${formatDurationMs(stats.providerRetryDelayMs ?? 0)}`
    );
  }
  if (
    typeof stats.loopBudgetMaxLlmRequests === 'number' ||
    typeof stats.loopBudgetMaxToolCalls === 'number' ||
    typeof stats.loopBudgetMaxModelVisibleBytes === 'number'
  ) {
    const caps = [
      typeof stats.loopBudgetMaxLlmRequests === 'number'
        ? `${stats.llmRequests}/${stats.loopBudgetMaxLlmRequests} LLM`
        : undefined,
      typeof stats.loopBudgetMaxToolCalls === 'number'
        ? `${stats.toolCalls}/${stats.loopBudgetMaxToolCalls} tools`
        : undefined,
      typeof stats.loopBudgetMaxModelVisibleBytes === 'number'
        ? `${formatBytes(stats.modelVisibleToolBytes)}/${formatBytes(stats.loopBudgetMaxModelVisibleBytes)} visible`
        : undefined,
    ].filter(Boolean);
    lines.push(`Budget cap ${caps.join(', ')} (${formatLoopBudgetSource(stats)})`);
  }
  return lines;
}

function commandCategory(command: SlashCommand): CommandCategory {
  return command.category ?? 'system';
}

function getCommandCategoryLabel(category: CommandCategory | undefined): string {
  return CATEGORY_LABELS[category ?? 'system'];
}

function sortCommands<TCommand extends SlashCommand>(commands: TCommand[]): TCommand[] {
  return [...commands].sort((a, b) => {
    const categoryDelta =
      CATEGORY_ORDER.indexOf(commandCategory(a)) - CATEGORY_ORDER.indexOf(commandCategory(b));
    if (categoryDelta !== 0) return categoryDelta;
    const priorityDelta = (a.priority ?? 100) - (b.priority ?? 100);
    if (priorityDelta !== 0) return priorityDelta;
    return a.name.localeCompare(b.name);
  });
}

function showHelp(
  ctx: CommandContext,
  visible: SlashCommand[],
  includeAdvanced = false
): CommandResult {
  const lines: string[] = ['', HEADER('Commands:'), ''];
  for (const category of CATEGORY_ORDER) {
    const items = visible.filter(
      command =>
        commandCategory(command) === category &&
        (includeAdvanced || (command.audience ?? 'primary') === 'primary')
    );
    if (items.length === 0) continue;
    lines.push(DIM(getCommandCategoryLabel(category)));
    for (const command of items) {
      const aliases = command.aliases ? ` (${command.aliases.join(', ')})` : '';
      const params =
        command.argumentHint || command.params?.map(param => `<${param.name}>`).join(' ') || '';
      const availability = command.availability?.(ctx);
      const lifecycle =
        command.lifecycle?.status === 'deprecated'
          ? ` deprecated since ${command.lifecycle.since ?? 'unknown'}${command.lifecycle.replacement ? `; use ${command.lifecycle.replacement}` : ''}`
          : '';
      const risk = command.risk === 'destructive' ? ' destructive' : '';
      const unavailable =
        availability && !availability.available
          ? ` unavailable: ${availability.reason ?? 'requirements not met'}`
          : '';
      lines.push(`  ${ACCENT(`/${command.name}`)}${aliases} ${DIM(params)}`);
      lines.push(`    ${DIM(`${command.description}${lifecycle}${risk}${unavailable}`)}`);
    }
    lines.push('');
  }
  lines.push(DIM('Type any text without / prefix to start a runtime turn.'), '');
  return { success: true, output: lines.join('\n') };
}

function showStatus(ctx: CommandContext): CommandResult {
  const lines: string[] = ['', HEADER('System Status'), DIM('─'.repeat(40))];
  const modelId = ctx.llm?.getModel() ?? ctx.store.getSnapshot().currentModel ?? ctx.config.model;
  const modelContext = resolveModelContext(modelId);
  const compact = ctx.compactCoordinator?.getAutomatic() ?? getAutoCompact({ modelId });
  if (ctx.compactCoordinator) {
    ctx.compactCoordinator.configure({
      modelId,
      llm: ctx.llm,
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
    });
  }
  const compactStats = compact.getStats();
  const snapshot = ctx.store.getSnapshot();

  lines.push(`  Mode       ${BRAND(ctx.config.mode)}`);
  lines.push(`  Model      ${BRAND(modelId)}`);
  lines.push(
    `  Context    ${DIM(`${formatTokenCount(modelContext.contextWindow)} tokens (${modelContext.source})`)}`
  );
  lines.push(
    `  Compact    ${compactStats.enabled ? SUCCESS('auto') : WARN('off')} ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}`)}`
  );
  lines.push(`  Renderer   ${formatRendererStatus(ctx)}`);
  lines.push(`  Runtime    ${SUCCESS('Thread / StepSnapshot / ToolGateway')}`);
  lines.push(`  Completion ${SUCCESS('TaskContext')}`);

  refreshProjectInstructions(ctx.store, ctx.cwd);
  const instructionFiles = loadProjectInstructionFiles(ctx.cwd);
  lines.push('', '  Context:');
  lines.push(
    `    Project rules ${instructionFiles.length > 0 ? SUCCESS(`${instructionFiles.length} files`) : DIM('none')}`
  );
  lines.push(
    `    Memory       ${snapshot.memoryContent ? SUCCESS(`${snapshot.memoryContent.length} chars`) : DIM('none')}`
  );
  lines.push(
    `    Skill bodies ${snapshot.skillsContent ? ERROR('legacy resident') : SUCCESS('lazy / none resident')}`
  );
  if (snapshot.lastLoopStats) {
    lines.push('', '  Last loop:');
    for (const line of formatLoopStatsLines(snapshot.lastLoopStats)) lines.push(`    ${line}`);
  }
  if (snapshot.harnessState?.contract) {
    lines.push('', '  TaskContext:');
    lines.push(`    Objective  ${ACCENT(snapshot.harnessState.contract.objective)}`);
    lines.push(
      `    Evidence   ${DIM(`${snapshot.harnessState.evidenceIndex?.length ?? 0} records`)}`
    );
  }
  lines.push('');
  return { success: true, output: lines.join('\n') };
}

async function handleExit(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.sessionId) {
    const messages = readSessionMessages(ctx.sessionId);
    if (messages.length > 0) updateSessionSummary(ctx.sessionId, messages);
    endSession(ctx.sessionId);
  }
  ctx.requestShutdown?.('user request');
  return { success: true, output: 'Goodbye.' };
}

export { showHelp, showStatus, handleExit, sortCommands, getCommandCategoryLabel };
