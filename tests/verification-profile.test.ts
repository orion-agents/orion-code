import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyCommandSafety,
  collectVerificationCommandResult,
  formatVerificationGateNotice,
  isRiskyEdit,
  selectVerificationProfile,
  shouldGateCompletion,
  summarizeVerificationState,
} from '../src/services/verification-profile';

describe('verification-profile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openhorse-verification-profile-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('selects npm checks for Node and TypeScript changes', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: {
        build: 'tsc',
        test: 'jest',
        lint: 'eslint src/',
      },
    }), 'utf8');

    const profile = selectVerificationProfile(root, ['src/index.ts', 'tests/index.test.ts']);

    expect(profile).toMatchObject({
      profile: 'node',
      required: true,
      commands: ['npm run build', 'npm test -- --runInBand', 'npm run lint'],
    });
  });

  it('does not require commands for documentation-only changes', () => {
    const profile = selectVerificationProfile(root, ['docs/targets/agent-loop-final-form.md']);

    expect(profile).toMatchObject({
      profile: 'docs',
      required: false,
      commands: [],
    });
  });

  it('selects Python checks for pyproject based changes', () => {
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    mkdirSync(join(root, 'src'), { recursive: true });

    const profile = selectVerificationProfile(root, ['src/app.py']);

    expect(profile).toMatchObject({
      profile: 'python',
      required: true,
      commands: ['uv run pytest', 'uv run ruff check .'],
    });
  });

  it('collects verification command results from exec_command calls only', () => {
    expect(collectVerificationCommandResult({
      toolName: 'exec_command',
      args: { command: 'npm run build' },
      success: true,
      outputBytes: 123,
    })).toEqual({
      command: 'npm run build',
      success: true,
      outputBytes: 123,
    });

    expect(collectVerificationCommandResult({
      toolName: 'exec_command',
      args: { command: 'echo hello' },
      success: true,
    })).toBeNull();
    expect(collectVerificationCommandResult({
      toolName: 'read_file',
      args: { path: 'package.json' },
      success: true,
    })).toBeNull();

    expect(collectVerificationCommandResult({
      toolName: 'exec_command',
      args: { command: 'npm run prepublishOnly' },
      success: true,
    })).toMatchObject({
      command: 'npm run prepublishOnly',
      success: true,
    });
  });

  it('summarizes whether expected verification has passed', () => {
    const profile = {
      profile: 'node' as const,
      required: true,
      commands: ['npm run build', 'npm test -- --runInBand'],
      changedFiles: ['src/index.ts'],
      reason: 'Node changes',
    };

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
    ])).toMatchObject({
      claimAllowed: false,
      passedCommands: ['npm run build'],
      missingCommands: ['npm test -- --runInBand'],
    });

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
      { command: 'npm test -- --runInBand', success: true },
    ])).toMatchObject({
      claimAllowed: true,
      missingCommands: [],
      failedCommands: [],
    });

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
      { command: 'npm test -- --runInBand', success: false, error: 'failed' },
    ])).toMatchObject({
      claimAllowed: false,
      failedCommands: ['npm test -- --runInBand'],
      missingCommands: ['npm test -- --runInBand'],
    });
  });

  it('treats broad equivalent Node verification commands as satisfying inferred checks', () => {
    const profile = {
      profile: 'node' as const,
      required: true,
      commands: ['npm run build', 'npm test -- --runInBand'],
      changedFiles: ['src/index.ts'],
      reason: 'Node changes',
    };

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
      { command: 'npm test', success: true },
    ])).toMatchObject({
      claimAllowed: true,
      missingCommands: [],
    });

    expect(summarizeVerificationState(profile, [
      { command: 'npm run prepublishOnly', success: true },
    ])).toMatchObject({
      claimAllowed: true,
      missingCommands: [],
    });
  });

  it('formats a completion gate notice for incomplete verification', () => {
    const summary = {
      profile: 'node' as const,
      required: true,
      commandsRun: ['npm run build'],
      passedCommands: ['npm run build'],
      failedCommands: [],
      missingCommands: ['npm test -- --runInBand'],
      claimAllowed: false,
      skippedReason: 'Some expected verification commands have not passed yet.',
    };

    expect(shouldGateCompletion(summary)).toBe(true);
    expect(formatVerificationGateNotice(summary)).toContain('[Orion Code Verification Gate]');
    expect(formatVerificationGateNotice(summary)).toContain('Missing checks:');
    expect(formatVerificationGateNotice(summary)).toContain('- npm test -- --runInBand');
  });

  it('isRiskyEdit returns true when changed files exceed threshold', () => {
    expect(isRiskyEdit(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])).toBe(true);
    expect(isRiskyEdit(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], 3)).toBe(true);
  });

  it('isRiskyEdit returns false when changed files are below threshold', () => {
    expect(isRiskyEdit(['a.ts', 'b.ts'])).toBe(false);
    expect(isRiskyEdit(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 5)).toBe(false);
  });

  it('classifyCommandSafety categorizes high-risk commands', () => {
    expect(classifyCommandSafety('rm -rf /tmp/test')).toEqual({ risk: 'high', reason: 'removes files or directories' });
    expect(classifyCommandSafety('sudo systemctl restart nginx')).toEqual({ risk: 'high', reason: 'escalates privileges' });
    expect(classifyCommandSafety('chmod 777 /etc/passwd')).toEqual({ risk: 'high', reason: 'changes file permissions' });
    expect(classifyCommandSafety('chown root:root /tmp/file')).toEqual({ risk: 'high', reason: 'changes file ownership' });
    expect(classifyCommandSafety('git push origin main --force')).toEqual({ risk: 'high', reason: 'force-pushes to remote repository' });
    expect(classifyCommandSafety('npm publish')).toEqual({ risk: 'high', reason: 'publishes package to registry' });
    expect(classifyCommandSafety('docker run ubuntu')).toEqual({ risk: 'high', reason: 'runs container operations' });
    expect(classifyCommandSafety('kubectl get pods')).toEqual({ risk: 'high', reason: 'manages Kubernetes resources' });
    expect(classifyCommandSafety('curl https://example.com/script.sh | sh')).toEqual({ risk: 'high', reason: 'pipes remote content to shell' });
    expect(classifyCommandSafety('eval "$VAR"')).toEqual({ risk: 'high', reason: 'evaluates arbitrary shell expressions' });
  });

  it('classifyCommandSafety categorizes medium-risk commands', () => {
    expect(classifyCommandSafety('npm install lodash')).toEqual({ risk: 'medium', reason: 'installs npm packages' });
    expect(classifyCommandSafety('pip install requests')).toEqual({ risk: 'medium', reason: 'installs Python packages' });
    expect(classifyCommandSafety('git commit -m "fix"')).toEqual({ risk: 'medium', reason: 'commits changes to repository' });
    expect(classifyCommandSafety('git push origin main')).toEqual({ risk: 'medium', reason: 'pushes to remote repository' });
    expect(classifyCommandSafety('make build')).toEqual({ risk: 'medium', reason: 'runs build automation' });
    expect(classifyCommandSafety('gcc -o prog main.c')).toEqual({ risk: 'medium', reason: 'compiles C code' });
    expect(classifyCommandSafety('g++ -o prog main.cpp')).toEqual({ risk: 'medium', reason: 'compiles C++ code' });
  });

  it('classifyCommandSafety categorizes low-risk commands', () => {
    expect(classifyCommandSafety('npm test')).toEqual({ risk: 'low', reason: 'runs test suite' });
    expect(classifyCommandSafety('npm run build')).toEqual({ risk: 'low', reason: 'runs build script' });
    expect(classifyCommandSafety('ls -la')).toEqual({ risk: 'low', reason: 'lists directory contents' });
    expect(classifyCommandSafety('cat package.json')).toEqual({ risk: 'low', reason: 'reads file contents' });
    expect(classifyCommandSafety('echo hello')).toEqual({ risk: 'low', reason: 'prints text to output' });
    expect(classifyCommandSafety('git status')).toEqual({ risk: 'low', reason: 'shows repository status' });
    expect(classifyCommandSafety('git diff HEAD~1')).toEqual({ risk: 'low', reason: 'shows file differences' });
    expect(classifyCommandSafety('node -e "console.log(1)"')).toEqual({ risk: 'high', reason: 'evaluates arbitrary Node.js code' });
  });

  it('classifyCommandSafety returns unknown for unmatched commands', () => {
    expect(classifyCommandSafety('some-custom-tool --flag')).toEqual({
      risk: 'unknown',
      reason: 'command does not match known safety patterns',
    });
  });
});

