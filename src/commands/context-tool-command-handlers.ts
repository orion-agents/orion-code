/** Handler implementations for the context-tool-command-handlers boundary. */

import chalk from 'chalk';
import { type CommandContext, type CommandResult } from './types';
import { errorMessage } from '../utils/errors';
import { loadSessionCompactCheckpoint, loadSessionMeta } from '../services/session-storage';
import { getAutoCompact } from '../services/compact/auto-compact';
import { createFirstPartyMcpAdapterV1, loadFirstPartyMcpConfigurationV1 } from '../runtime/mcp';
import { createProductionFilesystemSkillProviderV1 } from '../runtime/skills';
import { resolveContextBudget, resolveModelContext } from '../services/model-context';
import { validateAllMemories } from '../memory/validation';
import type { OrionRuntimeDiagnosticsV1 } from '../runtime/orion-runtime-v1';

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

  const snapshot = ctx.store.getSnapshot();

  console.log();
  console.log(HEADER('  Prompt Memory:'));
  console.log(`    Selected   ${snapshot.memoryContent ? snapshot.memoryContent.length : 0} chars`);
  console.log(`    Policy     bounded per-turn relevance context`);
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

function handleMemoryValidate(_ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Validating project memories...'));

  try {
    const results = validateAllMemories(process.cwd());
    let driftCount = 0;
    let incompleteCount = 0;

    for (const [name, result] of results) {
      if (!result.symbolScanComplete) incompleteCount += 1;
      for (const drift of result.drifts) {
        driftCount += 1;
        console.log(WARN(`  ${name}: ${drift.message}`));
      }
    }

    if (incompleteCount > 0) {
      console.log(
        WARN(
          `⚠ Symbol scan reached a safety limit for ${incompleteCount} memory entr${incompleteCount === 1 ? 'y' : 'ies'}; missing symbols were not inferred.`
        )
      );
    }
    if (driftCount > 0) {
      console.log(ERROR(`✗ Found ${driftCount} stale memory reference(s)`));
      console.log();
      return { success: false };
    }

    console.log(SUCCESS(`✔ ${results.size} memories validated`));
    console.log();
    return { success: incompleteCount === 0 };
  } catch (err) {
    console.log(ERROR(`✗ Memory validation failed: ${errorMessage(err)}`));
    console.log();
    return { success: false };
  }
}

async function handleMemory(ctx: CommandContext, args: string): Promise<CommandResult> {
  const sub = args.trim().toLowerCase();
  if (sub === 'validate') {
    return handleMemoryValidate(ctx);
  }
  if (sub === 'reindex') {
    return handleMemoryReindex(ctx);
  }
  return showMemory(ctx);
}

function showSafety(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Safety Checker'));
  console.log(DIM('─'.repeat(40)));

  console.log();
  console.log(`  Boundary   ${SUCCESS('ToolGateway')}`);
  console.log(`  Policy     ${ctx.config.toolConfirmation}`);
  console.log(`  Approval   independent from sandbox enforcement`);
  console.log(`  Mode       BUILD / PLAN / AUTO never changes containment`);
  console.log();
  return { success: true };
}

interface HarnessDiagnosticsWriter {
  log(...values: unknown[]): void;
}

