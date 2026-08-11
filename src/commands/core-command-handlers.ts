/** Handler implementations for the core-command-handlers boundary. */

import chalk from 'chalk';
import {
  type SlashCommand,
  type CommandCategory,
  type CommandContext,
  type CommandResult,
} from './types';
import { createStatusSnapshot } from '../runtime/ui-view-model';
import type { Task } from '../core/agent';
import { TaskCapacityError, TaskManager, CreateTaskOptions } from '../services/task-manager';
import { AgentRunner } from '../services/agent-runner';
import { isConfigured } from '../services/config';
import { errorMessage } from '../utils/errors';
import { resolveProjectToolAllowlist } from '../services/tool-allowlist';
import { createSpinner, toolLine } from '../ui/box';
import { createStreamRenderer, type StreamMarkdownRenderer } from '../ui/stream-markdown';
import { hideProgress, showToolProgress } from '../ui/progress';
import { formatBytes } from '../services/format';
import { query, getSystemPrompt, type LoopStats, type PromptContext } from '../framework';
import { executeTool, getRuntimeTools } from '../tools';
import type { Message, StreamCallbacks } from '../services/llm';
import {
  loadSessionMeta,
  appendSessionMessage,
  appendSessionMessages,
  endSession,
  updateSessionSummary,
  updateSessionHarnessState,
  updateSessionSkills,
  readSessionMessages,
  type SessionMessage,
} from '../services/session-storage';
import { getAutoCompact } from '../services/compact/auto-compact';
import { createContextHarness } from '../harness';
import { resolveSkillsForTurn } from '../skills';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { loadProjectInstructionFiles } from '../services/project-instructions';
import { refreshProjectInstructions } from '../services/prompt-context';
import { resolveModelContext } from '../services/model-context';
import { agentStepStatus, runningToolsStatus } from '../runtime/agent-status';
import { resolveRuntimeLoopBudget } from '../runtime/loop-budget';

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

function formatDurationMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
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
        : snapshot.renderer.status === 'technical'
          ? DIM('technical')
          : snapshot.renderer.status === 'non-interactive'
            ? DIM('non-interactive')
            : DIM('custom');

  return `${BRAND(snapshot.renderer.name)} ${status} ${DIM(snapshot.renderer.capabilityLabels.join(', '))}`;
}

function formatLoopBudgetSource(stats: LoopStats): string {
  const source = stats.loopBudgetSource ?? 'unknown';
  if (source === 'config' && stats.loopBudgetBaseProfile) {
    return `config over ${stats.loopBudgetBaseProfile}`;
  }
  return source;
}