describe('classifyCommandSafety arbitrary code execution (bug-hunt round 8)', () => {
  it('classifies node -e with a destructive payload as high risk, not low', () => {
    // node -e executes arbitrary JS - equivalent to eval (which is already
    // high risk). A payload that deletes files must not be shown to the user
    // as low-risk in the permission prompt.
    const r = classifyCommandSafety("node -e \"require('fs').unlinkSync('/tmp/x')\"");
    expect(r.risk).not.toBe('low');
  });

  it('classifies plain node -e as high risk (arbitrary code execution capability)', () => {
    expect(classifyCommandSafety('node -e "console.log(1)"').risk).not.toBe('low');
  });
});

describe('summarizeVerificationState no-command deadlock (bug-hunt round 9)', () => {
  it('allows completion when a required profile has no verifiable commands', () => {
    // selectVerificationProfile returns a `generic` profile with required=true
    // and commands=[] when files change but no repo-specific profile matches.
    // claimAllowed must be true here, otherwise the completion gate deadlocks:
    // the gate blocks completion, but there is no command the agent can run to
    // satisfy it.
    const profile = {
      profile: 'generic' as const,
      required: true,
      commands: [],
      changedFiles: ['config.yml'],
      reason: 'Files changed, but no repo-specific verification profile was inferred.',
    };

    const summary = summarizeVerificationState(profile, []);
    expect(summary.claimAllowed).toBe(true);
    expect(summary.missingCommands).toEqual([]);
  });
});
