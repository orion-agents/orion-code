import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface VerificationProfile {
  profile: 'node' | 'python' | 'rust' | 'go' | 'docs' | 'generic';
  required: boolean;
  commands: string[];
  changedFiles: string[];
  reason: string;
}

export interface VerificationCommandResult {
  command: string;
  success: boolean;
  outputBytes?: number;
  error?: string;
}

export interface VerificationSummary {
  profile: VerificationProfile['profile'];
  required: boolean;
  commandsRun: string[];
  passedCommands: string[];
  failedCommands: string[];
  missingCommands: string[];
  claimAllowed: boolean;
  skippedReason?: string;
}

export interface CommandSafetyClassification {
  risk: 'high' | 'medium' | 'low' | 'unknown';
  reason: string;
}

/**
 * Classify the safety risk of a shell command.
 */
export function classifyCommandSafety(command: string): CommandSafetyClassification {
  const normalized = command.trim();

  // High risk patterns
  const highRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\b/, reason: 'removes files or directories' },
    { pattern: /\bsudo\b/, reason: 'escalates privileges' },
    { pattern: /\bchmod\b/, reason: 'changes file permissions' },
    { pattern: /\bchown\b/, reason: 'changes file ownership' },
    { pattern: /\bgit\s+push\s+.*--force\b/, reason: 'force-pushes to remote repository' },
    { pattern: /\bnpm\s+publish\b/, reason: 'publishes package to registry' },
    { pattern: /\bdocker\b/, reason: 'runs container operations' },
    { pattern: /\bkubectl\b/, reason: 'manages Kubernetes resources' },
    { pattern: /\bcurl\s+.*\|\s*sh\b/, reason: 'pipes remote content to shell' },
    { pattern: /\beval\b/, reason: 'evaluates arbitrary shell expressions' },
    { pattern: /\bnode\s+-e\b/, reason: 'evaluates arbitrary Node.js code' },
  ];

  for (const { pattern, reason } of highRiskPatterns) {
    if (pattern.test(normalized)) {
      return { risk: 'high', reason };
    }
  }

  // Medium risk patterns
  const mediumRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bnpm\s+(install|i)\b/, reason: 'installs npm packages' },
    { pattern: /\bpip\s+install\b/, reason: 'installs Python packages' },
    { pattern: /\bgit\s+commit\b/, reason: 'commits changes to repository' },
    { pattern: /\bgit\s+push\b/, reason: 'pushes to remote repository' },
    { pattern: /\bmake\b/, reason: 'runs build automation' },
    { pattern: /(^|\s)gcc\s/, reason: 'compiles C code' },
    { pattern: /(^|\s)g\+\+\s/, reason: 'compiles C++ code' },
  ];

  for (const { pattern, reason } of mediumRiskPatterns) {
    if (pattern.test(normalized)) {
      return { risk: 'medium', reason };
    }
  }

  // Low risk patterns
  const lowRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bnpm\s+run\s+build(\b|:)/, reason: 'runs build script' },
    { pattern: /\bnpm\s+(run\s+)?test(\b|:)/, reason: 'runs test suite' },
    { pattern: /\bls\b/, reason: 'lists directory contents' },
    { pattern: /\bcat\b/, reason: 'reads file contents' },
    { pattern: /\becho\b/, reason: 'prints text to output' },
    { pattern: /\bgit\s+status\b/, reason: 'shows repository status' },
    { pattern: /\bgit\s+diff\b/, reason: 'shows file differences' },
  ];

  for (const { pattern, reason } of lowRiskPatterns) {
    if (pattern.test(normalized)) {
      return { risk: 'low', reason };
    }
  }

  return { risk: 'unknown', reason: 'command does not match known safety patterns' };
}

/**
 * Returns true when a turn modifies enough files to be flagged as a risky edit.
 * Wired into appendVerificationProfileTrace in chat-controller.ts, which records
 * `verificationRisky` on the verification_profile trace event so auditors can
 * spot large-scale refactors that deserve stricter review.
 */
export function isRiskyEdit(changedFiles: string[], threshold = 5): boolean {
  return changedFiles.length >= threshold;
}

export function shouldGateCompletion(summary: VerificationSummary): boolean {
  return summary.required && !summary.claimAllowed;
}

