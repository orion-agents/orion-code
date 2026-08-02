import type { GoalEvidenceKind, GoalEvidenceRecord } from './types';

const EXTERNAL_NEGATIVE_RESULT =
  /(?:\b(?:not found|no results?|does not exist|not available|not published|not merged|not created|not opened|request failed|verification failed)\b|\bstatus\s*[:=]\s*(?:404|410|failed|error)\b|\b(?:exists|found|published|merged|created|opened|available|visible)\s*[:=]\s*false\b|未找到|无结果|不存在|未发布|未合并|未创建|未打开|不可用|不可见|查询失败|验证失败)/iu;

const EXTERNAL_POSITIVE_RESULT =
  /(?:\bstatus\s*[:=]\s*(?:200|ok|healthy)\b|\b(?:exists|found|published|merged|created|opened|available|visible)\s*[:=]\s*true\b|\b(?:is|was)\s+(?:published|merged|created|opened|available|visible|healthy)\b|已找到|已发布|已合并|已创建|已打开|状态正常|可以使用|可见)/iu;

export type ExternalCompletionAction = 'publish' | 'pull_request' | 'merge' | 'registry' | 'push';

export interface ExternalCompletionActionRule {
  action: ExternalCompletionAction;
  label: string;
  criterionPattern: RegExp;
  completedEvidencePattern: RegExp;
}

/**
 * Shared action vocabulary for evidence ingestion and completion audit.
 * Keeping one rule set prevents a tool result from being recognized by the
 * audit while being downgraded to inconclusive before it reaches the ledger.
 */
export const EXTERNAL_COMPLETION_ACTION_RULES: readonly ExternalCompletionActionRule[] = [
  {
    action: 'publish',
    label: 'publish/release',
    criterionPattern:
      /\bpublish(?:es|ed|ing)?\b|\brelease(?:s|d|ing)?\b(?=[^.;\n]{0,40}\b(?:package|version|artifact|build|v?\d+\.\d+)\b)|\b(?:create|publish)(?:s|d|ing)?[^.;\n]{0,30}\bgithub\s+release\b|发布(?!说明|备注|文档|计划)|上线/iu,
    completedEvidencePattern:
      /\b(?:published|publication|release\s+(?:is\s+)?(?:live|available)|(?:github\s+)?release\s+(?:is\s+)?(?:created|published|live|available)|npm\s+publish(?:ed)?(?:\s+(?:succeeded|successful|complete|completed))?)\b|\breleased\b(?=[^.;\n]{0,40}\b(?:package|version|artifact|build|v?\d+\.\d+)\b)|已发布|发布成功|成功发布|已上线|上线成功|GitHub\s*Release\s*已创建/iu,
  },
  {
    action: 'pull_request',
    label: 'pull request created/opened',
    criterionPattern:
      /\b(?:(?:open|create|submit|raise)(?:s|d|ing)?[^.;\n]{0,40}(?:pull[\s_-]?request|pr)|(?:pull[\s_-]?request|pr)\s+(?:is\s+)?(?:open|opened|create|created|submit|submitted|ready))\b|(?:创建|提交|发起|打开)[^。；;\n]{0,30}(?:PR|拉取请求)|(?:PR|拉取请求)\s*(?:已创建|已提交|已打开)/iu,
    completedEvidencePattern:
      /\b(?:pull[\s_-]?request|pr)\s+(?:is\s+)?(?:open|opened|created|submitted|ready)\b|\b(?:opened|created|submitted|raised)\s+(?:an?\s+)?(?:pull[\s_-]?request|pr)\b|(?:PR|拉取请求)\s*(?:已创建|已提交|已打开)|(?:创建|提交|发起|打开)[^。；;\n]{0,30}(?:PR|拉取请求)\s*(?:成功|完成)/iu,
  },
  {
    action: 'merge',
    label: 'merge completed',
    criterionPattern: /\bmerge(?:s|d|ing)?\b|合并/iu,
    completedEvidencePattern:
      /\b(?:pull[\s_-]?request|pr)\s+(?:is\s+)?merged\b|\bmerged\b|\bmerge\s+(?:succeeded|successful|complete|completed)\b|已合并|合并成功|合并完成/iu,
  },
  {
    action: 'registry',
    label: 'registry entry visible',
    criterionPattern:
      /\b(?:package\s+)?registry\b|\bnpm\s+(?:registry|view)\b|注册表|(?:npm|软件包)仓库/iu,
    completedEvidencePattern:
      /\bregistry\b[^\n]{0,80}\b(?:entry|available|visible|contains|reports|published|version)\b|\b(?:entry|available|visible|published)\b[^\n]{0,80}\bregistry\b|\bnpm\s+view\b|注册表[^\n]{0,40}(?:条目|可用|可见|包含|版本|已发布)|(?:npm|软件包)仓库[^\n]{0,40}(?:可用|可见|版本|已发布)/iu,
  },
  {
    action: 'push',
    label: 'branch pushed',
    criterionPattern:
      /\bpush(?:es|ed|ing)?\b[^.;\n]{0,50}\b(?:branch|commit|github|gitlab|remote|upstream)\b|(?:推送|上传)[^。；;\n]{0,30}(?:分支|提交|GitHub|GitLab|远端)/iu,
    completedEvidencePattern:
      /\b(?:branch|commit)\s+(?:is\s+)?pushed\b|\bpush\s+(?:succeeded|successful|complete|completed)\b|已推送|推送成功|推送完成/iu,
  },
];