function renderRuntimeHarnessDiagnostics(
  output: HarnessDiagnosticsWriter,
  diagnostics: OrionRuntimeDiagnosticsV1
): void {
  const shortDigest = (value: string): string =>
    value === 'unavailable' ? value : value.slice(0, 12);
  output.log();
  output.log(HEADER('Harness Explain · Runtime v0.2'));
  output.log(DIM('─'.repeat(56)));
  output.log();
  output.log(HEADER('  Runtime Graph'));
  output.log(`    State       ${SUCCESS(diagnostics.runtime.state)}`);
  output.log(
    `    Scope       ${ACCENT(diagnostics.runtime.scope.state)} epoch=${diagnostics.runtime.scope.epoch} resources=${diagnostics.runtime.scope.activeResources} leases=${diagnostics.runtime.scope.activeLeases}`
  );
  for (const service of diagnostics.runtime.services) {
    output.log(`    ${DIM(service.slot.padEnd(12))} ${service.serviceId}`);
  }
  const contributors = diagnostics.runtime.contributors.filter(entry => entry.ids.length > 0);
  output.log(
    `    Contributors ${contributors.length > 0 ? contributors.map(entry => `${entry.lane}=[${entry.ids.join(',')}]`).join(' ') : DIM('none')}`
  );

  output.log();
  output.log(HEADER('  Thread / TaskContext'));
  output.log(
    `    Thread      ${ACCENT(diagnostics.thread.status)} cursor=${diagnostics.thread.cursor} lag=${diagnostics.thread.projectionLag} queue=${diagnostics.thread.queuedTurns}/${diagnostics.thread.queuedBytes}B`
  );
  if (diagnostics.thread.activeTurnId) {
    output.log(
      `    Active      ${diagnostics.thread.activeTurnId} items=[${diagnostics.thread.activeItemIds.join(',') || 'none'}] interrupt=${diagnostics.thread.interruptRequested ? 'requested' : 'no'}`
    );
  }
  output.log(
    `    Task        revision=${diagnostics.taskContext.revision} epoch=${diagnostics.taskContext.taskEpoch} criteria=${diagnostics.taskContext.criteria}`
  );
  output.log(`    Task digest ${shortDigest(diagnostics.taskContext.stateDigest)}`);
  output.log(
    `    Evidence    ${diagnostics.taskContext.evidenceRefs.length > 0 ? diagnostics.taskContext.evidenceRefs.join(', ') : DIM('none')}`
  );

  output.log();
  output.log(HEADER('  Capability Snapshot'));
  const capability = diagnostics.capability;
  if (!capability) {
    output.log(DIM('    No durable capability receipt yet. Run a model step first.'));
  } else {
    output.log(`    Step        ${capability.stepId} request=${capability.requestId}`);
    output.log(
      `    Direct      ${capability.direct.length > 0 ? capability.direct.join(', ') : DIM('none')}`
    );
    output.log(
      `    Deferred    ${capability.deferred.length > 0 ? capability.deferred.join(', ') : DIM('none')}`
    );
    const hidden = Object.entries(capability.hidden);
    output.log(
      `    Hidden      ${hidden.length > 0 ? hidden.map(([id, reason]) => `${id}(${reason})`).join(', ') : DIM('none')}`
    );
    output.log(
      `    Omitted     ${capability.omitted.length > 0 ? capability.omitted.map(item => `${item.id}(${item.reason})`).join(', ') : DIM('none')}`
    );
    output.log(
      `    Schemas     ${ACCENT(`${capability.schemaBytes}B`)} / ${capability.fullSchemaBytes}B (${SUCCESS(`${capability.schemaReductionPercent}% leaner`)})`
    );
    output.log(
      `    Digests     step=${shortDigest(capability.stepSnapshotDigest)} router=${shortDigest(capability.toolRouterDigest)} authority=${shortDigest(capability.authorityDigest)} policy=${shortDigest(capability.executionPolicyDigest)}`
    );
    output.log(
      `    Skills      catalog=${shortDigest(capability.skillCatalogDigest)} selected=[${capability.selectedSkillIds.join(',') || 'none'}]`
    );
    output.log(
      `    MCP         catalog=${shortDigest(capability.mcpCatalogDigest)} selected=[${capability.selectedMcpBindings.join(',') || 'none'}]`
    );
    output.log(
      `    Prompt      ${capability.promptSections.map(section => `${section.id}:${section.selected ? 'selected' : `omitted(${section.reason ?? 'policy'})`}`).join(', ') || 'none'}`
    );
  }

  output.log();
  output.log(HEADER('  Lazy Providers'));
  output.log(
    `    Skill defs  ${diagnostics.skills.definitionCache.entries}/${diagnostics.skills.definitionCache.maxEntries} entries · ${diagnostics.skills.definitionCache.bytes}/${diagnostics.skills.definitionCache.maxBytes}B · in-flight=${diagnostics.skills.definitionLoadsInFlight}`
  );
  output.log(
    `    Skill files ${diagnostics.skills.resourceCache.entries}/${diagnostics.skills.resourceCache.maxEntries} entries · ${diagnostics.skills.resourceCache.bytes}/${diagnostics.skills.resourceCache.maxBytes}B · in-flight=${diagnostics.skills.resourceLoadsInFlight}`
  );
  output.log(
    `    MCP catalog ${diagnostics.mcp.catalog.descriptors.length} descriptors · ${shortDigest(diagnostics.mcp.catalog.digest)}`
  );
  for (const server of diagnostics.mcp.servers) {
    output.log(
      `      ${server.serverId} ${server.state} leases=${server.activeLeaseCount} calls=${server.activeCallCount} pending=${server.pendingAcquireCount} tools=${server.toolCount}${server.failure ? ` failure=${server.failure}` : ''}`
    );
  }

  output.log();
  output.log(HEADER('  Latest Durable Outcome'));
  output.log(`    Event cursor ${diagnostics.latest.eventCursor}`);
  output.log(`    Compact      ${diagnostics.latest.compactEvent ?? 'none'}`);
  output.log(`    Recovery     ${shortDigest(diagnostics.latest.compactRecoveryDigest)}`);
  output.log(
    `    Stop         ${diagnostics.latest.stopDecision ? JSON.stringify(diagnostics.latest.stopDecision) : 'none'}`
  );
  output.log();
}

