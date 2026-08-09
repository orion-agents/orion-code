/** Handler implementations for the context-tool-command-handlers boundary. */

import chalk from 'chalk';
import { type CommandContext, type CommandResult } from './types';
import { errorMessage } from '../utils/errors';
import { getToolState } from '../framework';
import { executeTool, getRuntimeTools } from '../tools';
import { mcpManager } from '../tools/mcp';
import { loadSessionMeta } from '../services/session-storage';
import { getAutoCompact } from '../services/compact/auto-compact';
import {
  getSkillsRegistry,
  loadExplicitSkillReference,
  normalizeRequestedSkillName,
  parseSkillCommandInput,
  skillActivationNames,
} from '../skills';
import { resolveModelContext } from '../services/model-context';

const ACCENT = chalk.hex('#00D4AA');

const DIM = chalk.dim;

const ERROR = chalk.red;

const WARN = chalk.yellow;

const SUCCESS = chalk.green;

const HEADER = chalk.cyan.bold;

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function formatThreshold(value: number): string {
  return `${Math.round(value * 100)}%`;
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

function showMemory(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Memory Status'));
  console.log(DIM('─'.repeat(40)));

  const memStatus = ctx.runtime.memory.getStatus();
  const storeStats = ctx.runtime.store.getStats();

  console.log();
  console.log(HEADER('  Inline MemorySystem:'));
  console.log(`    Working    ${memStatus.working} / ${ctx.runtime.config.memory.workingCapacity}`);
  console.log(
    `    Short-term ${memStatus['short-term']} / ${ctx.runtime.config.memory.shortTermCapacity}`
  );
  console.log(`    Long-term  ${memStatus['long-term']} entries`);

  console.log();
  console.log(HEADER('  Modular MemoryStore:'));
  console.log(`    Working    ${storeStats.working}`);
  console.log(`    Short-term ${storeStats['short-term']}`);
  console.log(`    Long-term  ${storeStats['long-term']} entries`);
  console.log();
  return { success: true };
}

async function handleMemoryReindex(_ctx: CommandContext): Promise<CommandResult> {
  const { isSemanticEnabled, getSemanticSearchService } = require('../memory/semantic-search');

  if (!isSemanticEnabled()) {
    console.log();
    console.log(WARN('⚠ Semantic search is not enabled.'));
    console.log(DIM('  Set ORION_CODE_EMBEDDING_PROVIDER=ollama or openai to enable.'));
    console.log();
    return { success: false };
  }

  console.log();
  console.log(HEADER('Reindexing project memories...'));

  try {
    const service = getSemanticSearchService();
    const count = await service.indexExistingMemories(process.cwd());
    console.log(SUCCESS(`✔ Indexed ${count} memories`));
  } catch (err) {
    console.log(ERROR(`✗ Reindex failed: ${errorMessage(err)}`));
    return { success: false };
  }

  console.log();
  return { success: true };
}

async function handleMemory(ctx: CommandContext, args: string): Promise<CommandResult> {
  const sub = args.trim().toLowerCase();
  if (sub === 'reindex') {
    return handleMemoryReindex(ctx);
  }
  return showMemory(ctx);
}

function showSafety(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Safety Checker'));
  console.log(DIM('─'.repeat(40)));

  const policy = ctx.runtime.safety.getPolicy();
  const summary = ctx.runtime.safety.getAuditSummary();

  console.log();
  console.log(`  Enabled    ${policy.enabled ? SUCCESS('yes') : ERROR('no')}`);
  console.log(`  Sandbox    ${policy.sandboxMode ? WARN('on') : DIM('off')}`);
  console.log();
  console.log(`  Blocked patterns:`);
  for (const pattern of policy.blocked) {
    console.log(`    ${ERROR('✗')} ${DIM(pattern)}`);
  }
  console.log();
  console.log(`  Dangerous patterns:`);
  for (const pattern of policy.dangerousPatterns) {
    console.log(`    ${WARN('⚠')} ${DIM(pattern)}`);
  }
  console.log();
  console.log(
    `  Audit summary: ${summary.total} checks | ${SUCCESS(`${summary.passed} passed`)} | ${ERROR(`${summary.blocked} blocked`)}`
  );
  console.log();
  return { success: true };
}

function showHarness(ctx: CommandContext, args: string = ''): CommandResult {
  const explain = args.trim().toLowerCase() === 'explain';
  console.log();
  console.log(HEADER(explain ? 'Harness Explain' : 'Harness'));
  console.log(DIM('─'.repeat(40)));

  const cfg = ctx.runtime.harness.getConfig();
  console.log();
  if (!explain) {
    console.log(`  Max steps       ${cfg.maxSteps}`);
    console.log(`  Boundary check  ${cfg.boundaryCheck ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Goal constraint ${cfg.goalConstraint ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Result validate ${cfg.resultValidation ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Sandbox         ${cfg.sandbox ? WARN('on') : DIM('off')}`);
    console.log(`  Timeout         ${cfg.timeout}ms`);
    console.log(`  Blocked actions ${DIM(cfg.blockedActions.join(', ') || 'none')}`);
  }

  const state = ctx.store.getSnapshot().harnessState;
  if (!state) {
    console.log();
    console.log(DIM('  No Context Harness state for this session yet.'));
    console.log();
    return { success: true };
  }

  if (explain) {
    // Build explain output from harnessState in store
    const contract = state.contract;

    // Contract section
    console.log(HEADER('  Contract'));
    if (contract) {
      console.log(`    Objective   ${ACCENT(contract.objective || '(none)')}`);
      if (contract.requirements?.length) {
        console.log(`    Requires    ${DIM(contract.requirements.slice(0, 3).join(' | '))}`);
      }
      if (contract.prohibitions?.length) {
        console.log(`    Prohibits   ${WARN(contract.prohibitions.slice(0, 3).join(' | '))}`);
      }
      if (contract.successCriteria?.length) {
        console.log(`    Success     ${DIM(contract.successCriteria.slice(0, 3).join(' | '))}`);
      }
    } else {
      console.log(DIM('    (no contract established)'));
    }
    console.log();

    // Context source
    console.log(HEADER('  Context Source'));
    const session = ctx.getSession?.() ?? (ctx.sessionId ? loadSessionMeta(ctx.sessionId) : null);
    const isRestored = session?.transcriptDisplayStartTime != null;
    const isCompactActive = Boolean(state.promptAssemblyStats);
    console.log(`    Root       ${ACCENT(state.rootObjective || contract?.objective || '(none)')}`);
    console.log(
      `    Active     ${DIM(state.activeInstruction || contract?.userIntent || '(none)')}`
    );
    console.log(`    Source     ${isRestored ? WARN('restored session') : DIM('live turn')}`);
    if (isRestored && session) {
      const restoredTime = session.transcriptDisplayStartTime
        ? new Date(session.transcriptDisplayStartTime).toLocaleString()
        : 'unknown';
      console.log(`    Restored   ${DIM(restoredTime)}`);
    }
    if (isCompactActive) {
      console.log(`    Compact    ${SUCCESS('active')}`);
    }
    console.log();

    // Evidence index summary
    console.log(HEADER('  Evidence Index'));
    const evidenceItems = state.evidenceIndex?.length ?? 0;
    const evidenceKinds = new Map<string, number>();
    if (state.evidenceIndex) {
      for (const item of state.evidenceIndex) {
        const kind = item.kind || 'unknown';
        evidenceKinds.set(kind, (evidenceKinds.get(kind) || 0) + 1);
      }
    }
    console.log(`    Total      ${ACCENT(String(evidenceItems))} items`);
    if (evidenceKinds.size > 0) {
      const kinds = Array.from(evidenceKinds.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [kind, count] of kinds) {
        console.log(`      ${DIM(kind.padEnd(16))} ${count}`);
      }
    } else {
      console.log(DIM('      (no evidence records yet)'));
    }
    console.log();

    // Intent history
    console.log(HEADER('  Recent Intents'));
    const intents = state.intentHistory?.slice(-5) ?? [];
    if (intents.length > 0) {
      for (const intent of intents) {
        const conf = intent.confidence != null ? ` (${Math.round(intent.confidence * 100)}%)` : '';
        console.log(
          `    ${ACCENT(intent.kind)}${DIM(conf)} ${DIM(intent.summary?.slice(0, 50) || '')}`
        );
      }
    } else {
      console.log(DIM('    (no intents recorded)'));
    }
    console.log();

    // Capsule snapshot
    console.log(HEADER('  Capsule'));
    const capsule = state.capsule;
    if (capsule) {
      console.log(`    Next        ${DIM(capsule.nextAction)}`);
      if (capsule.completed?.length) {
        console.log(`    Done        ${SUCCESS(`${capsule.completed.length} steps`)}`);
      }
      if (capsule.openTodos?.length) {
        console.log(`    Open        ${WARN(`${capsule.openTodos.length} todos`)}`);
      }
      if (capsule.changedFiles?.length) {
        console.log(`    Files       ${DIM(capsule.changedFiles.slice(0, 5).join(', '))}`);
      }
      const passed = capsule.verification?.passed?.length ?? 0;
      const failed = capsule.verification?.failed?.length ?? 0;
      console.log(
        `    Verify      ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`
      );
    } else {
      console.log(DIM('    (no capsule yet)'));
    }
    console.log();

    // Prompt assembly stats
    const stats = state.promptAssemblyStats;
    console.log(HEADER('  Prompt Assembly'));
    if (stats) {
      console.log(`    Model       ${ACCENT(stats.modelId)}`);
      console.log(
        `    Budget      ${DIM(`${stats.estimatedTokens}/${stats.budgetTokens} tokens`)}`
      );
      console.log(`    Sections    ${DIM(stats.sections.join(', ') || 'none')}`);
      console.log(`    Ledger      ${DIM(`${state.ledger?.length ?? 0} entries`)}`);
      console.log(`    Evidence    ${DIM(`${state.evidenceIndex?.length ?? 0} records`)}`);
      console.log(`    Turns       ${DIM(`${state.turnSummaries?.length ?? 0} summaries`)}`);
      console.log();
      console.log(HEADER('    Included Evidence'));
      for (const item of stats.includedEvidence.slice(0, 10)) {
        console.log(
          `      ${ACCENT(item.id)} ${DIM(`[${item.kind}] score=${item.score} tokens=${item.tokens}`)}`
        );
        console.log(`        ${DIM(item.reason)}`);
      }
      if (stats.includedEvidence.length === 0) {
        console.log(DIM('      none'));
      }
      if (stats.omittedEvidence.length > 0) {
        console.log();
        console.log(HEADER('    Omitted Evidence'));
        for (const item of stats.omittedEvidence.slice(0, 8)) {
          console.log(
            `      ${DIM(item.id)} ${DIM(`[${item.kind}] score=${item.score} tokens=${item.tokens}`)}`
          );
          console.log(`        ${DIM(item.reason)}`);
        }
      }
    } else {
      console.log(DIM('    No prompt assembly stats recorded yet. Run a chat turn first.'));
    }
    console.log();
    console.log(HEADER('  Auto Compact'));
    const compactStats = getCommandAutoCompact(
      ctx,
      state.promptAssemblyStats?.modelId ?? snapshotCurrentModel(ctx)
    ).getStats();
    const contextInfo = resolveModelContext(compactStats.modelId);
    console.log(`    Model       ${ACCENT(compactStats.modelId)}`);
    console.log(
      `    Window      ${DIM(`${formatTokenCount(contextInfo.contextWindow)} tokens (${contextInfo.source}${contextInfo.source === 'fuzzy' ? `:${contextInfo.matchedId}` : ''})`)}`
    );
    console.log(
      `    Thresholds  ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}, prewarm ${formatThreshold(compactStats.preCompactThreshold)}`)}`
    );
    console.log(
      `    Usage       ${DIM(`${compactStats.lastTokenCount} tokens, ${compactStats.ctxPercent}%`)}`
    );
    console.log(`    Armed       ${compactStats.preCompactArmed ? SUCCESS('yes') : DIM('no')}`);
    console.log(`    Last mode   ${DIM(compactStats.lastCompactMode ?? 'none')}`);
    console.log();
    return { success: true };
  }

  console.log();
  console.log(HEADER('  Context State'));
  console.log(`    Version     ${ACCENT(String(state.version ?? 1))}`);
  console.log(`    Epoch       ${ACCENT(String(state.taskEpoch ?? 1))}`);
  console.log(
    `    Objective   ${ACCENT(state.rootObjective ?? state.contract?.objective ?? '(none)')}`
  );
  console.log(
    `    Active      ${DIM(state.activeInstruction ?? state.contract?.userIntent ?? '(none)')}`
  );
  console.log(`    Ledger      ${DIM(`${state.ledger.length} entries`)}`);
  console.log(`    Evidence    ${DIM(`${state.evidenceIndex?.length ?? 0} records`)}`);
  console.log(`    Turns       ${DIM(`${state.turnSummaries?.length ?? 0} summaries`)}`);
  if (state.activeConstraints && state.activeConstraints.length > 0) {
    console.log(`    Constraints ${DIM(state.activeConstraints.slice(0, 3).join(' | '))}`);
  }
  if (state.capsule) {
    console.log(`    Next        ${DIM(state.capsule.nextAction)}`);
    const passed = state.capsule.verification.passed.length;
    const failed = state.capsule.verification.failed.length;
    console.log(
      `    Verify      ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`
    );
  }
  if (state.diagnostics && state.diagnostics.length > 0) {
    console.log(`    Diagnostics ${WARN(state.diagnostics.slice(-2).join(' | '))}`);
  }
  console.log();
  return { success: true };
}

function handleSkills(_ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Loaded Skills'));
  console.log(DIM('─'.repeat(40)));

  try {
    const registry = getSkillsRegistry();
    const summary = registry.getSummary();

    if (summary.count === 0) {
      console.log();
      console.log(DIM('  No skills loaded.'));
      console.log(
        DIM('  Place SKILL.md files in ~/.orion-code/skills/<name>/ or .orion-code/skills/<name>/')
      );
      console.log();
      return { success: true };
    }

    console.log();
    console.log(
      `  Total ${SUCCESS(summary.count)} skills (${WARN(summary.autoCount)} auto-trigger)`
    );
    console.log();
    for (const skill of registry.getAllSkills()) {
      const source = registry.getSource(skill.name);
      const sourceType = source?.type || 'unknown';
      const resourceRoot = skill.resourceRoot || skill.source || source?.path;
      const skillFile = resourceRoot
        ? `${resourceRoot.replace(/\/SKILL\.md$/i, '')}/SKILL.md`
        : source?.skillFile;
      console.log(`  ${ACCENT(skill.name)} ${DIM(`(${sourceType})`)}`);
      console.log(`    ${DIM(skill.description || '(no description)')}`);
      if (skillFile) console.log(`    ${DIM(`SKILL.md ${skillFile}`)}`);
      if (resourceRoot) console.log(`    ${DIM(`Root     ${resourceRoot}`)}`);
    }
    console.log();
  } catch (err) {
    console.log(ERROR(`✗ ${errorMessage(err)}`));
    return { success: false };
  }

  return { success: true };
}

function handleSkill(ctx: CommandContext, args: string): CommandResult {
  const trimmed = args.trim();
  const registry = getSkillsRegistry();
  registry.initialize();

  if (!trimmed) {
    const names = registry
      .getAllSkills()
      .map(skill => skill.name)
      .sort();
    return {
      success: false,
      error: ['Usage: /skill <name> <task>', `Loaded skills: ${names.join(', ') || 'none'}`].join(
        '\n'
      ),
    };
  }

  const parsed = parseSkillCommandInput(`/skill ${trimmed}`);
  const rawName = trimmed.split(/\s+/, 1)[0] || '';
  const requestedName = parsed.skillName || normalizeRequestedSkillName(rawName);
  const referencedSkill = loadExplicitSkillReference(`/skill ${trimmed}`, ctx.cwd);
  if (parsed.skillPath && !referencedSkill) {
    return {
      success: false,
      error: `Invalid skill reference: ${parsed.skillPath}`,
    };
  }

  const skill =
    referencedSkill ||
    registry
      .getAllSkills()
      .find(candidate =>
        skillActivationNames(candidate).some(
          name => normalizeRequestedSkillName(name) === requestedName
        )
      );

  if (!skill) {
    const suggestions = registry
      .getAllSkills()
      .map(candidate => candidate.name)
      .filter(name => name.includes(requestedName) || requestedName.includes(name))
      .slice(0, 5);
    return {
      success: false,
      error:
        suggestions.length > 0
          ? `Unknown skill: ${rawName}\nDid you mean: ${suggestions.join(', ')}?`
          : `Unknown skill: ${rawName}`,
    };
  }

  const task = parsed.task;
  const source = registry.getSource(skill.name);
  const resourceRoot = skill.resourceRoot || skill.source || source?.path;
  const skillFile = resourceRoot
    ? `${resourceRoot.replace(/\/SKILL\.md$/i, '')}/SKILL.md`
    : source?.skillFile;

  if (!task) {
    const usageSelector = parsed.skillPath
      ? `[$${skill.name}](${formatSkillReferencePath(parsed.skillPath)})`
      : skill.name;
    return {
      success: true,
      output: [
        parsed.skillPath
          ? `Skill reference ${skill.name} is valid for one turn.`
          : `Skill ${skill.name} is loaded.`,
        skillFile ? `SKILL.md ${skillFile}` : '',
        resourceRoot ? `Root     ${resourceRoot}` : '',
        `Use: /skill ${usageSelector} <task>`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  return {
    success: true,
    continueAsChat: true,
    chatInput: parsed.skillPath
      ? `/skill [$${skill.name}](${formatSkillReferencePath(parsed.skillPath)}) ${task}`
      : `/skill ${skill.name} ${task}`,
  };
}

function formatSkillReferencePath(path: string): string {
  return /[\s()]/u.test(path) ? `<${path}>` : path;
}

function handleMcp(_ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('MCP Servers'));
  console.log(DIM('─'.repeat(40)));

  const status = mcpManager.getStatus();
  if (status.length === 0) {
    console.log();
    console.log(DIM('  No servers configured. Add to ~/.orion-code/mcp.json'));
    console.log();
    return { success: true };
  }

  console.log();
  for (const s of status) {
    const stateLabel = s.dead
      ? ERROR('dead')
      : s.connected
        ? SUCCESS('connected')
        : WARN('disconnected');
    console.log(`  ${ACCENT(s.name.padEnd(20))} ${stateLabel}  ${DIM(`${s.toolCount} tools`)}`);
  }
  console.log();
  return { success: true };
}

function handleTools(ctx: CommandContext): CommandResult {
  const tools =
    ctx.store.getSnapshot().tools.length > 0 ? ctx.store.getSnapshot().tools : getRuntimeTools();
  const staticTools = tools.filter(tool => !tool.name.startsWith('mcp__'));
  const mcpTools = tools.filter(tool => tool.name.startsWith('mcp__'));

  console.log();
  console.log(HEADER('Available Tools'));
  console.log(DIM('─'.repeat(40)));
  console.log(`  Static tools  ${ACCENT(String(staticTools.length))}`);
  console.log(`  MCP tools     ${ACCENT(String(mcpTools.length))}`);
  console.log();

  const visible = [...staticTools, ...mcpTools].slice(0, 28);
  for (const tool of visible) {
    const label = tool.name.startsWith('mcp__') ? 'mcp' : 'tool';
    console.log(`  ${ACCENT(tool.name)} ${DIM(`[${label}]`)}`);
    console.log(`    ${DIM(tool.description.slice(0, 96))}`);
  }

  if (tools.length > visible.length) {
    console.log();
    console.log(DIM(`  ... ${tools.length - visible.length} more tools hidden`));
  }
  console.log();
  return { success: true };
}

function handleTodos(ctx: CommandContext): CommandResult {
  const todos = ctx.store.getSnapshot().todos;
  console.log();
  console.log(HEADER('Todos'));
  console.log(DIM('─'.repeat(40)));

  if (todos.length === 0) {
    console.log(DIM('  No active todos yet.'));
    console.log();
    return { success: true };
  }

  for (const todo of todos) {
    const marker =
      todo.status === 'completed'
        ? SUCCESS('✓')
        : todo.status === 'in_progress'
          ? WARN('›')
          : DIM('○');
    console.log(`  ${marker} ${todo.content}`);
    if (todo.activeForm && todo.activeForm !== todo.content) {
      console.log(`    ${DIM(todo.activeForm)}`);
    }
  }
  console.log();
  return { success: true };
}

async function handleEditPreview(ctx: CommandContext): Promise<CommandResult> {
  const lastEdit = getToolState().lastEditFileArgs;

  if (!lastEdit) {
    console.log(ERROR('No previous edit_file call found for preview'));
    console.log(
      DIM(
        'Run an edit_file tool call first, then use /edit-preview to inspect the match candidates.'
      )
    );
    console.log();
    return { success: false };
  }

  const hasMetadata = Boolean(lastEdit.sessionId || lastEdit.turnId);
  if (!hasMetadata) {
    console.log(
      WARN(
        'Using legacy edit-preview state without session/turn tags. Running preview as best-effort.'
      )
    );
  }

  const staleBySession = Boolean(
    lastEdit.sessionId && ctx.sessionId && lastEdit.sessionId !== ctx.sessionId
  );
  const staleByTurn = Boolean(
    lastEdit.turnId != null && ctx.turnId != null && String(lastEdit.turnId) !== String(ctx.turnId)
  );
  if (staleBySession || staleByTurn) {
    const mismatch = [];
    if (staleBySession) mismatch.push(`session ${lastEdit.sessionId} vs ${ctx.sessionId}`);
    if (staleByTurn) mismatch.push(`turn ${String(lastEdit.turnId)} vs ${String(ctx.turnId)}`);
    console.log(ERROR('Edit preview target does not match current context.'));
    console.log(DIM(`Stale edit target: ${mismatch.join(', ')}.`));
    console.log();
    return { success: false };
  }

  if (hasMetadata && !(ctx.sessionId || ctx.turnId)) {
    console.log(
      WARN(
        'Edit preview context is available, but current command context is missing session/turn metadata.'
      )
    );
    console.log(DIM('Preview is allowed, but stale checks cannot be fully validated.'));
  }

  const rawResult = await executeTool(
    'edit_file',
    {
      ...lastEdit,
      preview: true,
    },
    ctx.abortSignal,
    {
      cwd: ctx.cwd,
      config: {
        name: ctx.config.name,
        mode: ctx.config.mode,
      },
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    }
  );

  let parsed: {
    success?: boolean;
    output?: string;
    error?: string;
    metadata?: { candidates?: unknown[] };
  };
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    parsed = { success: false, error: rawResult };
  }

  console.log();
  console.log(HEADER('Edit Preview'));
  console.log(DIM('─'.repeat(40)));
  if (parsed.success) {
    console.log(parsed.output || DIM('No preview output'));
  } else {
    console.log(ERROR(parsed.error || 'Preview failed'));
  }
  console.log();

  // Return structured data for terminal/TUI/Ink picker rendering.
  if (parsed.success && parsed.metadata?.candidates && Array.isArray(parsed.metadata.candidates)) {
    return {
      success: true,
      editPreview: {
        path: lastEdit.path as string,
        newString: lastEdit.new_string as string,
        kind: (lastEdit.fuzzy_match ? 'fuzzy' : 'exact') as 'exact' | 'fuzzy',
        candidates: parsed.metadata.candidates as Array<{
          index: number;
          line: number;
          match: string;
          contextBefore: string;
          contextAfter: string;
          isReplaceAll: boolean;
        }>,
      },
    };
  }

  return { success: parsed.success === true };
}

export {
  handleTodos,
  showHarness,
  handleSkills,
  handleSkill,
  handleMemory,
  handleTools,
  handleEditPreview,
  handleMcp,
  showSafety,
};
