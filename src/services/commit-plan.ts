import { collectWorkspaceDiff, type WorkspaceDiffFile, type WorkspaceDiffReport } from './workspace-diff';

export interface CommitPlan {
  diff: WorkspaceDiffReport;
  suggestedMessage: string;
  title: string;
  body: string[];
  readyToCommit: boolean;
  warnings: string[];
  nextSteps: string[];
}

export interface CommitPlanOptions {
  cwd?: string;
  maxFiles?: number;
}

function allFiles(diff: WorkspaceDiffReport): WorkspaceDiffFile[] {
  return [...diff.staged, ...diff.unstaged, ...diff.untracked];
}

function topLevel(path: string): string {
  const normalized = path.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  const first = normalized.split('/')[0] || '';
  if (first === 'src') {
    const second = normalized.split('/')[1] || '';
    return second || 'src';
  }
  return first || 'workspace';
}

function inferScope(files: WorkspaceDiffFile[]): string | undefined {
  const scopes = new Set(files.map(file => topLevel(file.path)));
  if (scopes.size === 1) return [...scopes][0];
  if ([...scopes].every(scope => scope === 'docs' || scope === 'README.md')) return 'docs';
  if ([...scopes].every(scope => scope === 'tests' || scope === '__tests__')) return 'tests';
  return undefined;
}

function inferType(files: WorkspaceDiffFile[]): string {
  if (files.length === 0) return 'chore';
  const paths = files.map(file => file.path.toLowerCase());
  if (paths.every(path => path.startsWith('docs/') || path.startsWith('readme') || path.endsWith('.md'))) return 'docs';
  if (paths.every(path => path.includes('test') || path.startsWith('tests/'))) return 'test';
  if (paths.every(path => path.includes('package') || path.includes('tsconfig') || path.includes('config'))) return 'chore';
  return 'feat';
}

function inferSubject(files: WorkspaceDiffFile[]): string {
  if (files.length === 0) return 'no workspace changes';
  const paths = files.map(file => file.path.toLowerCase());
  if (paths.every(path => path.startsWith('docs/') || path.startsWith('readme') || path.endsWith('.md'))) {
    return 'update documentation';
  }
  if (paths.every(path => path.includes('test') || path.startsWith('tests/'))) {
    return 'update tests';
  }

  const scope = inferScope(files);
  if (scope && scope !== 'workspace') {
    return `update ${scope.replace(/[-_]/g, ' ')}`;
  }
  return 'update workspace changes';
}

function formatMessage(type: string, scope: string | undefined, subject: string): string {
  const prefix = scope ? `${type}(${scope})` : type;
  return `${prefix}: ${subject}`;
}

function listFiles(label: string, files: WorkspaceDiffFile[], maxFiles: number): string[] {
  if (files.length === 0) return [];
  const lines = [`${label}: ${files.length}`];
  for (const file of files.slice(0, maxFiles)) {
    lines.push(`- ${file.status} ${file.path}`);
  }
  if (files.length > maxFiles) {
    lines.push(`- ... ${files.length - maxFiles} more`);
  }
  return lines;
}

export function createCommitPlan(options: CommitPlanOptions = {}): CommitPlan {
  const maxFiles = options.maxFiles ?? 20;
  const diff = collectWorkspaceDiff({ cwd: options.cwd, maxFiles });
  const files = allFiles(diff);
  const type = inferType(files);
  const scope = inferScope(files);
  const title = inferSubject(files);
  const suggestedMessage = formatMessage(type, scope, title);
  const warnings: string[] = [];
  const body: string[] = [];
  const nextSteps: string[] = [];

  if (!diff.isGitRepo) {
    warnings.push('Not a git repository.');
    nextSteps.push('Run this command inside a git worktree.');
    return {
      diff,
      suggestedMessage,
      title,
      body,
      readyToCommit: false,
      warnings,
      nextSteps,
    };
  }

  if (diff.clean) {
    warnings.push('Working tree is clean.');
    nextSteps.push('Make changes before creating a commit.');
  }

  if (diff.unstaged.length > 0) {
    warnings.push(`${diff.unstaged.length} unstaged file(s) are not part of the current index.`);
  }
  if (diff.untracked.length > 0) {
    warnings.push(`${diff.untracked.length} untracked file(s) need review before committing.`);
  }
  if (diff.staged.length === 0 && !diff.clean) {
    warnings.push('No staged files. A plain git commit would not include the current changes.');
  }

  body.push(...listFiles('Staged files', diff.staged, maxFiles));
  body.push(...listFiles('Unstaged files', diff.unstaged, maxFiles));
  body.push(...listFiles('Untracked files', diff.untracked, maxFiles));

  if (diff.staged.length > 0 && diff.unstaged.length === 0 && diff.untracked.length === 0) {
    nextSteps.push(`git commit -m "${suggestedMessage.replace(/"/g, '\\"')}"`);
  } else if (!diff.clean) {
    nextSteps.push('Review the file list above.');
    nextSteps.push('Stage the intended files, then run this command again.');
  }

  return {
    diff,
    suggestedMessage,
    title,
    body,
    readyToCommit: diff.staged.length > 0 && diff.unstaged.length === 0 && diff.untracked.length === 0,
    warnings,
    nextSteps,
  };
}

export function formatCommitPlan(plan: CommitPlan): string {
  const lines: string[] = [
    'Commit Plan',
    '─'.repeat(40),
    `Status    ${plan.diff.isGitRepo ? (plan.diff.clean ? 'clean' : 'dirty') : 'not a git repository'}`,
  ];

  if (plan.diff.root) lines.push(`Root      ${plan.diff.root}`);
  if (plan.diff.branch) lines.push(`Branch    ${plan.diff.branch}`);
  if (plan.diff.head) lines.push(`HEAD      ${plan.diff.head}`);
  lines.push(`Message   ${plan.suggestedMessage}`);
  lines.push(`Ready     ${plan.readyToCommit ? 'yes' : 'no'}`);

  if (plan.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of plan.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (plan.body.length > 0) {
    lines.push('', 'Changes:');
    lines.push(...plan.body);
  }

  if (plan.nextSteps.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of plan.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join('\n');
}