/**
 * Transport success is not evidence that an external state assertion passed.
 * External adapters must expose an explicit positive state in their summary;
 * explicit negative states fail, and ambiguous successful requests stay
 * inconclusive so completion remains fail-closed.
 */
export function classifyGoalEvidenceResult(input: {
  kind: GoalEvidenceKind;
  success: boolean;
  skipped?: boolean;
  summary?: string;
  error?: string;
}): GoalEvidenceRecord['result'] {
  if (input.skipped) return 'inconclusive';
  if (!input.success) return 'failed';
  if (input.kind !== 'external') return 'passed';

  const resultText = `${input.summary ?? ''}\n${input.error ?? ''}`.trim();
  if (input.error?.trim() || EXTERNAL_NEGATIVE_RESULT.test(resultText)) return 'failed';
  if (
    EXTERNAL_POSITIVE_RESULT.test(resultText) ||
    EXTERNAL_COMPLETION_ACTION_RULES.some(rule => rule.completedEvidencePattern.test(resultText))
  )
    return 'passed';
  return 'inconclusive';
}

function shellWords(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (current) words.push(current);
    current = '';
  };

  for (const char of value) {
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
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return words;
}

/** Split shell control-flow boundaries while leaving quoted text untouched. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '\n' || char === '|' || (char === '&' && next === '&')) {
      flush();
      if ((char === '|' && next === '|') || (char === '&' && next === '&')) index += 1;
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

/**
 * A successful shell process is not proof that a verification command passed
 * when its exit status can be masked by a pipeline, fallback, background job,
 * or a later unconditional command. Keep evidence conservative and accept
 * only simple commands or `&&` chains, whose final success implies every
 * preceding validation command succeeded.
 */
function hasStatusMaskingControlFlow(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ';' || char === '\n' || char === '|') return true;
    if (char === '&' && next !== '&') return true;
    if (char === '&' && next === '&') index += 1;
  }
  return false;
}

function stripCommandPrefix(words: string[]): string[] {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index])) index += 1;
  if (words[index]?.toLowerCase() === 'env') {
    index += 1;
    while (
      index < words.length &&
      (/^-/u.test(words[index]) || /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index]))
    ) {
      index += 1;
    }
  }
  if (words[index]?.toLowerCase() === 'command') index += 1;
  return words.slice(index).map(word => word.toLowerCase());
}