function formatLoopStatsLines(stats: LoopStats, detail = false): string[] {
  const lines = [
    `Finish     ${stats.finishReason}`,
    `Requests   ${stats.llmRequests} LLM / ${stats.turnsStarted} turns`,
    `Tools      ${stats.toolCalls} total (${stats.readOnlyToolCalls} read-only, ${stats.unsafeToolCalls} unsafe)`,
    `Tool bytes ${formatBytes(stats.modelVisibleToolBytes)} model-visible / ${formatBytes(stats.toolResultBytes)} total`,
  ];

  if (stats.summarizedBytes > 0) {
    lines.push(`Saved      ${formatBytes(stats.summarizedBytes)} from model context`);
  }
  if (stats.compactTrigger) {
    lines.push(`Compact    ${stats.compactTrigger}`);
  }
  if (stats.localFastPathUsed) {
    lines.push('Fast path  yes');
  }
  if (stats.budgetExceededReason) {
    lines.push(`Budget     ${stats.budgetExceededReason}`);
  }
  if (stats.continuationActions && stats.continuationActions.length > 0) {
    lines.push(`Next       ${stats.continuationActions.join(', ')}`);
  }
  if ((stats.providerRetryCount ?? 0) > 0) {
    const retryParts = [
      `${stats.providerRetryCount} retries`,
      `delay ${formatDurationMs(stats.providerRetryDelayMs ?? 0)}`,
      stats.providerLastRetryErrorType
        ? `last ${stats.providerLastRetryErrorType}${stats.providerLastRetryStatus ? `/${stats.providerLastRetryStatus}` : ''}`
        : undefined,
    ].filter(Boolean);
    lines.push(`Provider   ${retryParts.join(', ')}`);
  }
  if ((stats.providerFallbackCount ?? 0) > 0 || stats.providerUsingFallback) {
    const fallbackPath =
      stats.providerFallbackFromModel && stats.providerFallbackToModel
        ? `${stats.providerFallbackFromModel} -> ${stats.providerFallbackToModel}`
        : stats.providerFinalModel
          ? `final ${stats.providerFinalModel}`
          : 'active';
    lines.push(`Fallback   ${fallbackPath}`);
  }
  if (typeof stats.verificationClaimAllowed === 'boolean') {
    const verificationParts = [
      stats.verificationProfile ?? 'unknown',
      `required=${stats.verificationRequired ? 'yes' : 'no'}`,
      `passed=${stats.verificationPassedCommands?.length ?? 0}`,
      `failed=${stats.verificationFailedCommands?.length ?? 0}`,
      `missing=${stats.verificationMissingCommands?.length ?? 0}`,
      `claim=${stats.verificationClaimAllowed ? 'yes' : 'no'}`,
    ];
    lines.push(`Verify     ${verificationParts.join(' ')}`);
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
      typeof stats.loopBudgetMaxReadOnlyFragmentation === 'number'
        ? `fragment ${stats.singleReadOnlyStreak}/${stats.loopBudgetMaxReadOnlyFragmentation}`
        : undefined,
    ].filter(Boolean);
    lines.push(`Budget cap ${caps.join(', ')} (${formatLoopBudgetSource(stats)})`);
  }
  if (stats.singleReadOnlyStreak > 0 || stats.batchReadSuggestionCount > 0) {
    lines.push(
      `Read-only  streak ${stats.singleReadOnlyStreak}, batch_read hints ${stats.batchReadSuggestionCount}`
    );
  }

  if (detail) {
    lines.push(`Unsafe     ${stats.unsafeToolCalls}`);
    if (stats.providerRetryErrorTypes && stats.providerRetryErrorTypes.length > 0) {
      lines.push(`Retry type ${stats.providerRetryErrorTypes.join(', ')}`);
    }
    if (stats.verificationFailedCommands && stats.verificationFailedCommands.length > 0) {
      lines.push(`Failed     ${stats.verificationFailedCommands.join(' && ')}`);
    }
    if (stats.verificationMissingCommands && stats.verificationMissingCommands.length > 0) {
      lines.push(`Missing    ${stats.verificationMissingCommands.join(' && ')}`);
    }
    if (stats.verificationSkippedReason) {
      lines.push(`Verify why ${stats.verificationSkippedReason}`);
    }
    if (stats.continuationHint) {
      lines.push(`Next why   ${stats.continuationHint}`);
    }
    lines.push(`Budget hit ${stats.finishReason === 'budget_exceeded' ? 'yes' : 'no'}`);
  }

  return lines;
}

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

function isAbortError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
  }
  return false;
}

// ============================================================================
// 工具参数摘要
// ============================================================================

// ============================================================================
// 命令实现
// ============================================================================

let taskManager: TaskManager | null = null;

function showHelp(
  ctx: CommandContext,
  visible: SlashCommand[],
  includeAdvanced = false
): CommandResult {
  const lines: string[] = ['', HEADER('Commands:'), ''];
  const write = (line = ''): void => {
    lines.push(line);
  };

  for (const category of CATEGORY_ORDER) {
    const items = visible.filter(
      cmd =>
        commandCategory(cmd) === category &&
        (includeAdvanced || (cmd.audience ?? 'primary') === 'primary')
    );
    if (items.length === 0) continue;

    write(DIM(getCommandCategoryLabel(category)));
    for (const cmd of items) {
      const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : '';
      const params = cmd.argumentHint || cmd.params?.map(p => `<${p.name}>`).join(' ') || '';
      const lifecycle =
        cmd.lifecycle?.status === 'deprecated'
          ? ` deprecated since ${cmd.lifecycle.since ?? 'unknown'}${cmd.lifecycle.replacement ? `; use ${cmd.lifecycle.replacement}` : ''}${cmd.lifecycle.removeIn ? `; remove in ${cmd.lifecycle.removeIn}` : ''}`
          : cmd.deprecated
            ? ` deprecated since ${cmd.deprecated.since}${cmd.deprecated.replacement ? `; use ${cmd.deprecated.replacement}` : ''}`
            : '';
      const risk = cmd.risk === 'destructive' ? ' destructive' : '';
      const availability = cmd.availability?.(ctx);
      const unavailable =
        availability && !availability.available
          ? ` unavailable: ${availability.reason ?? 'requirements not met'}`
          : '';
      write(`  ${ACCENT(`/${cmd.name}`)}${aliases} ${DIM(params)}`);
      write(`    ${DIM(`${cmd.description}${lifecycle}${risk}${unavailable}`)}`);
    }
    write();
  }

  write(DIM('Type any text without / prefix to chat with the LLM.'));
  write();
  return { success: true, output: lines.join('\n') };
}