async function showHarness(ctx: CommandContext, args: string = ''): Promise<CommandResult> {
  const lines: string[] = [];
  const console = {
    log: (...values: unknown[]): void => {
      lines.push(values.map(value => String(value)).join(' '));
    },
  };
  const result = (): CommandResult => ({ success: true, output: lines.join('\n') });
  const tokens = args
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  const explain = tokens[0] === 'explain';
  const json = tokens.includes('--json');
  if (tokens.some(token => token !== 'explain' && token !== '--json')) {
    return { success: false, error: 'Usage: /harness [explain [--json]]' };
  }

  if (explain && ctx.getHarnessDiagnostics) {
    try {
      const diagnostics = await ctx.getHarnessDiagnostics();
      if (diagnostics) {
        if (json) {
          return { success: true, output: JSON.stringify(diagnostics, null, 2) };
        }
        renderRuntimeHarnessDiagnostics(console, diagnostics);
        return result();
      }
    } catch (error) {
      return {
        success: false,
        error: `Harness diagnostics unavailable: ${errorMessage(error)}`,
      };
    }
  }

  console.log();
  console.log(HEADER(explain ? 'Harness Explain' : 'Harness'));
  console.log(DIM('─'.repeat(40)));

  console.log();
  if (!explain) {
    console.log(`  Completion owner ${SUCCESS('TaskContext')}`);
    console.log(`  Execution owner  ${SUCCESS('ToolGateway')}`);
    console.log(`  Durable owner    ${SUCCESS('ThreadEventStore')}`);
  }

  const state = ctx.store.getSnapshot().harnessState;
  if (!state) {
    console.log();
    console.log(DIM('  No Context Harness state for this session yet.'));
    console.log();
    return result();
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
      if (stats.capabilityProfileVersion) {
        console.log(
          `    Capability  ${DIM(`v${stats.capabilityProfileVersion} ${stats.capabilityProfileFingerprint?.slice(0, 12) ?? 'unknown'}`)}`
        );
      }
      if (stats.sectionManifest?.length) {
        console.log();
        console.log(HEADER('    Section Budget'));
        for (const section of stats.sectionManifest) {
          const disposition = section.selected ? SUCCESS('selected') : WARN('omitted');
          console.log(
            `      ${ACCENT(section.name.padEnd(18))} ${DIM(`[${section.authority}] ${section.tokenEstimate}/${section.budgetTokens}`)} ${disposition}`
          );
          if (section.reason) console.log(`        ${DIM(section.reason)}`);
        }
      }
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
    const budget = resolveContextBudget(compactStats.modelId, ctx.llm?.getMaxTokens?.());
    console.log(
      `    Reserve     ${DIM(`${budget.reservedOutputTokens} output + ${budget.safetyMarginTokens} safety tokens`)}`
    );
    if (session?.id) {
      try {
        const checkpoint = loadSessionCompactCheckpoint(session.id);
        console.log();
        console.log(HEADER('  Latest Compact Receipt'));
        if (!checkpoint) {
          console.log(DIM('    No committed compact checkpoint.'));
        } else {
          console.log(`    Checkpoint  ${ACCENT(checkpoint.checkpointId)}`);
          console.log(`    Schema      ${DIM(`v${checkpoint.version}`)}`);
          console.log(`    Mode        ${DIM(checkpoint.mode)}`);
          console.log(
            `    Tokens      ${DIM(`${checkpoint.beforeUsage.usedTokens} → ${checkpoint.afterUsage.usedTokens}`)}`
          );
          if (checkpoint.version === 2) {
            console.log(`    Strategy    ${DIM(checkpoint.summary.strategy)}`);
            console.log(
              `    Target      ${DIM(`${Math.round(checkpoint.validation.targetHeadroomRatio * 100)}% (${checkpoint.validation.targetMet ? 'met' : 'missed'})`)}`
            );
            console.log(
              `    Coverage    ${DIM(`${checkpoint.candidateReceipt.semanticSummary?.coverage.groupCount ?? 0} groups / ${checkpoint.candidateReceipt.semanticSummary?.coverage.messageCount ?? 0} messages`)}`
            );
            console.log(
              `    Diagnostics ${DIM(String(checkpoint.candidateReceipt.diagnostics.length))}`
            );
          }
        }
      } catch (error) {
        console.log();
        console.log(HEADER('  Latest Compact Receipt'));
        console.log(
          WARN(`    Unavailable: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
    }
    console.log();
    return result();
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
  return result();
}

async function handleSkills(ctx: CommandContext): Promise<CommandResult> {
  console.log();
  console.log(HEADER('Skill Catalog'));
  console.log(DIM('─'.repeat(40)));

  try {
    const provider = createProductionFilesystemSkillProviderV1({
      cwd: ctx.cwd,
      configuredPaths: ctx.config.skills?.paths,
      watch: false,
    });
    const catalog = await provider.list(
      { id: `command:${ctx.cwd}` },
      ctx.abortSignal ?? new AbortController().signal
    );
    if (catalog.descriptors.length === 0) {
      console.log();
      console.log(DIM('  No Skill descriptors found.'));
      console.log(
        DIM('  Place SKILL.md files in ~/.orion-code/skills/<name>/ or .orion-code/skills/<name>/')
      );
      console.log();
      return { success: true };
    }

    console.log();
    console.log(
      `  Total ${SUCCESS(catalog.descriptors.length)} descriptors (definitions remain lazy)`
    );
    console.log();
    for (const skill of catalog.descriptors) {
      console.log(`  ${ACCENT(skill.name)} ${DIM(`(${skill.sourceScope})`)}`);
      console.log(`    ${DIM(skill.description || '(no description)')}`);
    }
    console.log();
  } catch (err) {
    console.log(ERROR(`✗ ${errorMessage(err)}`));
    return { success: false };
  }

  return { success: true };
}

function handleSkill(_ctx: CommandContext, args: string): CommandResult {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      success: false,
      error: 'Usage: /skill <name> <task>',
    };
  }
  return {
    success: true,
    continueAsChat: true,
    chatInput: `/skill ${trimmed}`,
  };
}

function handleMcp(_ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('MCP Servers'));
  console.log(DIM('─'.repeat(40)));

  let descriptors;
  try {
    descriptors = createFirstPartyMcpAdapterV1({
      config: loadFirstPartyMcpConfigurationV1(),
    }).descriptors;
  } catch (error) {
    console.log();
    console.log(ERROR(`  Invalid MCP configuration: ${errorMessage(error)}`));
    console.log();
    return { success: false };
  }
  if (descriptors.length === 0) {
    console.log();
    console.log(DIM('  No servers configured. Add to ~/.orion-code/mcp.json'));
    console.log();
    return { success: true };
  }

  console.log();
  for (const server of descriptors) {
    console.log(`  ${ACCENT(server.name.padEnd(20))} ${DIM('dormant · activates on selection')}`);
  }
  console.log();
  return { success: true };
}

function handleTools(ctx: CommandContext): CommandResult {
  const tools = ctx.store.getSnapshot().tools;
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

export {
  handleTodos,
  showHarness,
  handleSkills,
  handleSkill,
  handleMemory,
  handleTools,
  handleMcp,
  showSafety,
};