export function formatVerificationGateNotice(summary: VerificationSummary): string {
  const lines = [
    '[Orion Code Verification Gate]',
    'This turn changed files, but required verification is incomplete. Do not claim verified completion yet.',
  ];

  if (summary.passedCommands.length > 0) {
    lines.push('Passed checks:');
    lines.push(...summary.passedCommands.map(command => `- ${command}`));
  }
  if (summary.failedCommands.length > 0) {
    lines.push('Failed checks:');
    lines.push(...summary.failedCommands.map(command => `- ${command}`));
  }
  if (summary.missingCommands.length > 0) {
    lines.push('Missing checks:');
    lines.push(...summary.missingCommands.map(command => `- ${command}`));
  }
  if (summary.skippedReason) {
    lines.push(`Reason: ${summary.skippedReason}`);
  }
  lines.push('Next action: run the missing checks, fix failures, or explicitly explain why verification is skipped.');
  return lines.join('\n');
}

function hasAnyExtension(files: string[], extensions: string[]): boolean {
  return files.some(file => extensions.some(extension => file.endsWith(extension)));
}

function hasAnyPath(files: string[], paths: string[]): boolean {
  return files.some(file => paths.some(target => file === target || file.startsWith(`${target}/`)));
}

function readPackageScripts(cwd: string): Record<string, string> {
  const packagePath = join(cwd, 'package.json');
  if (!existsSync(packagePath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object') return {};
    return parsed.scripts as Record<string, string>;
  } catch {
    return {};
  }
}

function hasUsefulScript(scripts: Record<string, string>, name: string): boolean {
  const script = scripts[name];
  return typeof script === 'string'
    && script.trim().length > 0
    && !/no test specified/i.test(script);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function isVerificationCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|check)\b/i.test(normalized)
    || /(^|\s)(npm|pnpm|yarn|bun)\s+run\s+prepublishOnly\b/i.test(normalized)
    || /(^|\s)(jest|vitest|mocha|ava|tsc|eslint)\b/i.test(normalized)
    || /(^|\s)(pytest|ruff|mypy|pyright|ty)\b/i.test(normalized)
    || /^uv\s+run\s+(pytest|ruff|mypy|pyright|ty)\b/i.test(normalized)
    || /^cargo\s+(test|clippy|check)\b/i.test(normalized)
    || /^go\s+test\b/i.test(normalized);
}

export function collectVerificationCommandResult(params: {
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  outputBytes?: number;
  error?: string;
}): VerificationCommandResult | null {
  if (params.toolName !== 'exec_command') return null;
  const command = typeof params.args.command === 'string' ? normalizeCommand(params.args.command) : '';
  if (!command || !isVerificationCommand(command)) return null;
  return {
    command,
    success: params.success,
    outputBytes: params.outputBytes,
    error: params.error,
  };
}

function isNpmBuildCommand(command: string): boolean {
  return /^(npm|pnpm|yarn|bun)\s+run\s+build\b/i.test(command);
}

function isNpmTestCommand(command: string): boolean {
  return /^(npm|pnpm|yarn|bun)\s+(run\s+)?test(\s+--\s+--runInBand)?$/i.test(command);
}

function isPrepublishCommand(command: string): boolean {
  return /^(npm|pnpm|yarn|bun)\s+run\s+prepublishOnly\b/i.test(command);
}

function passedCommandCoversExpected(passed: string, expected: string): boolean {
  if (passed === expected) return true;

  if (isPrepublishCommand(passed) && (isNpmBuildCommand(expected) || isNpmTestCommand(expected))) {
    return true;
  }

  if (isNpmTestCommand(expected) && isNpmTestCommand(passed)) {
    return true;
  }

  return false;
}

