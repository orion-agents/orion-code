/** Goal completion and blocked audits. Terminal state changes are runtime-owned. */

import type {
  GoalBlocker,
  GoalCompletionAudit,
  GoalContract,
  GoalCriterion,
  GoalCriterionStatus,
  GoalEvidenceRecord,
  GoalEvidenceLedgerTruncation,
} from './types';
import { EXTERNAL_COMPLETION_ACTION_RULES, type ExternalCompletionAction } from './evidence';

const WORKSPACE_BOUND_EVIDENCE = new Set(['test', 'build', 'lint', 'file', 'runtime']);
const MAX_EVIDENCE_TRUNCATION_COUNT = 1_000_000_000;

function evidenceLedgerTruncationRequirement(
  truncation: GoalEvidenceLedgerTruncation | undefined,
  objectiveRevision: number
): string | null {
  if (truncation === undefined) return null;
  const fields = Object.keys(truncation);
  const counts = [
    truncation.droppedPassed,
    truncation.droppedFailed,
    truncation.droppedInconclusive,
  ];
  const valid =
    fields.length === 4 &&
    fields.every(field =>
      ['objectiveRevision', 'droppedPassed', 'droppedFailed', 'droppedInconclusive'].includes(field)
    ) &&
    Number.isSafeInteger(truncation.objectiveRevision) &&
    truncation.objectiveRevision === objectiveRevision &&
    counts.every(
      count => Number.isSafeInteger(count) && count >= 0 && count <= MAX_EVIDENCE_TRUNCATION_COUNT
    ) &&
    counts.some(count => count > 0);
  if (!valid) {
    return (
      'Completion is fail-closed because evidence-ledger truncation metadata is invalid or ' +
      'does not belong to the current objective revision. Use /target edit to start a new ' +
      'objective epoch, then rerun every criterion-specific verification.'
    );
  }
  if (truncation.droppedFailed === 0 && truncation.droppedInconclusive === 0) return null;
  return (
    `Completion is fail-closed because the bounded evidence ledger discarded ` +
    `${truncation.droppedFailed} failed and ${truncation.droppedInconclusive} ` +
    `inconclusive record(s) for objective revision ${truncation.objectiveRevision}. ` +
    'Use /target edit to start a new objective epoch, then rerun every criterion-specific verification.'
  );
}

const SEMANTIC_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'been',
  'complete',
  'completed',
  'criterion',
  'derived',
  'evidence',
  'file',
  'for',
  'from',
  'goal',
  'in',
  'is',
  'of',
  'on',
  'or',
  'pass',
  'passed',
  'passes',
  'primary',
  'requirement',
  'result',
  'runtime',
  'suite',
  'test',
  'the',
  'to',
  'verify',
  'verified',
  'verification',
  'with',
]);

function canonicalToken(value: string): string {
  const lower = value.toLowerCase();
  const actionStem = lower.match(
    /^(publish|release|merge|create|open|submit|raise|push)(?:s|es|ed|d|ing)?$/u
  );
  if (actionStem) return actionStem[1];
  if (/^[a-z0-9_-]+$/u.test(lower) && lower.length > 4 && lower.endsWith('s')) {
    return lower.slice(0, -1);
  }
  return lower;
}

function semanticTokens(value: string): Set<string> {
  const result = new Set<string>();
  for (const raw of value.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []) {
    const token = canonicalToken(raw);
    if (token.length >= 3 && !SEMANTIC_STOP_WORDS.has(token)) result.add(token);
    if (/\p{Script=Han}/u.test(raw)) {
      const characters = Array.from(raw);
      for (let index = 0; index < characters.length - 1; index += 1) {
        result.add(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  return result;
}

const ACTION_NEGATION_PATTERN =
  /\b(?:do\s+not|don't|must\s+not|should\s+not|cannot|can't|never|not\b(?!\s+only\b)|without)\b|不要|禁止|不得|不允许|尚未|不(?:发布|上线|创建|提交|打开|合并|部署|删除|推送|上传)|未(?:发布|上线|创建|提交|打开|合并|部署|删除|推送|上传)/iu;

// A contrast or a strong sentence boundary ends the scope of an earlier
// negation. Ordinary conjunctions deliberately do not: "do not publish and
// merge" negates both actions, while "do not merge, but publish" resets at
// "but" and preserves the positive publish action.
const NEGATION_SCOPE_RESET_PATTERN =
  /[.;；。\n]+|\b(?:but|however|yet|then)\b|(?:但是|但|不过|然而|然后)/giu;

function negationScopeStart(value: string, actionIndex: number): number {
  const matcher = new RegExp(
    NEGATION_SCOPE_RESET_PATTERN.source,
    NEGATION_SCOPE_RESET_PATTERN.flags
  );
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) && match.index < actionIndex) {
    start = matcher.lastIndex;
  }
  return start;
}

/** Return true when at least one pattern match is outside a local negation scope. */
export function hasUnnegatedActionMatch(value: string, pattern: RegExp): boolean {
  const flags = `${pattern.flags.replace(/[gy]/gu, '')}g`;
  const matcher = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value))) {
    const scope = value.slice(negationScopeStart(value, match.index), matcher.lastIndex);
    if (!ACTION_NEGATION_PATTERN.test(scope)) return true;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return false;
}

