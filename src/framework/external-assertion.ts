/** A bounded, runtime-produced assertion about an external side effect or state. */
export type ToolExternalAssertionAction =
  | 'publish'
  | 'pull_request'
  | 'merge'
  | 'registry'
  | 'push';

export type ToolExternalAssertionStatus = 'passed' | 'failed' | 'inconclusive';

export type ToolExternalAssertionDetails =
  | {
      kind: 'npm';
      packageName: string;
      version?: string;
      field: 'publish' | 'version' | 'dist-tags.latest';
    }
  | {
      kind: 'github_pr';
      repository?: string;
      prNumber?: number;
      state?: 'OPEN' | 'MERGED' | 'CLOSED';
    }
  | {
      kind: 'github_release';
      repository?: string;
      tagName?: string;
      isDraft?: boolean;
      publishedAt?: string;
    }
  | {
      kind: 'git_push';
      remote?: string;
      branch?: string;
      commit?: string;
    };

export interface ToolExternalAssertion {
  version: 1;
  action: ToolExternalAssertionAction;
  status: ToolExternalAssertionStatus;
  provider: 'npm' | 'github' | 'git';
  target: string;
  observedValue?: string;
  observedAt: number;
  details?: ToolExternalAssertionDetails;
}

const ACTIONS = new Set<ToolExternalAssertionAction>([
  'publish',
  'pull_request',
  'merge',
  'registry',
  'push',
]);
const STATUSES = new Set<ToolExternalAssertionStatus>(['passed', 'failed', 'inconclusive']);
const PROVIDERS = new Set(['npm', 'github', 'git']);

function isBoundedOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 512);
}

function isAssertionDetails(value: unknown): value is ToolExternalAssertionDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'npm') {
    return (
      typeof record.packageName === 'string' &&
      record.packageName.length > 0 &&
      record.packageName.length <= 214 &&
      isBoundedOptionalString(record.version) &&
      ['publish', 'version', 'dist-tags.latest'].includes(String(record.field))
    );
  }
  if (record.kind === 'github_pr') {
    return (
      isBoundedOptionalString(record.repository) &&
      (record.prNumber === undefined ||
        (typeof record.prNumber === 'number' &&
          Number.isSafeInteger(record.prNumber) &&
          record.prNumber > 0)) &&
      (record.state === undefined || ['OPEN', 'MERGED', 'CLOSED'].includes(String(record.state)))
    );
  }
  if (record.kind === 'github_release') {
    return (
      isBoundedOptionalString(record.repository) &&
      isBoundedOptionalString(record.tagName) &&
      (record.isDraft === undefined || typeof record.isDraft === 'boolean') &&
      isBoundedOptionalString(record.publishedAt)
    );
  }
  if (record.kind === 'git_push') {
    return (
      isBoundedOptionalString(record.remote) &&
      isBoundedOptionalString(record.branch) &&
      isBoundedOptionalString(record.commit)
    );
  }
  return false;
}

function assertionDetailsAreConsistent(record: Record<string, unknown>): boolean {
  const details = record.details as ToolExternalAssertionDetails | undefined;
  if (!details) return true;
  if (details.kind === 'npm') {
    return (
      record.provider === 'npm' &&
      ((record.action === 'publish' && details.field === 'publish') ||
        (record.action === 'registry' && details.field !== 'publish'))
    );
  }
  if (details.kind === 'github_pr') {
    if (
      record.provider !== 'github' ||
      !['pull_request', 'merge'].includes(String(record.action))
    ) {
      return false;
    }
    if (record.status !== 'passed') return true;
    return (
      (record.action === 'pull_request' && details.state === 'OPEN') ||
      (record.action === 'merge' && details.state === 'MERGED')
    );
  }
  if (details.kind === 'github_release') {
    return (
      record.provider === 'github' &&
      record.action === 'publish' &&
      (record.status !== 'passed' || (details.isDraft === false && Boolean(details.publishedAt)))
    );
  }
  return record.provider === 'git' && record.action === 'push';
}

