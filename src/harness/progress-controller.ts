import { createHash } from 'crypto';
import type {
  ContextLedgerEntry,
  HarnessProgressState,
  ProgressDelta,
  ProgressSnapshot,
  TaskContract,
  TaskCriterionStatus,
} from './types';

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => !!value?.trim()).map(value => value.trim())
    ),
  ].sort();
}

function metadataString(entry: ContextLedgerEntry, key: string): string | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function criterionStates(contract: TaskContract | undefined): ProgressSnapshot['criterionStates'] {
  return (contract?.criteria ?? [])
    .map(criterion => ({
      id: criterion.id,
      status: (criterion.status ?? 'pending') as TaskCriterionStatus,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function latestToolSignature(ledger: ContextLedgerEntry[]): string | undefined {
  const entry = [...ledger]
    .reverse()
    .find(item => item.type === 'tool_result' || item.type === 'verification');
  if (!entry) return undefined;
  return canonicalHash({
    toolName: metadataString(entry, 'toolName'),
    command: metadataString(entry, 'command'),
    path: metadataString(entry, 'path'),
    success: entry.metadata?.success,
    error: metadataString(entry, 'error'),
  });
}

function buildSnapshot(params: {
  contract?: TaskContract;
  ledger: ContextLedgerEntry[];
  diagnostics: string[];
}): ProgressSnapshot {
  const states = criterionStates(params.contract);
  const evidenceRefs = unique(
    params.ledger
      .filter(
        entry =>
          (entry.type === 'verification' || entry.type === 'test_result') &&
          entry.metadata?.resultTrust === 'structured'
      )
      .map(entry => entry.id)
  );
  const changedFiles = unique(
    params.ledger.map(
      entry => metadataString(entry, 'changedFile') ?? metadataString(entry, 'path')
    )
  );
  const decisions = unique(
    params.ledger.filter(entry => entry.type === 'decision').map(entry => entry.content)
  ).slice(-20);
  const blockers = unique(
    params.ledger
      .filter(entry => entry.type === 'blocker' || entry.type === 'risk')
      .map(entry => entry.content)
  ).slice(-20);
  const diagnostics = unique(params.diagnostics).slice(-20);
  const toolSignature = latestToolSignature(params.ledger);
  const workspaceStateHash = canonicalHash(changedFiles);
  const material = {
    criterionStates: states,
    evidenceRefs,
    changedFiles,
    decisions,
    blockers,
    diagnostics,
    toolSignature,
    workspaceStateHash,
  };
  return { fingerprint: canonicalHash(material), ...material };
}

function difference(current: string[], previous: string[]): string[] {
  const before = new Set(previous);
  return current.filter(item => !before.has(item));
}

/** Harness-owned deterministic progress tracker used by all completion adapters. */
export class ProgressController {
  private state: HarnessProgressState;

  constructor(state?: HarnessProgressState) {
    this.state = state?.schemaVersion === 1 ? structuredClone(state) : { schemaVersion: 1 };
  }

  observe(params: {
    contract?: TaskContract;
    ledger: ContextLedgerEntry[];
    diagnostics?: string[];
    now?: number;
  }): ProgressDelta {
    const snapshot = buildSnapshot({
      contract: params.contract,
      ledger: params.ledger,
      diagnostics: params.diagnostics ?? [],
    });
    const previous = this.state.snapshot;
    const previousStates = new Map(previous?.criterionStates.map(item => [item.id, item.status]));
    const criterionChanges = snapshot.criterionStates
      .filter(item => previousStates?.get(item.id) !== item.status)
      .map(item => ({ id: item.id, from: previousStates?.get(item.id), to: item.status }));
    const repeatedSignatureCount =
      previous?.fingerprint === snapshot.fingerprint
        ? (this.state.lastDelta?.repeatedSignatureCount ?? 0) + 1
        : 0;
    const delta: ProgressDelta = {
      schemaVersion: 1,
      changed: previous === undefined || previous.fingerprint !== snapshot.fingerprint,
      criterionChanges,
      newEvidenceRefs: difference(snapshot.evidenceRefs, previous?.evidenceRefs ?? []),
      newChangedFiles: difference(snapshot.changedFiles, previous?.changedFiles ?? []),
      newDecisions: difference(snapshot.decisions, previous?.decisions ?? []),
      newBlockers: difference(snapshot.blockers, previous?.blockers ?? []),
      newDiagnostics: difference(snapshot.diagnostics, previous?.diagnostics ?? []),
      toolSignature: snapshot.toolSignature,
      workspaceStateHash: snapshot.workspaceStateHash,
      repeatedSignatureCount,
      recordedAt: params.now ?? Date.now(),
    };
    this.state = { schemaVersion: 1, snapshot, lastDelta: delta };
    return structuredClone(delta);
  }

  toJSON(): HarnessProgressState {
    return structuredClone(this.state);
  }
}