function showStatus(ctx: CommandContext): CommandResult {
  const lines: string[] = ['', HEADER('System Status'), DIM('─'.repeat(40))];
  const write = (line = ''): void => {
    lines.push(line);
  };

  const brainStatus = ctx.runtime.brain.getStatus();
  const memStatus = ctx.runtime.memory.getStatus();
  const storeStats = ctx.runtime.store.getStats();

  write(`  Mode       ${BRAND(ctx.config.mode)}`);
  write(`  Log level  ${DIM(ctx.config.logLevel)}`);
  const modelId = ctx.llm?.getModel() ?? snapshotCurrentModel(ctx);
  const modelContext = resolveModelContext(modelId);
  const compactStats = getCommandAutoCompact(ctx, modelId).getStats();
  write(`  Model      ${BRAND(modelId)}`);
  const effort = ctx.store.getSnapshot().resolvedEffort;
  write(
    `  Effort     ${DIM(effort ? `${effort.requested}/${effort.effective ?? 'provider-default'}` : 'auto/provider-default')}`
  );
  write(
    `  Context    ${DIM(`${formatTokenCount(modelContext.contextWindow)} tokens (${modelContext.source}${modelContext.source === 'fuzzy' ? `:${modelContext.matchedId}` : ''})`)}`
  );
  write(
    `  Compact    ${compactStats.enabled ? SUCCESS('auto') : WARN('off')} ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}, used ${compactStats.ctxPercent}%`)}`
  );
  write(`  Renderer   ${formatRendererStatus(ctx)}`);
  write();
  write(`  Agents     ${SUCCESS(brainStatus.agents.length)} registered`);
  write(`  Tasks      ${brainStatus.pendingTasks} pending (${brainStatus.strategy} strategy)`);
  write();
  write('  Memory (inline):');
  write(`    Working    ${memStatus.working} entries`);
  write(`    Short-term ${memStatus['short-term']} entries`);
  write(`    Long-term  ${memStatus['long-term']} entries`);
  write();
  write('  Memory (store):');
  write(`    Working    ${storeStats.working} entries`);
  write(`    Short-term ${storeStats['short-term']} entries`);
  write(`    Long-term  ${storeStats['long-term']} entries`);

  refreshProjectInstructions(ctx.store, ctx.cwd);
  const snapshot = ctx.store.getSnapshot();
  const instructionFiles = loadProjectInstructionFiles(ctx.cwd);
  write();
  write('  Context:');
  write(
    `    Project rules ${instructionFiles.length > 0 ? SUCCESS(`${instructionFiles.length} files`) : DIM('none')}`
  );
  for (const file of instructionFiles.slice(0, 8)) {
    write(`      ${DIM(file.path)}${file.truncated ? ` ${WARN('(truncated)')}` : ''}`);
  }
  if (instructionFiles.length > 8) {
    write(`      ${DIM(`... ${instructionFiles.length - 8} more`)}`);
  }
  write(
    `    Prompt rules  ${snapshot.projectInstructionsContent ? SUCCESS(`${snapshot.projectInstructionsContent.length} chars`) : DIM('none')}`
  );
  write(
    `    Project memory ${snapshot.memoryContent ? SUCCESS(`${snapshot.memoryContent.length} chars`) : DIM('none')}`
  );
  write(
    `    Skills index   ${snapshot.skillsContent ? SUCCESS(`${snapshot.skillsContent.length} chars`) : DIM('none')}`
  );

  if (snapshot.lastLoopStats) {
    const stats = snapshot.lastLoopStats;
    write();
    write('  Last loop:');
    for (const line of formatLoopStatsLines(stats)) {
      write(`    ${line}`);
    }
  }

  const harnessState = snapshot.harnessState;
  if (harnessState?.contract || harnessState?.capsule) {
    write();
    write('  Harness:');
    if (harnessState.contract) {
      write(`    Objective  ${ACCENT(harnessState.contract.objective)}`);
    }
    write(`    Ledger     ${DIM(`${harnessState.ledger.length} entries`)}`);
    if (harnessState.capsule) {
      write(`    Next       ${DIM(harnessState.capsule.nextAction)}`);
      const passed = harnessState.capsule.verification.passed.length;
      const failed = harnessState.capsule.verification.failed.length;
      write(
        `    Verify     ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`
      );
    }
  }
  write();
  return { success: true, output: lines.join('\n') };
}

function snapshotCurrentModel(ctx: CommandContext): string {
  return ctx.store.getSnapshot().currentModel || ctx.config.model;
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

function handleTask(ctx: CommandContext, args: string): CommandResult {
  const [sub] = args.trim().split(/\s+/);

  if (sub === 'list' || sub === 'ls') {
    if (!taskManager) {
      taskManager = new TaskManager();
    }

    console.log();
    console.log(HEADER('Task List'));
    console.log(DIM('─'.repeat(40)));

    const stats = taskManager.getStats();
    console.log(`  Total      ${stats.total}`);
    console.log(`  Pending    ${stats.pending}`);
    console.log(`  Running    ${stats.running}`);
    console.log(`  Completed  ${SUCCESS(stats.completed)}`);
    console.log(`  Failed     ${ERROR(stats.failed)}`);
    console.log(`  Cancelled  ${DIM(stats.cancelled)}`);

    const tasks = taskManager.list();
    if (tasks.length > 0) {
      console.log();
      for (const t of tasks) {
        const statusIcon =
          t.status === 'completed'
            ? SUCCESS('✓')
            : t.status === 'failed'
              ? ERROR('✗')
              : t.status === 'running'
                ? WARN('◌')
                : t.status === 'cancelled'
                  ? DIM('⊘')
                  : DIM('○');
        console.log(`  ${statusIcon} ${ACCENT(t.name)} ${DIM(`(${t.id.slice(0, 8)})`)}`);
        console.log(`    ${DIM(`[${t.priority}]`)} ${t.description.slice(0, 60)}`);
      }
    }
    console.log();
    return { success: true };
  }

  // 默认行为: 作为任务名提交
  const taskName = args.trim() || 'demo-task';
  const task: Task = {
    id: `cli-${Date.now()}`,
    name: taskName,
    description: `Task submitted from CLI: ${taskName}`,
    priority: 'P1',
    assignedTo: 'leader',
    status: 'pending',
  };

  console.log();
  ctx.runtime.brain.submitTask(task);
  console.log(SUCCESS(`✔ Task "${taskName}" submitted`));
  console.log();
  return { success: true };
}

async function handleRun(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (!args.trim()) {
    console.log(ERROR('Usage: /run <task description>'));
    console.log(DIM('  Creates a task and executes it through the Agent + LLM pipeline.'));
    console.log();
    return { success: false };
  }

  if (!ctx.llm || !isConfigured(ctx.config)) {
    console.log(WARN('⚠ LLM not configured. Set ORION_CODE_API_KEY in .env to enable run mode.'));
    console.log();
    return { success: false };
  }

  if (!taskManager) {
    taskManager = new TaskManager();
  }

  const taskOptions: CreateTaskOptions = {
    name: args.slice(0, 80),
    description: args,
    priority: 'P1',
    assignedTo: 'leader',
    tags: ['cli', 'interactive'],
  };

  let record;
  try {
    record = taskManager.create(taskOptions);
  } catch (error) {
    if (error instanceof TaskCapacityError) {
      console.log(ERROR(`✗ ${error.message}`));
      console.log();
      return { success: false };
    }
    throw error;
  }
  console.log();
  console.log(SUCCESS(`✔ Task created: ${ACCENT(record.name)}`));
  console.log(DIM(`  ID: ${record.id} | Tags: ${record.tags.join(', ')}`));

  taskManager.start(record.id);
  console.log(WARN('◌ Running task through Agent + LLM...'));

  try {
    const agent = ctx.runtime.agents[0];
    if (!agent) {
      throw new Error('No agents registered');
    }

    const runner = new AgentRunner(agent, ctx.llm);
    const task = taskManager.toTask(record);
    const result = await runner.run(task);

    if (result.success) {
      taskManager.complete(record.id, result);
      console.log(SUCCESS(`✓ Task completed in ${result.duration}ms`));
      if (result.tokenUsage) {
        console.log(
          DIM(
            `  Tokens: ${result.tokenUsage.promptTokens} in / ${result.tokenUsage.completionTokens} out`
          )
        );
      }
      if (result.data?.summary) {
        console.log();
        console.log(ACCENT('  Summary:'));
        console.log(`  ${result.data.summary}`);
      }
    } else {
      taskManager.fail(record.id, result.error, result);
      console.log(ERROR(`✗ Task failed: ${result.error}`));
    }
  } catch (error) {
    const message = errorMessage(error);
    taskManager.fail(record.id, message);
    console.log(ERROR(`✗ Task error: ${message}`));
  }

  console.log();
  return { success: true };
}

async function handleChat(ctx: CommandContext, input: string): Promise<CommandResult> {
  const ui = commandUICapabilities(ctx);
  const writeOutput = ctx.writeOutput ?? ((text: string) => process.stdout.write(text));
  const writeLine = ctx.writeLine ?? ((text: string = '') => console.log(text));

  if (!input) {
    console.log(ERROR('Usage: /chat <message>'));
    console.log();
    return { success: false };
  }

  if (!ctx.llm || !isConfigured(ctx.config)) {
    console.log(WARN('⚠ LLM not configured. Set ORION_CODE_API_KEY in .env to enable chat.'));
    console.log();
    return { success: false };
  }

  const activeSession =
    ctx.getSession?.() ??
    ctx.ensureSession?.() ??
    (ctx.sessionId ? loadSessionMeta(ctx.sessionId) : null);
  const sessionId = activeSession?.id ?? ctx.sessionId;
  const runtimeTools = getRuntimeTools();
  const skillResolution = resolveSkillsForTurn({
    cwd: ctx.cwd,
    input,
    tools: runtimeTools,
    projectPath: activeSession?.projectPath,
    sessionId,
  });
  const appliedSkillNames = skillResolution.skills.map(skill => skill.name);

  // Record user message to session
  if (sessionId) {
    appendSessionMessage(sessionId, {
      role: 'user',
      content: input,
      timestamp: Date.now(),
      appliedSkills: appliedSkillNames.length > 0 ? appliedSkillNames : undefined,
    });
  }

  ctx.store.addMessage({ role: 'user', content: input });
  refreshProjectInstructions(ctx.store, ctx.cwd);
  const snapshot = ctx.store.getSnapshot();
  const harness = createContextHarness({
    cwd: ctx.cwd,
    modelId: ctx.llm.getModel(),
    state: snapshot.harnessState,
    config: {
      enabled: true,
      driftGuard: 'warn',
      completionGate: true,
    },
  });
  const intent = harness.updateContractFromUserInput(input);
  harness.recordAppliedSkills(skillResolution.skills);

  const promptCtx: PromptContext = {
    cwd: ctx.cwd,
    platform: process.platform,
    nodeVersion: process.version,
    tools: skillResolution.tools,
    memoryContent: snapshot.memoryContent,
    skillsContent: snapshot.skillsContent,
    projectInstructionsContent: snapshot.projectInstructionsContent,
    activeSkillsContent: skillResolution.promptInjection,
    referencedFilesContent: buildReferencedFilesPrompt(input, ctx.cwd),
  };
  const systemPrompt = getSystemPrompt(promptCtx);

  const spinner = createSpinner();
  const useSpinner = !ui.inlineProgress;
  if (useSpinner) {
    spinner.start('Thinking');
  }

  let finalContent = '';
  let finalModel = '';
  let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
  let responseStarted = false;
  const sessionMessagesToRecord: SessionMessage[] = [];

  // Issue #22: 批量工具调用进度显示
  let toolCallCount = 0;
  let lastProgressUpdate = 0;

  // 流式 Markdown 渲染器
  let streamRenderer: StreamMarkdownRenderer | null = null;

  // Issue #32 #3.2: toolExecutor 支持 abortSignal
  const toolExecutor = async (
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal
  ) => {
    if (!skillResolution.tools.some(tool => tool.name === name)) {
      return JSON.stringify({
        success: false,
        error: skillResolution.toolScopeActive
          ? `Tool ${name} is not available for the active skill scope. Available tools: ${skillResolution.tools.map(tool => tool.name).join(', ') || 'none'}`
          : `Tool ${name} is not available.`,
      });
    }
    const result = await executeTool(name, args, abortSignal, {
      cwd: ctx.cwd,
      config: {
        name: ctx.config.name,
        mode: ctx.config.mode,
      },
      sessionId,
      turnId: ctx.turnId,
      // Tools that fan out to other tools (batch_read) have to re-run the
      // permission gate per sub-step; they need the mode and the allowlist.
      permissionMode: ctx.store.getEffectivePermissionMode(),
      toolAllowlist: resolveProjectToolAllowlist(ctx.cwd).evaluator,
    });
    // 不在这里打印，让 tool_result 事件处理
    return result;
  };

  const streamCallbacks: StreamCallbacks = {
    onChunk: (chunk: string) => {
      if (ctx.abortSignal?.aborted) {
        return;
      }

      if (!responseStarted) {
        responseStarted = true;
        spinner.stop();
        // 打印换行，让流式输出在新行开始
        writeLine();
        // 初始化流式渲染器
        streamRenderer = createStreamRenderer();
      }
      // 使用流式渲染器处理 chunk
      if (streamRenderer) {
        const rendered = streamRenderer.feed(chunk);
        if (rendered) {
          writeOutput(rendered);
        }
      } else {
        writeOutput(chunk);
      }
    },
  };

  try {
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...snapshot.conversationHistory,
    ];

    for await (const event of query({
      messages,
      tools: skillResolution.tools,
      toolExecutor,
      llm: ctx.llm,
      streamCallbacks,
      costTracker: snapshot.costTracker,
      permissionMode: ctx.store.getEffectivePermissionMode(),
      toolConfirmation: ctx.config.toolConfirmation,
      toolAllowlist: resolveProjectToolAllowlist(ctx.cwd).evaluator,
      toolContext: {
        cwd: ctx.cwd,
        config: {
          name: ctx.config.name,
          mode: ctx.config.mode,
        },
        sessionId,
        turnId: ctx.turnId,
      },
      abortSignal: ctx.abortSignal,
      harness,
      input,
      loopBudget: resolveRuntimeLoopBudget(input, ctx.config, harness.toJSON()),
    })) {
      switch (event.type) {
        case 'request_start':
          // 停止 spinner，等待 LLM 响应
          spinner.stop();
          writeLine();
          writeLine(DIM(agentStepStatus(event.turn)));
          // 重置流式渲染器
          streamRenderer = createStreamRenderer();
          // Issue #22: 重置工具调用计数器
          toolCallCount = 0;
          lastProgressUpdate = 0;
          break;

        case 'assistant_tool_calls':
          if (event.toolCalls.length > 1) {
            writeLine(DIM(runningToolsStatus(event.toolCalls.length)));
          }
          sessionMessagesToRecord.push({
            role: 'assistant',
            content: event.content || '',
            timestamp: Date.now(),
            tool_calls: event.toolCalls,
          });
          break;

        case 'tool_call':
          // Issue #22: 批量工具调用进度显示
          toolCallCount++;
          if (toolCallCount >= 3 && Date.now() - lastProgressUpdate > 1000) {
            showToolProgress(toolCallCount, event.name);
            lastProgressUpdate = Date.now();
          }
          break;

        case 'tool_result':
          // Issue #22: 隐藏进度指示
          hideProgress();
          // 显示工具结果后，准备下一轮（不启动 spinner）
          writeLine(
            event.summary || toolLine(event.name, event.args, event.success, event.duration)
          );
          // 显示错误详情
          if (!event.success && event.error) {
            writeLine(ERROR(`    Error: ${event.error}`));
          }
          // Debug: 显示接收到的参数
          if (!event.success && Object.keys(event.args).length === 0) {
            writeLine(
              WARN(
                `    ⚠ Tool received empty arguments - LLM may not be providing parameters correctly`
              )
            );
            writeLine(
              DIM(`    Try using /model qwen or /model gpt4o for better tool calling support`)
            );
          }
          // Record tool result for session
          sessionMessagesToRecord.push({
            role: 'tool',
            content: event.result,
            modelVisibleContent: event.modelVisibleResult,
            timestamp: Date.now(),
            toolCallId: event.callId,
          });
          break;

        case 'message':
          if (event.content) {
            sessionMessagesToRecord.push({
              role: 'assistant',
              content: event.content,
              timestamp: Date.now(),
            });
          }
          break;

        case 'strategy_exhausted':
          writeLine(WARN(`⚠ ${event.suggestion}`));
          break;

        case 'complete':
          finalContent = event.content;
          finalModel = event.model;
          finalUsage = event.usage;
          if (event.stats) {
            ctx.store.setLastLoopStats(event.stats);
          }
          break;
      }
    }

    // 刷新流式渲染器，输出剩余内容
    if (streamRenderer) {
      const remaining = streamRenderer.flush();
      if (remaining) {
        writeOutput(remaining);
      }
      streamRenderer = null;
    }

    const wasAborted = ctx.abortSignal?.aborted === true;

    if (finalContent && !wasAborted) {
      ctx.store.addMessage({ role: 'assistant', content: finalContent });
    }

    if (sessionId && sessionMessagesToRecord.length > 0 && !wasAborted) {
      appendSessionMessages(sessionId, sessionMessagesToRecord);
    }

    if (finalUsage && !wasAborted) {
      ctx.store.setTokenUsage(finalUsage);
    }

    if (!wasAborted) {
      harness.ingestTurn({
        userInput: input,
        assistantContent: finalContent,
        sessionMessages: sessionMessagesToRecord,
        intent,
      });
      const harnessState = harness.toJSON();
      ctx.store.setState({ harnessState });
      if (sessionId) {
        updateSessionSkills(sessionId, appliedSkillNames);
        updateSessionHarnessState(sessionId, harnessState);
        const recordedMessages = readSessionMessages(sessionId);
        if (recordedMessages.length > 0) {
          updateSessionSummary(sessionId, recordedMessages);
        }
      }
    }

    if (responseStarted) {
      writeLine();
      if (ui.extraAssistantSpacing) {
        writeLine();
      }
    }
    if (!ui.suppressLegacyTokenMeta) {
      const stats = [
        finalUsage ? `tokens: ${finalUsage.promptTokens}+${finalUsage.completionTokens}` : '',
        finalModel ? finalModel : '',
      ]
        .filter(Boolean)
        .join('  ');
      if (stats) {
        writeLine(DIM(stats));
      }
    }
  } catch (error) {
    spinner.stop();
    writeLine();
    if (isAbortError(error, ctx.abortSignal)) {
      hideProgress();
      if (!ui.suppressAbortNotice) {
        writeLine(DIM('Interrupted.'));
      }
    } else {
      writeLine(ERROR(`✗ ${errorMessage(error)}`));
      const hist = ctx.store.getSnapshot().conversationHistory;
      if (hist.length > 0) {
        ctx.store.setState({ conversationHistory: hist.slice(0, -1) });
      }
    }
  }

  return { success: true };
}

async function handleExit(ctx: CommandContext): Promise<CommandResult> {
  console.log();
  console.log(DIM('Shutting down...'));

  // Update session summary before exit
  if (ctx.sessionId) {
    const messages = readSessionMessages(ctx.sessionId);
    if (messages.length > 0) {
      updateSessionSummary(ctx.sessionId, messages);
    }
    endSession(ctx.sessionId);
  }

  ctx.requestShutdown?.('user request');
  await ctx.runtime.shutdown();
  console.log(SUCCESS('Goodbye.'));
  return { success: true };
}

export {
  showHelp,
  showStatus,
  handleExit,
  handleTask,
  handleRun,
  handleChat,
  sortCommands,
  getCommandCategoryLabel,
};