export function isToolExternalAssertion(value: unknown): value is ToolExternalAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.action === 'string' &&
    ACTIONS.has(record.action as ToolExternalAssertionAction) &&
    typeof record.status === 'string' &&
    STATUSES.has(record.status as ToolExternalAssertionStatus) &&
    typeof record.provider === 'string' &&
    PROVIDERS.has(record.provider) &&
    typeof record.target === 'string' &&
    record.target.trim().length > 0 &&
    record.target.length <= 512 &&
    isBoundedOptionalString(record.observedValue) &&
    typeof record.observedAt === 'number' &&
    Number.isFinite(record.observedAt) &&
    record.observedAt >= 0 &&
    (record.details === undefined || isAssertionDetails(record.details)) &&
    assertionDetailsAreConsistent(record)
  );
}

function simpleShellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    if (current) words.push(current);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    // External assertions accept only one direct command. This deliberately
    // excludes pipes, fallbacks, background jobs and command substitution.
    if (';\n|&`'.includes(char) || (char === '$' && command[index + 1] === '(')) return null;
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  if (quote || escaped) return null;
  flush();

  let offset = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[offset] ?? '')) offset += 1;
  if (words[offset]?.toLowerCase() === 'env') {
    offset += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[offset] ?? '')) offset += 1;
  }
  if (words[offset]?.toLowerCase() === 'command') offset += 1;
  return words.slice(offset);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const exact = argv.indexOf(flag);
  if (exact >= 0) return argv[exact + 1];
  const prefix = `${flag}=`;
  return argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

function bounded(value: string | undefined, fallback: string): string {
  const compact = value?.trim().replace(/\s+/gu, ' ');
  return (compact || fallback).slice(0, 512);
}

function npmViewValue(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string' || typeof parsed === 'number') return String(parsed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === 'string' || typeof version === 'number') return String(version);
    }
  } catch {
    // npm's default non-JSON view output is handled below.
  }
  return (
    trimmed
      .split(/\r?\n/u, 1)[0]
      ?.replace(/^['"]|['"]$/gu, '')
      .trim() || undefined
  );
}

function githubState(output: string): { state?: string; url?: string; number?: string } {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      state: typeof parsed.state === 'string' ? parsed.state.toUpperCase() : undefined,
      url: typeof parsed.url === 'string' ? parsed.url : undefined,
      number:
        typeof parsed.number === 'string' || typeof parsed.number === 'number'
          ? String(parsed.number)
          : undefined,
    };
  } catch {
    return {
      state: trimmed.match(/\b(OPEN|MERGED|CLOSED)\b/iu)?.[1]?.toUpperCase(),
      url: trimmed.match(/https:\/\/[^\s]+\/pull\/\d+/u)?.[0],
      number: trimmed.match(/(?:pull\/|#)(\d+)/u)?.[1],
    };
  }
}

function githubRepositoryFromUrl(url: string | undefined): string | undefined {
  return url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|releases)(?:\/|$)/iu)?.[1];
}

function packageSpec(value: string): { packageName: string; requestedVersion?: string } | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-')) return null;
  const splitAt = trimmed.startsWith('@') ? trimmed.lastIndexOf('@') : trimmed.indexOf('@');
  const hasVersion = splitAt > 0 && (!trimmed.startsWith('@') || splitAt > trimmed.indexOf('/'));
  const packageName = hasVersion ? trimmed.slice(0, splitAt) : trimmed;
  const requestedVersion = hasVersion ? trimmed.slice(splitAt + 1) : undefined;
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(packageName)) return null;
  return { packageName, ...(requestedVersion ? { requestedVersion } : {}) };
}

const NPM_BOOLEAN_FLAGS = new Set(['--json', '-j', '--silent', '--long', '--parseable']);
const NPM_VALUE_FLAGS = new Set(['--registry', '--tag', '--workspace', '--userconfig', '--otp']);

