/**
 * v0.3.23 T23-B — Repo Intelligence facade: symbol index, incremental
 * maintenance, task-relevant recall with sourced reasons, and budget-aware
 * selection. Feature-flagged at the integration seam (ORION_CODE_REPO_INTELLIGENCE)
 * so the prompt assembly can adopt it incrementally.
 */
export {
  RepoSymbolIndexV1,
  type RepoSymbolEntryV1,
  type RepoFileRecordV1,
  type RepoIndexStatsV1,
  type RepoSymbolIndexOptionsV1,
} from './symbol-index';
export {
  recallFiles,
  selectWithinBudget,
  type RecallCandidateV1,
  type RecallOptionsV1,
} from './recall';

/** The runtime integration flag: 'on' enables harness wiring; default off. */
export function isRepoIntelligenceEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.ORION_CODE_REPO_INTELLIGENCE === 'on';
}