function classifyValidationInvocation(words: string[]): GoalEvidenceKind | null {
  const argv = stripCommandPrefix(words);
  const executable = argv[0]?.split('/').pop();
  if (!executable) return null;

  const runtimeInvocation =
    (executable === 'orion' && ['doctor', '--version', '--help'].includes(argv[1])) ||
    (executable === 'node' &&
      /(?:^|\/)dist\/cli\.js$/u.test(argv[1] ?? '') &&
      ['doctor', '--version', '--help'].includes(argv[2]));

  const probeOnlyFlags = new Set([
    '--help',
    '-h',
    '--version',
    '-v',
    '--if-present',
    '--listtests',
    '--list',
    '--showconfig',
    '--collect-only',
    '--print-config',
  ]);
  if (!runtimeInvocation && argv.slice(1).some(arg => probeOnlyFlags.has(arg.toLowerCase())))
    return null;

  const packageScript = (script: string): boolean => {
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) return false;
    const args = argv.slice(1);
    if (args[0] === 'run') return args[1] === script || args[1]?.startsWith(`${script}:`) === true;
    return args[0] === script || args[0]?.startsWith(`${script}:`) === true;
  };
  const npxTool = (names: string[]): boolean =>
    executable === 'npx' && argv.length > 1 && names.includes(argv[1].split('/').pop() ?? '');

  const npmExternalInvocation =
    ['npm', 'pnpm', 'yarn', 'bun'].includes(executable) &&
    ((argv[1] === 'publish' &&
      !argv.slice(2).some(arg => arg === '--dry-run' || arg.startsWith('--dry-run='))) ||
      (executable === 'npm' && argv[1] === 'view'));
  const githubExternalInvocation =
    executable === 'gh' &&
    ((argv[1] === 'pr' && ['create', 'merge', 'view'].includes(argv[2])) ||
      (argv[1] === 'release' && ['create', 'view'].includes(argv[2])));
  if (npmExternalInvocation || githubExternalInvocation) return 'external';

  if (
    packageScript('test') ||
    ['jest', 'vitest', 'pytest'].includes(executable) ||
    npxTool(['jest', 'vitest', 'pytest']) ||
    (executable === 'go' && argv[1] === 'test') ||
    (executable === 'cargo' && argv[1] === 'test')
  ) {
    return 'test';
  }
  if (
    packageScript('build') ||
    executable === 'tsc' ||
    npxTool(['tsc']) ||
    (executable === 'go' && argv[1] === 'build') ||
    (executable === 'cargo' && argv[1] === 'build')
  ) {
    return 'build';
  }
  if (
    packageScript('lint') ||
    ['eslint', 'ruff', 'golangci-lint'].includes(executable) ||
    npxTool(['eslint', 'ruff'])
  ) {
    return 'lint';
  }
  if (runtimeInvocation) return 'runtime';
  return null;
}

/**
 * Classify runtime evidence from the tool that actually executed it.
 *
 * Verification evidence is intentionally conservative: a validation command
 * must be the executable at a real shell command boundary. Merely mentioning
 * `npm test` in `echo`, `printf`, a quoted string, or another tool's arguments
 * never produces test/build/lint evidence.
 */
export function classifyGoalEvidenceKind(
  name: string,
  args: Record<string, unknown>
): GoalEvidenceKind | null {
  const normalizedName = name.toLowerCase();
  if (normalizedName === 'exec_command') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (hasStatusMaskingControlFlow(command)) return null;
    for (const segment of shellSegments(command)) {
      const kind = classifyValidationInvocation(shellWords(segment));
      if (kind) return kind;
    }
    return null;
  }
  if (/apply_patch|write_file|edit_file|create_file|delete_file/u.test(normalizedName))
    return 'file';
  if (normalizedName === 'git_push') return 'external';
  if (/web|http|browser|github/u.test(normalizedName)) return 'external';
  return null;
}