function npmViewInvocation(args: string[]):
  | {
      packageName: string;
      requestedVersion?: string;
      field: 'version' | 'dist-tags.latest';
    }
  | undefined {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const lower = arg.toLowerCase();
    if (NPM_BOOLEAN_FLAGS.has(lower)) continue;
    if (NPM_VALUE_FLAGS.has(lower)) {
      index += 1;
      if (index >= args.length) return undefined;
      continue;
    }
    if ([...NPM_VALUE_FLAGS].some(flag => lower.startsWith(`${flag}=`))) continue;
    if (arg.startsWith('-')) return undefined;
    positionals.push(arg);
  }
  if (positionals.length !== 2) return undefined;
  const spec = packageSpec(positionals[0]);
  const field = positionals[1].toLowerCase();
  if (!spec || !['version', 'dist-tags.latest'].includes(field)) return undefined;
  return {
    packageName: spec.packageName,
    ...(spec.requestedVersion ? { requestedVersion: spec.requestedVersion } : {}),
    field: field as 'version' | 'dist-tags.latest',
  };
}

function npmPublishedPackage(output: string): { packageName?: string; version?: string } {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
      return { packageName: parsed.name, version: parsed.version };
    }
    if (typeof parsed.id === 'string') {
      const spec = packageSpec(parsed.id);
      if (spec?.requestedVersion) {
        return { packageName: spec.packageName, version: spec.requestedVersion };
      }
    }
  } catch {
    // npm's human-readable success line is handled below.
  }
  const published = output.match(/(?:^|\n)\+\s+(@?[^@\s]+(?:\/[^@\s]+)?)@([^\s]+)/u);
  return { packageName: published?.[1], version: published?.[2] };
}

function githubReleaseState(output: string): {
  url?: string;
  tagName?: string;
  isDraft?: boolean;
  publishedAt?: string | null;
} {
  try {
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : undefined,
      tagName: typeof parsed.tagName === 'string' ? parsed.tagName : undefined,
      isDraft: typeof parsed.isDraft === 'boolean' ? parsed.isDraft : undefined,
      publishedAt:
        typeof parsed.publishedAt === 'string' || parsed.publishedAt === null
          ? parsed.publishedAt
          : undefined,
    };
  } catch {
    return {};
  }
}

function assertion(
  action: ToolExternalAssertionAction,
  status: ToolExternalAssertionStatus,
  provider: ToolExternalAssertion['provider'],
  target: string,
  observedAt: number,
  observedValue?: string,
  details?: ToolExternalAssertionDetails
): ToolExternalAssertion {
  return {
    version: 1,
    action,
    status,
    provider,
    target: bounded(target, 'unknown-target'),
    ...(observedValue ? { observedValue: bounded(observedValue, '') } : {}),
    observedAt,
    ...(details ? { details } : {}),
  };
}

/**
 * Derive assertions only for an allowlist of commands whose exit status and
 * output have well-defined semantics. Generic web/browser text is never
 * promoted here.
 */