export function summarizeVerificationState(
  profile: VerificationProfile,
  results: VerificationCommandResult[],
): VerificationSummary {
  const commandsRun = [...new Set(results.map(result => normalizeCommand(result.command)))];
  const passedCommands = [...new Set(results.filter(result => result.success).map(result => normalizeCommand(result.command)))];
  const failedCommands = [...new Set(results.filter(result => !result.success).map(result => normalizeCommand(result.command)))];
  const expectedCommands = profile.commands.map(normalizeCommand);
  const missingCommands = expectedCommands.filter(command =>
    !passedCommands.some(passed => passedCommandCoversExpected(passed, command))
  );

  let skippedReason: string | undefined;
  if (!profile.required) {
    skippedReason = 'Verification is not required for this profile.';
  } else if (expectedCommands.length === 0) {
    skippedReason = 'No verification commands were inferred for this profile.';
  } else if (missingCommands.length > 0 && commandsRun.length === 0) {
    skippedReason = 'No expected verification command has been run yet.';
  } else if (missingCommands.length > 0) {
    skippedReason = 'Some expected verification commands have not passed yet.';
  }

  return {
    profile: profile.profile,
    required: profile.required,
    commandsRun,
    passedCommands,
    failedCommands,
    missingCommands,
    claimAllowed: !profile.required
      || expectedCommands.length === 0
      || (missingCommands.length === 0 && failedCommands.length === 0),
    skippedReason,
  };
}

function nodeCommands(cwd: string): string[] {
  const scripts = readPackageScripts(cwd);
  const commands: string[] = [];
  if (hasUsefulScript(scripts, 'build')) commands.push('npm run build');
  if (hasUsefulScript(scripts, 'test')) commands.push('npm test -- --runInBand');
  if (hasUsefulScript(scripts, 'lint')) commands.push('npm run lint');
  return commands;
}

function pythonCommands(cwd: string): string[] {
  if (existsSync(join(cwd, 'pyproject.toml'))) {
    return [
      'uv run pytest',
      'uv run ruff check .',
    ];
  }
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'tests'))) {
    return ['pytest'];
  }
  return [];
}

export function selectVerificationProfile(cwd: string, changedFiles: string[]): VerificationProfile {
  const files = [...new Set(changedFiles)].sort();
  if (files.length === 0) {
    return {
      profile: 'generic',
      required: false,
      commands: [],
      changedFiles: files,
      reason: 'No workspace files changed during this turn.',
    };
  }

  const docsOnly = files.every(file => /\.(md|mdx|txt|rst)$/i.test(file) || file.startsWith('docs/'));
  if (docsOnly) {
    return {
      profile: 'docs',
      required: false,
      commands: [],
      changedFiles: files,
      reason: 'Documentation-only changes usually require review, not automated test commands.',
    };
  }

  const nodeLike = existsSync(join(cwd, 'package.json'))
    && (hasAnyExtension(files, ['.ts', '.tsx', '.js', '.jsx', '.json'])
      || hasAnyPath(files, ['src', 'tests', 'bin']));
  if (nodeLike) {
    const commands = nodeCommands(cwd);
    return {
      profile: 'node',
      required: true,
      commands,
      changedFiles: files,
      reason: commands.length > 0
        ? 'Node/TypeScript project changes detected from package.json and changed file paths.'
        : 'Node/TypeScript project changes detected, but no build/test/lint scripts are configured.',
    };
  }

  const pythonLike = (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'pytest.ini')))
    && hasAnyExtension(files, ['.py', '.toml']);
  if (pythonLike) {
    const commands = pythonCommands(cwd);
    return {
      profile: 'python',
      required: true,
      commands,
      changedFiles: files,
      reason: commands.length > 0
        ? 'Python project changes detected from project files and changed file paths.'
        : 'Python project changes detected, but no known test command was inferred.',
    };
  }

  if (existsSync(join(cwd, 'Cargo.toml')) && hasAnyExtension(files, ['.rs', '.toml'])) {
    return {
      profile: 'rust',
      required: true,
      commands: ['cargo test'],
      changedFiles: files,
      reason: 'Rust project changes detected from Cargo.toml and changed file paths.',
    };
  }

  if (existsSync(join(cwd, 'go.mod')) && hasAnyExtension(files, ['.go', '.mod', '.sum'])) {
    return {
      profile: 'go',
      required: true,
      commands: ['go test ./...'],
      changedFiles: files,
      reason: 'Go project changes detected from go.mod and changed file paths.',
    };
  }

  return {
    profile: 'generic',
    required: true,
    commands: [],
    changedFiles: files,
    reason: 'Files changed, but no repo-specific verification profile was inferred.',
  };
}
