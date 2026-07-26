import type {
  ContextCapsule,
  ContextLedgerEntry,
  HarnessState,
  PlanStep,
  TaskContract,
} from './types';

function metadataString(entry: ContextLedgerEntry, key: string): string | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function metadataBool(entry: ContextLedgerEntry, key: string): boolean | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function compactLine(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

function fallbackNextAction(contract: TaskContract | undefined): string {
  if (!contract) return 'Continue the current task.';
  const currentInstruction = compactLine(contract.userIntent || contract.objective, 220);
  return `Address current instruction: ${currentInstruction}`;
}

export function createContextCapsule(
  contract: TaskContract | undefined,
  entries: ContextLedgerEntry[]
): ContextCapsule {
  const now = Date.now();
  const keyFacts = [...entries]
    .filter(entry => entry.importance >= 4 || entry.type === 'user_requirement')
    .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
    .slice(0, 12);

  const todoEntries = entries.filter(entry => entry.type === 'todo');
  const currentPlan: PlanStep[] = todoEntries.slice(0, 8).map((entry, index) => ({
    id: entry.id,
    title: compactLine(entry.content),
    status: index === 0 ? 'in_progress' : 'pending',
  }));

  const verificationEntries = entries.filter(
    entry => entry.type === 'verification' || entry.type === 'test_result'
  );
  const passed = verificationEntries
    .filter(entry => metadataBool(entry, 'success') === true)
    .map(entry => compactLine(entry.content));
  const failed = verificationEntries
    .filter(entry => metadataBool(entry, 'success') === false)
    .map(entry => compactLine(entry.content));
  const commandsRun = unique(
    verificationEntries.map(entry => metadataString(entry, 'command') || '').filter(Boolean)
  );
  const changedFiles = unique(
    entries
      .map(entry => metadataString(entry, 'changedFile') || metadataString(entry, 'path') || '')
      .filter(Boolean)
  );
  const completed = entries
    .filter(
      entry =>
        entry.type === 'decision' ||
        (entry.type === 'tool_result' && metadataBool(entry, 'success') === true)
    )
    .slice(-8)
    .map(entry => compactLine(entry.content));
  const openTodos = currentPlan.filter(step => step.status !== 'completed').map(step => step.title);

  return {
    contract,
    currentPlan,
    completed,
    openTodos,
    keyFacts,
    changedFiles,
    verification: {
      commandsRun,
      passed,
      failed,
      warnings: entries
        .filter(entry => entry.type === 'risk' || entry.type === 'blocker')
        .slice(-5)
        .map(entry => compactLine(entry.content)),
    },
    nextAction: openTodos[0] || fallbackNextAction(contract),
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeContextCapsule(
  capsule: ContextCapsule,
  contract: TaskContract | undefined = capsule.contract
): ContextCapsule {
  const currentPlan = capsule.currentPlan ?? [];
  const openTodos = currentPlan
    .filter(step => step.status !== 'completed')
    .map(step => compactLine(step.title));
  return {
    ...capsule,
    contract,
    currentPlan,
    openTodos,
    nextAction: openTodos[0] || fallbackNextAction(contract),
    updatedAt: Date.now(),
  };
}

export function renderContextCapsule(capsule: ContextCapsule): string {
  const contract = capsule.contract;
  const lines: string[] = ['## Context Capsule'];

  if (contract) {
    lines.push('', `Objective: ${contract.objective}`);
    if (contract.requirements.length > 0) {
      lines.push('Requirements:');
      lines.push(...contract.requirements.map(item => `- ${item}`));
    }
    if (contract.prohibitions.length > 0) {
      lines.push('Prohibitions:');
      lines.push(...contract.prohibitions.map(item => `- ${item}`));
    }
  }

  if (capsule.openTodos.length > 0) {
    lines.push('', 'Open todos:');
    lines.push(...capsule.openTodos.map(item => `- ${item}`));
  }

  if (capsule.keyFacts.length > 0) {
    lines.push('', 'Key facts:');
    lines.push(...capsule.keyFacts.slice(0, 8).map(entry => `- ${entry.content}`));
  }

  if (capsule.verification.passed.length > 0 || capsule.verification.failed.length > 0) {
    lines.push('', 'Verification:');
    lines.push(...capsule.verification.passed.map(item => `- Passed: ${item}`));
    lines.push(...capsule.verification.failed.map(item => `- Failed: ${item}`));
  }

  if (capsule.changedFiles.length > 0) {
    lines.push('', `Changed files: ${capsule.changedFiles.join(', ')}`);
  }

  lines.push('', `Next action: ${capsule.nextAction}`);
  return lines.join('\n');
}

export function renderHarnessStateForCompact(
  state: HarnessState,
  mode: 'manual' | 'auto_pre_turn' | 'mid_turn' = 'manual'
): string {
  const lines: string[] = ['[Orion Code Context State v2]'];
  lines.push(`mode: ${mode}`);
  lines.push(`taskEpoch: ${state.taskEpoch ?? 1}`);
  if (state.rootObjective || state.contract?.objective) {
    lines.push(
      `rootObjective: ${compactLine(state.rootObjective ?? state.contract!.objective, 220)}`
    );
  }
  if (state.activeInstruction || state.contract?.userIntent) {
    lines.push(
      `activeInstruction: ${compactLine(state.activeInstruction ?? state.contract!.userIntent, 260)}`
    );
  }

  const latestIntent = state.intentHistory?.[state.intentHistory.length - 1];
  if (latestIntent) {
    lines.push(
      `latestIntent: ${latestIntent.kind} (${Math.round(latestIntent.confidence * 100)}%)`
    );
  }

  const constraints = state.activeConstraints ?? state.contract?.constraints ?? [];
  if (constraints.length > 0) {
    lines.push('activeConstraints:');
    lines.push(...constraints.slice(0, 8).map(item => `- ${compactLine(item)}`));
  }

  const nonGoals = state.nonGoals ?? state.contract?.prohibitions ?? [];
  if (nonGoals.length > 0) {
    lines.push('nonGoals:');
    lines.push(...nonGoals.slice(0, 8).map(item => `- ${compactLine(item)}`));
  }

  if (state.openQuestions && state.openQuestions.length > 0) {
    lines.push('openQuestions:');
    lines.push(...state.openQuestions.slice(0, 6).map(item => `- ${compactLine(item)}`));
  }

  if (state.capsule) {
    if (state.capsule.openTodos.length > 0) {
      lines.push('openTodos:');
      lines.push(...state.capsule.openTodos.slice(0, 8).map(item => `- ${compactLine(item)}`));
    }
    const verification = state.capsule.verification;
    if (
      verification.passed.length > 0 ||
      verification.failed.length > 0 ||
      verification.warnings.length > 0
    ) {
      lines.push('verification:');
      lines.push(...verification.passed.slice(0, 5).map(item => `- passed: ${compactLine(item)}`));
      lines.push(...verification.failed.slice(0, 5).map(item => `- failed: ${compactLine(item)}`));
      lines.push(
        ...verification.warnings.slice(0, 4).map(item => `- warning: ${compactLine(item)}`)
      );
    }
    if (state.capsule.changedFiles.length > 0) {
      lines.push(`changedFiles: ${state.capsule.changedFiles.slice(0, 12).join(', ')}`);
    }
    lines.push(`nextAction: ${compactLine(state.capsule.nextAction, 220)}`);
  }

  const turns = state.turnSummaries ?? [];
  if (turns.length > 0) {
    lines.push('recentTurns:');
    for (const turn of turns.slice(-5)) {
      lines.push(
        `- turn ${turn.turn} [${turn.intentKind}]: ${compactLine(turn.userIntent, 100)} -> ${compactLine(turn.assistantOutcome, 140)}`
      );
    }
  }

  const evidenceIds =
    state.promptAssemblyStats?.includedEvidence.map(item => item.id) ??
    state.evidenceIndex?.slice(0, 8).map(item => item.id) ??
    [];
  if (evidenceIds.length > 0) {
    lines.push(`evidenceIds: ${evidenceIds.slice(0, 12).join(', ')}`);
  }

  if (state.diagnostics && state.diagnostics.length > 0) {
    lines.push('diagnostics:');
    lines.push(...state.diagnostics.slice(-5).map(item => `- ${compactLine(item)}`));
  }

  lines.push('[/Orion Code Context State v2]');
  return lines.join('\n');
}