export function deriveToolExternalAssertion(input: {
  name: string;
  args: Record<string, unknown>;
  result: { success: boolean; output: string };
  observedAt?: number;
}): ToolExternalAssertion | undefined {
  const observedAt = input.observedAt ?? Date.now();
  const name = input.name.toLowerCase();
  if (name === 'git_push') {
    const commit = input.result.output.match(/Latest commit:\s*([0-9a-f]{7,64})/iu)?.[1];
    const branch = input.result.output.match(/Pushed branch:\s*(\S+)/iu)?.[1];
    const remote = input.result.output.match(/Remote:\s*(\S+)/iu)?.[1];
    return assertion(
      'push',
      input.result.success && branch && remote && commit
        ? 'passed'
        : input.result.success
          ? 'inconclusive'
          : 'failed',
      'git',
      branch && remote ? `${remote}#${branch}` : 'configured-upstream',
      observedAt,
      commit,
      { kind: 'git_push', remote, branch, commit }
    );
  }
  if (name !== 'exec_command' || typeof input.args.command !== 'string') return undefined;

  const rawArgv = simpleShellWords(input.args.command);
  if (!rawArgv?.length) return undefined;
  const argv = rawArgv.map(arg => arg.toLowerCase());
  const executable = argv[0].split('/').pop();

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable ?? '') && argv[1] === 'publish') {
    if (argv.slice(2).some(arg => arg === '--dry-run' || arg.startsWith('--dry-run='))) {
      return undefined;
    }
    const published = npmPublishedPackage(input.result.output);
    const target = published.packageName ?? 'current-package';
    const version = published.version;
    return assertion(
      'publish',
      input.result.success && target !== 'current-package' && Boolean(version)
        ? 'passed'
        : input.result.success
          ? 'inconclusive'
          : 'failed',
      'npm',
      target,
      observedAt,
      version,
      published.packageName
        ? { kind: 'npm', packageName: published.packageName, version, field: 'publish' }
        : undefined
    );
  }

  if (executable === 'npm' && argv[1] === 'view') {
    const invocation = npmViewInvocation(rawArgv.slice(2));
    if (!invocation) return undefined;
    const observedValue = npmViewValue(input.result.output);
    return assertion(
      'registry',
      input.result.success && observedValue
        ? 'passed'
        : input.result.success
          ? 'inconclusive'
          : 'failed',
      'npm',
      invocation.packageName,
      observedAt,
      observedValue,
      {
        kind: 'npm',
        packageName: invocation.packageName,
        version: observedValue,
        field: invocation.field,
      }
    );
  }

  if (executable !== 'gh') return undefined;
  const repo = flagValue(rawArgv, '--repo');
  if (argv[1] === 'pr' && argv[2] === 'create') {
    if (argv.slice(3).includes('--dry-run')) return undefined;
    const state = githubState(input.result.output);
    const prNumber = state.number ? Number(state.number) : undefined;
    const repository = githubRepositoryFromUrl(state.url) ?? repo;
    const target = state.url ?? (repo ? `${repo}:pull-request` : 'current-repository:pull-request');
    return assertion(
      'pull_request',
      input.result.success && state.url && prNumber
        ? 'passed'
        : input.result.success
          ? 'inconclusive'
          : 'failed',
      'github',
      target,
      observedAt,
      'OPEN',
      { kind: 'github_pr', repository, prNumber, state: 'OPEN' }
    );
  }
  if (argv[1] === 'pr' && argv[2] === 'merge') {
    const pr = rawArgv[3]?.startsWith('-') ? undefined : rawArgv[3];
    const target = repo ? `${repo}#${pr ?? 'current'}` : `pull-request:${pr ?? 'current'}`;
    return assertion(
      'merge',
      input.result.success ? 'inconclusive' : 'failed',
      'github',
      target,
      observedAt,
      input.result.success ? 'MERGE_REQUESTED' : 'MERGE_FAILED',
      {
        kind: 'github_pr',
        repository: repo,
        prNumber: pr && /^\d+$/u.test(pr) ? Number(pr) : undefined,
      }
    );
  }
  if (argv[1] === 'pr' && argv[2] === 'view') {
    const state = githubState(input.result.output);
    const pr = rawArgv[3]?.startsWith('-') ? undefined : rawArgv[3];
    const target = bounded(
      state.url ??
        (repo
          ? `${repo}#${state.number ?? pr ?? 'current'}`
          : `pull-request:${state.number ?? pr ?? 'current'}`),
      'pull-request:current'
    );
    const action = state.state === 'MERGED' ? 'merge' : 'pull_request';
    const status = !input.result.success
      ? 'failed'
      : state.state === 'OPEN' || state.state === 'MERGED'
        ? 'passed'
        : state.state === 'CLOSED'
          ? 'failed'
          : 'inconclusive';
    const prNumber = state.number ?? pr;
    return assertion(action, status, 'github', target, observedAt, state.state, {
      kind: 'github_pr',
      repository: githubRepositoryFromUrl(state.url) ?? repo,
      prNumber: prNumber && /^\d+$/u.test(prNumber) ? Number(prNumber) : undefined,
      state:
        state.state === 'OPEN' || state.state === 'MERGED' || state.state === 'CLOSED'
          ? state.state
          : undefined,
    });
  }
  if (argv[1] === 'release' && argv[2] === 'create') {
    const tag = rawArgv[3]?.startsWith('-') ? undefined : rawArgv[3];
    const target = repo ? `${repo}:${tag ?? 'release'}` : `github-release:${tag ?? 'current'}`;
    return assertion(
      'publish',
      input.result.success ? 'inconclusive' : 'failed',
      'github',
      target,
      observedAt,
      argv.slice(3).includes('--draft') ? 'DRAFT_CREATED' : 'RELEASE_CREATED_UNVERIFIED',
      { kind: 'github_release', repository: repo, tagName: tag, isDraft: undefined }
    );
  }
  if (argv[1] === 'release' && argv[2] === 'view') {
    const tag = rawArgv[3]?.startsWith('-') ? undefined : rawArgv[3];
    const state = githubReleaseState(input.result.output);
    const repository = githubRepositoryFromUrl(state.url) ?? repo;
    const tagName = state.tagName ?? tag;
    const target = repository
      ? `${repository}:${tagName ?? 'release'}`
      : `github-release:${tagName ?? 'current'}`;
    const published = state.isDraft === false && Boolean(state.publishedAt);
    return assertion(
      'publish',
      !input.result.success
        ? 'failed'
        : published
          ? 'passed'
          : state.isDraft === true || state.publishedAt === null
            ? 'failed'
            : 'inconclusive',
      'github',
      target,
      observedAt,
      published
        ? `${tagName ?? 'release'}@${state.publishedAt}`
        : state.isDraft
          ? 'DRAFT'
          : undefined,
      {
        kind: 'github_release',
        repository,
        tagName,
        isDraft: state.isDraft,
        publishedAt: state.publishedAt ?? undefined,
      }
    );
  }
  return undefined;
}