function criterionCompletionActions(value: string): ExternalCompletionAction[] {
  return EXTERNAL_COMPLETION_ACTION_RULES.filter(rule =>
    hasUnnegatedActionMatch(value, rule.criterionPattern)
  ).map(rule => rule.action);
}

function completedEvidenceActions(
  evidence: GoalEvidenceRecord,
  allowConfirmedAction: boolean
): ExternalCompletionAction[] {
  if (evidence.externalAssertion?.status === 'passed') {
    return [evidence.externalAssertion.action];
  }
  const evidenceText = `${evidence.subject} ${evidence.sourceRef}`;
  return EXTERNAL_COMPLETION_ACTION_RULES.filter(rule =>
    hasUnnegatedActionMatch(
      evidenceText,
      allowConfirmedAction ? rule.criterionPattern : rule.completedEvidencePattern
    )
  ).map(rule => rule.action);
}

function normalizeVersion(value: string): string {
  return value.toLowerCase().replace(/^v/u, '');
}

function exactRequiredVersion(statement: string): string | undefined {
  const packageVersion = statement.match(
    /(?:^|[\s("'`])(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@(v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)/iu
  )?.[1];
  if (packageVersion) return normalizeVersion(packageVersion);
  const versions = statement.match(/\bv?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?\b/giu) ?? [];
  return versions.length > 0 ? normalizeVersion(versions[versions.length - 1]) : undefined;
}

function exactRequiredVersions(statement: string): string[] {
  return [
    ...new Set(
      (statement.match(/\bv?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?\b/giu) ?? []).map(normalizeVersion)
    ),
  ];
}

function exactRequiredPackages(statement: string): string[] {
  const packages = new Set<string>();
  for (const match of statement.matchAll(/@[a-z0-9._-]+\/[a-z0-9._-]+/giu)) {
    packages.add(match[0].toLowerCase());
  }
  for (const match of statement.matchAll(
    /(?:^|[\s("'`])((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?/giu
  )) {
    packages.add(match[1].toLowerCase());
  }
  // A release criterion commonly names unversioned packages as a conjunction,
  // for example "Publish orion-code and orion-sdk to npm". Those names do not
  // carry the scoped-package or @version signals above, but they are still
  // exact targets and must not be collapsed into one generic npm action.
  for (const match of statement.matchAll(
    /\b(?:publish|release)(?:es|ed|d|ing)?\s+(.+?)\s+(?:to|on)\s+(?:the\s+)?npm\b/giu
  )) {
    const clause = match[1].replace(/\b(?:both|the)\b/giu, ' ').replace(/\bpackages?\b/giu, ' ');
    for (const rawCandidate of clause.split(/\s*(?:,|\band\b|&)\s*/iu)) {
      const candidate = rawCandidate.trim().replace(/^[`'"]+|[`'".]+$/gu, '');
      const packageMatch = candidate.match(
        /^((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:@v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)?$/iu
      );
      if (packageMatch) packages.add(packageMatch[1].toLowerCase());
    }
  }
  return [...packages];
}

interface RequiredNpmTarget {
  packageName: string;
  version?: string;
}

function exactRequiredNpmTargets(statement: string): RequiredNpmTarget[] {
  const targets = new Map<string, RequiredNpmTarget>();
  for (const match of statement.matchAll(
    /(?:^|[\s("'`])((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)/giu
  )) {
    const packageName = match[1].toLowerCase();
    targets.set(packageName, { packageName, version: normalizeVersion(match[2]) });
  }
  const sharedVersion = exactRequiredVersion(statement);
  for (const packageName of exactRequiredPackages(statement)) {
    if (!targets.has(packageName)) {
      targets.set(packageName, { packageName, version: sharedVersion });
    }
  }
  return [...targets.values()];
}

function formatRequiredNpmTarget(target: RequiredNpmTarget): string {
  return target.version ? `${target.packageName}@${target.version}` : target.packageName;
}

interface RequiredGithubPullRequestTarget {
  repository?: string;
  prNumber: number;
}

function exactRequiredGithubPullRequests(statement: string): RequiredGithubPullRequestTarget[] {
  const targets = new Map<string, RequiredGithubPullRequestTarget>();
  const sharedRepository = exactRequiredGithubRepository(statement);

  const targetToken = String.raw`(?:[a-z0-9_.-]+\/[a-z0-9_.-]+)?#?\d+`;
  const targetList = String.raw`${targetToken}(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)${targetToken})*`;
  const pullRequestPattern = /\b(?:prs?|pull[\s_-]?requests?)\b/giu;
  for (const pullRequestMatch of statement.matchAll(pullRequestPattern)) {
    const matchIndex = pullRequestMatch.index ?? 0;
    const before = statement.slice(0, matchIndex);
    const after = statement.slice(matchIndex + pullRequestMatch[0].length);
    const adjacentLists = [
      after.match(new RegExp(`^\\s*(${targetList})`, 'iu'))?.[1],
      before.match(new RegExp(`(${targetList})\\s*$`, 'iu'))?.[1],
    ];

    for (const list of adjacentLists) {
      if (!list) continue;
      for (const match of list.matchAll(/(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#?(\d+)\b/giu)) {
        const repository = match[1]?.toLowerCase() ?? sharedRepository;
        const prNumber = Number(match[2]);
        targets.set(`${repository ?? '*'}#${prNumber}`, { repository, prNumber });
      }
    }
  }
  return [...targets.values()];
}

function exactRequiredGithubReleaseRepositories(statement: string): string[] {
  const repositories = new Set<string>();
  const statementWithoutGithubUrls = statement.replace(
    /(?:https?:\/\/)?github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)/giu,
    (_url, repository: string) => {
      repositories.add(repository.toLowerCase());
      return ' ';
    }
  );
  for (const match of statementWithoutGithubUrls.matchAll(/\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/giu)) {
    repositories.add(match[1].toLowerCase());
  }
  return [...repositories];
}

function exactRequiredGithubRepository(statement: string): string | undefined {
  return (
    statement.match(/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)/iu)?.[1] ??
    statement.match(/\b(?:repo(?:sitory)?|github)\s+[`'"]?([a-z0-9_.-]+\/[a-z0-9_.-]+)/iu)?.[1] ??
    statement.match(/\b([a-z0-9_.-]+\/[a-z0-9_.-]+)#\d+\b/iu)?.[1]
  )?.toLowerCase();
}

function exactRequiredBranch(statement: string): string | undefined {
  return (
    statement.match(/\bbranch\s+[`'"]?([a-z0-9._\/-]+)/iu)?.[1] ??
    statement.match(/\bpush(?:ed|ing)?\s+(?:the\s+)?[`'"]?([a-z0-9._\/-]+)\s+branch\b/iu)?.[1]
  );
}

function exactRequiredRemote(statement: string): string | undefined {
  return (
    statement.match(/\bremote\s+[`'"]?([a-z0-9._\/-]+)/iu)?.[1] ??
    statement.match(/\bpush(?:ed|ing)?\s+to\s+[`'"]?([a-z0-9._\/-]+)/iu)?.[1]
  );
}

function externalAssertionMatchesCriterion(
  assertion: NonNullable<GoalEvidenceRecord['externalAssertion']>,
  statement: string
): boolean {
  if (assertion.status !== 'passed' || !assertion.details) return false;
  const statementLower = statement.toLowerCase();

  if (assertion.details.kind === 'npm') {
    const npmDetails = assertion.details;
    if (assertion.provider !== 'npm') return false;
    if (assertion.action === 'publish' && npmDetails.field !== 'publish') return false;
    if (assertion.action === 'registry' && npmDetails.field === 'publish') return false;
    const requiredTargets = exactRequiredNpmTargets(statement);
    if (
      requiredTargets.length > 0 &&
      !requiredTargets.some(
        target =>
          npmDetails.packageName.toLowerCase() === target.packageName &&
          (!target.version || normalizeVersion(npmDetails.version ?? '') === target.version)
      )
    ) {
      return false;
    }
    return true;
  }

  if (assertion.details.kind === 'github_pr') {
    if (assertion.provider !== 'github') return false;
    if (assertion.action === 'merge' && assertion.details.state !== 'MERGED') return false;
    if (assertion.action === 'pull_request' && assertion.details.state !== 'OPEN') return false;
    const prDetails = assertion.details;
    const requiredPullRequests = exactRequiredGithubPullRequests(statement);
    if (
      requiredPullRequests.length > 0 &&
      !requiredPullRequests.some(
        target =>
          target.prNumber === prDetails.prNumber &&
          (!target.repository || prDetails.repository?.toLowerCase() === target.repository)
      )
    ) {
      return false;
    }
    return !/\bnpm\b/iu.test(statement);
  }

  if (assertion.details.kind === 'github_release') {
    if (
      assertion.provider !== 'github' ||
      assertion.action !== 'publish' ||
      assertion.details.isDraft !== false ||
      !assertion.details.publishedAt
    ) {
      return false;
    }
    if (/\bnpm\b/iu.test(statement)) return false;
    const requiredRepositories = exactRequiredGithubReleaseRepositories(statement);
    const requiredVersions = exactRequiredVersions(statement);
    // Pairing several repositories with several tags is ambiguous without an
    // explicit structured contract. Fail closed and require separate atomic
    // criteria instead of accepting a cross-paired set of assertions.
    if (requiredRepositories.length > 1 && requiredVersions.length > 1) return false;
    if (
      requiredRepositories.length > 0 &&
      !requiredRepositories.includes(assertion.details.repository?.toLowerCase() ?? '')
    ) {
      return false;
    }
    if (
      requiredVersions.length > 0 &&
      !requiredVersions.includes(normalizeVersion(assertion.details.tagName ?? ''))
    ) {
      return false;
    }
    return true;
  }

  if (assertion.details.kind === 'git_push') {
    if (assertion.provider !== 'git' || assertion.action !== 'push') return false;
    const requiredBranch = exactRequiredBranch(statement);
    if (requiredBranch && assertion.details.branch !== requiredBranch) return false;
    const requiredRemote = exactRequiredRemote(statement);
    if (requiredRemote && assertion.details.remote !== requiredRemote) return false;
    return !statementLower.includes('npm');
  }

  return false;
}

export function criterionRequiresExternalCompletionEvidence(statement: string): boolean {
  return criterionCompletionActions(statement).length > 0;
}

function completionActionLabel(action: ExternalCompletionAction): string {
  return EXTERNAL_COMPLETION_ACTION_RULES.find(rule => rule.action === action)?.label ?? action;
}

/**
 * Evidence kinds are deliberately broad, so kind equality alone is not proof
 * that a result verifies a criterion. Require an explainable subject/criterion
 * overlap (or the exact criterion id) before a model-proposed mapping is
 * accepted. This is conservative by design: an agent can rerun a specifically
 * named check, but it cannot close a goal with an unrelated generic success.
 */
type EvidenceCriterionMatchReason =
  | 'matched_criterion_id'
  | 'matched_discriminative_token'
  | 'ambiguous_shared_tokens'
  | 'kind_mismatch'
  | 'missing_metadata'
  | 'missing_completion_action'
  | 'untrusted_completion_source'
  | 'external_assertion_mismatch'
  | 'no_semantic_overlap'
  | 'user_confirmation_mismatch';

interface EvidenceCriterionMatch {
  matched: boolean;
  reason: EvidenceCriterionMatchReason;
  sharedTokens: string[];
  coveredActions: ExternalCompletionAction[];
}

function evidenceMatchesCriterion(
  evidence: GoalEvidenceRecord,
  criterion: GoalCriterion,
  allCriteria: GoalCriterion[]
): EvidenceCriterionMatch {
  const requiredActions = criterionCompletionActions(criterion.statement);
  const requiresExternalCompletion = requiredActions.length > 0;
  const allowedKind = requiresExternalCompletion
    ? evidence.kind === 'external' || evidence.kind === 'user'
    : criterion.requiredEvidenceKinds.includes(evidence.kind);
  if (!allowedKind) {
    return { matched: false, reason: 'kind_mismatch', sharedTokens: [], coveredActions: [] };
  }
  if (!evidence.sourceRef.trim() || !evidence.subject.trim()) {
    return { matched: false, reason: 'missing_metadata', sharedTokens: [], coveredActions: [] };
  }
  if (evidence.kind === 'user') {
    const matched =
      evidence.sourceRef === 'user:/target-confirm' && evidence.subject.includes(criterion.id);
    const coveredActions = completedEvidenceActions(evidence, true).filter(action =>
      requiredActions.includes(action)
    );
    const coversRequiredAction = requiredActions.length === 0 || coveredActions.length > 0;
    return {
      matched: matched && coversRequiredAction,
      reason:
        matched && !coversRequiredAction
          ? 'missing_completion_action'
          : matched
            ? 'matched_criterion_id'
            : 'user_confirmation_mismatch',
      sharedTokens: [],
      coveredActions,
    };
  }
  if (
    requiresExternalCompletion &&
    evidence.kind === 'external' &&
    evidence.sourceRef.startsWith('tool:') &&
    !evidence.externalAssertion
  ) {
    return {
      matched: false,
      reason: 'untrusted_completion_source',
      sharedTokens: [],
      coveredActions: [],
    };
  }
  if (
    requiresExternalCompletion &&
    evidence.externalAssertion &&
    !externalAssertionMatchesCriterion(evidence.externalAssertion, criterion.statement)
  ) {
    return {
      matched: false,
      reason: 'external_assertion_mismatch',
      sharedTokens: [],
      coveredActions: [],
    };
  }
  const coveredActions = completedEvidenceActions(evidence, false).filter(action =>
    requiredActions.includes(action)
  );
  if (requiresExternalCompletion && coveredActions.length === 0) {
    return {
      matched: false,
      reason: 'missing_completion_action',
      sharedTokens: [],
      coveredActions: [],
    };
  }
  if (
    evidence.subject.toLowerCase().includes(criterion.id.toLowerCase()) ||
    evidence.sourceRef.toLowerCase().includes(criterion.id.toLowerCase())
  ) {
    return { matched: true, reason: 'matched_criterion_id', sharedTokens: [], coveredActions };
  }
  const criterionTokens = semanticTokens(criterion.statement);
  if (criterionTokens.size === 0) {
    return { matched: false, reason: 'no_semantic_overlap', sharedTokens: [], coveredActions };
  }
  const evidenceTokens = semanticTokens(evidence.subject);
  const sharedTokens = [...criterionTokens].filter(token => evidenceTokens.has(token));
  if (sharedTokens.length === 0) {
    return { matched: false, reason: 'no_semantic_overlap', sharedTokens: [], coveredActions };
  }

  // Terms repeated across criteria identify the overall goal topic, not the
  // individual requirement. For example, "package smoke" cannot distinguish
  // a registry-entry check from a binary-start check. At least one overlapping
  // term must be unique to this criterion within the current contract.
  const otherCriterionTokens = new Set(
    allCriteria
      .filter(item => item.id !== criterion.id)
      .flatMap(item => [...semanticTokens(item.statement)])
  );
  const discriminativeTokens = sharedTokens.filter(token => !otherCriterionTokens.has(token));
  if (discriminativeTokens.length > 0) {
    return {
      matched: true,
      reason: 'matched_discriminative_token',
      sharedTokens: discriminativeTokens,
      coveredActions,
    };
  }
  return { matched: false, reason: 'ambiguous_shared_tokens', sharedTokens, coveredActions };
}

export interface CompletionAuditInput {
  objective: string;
  contract: GoalContract;
  evidenceLedger: GoalEvidenceRecord[];
  evidenceLedgerTruncation?: GoalEvidenceLedgerTruncation;
  goalId: string;
  goalRevision: number;
  requestedAt: number;
  verificationSummary: string;
  workspaceFingerprint?: string;
  now?: number;
}

function evidenceIsFresh(
  evidence: GoalEvidenceRecord,
  input: CompletionAuditInput,
  now: number,
  requireExternalExpiry = false
): boolean {
  if (evidence.goalId !== input.goalId) return false;
  if (evidence.goalRevision > input.goalRevision) return false;
  if (evidence.objectiveRevision !== input.contract.objectiveRevision) return false;
  if (evidence.capturedAt > now) return false;
  if (
    requireExternalExpiry &&
    evidence.kind === 'external' &&
    evidence.expiresAt === undefined &&
    // Legacy registry adapters emit a typed registry source instead of an
    // explicit expiry. Keep those records only when they were captured for
    // this completion request; generic external/tool claims remain fail-closed.
    !(evidence.sourceRef.startsWith('registry:') && evidence.capturedAt >= input.requestedAt)
  )
    return false;
  if (evidence.expiresAt !== undefined && evidence.expiresAt <= now) return false;
  if (evidence.externalAssertion) {
    const observedAt = evidence.externalAssertion.observedAt;
    // Bind freshness to the time of the external observation, not merely to
    // when a ledger record was created. This prevents a stale assertion from
    // being copied into a fresh-looking evidence envelope.
    if (observedAt > evidence.capturedAt || observedAt > now) return false;
    if (requireExternalExpiry && now - observedAt >= 5 * 60_000) return false;
  }
  if (WORKSPACE_BOUND_EVIDENCE.has(evidence.kind)) {
    if (!input.workspaceFingerprint || !evidence.workspaceFingerprint) return false;
    if (evidence.workspaceFingerprint !== input.workspaceFingerprint) return false;
  }
  if (
    input.workspaceFingerprint &&
    evidence.workspaceFingerprint &&
    evidence.workspaceFingerprint !== input.workspaceFingerprint
  )
    return false;
  return true;
}

export function auditCompletion(input: CompletionAuditInput): GoalCompletionAudit {
  const now = input.now ?? Date.now();
  const evidenceById = new Map(input.evidenceLedger.map(record => [record.id, record]));
  const criterionResults = input.contract.successCriteria.map(criterion => {
    const records = criterion.evidenceRefs
      .map(ref => evidenceById.get(ref))
      .filter((record): record is GoalEvidenceRecord => Boolean(record));
    const mappedMatches = records.map(record => ({
      record,
      match: evidenceMatchesCriterion(record, criterion, input.contract.successCriteria),
    }));
    const mappedRelevant = mappedMatches.filter(item => item.match.matched);
    const requiredActions = criterionCompletionActions(criterion.statement);
    const requireExternalExpiry = requiredActions.length > 0;
    const relevantMatches = mappedRelevant.filter(
      item =>
        item.record.result === 'passed' &&
        evidenceIsFresh(item.record, input, now, requireExternalExpiry)
    );
    const relevant = relevantMatches.map(item => item.record);
    const hasTrustedUserConfirmation = relevant.some(record => record.kind === 'user');
    // Audit the whole ledger, not only model-selected refs. Otherwise a model
    // can omit a relevant failed record and cherry-pick a passing record.
    const failedRecords = input.evidenceLedger.filter(
      record =>
        record.result === 'failed' &&
        evidenceMatchesCriterion(record, criterion, input.contract.successCriteria).matched &&
        evidenceIsFresh(record, input, now, requireExternalExpiry)
    );
    const failed = failedRecords.length > 0;
    const coveredActions = new Set(relevantMatches.flatMap(item => item.match.coveredActions));
    const missingActions = requiredActions.filter(action => !coveredActions.has(action));
    const requiredNpmTargets = exactRequiredNpmTargets(criterion.statement);
    const npmAssertions = relevantMatches
      .map(item => item.record.externalAssertion)
      .filter(
        (
          assertion
        ): assertion is NonNullable<GoalEvidenceRecord['externalAssertion']> & {
          details: Extract<
            NonNullable<GoalEvidenceRecord['externalAssertion']>['details'],
            { kind: 'npm' }
          >;
        } => assertion?.details?.kind === 'npm'
      );
    // A structured npm assertion proves exactly one package target. When a
    // criterion names several packages, require a fresh matching assertion
    // for every target instead of letting any one package close the whole
    // conjunction.
    const missingNpmTargets =
      !hasTrustedUserConfirmation &&
      requiredNpmTargets.length > 0 &&
      (npmAssertions.length > 0 || requiredNpmTargets.length > 1)
        ? requiredNpmTargets.filter(
            target =>
              !npmAssertions.some(
                assertion =>
                  assertion.details.packageName.toLowerCase() === target.packageName &&
                  (!target.version ||
                    normalizeVersion(assertion.details.version ?? '') === target.version)
              )
          )
        : [];
    const requiredPullRequests = exactRequiredGithubPullRequests(criterion.statement);
    const pullRequestAssertions = relevantMatches
      .map(item => item.record.externalAssertion)
      .filter(
        (
          assertion
        ): assertion is NonNullable<GoalEvidenceRecord['externalAssertion']> & {
          details: Extract<
            NonNullable<GoalEvidenceRecord['externalAssertion']>['details'],
            { kind: 'github_pr' }
          >;
        } => assertion?.details?.kind === 'github_pr'
      );
    const missingPullRequests =
      !hasTrustedUserConfirmation &&
      requiredPullRequests.length > 0 &&
      (pullRequestAssertions.length > 0 || requiredPullRequests.length > 1)
        ? requiredPullRequests.filter(
            target =>
              !pullRequestAssertions.some(
                assertion =>
                  assertion.details.prNumber === target.prNumber &&
                  (!target.repository ||
                    assertion.details.repository?.toLowerCase() === target.repository)
              )
          )
        : [];
    const requiresGithubReleaseTargets =
      requiredActions.includes('publish') &&
      requiredNpmTargets.length === 0 &&
      !/\bnpm\b/iu.test(criterion.statement);
    const requiredReleaseRepositories = requiresGithubReleaseTargets
      ? exactRequiredGithubReleaseRepositories(criterion.statement)
      : [];
    const releaseAssertions = relevantMatches
      .map(item => item.record.externalAssertion)
      .filter(
        (
          assertion
        ): assertion is NonNullable<GoalEvidenceRecord['externalAssertion']> & {
          details: Extract<
            NonNullable<GoalEvidenceRecord['externalAssertion']>['details'],
            { kind: 'github_release' }
          >;
        } => assertion?.details?.kind === 'github_release'
      );
    const missingReleaseRepositories =
      !hasTrustedUserConfirmation &&
      requiredReleaseRepositories.length > 0 &&
      (releaseAssertions.length > 0 || requiredReleaseRepositories.length > 1)
        ? requiredReleaseRepositories.filter(
            repository =>
              !releaseAssertions.some(
                assertion => assertion.details.repository?.toLowerCase() === repository
              )
          )
        : [];
    const requiredReleaseVersions = requiresGithubReleaseTargets
      ? exactRequiredVersions(criterion.statement)
      : [];
    const missingReleaseVersions =
      !hasTrustedUserConfirmation &&
      requiredReleaseVersions.length > 0 &&
      (releaseAssertions.length > 0 || requiredReleaseVersions.length > 1)
        ? requiredReleaseVersions.filter(
            version =>
              !releaseAssertions.some(
                assertion => normalizeVersion(assertion.details.tagName ?? '') === version
              )
          )
        : [];
    const missingExternalTargets = [
      ...missingNpmTargets.map(formatRequiredNpmTarget),
      ...missingPullRequests.map(
        target => `${target.repository ?? 'requested repository'}#${target.prNumber}`
      ),
      ...missingReleaseRepositories.map(repository => `GitHub release ${repository}`),
      ...missingReleaseVersions.map(version => `GitHub release tag ${version}`),
    ];
    const passed =
      relevant.length > 0 &&
      missingActions.length === 0 &&
      missingExternalTargets.length === 0 &&
      !failed;
    const stale = mappedRelevant.some(
      item => !evidenceIsFresh(item.record, input, now, requireExternalExpiry)
    );
    const irrelevant = records.length > 0 && mappedRelevant.length === 0;
    const ambiguousTokens = [
      ...new Set(
        mappedMatches
          .filter(item => item.match.reason === 'ambiguous_shared_tokens')
          .flatMap(item => item.match.sharedTokens)
      ),
    ];
    const status: GoalCriterionStatus = passed
      ? 'passed'
      : failed
        ? 'failed'
        : stale
          ? 'stale'
          : 'pending';
    let reason: string | undefined;
    if (!passed) {
      reason =
        status === 'failed'
          ? `[${criterion.id}] ${criterion.statement}: relevant verification failed (${failedRecords
              .slice(0, 3)
              .map(record => record.id)
              .join(', ')}). Rerun the criterion-specific verification after fixing the failure.`
          : status === 'stale'
            ? `[${criterion.id}] ${criterion.statement}: referenced evidence is stale or lacks the required workspace fingerprint. Rerun a criterion-specific ${criterion.requiredEvidenceKinds.join('/')} check.`
            : missingExternalTargets.length > 0
              ? `[${criterion.id}] ${criterion.statement}: fresh external evidence is missing for required target(s): ${missingExternalTargets.join(', ')}.`
              : missingActions.length > 0
                ? `[${criterion.id}] ${criterion.statement}: completion requires fresh external or user evidence covering the completed action/status (${missingActions.map(completionActionLabel).join(', ')}). Local runtime, build, file, or version output cannot prove this external state.`
                : irrelevant && ambiguousTokens.length > 0
                  ? `[${criterion.id}] ${criterion.statement}: mapped evidence overlaps only on terms shared by multiple criteria (${ambiguousTokens.slice(0, 4).join(', ')}). Include a criterion-specific term or the exact criterion id in the evidence subject.`
                  : irrelevant
                    ? `[${criterion.id}] ${criterion.statement}: mapped evidence is not semantically related to this criterion. Run a specifically named ${criterion.requiredEvidenceKinds.join('/')} check.`
                    : `[${criterion.id}] ${criterion.statement}: fresh relevant evidence is required. Run a criterion-specific ${criterion.requiredEvidenceKinds.join('/')} check.`;
    }
    return {
      criterionId: criterion.id,
      passed,
      status,
      evidenceRefs: relevant.map(record => record.id),
      reason,
    };
  });
  const remainingRequirements = criterionResults
    .filter(result => !result.passed)
    .map(result => result.reason ?? `Criterion ${result.criterionId} is not verified.`);
  const truncationRequirement = evidenceLedgerTruncationRequirement(
    input.evidenceLedgerTruncation,
    input.contract.objectiveRevision
  );
  if (truncationRequirement) remainingRequirements.push(truncationRequirement);
  const passed = criterionResults.length > 0 && remainingRequirements.length === 0;
  return {
    requestedAt: input.requestedAt,
    auditedAt: now,
    passed,
    verificationSummary:
      input.verificationSummary.trim() ||
      (passed ? 'All success criteria have fresh runtime evidence.' : 'Completion audit failed.'),
    remainingRequirements,
    evidenceRefs: [...new Set(criterionResults.flatMap(result => result.evidenceRefs))],
    criterionResults,
  };
}

export interface BlockedAuditInput {
  blocker: GoalBlocker;
  noProgressCount: number;
}

export function auditBlocked(input: BlockedAuditInput): {
  allowed: boolean;
  reason: string;
} {
  if (!['user_input', 'permission', 'external_state'].includes(input.blocker.category)) {
    return { allowed: false, reason: 'Blocker category is not eligible for terminal blocked.' };
  }
  if (input.blocker.retryable !== false) {
    return { allowed: false, reason: 'Retryable blockers cannot become terminal blocked.' };
  }
  if (input.blocker.consecutiveTurns < 3) {
    return {
      allowed: false,
      reason: `Blocker seen ${input.blocker.consecutiveTurns}/3 required turns.`,
    };
  }
  if (input.noProgressCount < 3) {
    return {
      allowed: false,
      reason: 'Progress was made in recent turns; blocking not justified.',
    };
  }
  return {
    allowed: true,
    reason: `Blocker persisted for ${input.blocker.consecutiveTurns} consecutive turns with no progress.`,
  };
}

export function blockerFingerprint(category: string, resource: string, reason: string): string {
  return `${category}:${resource}:${reason}`;
}

export function blockersMatch(a: GoalBlocker | undefined, fingerprint: string): boolean {
  return Boolean(a && a.fingerprint === fingerprint);
}