const MAX_ASSERTION_TRANSPORT_AGE_MS = 5 * 60_000;

function sameText(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function githubInvocationRepository(
  assertion: ToolExternalAssertion,
  commandRepository: string | undefined
): boolean {
  if (!commandRepository) return true;
  const details = assertion.details;
  return (
    (details?.kind === 'github_pr' || details?.kind === 'github_release') &&
    sameText(details.repository, commandRepository)
  );
}

/**
 * Bind a typed assertion to the tool invocation that produced its envelope.
 * This is deliberately independent from display text: injected/custom tool
 * executors cannot attach an npm/GitHub assertion to an unrelated command or
 * promote a failed outer tool event to passed evidence.
 */
export function externalAssertionMatchesInvocation(input: {
  assertion: ToolExternalAssertion;
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  skipped?: boolean;
  now?: number;
}): boolean {
  const { assertion } = input;
  const now = input.now ?? Date.now();
  if (input.skipped) return false;
  if (!input.success && assertion.status !== 'failed') return false;
  if (assertion.observedAt > now || now - assertion.observedAt >= MAX_ASSERTION_TRANSPORT_AGE_MS) {
    return false;
  }

  const name = input.name.toLowerCase();
  if (name === 'git_push') {
    return (
      assertion.provider === 'git' &&
      assertion.action === 'push' &&
      assertion.details?.kind === 'git_push' &&
      (assertion.status !== 'passed' ||
        Boolean(assertion.details.remote && assertion.details.branch && assertion.details.commit))
    );
  }
  if (name !== 'exec_command' || typeof input.args.command !== 'string') return false;

  const rawArgv = simpleShellWords(input.args.command);
  if (!rawArgv?.length) return false;
  const argv = rawArgv.map(arg => arg.toLowerCase());
  const executable = argv[0].split('/').pop();

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable ?? '') && argv[1] === 'publish') {
    if (argv.slice(2).some(arg => arg === '--dry-run' || arg.startsWith('--dry-run=')))
      return false;
    const details = assertion.details;
    return (
      assertion.provider === 'npm' &&
      assertion.action === 'publish' &&
      details?.kind === 'npm' &&
      details.field === 'publish' &&
      (assertion.status !== 'passed' || Boolean(details.packageName && details.version))
    );
  }

  if (executable === 'npm' && argv[1] === 'view') {
    const invocation = npmViewInvocation(rawArgv.slice(2));
    const details = assertion.details;
    if (
      !invocation ||
      assertion.provider !== 'npm' ||
      assertion.action !== 'registry' ||
      details?.kind !== 'npm' ||
      details.field !== invocation.field ||
      !sameText(details.packageName, invocation.packageName)
    ) {
      return false;
    }
    if (
      invocation.requestedVersion &&
      normalizeComparableVersion(details.version) !==
        normalizeComparableVersion(invocation.requestedVersion)
    ) {
      return false;
    }
    return assertion.status !== 'passed' || Boolean(details.version);
  }

  if (executable !== 'gh') return false;
  const repo = flagValue(rawArgv, '--repo');
  const details = assertion.details;
  if (argv[1] === 'pr' && argv[2] === 'create') {
    return (
      !argv.slice(3).includes('--dry-run') &&
      assertion.provider === 'github' &&
      assertion.action === 'pull_request' &&
      details?.kind === 'github_pr' &&
      githubInvocationRepository(assertion, repo) &&
      (assertion.status !== 'passed' ||
        (details.state === 'OPEN' && Boolean(details.prNumber && details.repository)))
    );
  }
  if (argv[1] === 'pr' && argv[2] === 'merge') {
    // Mutation success is not a postcondition. A subsequent `gh pr view`
    // observation is required before a merge assertion may pass.
    return (
      assertion.provider === 'github' &&
      assertion.action === 'merge' &&
      assertion.status !== 'passed' &&
      details?.kind === 'github_pr' &&
      githubInvocationRepository(assertion, repo)
    );
  }
  if (argv[1] === 'pr' && argv[2] === 'view') {
    const requested = rawArgv[3]?.startsWith('-') ? undefined : rawArgv[3];
    if (
      assertion.provider !== 'github' ||
      details?.kind !== 'github_pr' ||
      !githubInvocationRepository(assertion, repo) ||
      (requested && /^\d+$/u.test(requested) && details.prNumber !== Number(requested))
    ) {
      return false;
    }
    if (assertion.status !== 'passed') return true;
    return (
      (assertion.action === 'merge' && details.state === 'MERGED') ||
      (assertion.action === 'pull_request' && details.state === 'OPEN')
    );
  }
  if (argv[1] === 'release' && argv[2] === 'create') {
    return (
      assertion.provider === 'github' &&
      assertion.action === 'publish' &&
      assertion.status !== 'passed' &&
      details?.kind === 'github_release' &&
      githubInvocationRepository(assertion, repo)
    );
  }
  if (argv[1] === 'release' && argv[2] === 'view') {
    const requestedTag = rawArgv[3]?.startsWith('-') ? undefined : rawArgv[3];
    if (
      assertion.provider !== 'github' ||
      assertion.action !== 'publish' ||
      details?.kind !== 'github_release' ||
      !githubInvocationRepository(assertion, repo) ||
      (requestedTag && !sameText(details.tagName, requestedTag))
    ) {
      return false;
    }
    return (
      assertion.status !== 'passed' || (details.isDraft === false && Boolean(details.publishedAt))
    );
  }
  return false;
}

function normalizeComparableVersion(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/^v/u, '');
}
