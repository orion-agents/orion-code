import {
  classifyGoalEvidenceKind,
  classifyGoalEvidenceResult,
} from '../src/runtime/goals/evidence';
import {
  deriveToolExternalAssertion,
  externalAssertionMatchesInvocation,
} from '../src/framework/external-assertion';

describe('Goal evidence command classification', () => {
  it.each([
    ['npm test', 'test'],
    ['cd packages/core && npm run test:unit -- --runInBand', 'test'],
    ['npx vitest run', 'test'],
    ['go test ./...', 'test'],
    ['npm run build', 'build'],
    ['npx tsc --noEmit', 'build'],
    ['pnpm lint', 'lint'],
    ['npx eslint src', 'lint'],
    ['NODE_ENV=test env CI=1 npm test', 'test'],
    ['orion doctor', 'runtime'],
    ['node dist/cli.js --version', 'runtime'],
    ['npm publish --access public', 'external'],
    ['npm view @orion-agents/orion-code version', 'external'],
    ['gh pr create --fill', 'external'],
    ['gh pr merge 42 --merge', 'external'],
    ['gh release create v0.1.2', 'external'],
    ['gh release view v0.1.2', 'external'],
  ])('classifies a real validation invocation: %s', (command, expected) => {
    expect(classifyGoalEvidenceKind('exec_command', { command })).toBe(expected);
  });

  it.each([
    'echo npm test',
    "printf 'npm run build'",
    'node -e "console.log(\'pytest\')"',
    "echo 'safe; npm test'",
    'true # npm test',
    'grep "cargo test" README.md',
    'npm test || true',
    'npm test; true',
    'npm test | tee test.log',
    'npm test & wait',
    'npm test\nprintf done',
    'npm test --if-present',
    'npx tsc --help',
    'jest --listTests',
    'pytest --collect-only',
    'eslint --print-config src/index.ts',
    "echo 'npm publish succeeded'",
    "printf 'Pull request created'",
    'npm publish --dry-run',
    'npm publish || true',
    'npm view @orion-agents/orion-code version | cat',
    'gh --version',
  ])('rejects mentioned-only or status-masked validation commands: %s', command => {
    expect(classifyGoalEvidenceKind('exec_command', { command })).toBeNull();
  });

  it('does not treat another tool argument as an executed validation command', () => {
    expect(classifyGoalEvidenceKind('web_search', { query: 'how to run npm test' })).toBe(
      'external'
    );
  });

  it('classifies the dedicated git_push tool as external evidence', () => {
    expect(classifyGoalEvidenceKind('git_push', { message: 'release' })).toBe('external');
  });

  it.each([
    {
      name: 'npm publish',
      command: 'npm publish --access public',
      output: '+ @orion-agents/orion-code@0.1.2',
      expected: {
        action: 'publish',
        status: 'passed',
        provider: 'npm',
        target: '@orion-agents/orion-code',
        observedValue: '0.1.2',
      },
    },
    {
      name: 'npm view',
      command: 'npm view @orion-agents/orion-code version --json',
      output: '"0.1.1"',
      expected: {
        action: 'registry',
        status: 'passed',
        provider: 'npm',
        target: '@orion-agents/orion-code',
        observedValue: '0.1.1',
      },
    },
    {
      name: 'gh pr create',
      command: 'gh pr create --fill --repo linux2010/orion-code',
      output: 'https://github.com/linux2010/orion-code/pull/42',
      expected: { action: 'pull_request', status: 'passed', observedValue: 'OPEN' },
    },
    {
      name: 'gh pr merge',
      command: 'gh pr merge 42 --merge --repo linux2010/orion-code',
      output: 'Merged pull request #42',
      expected: { action: 'merge', status: 'inconclusive', observedValue: 'MERGE_REQUESTED' },
    },
    {
      name: 'gh pr view OPEN',
      command: 'gh pr view 42 --json state,url',
      output: '{"state":"OPEN","url":"https://github.com/linux2010/orion-code/pull/42"}',
      expected: { action: 'pull_request', status: 'passed', observedValue: 'OPEN' },
    },
    {
      name: 'gh pr view MERGED',
      command: 'gh pr view 42 --json state,url',
      output: '{"state":"MERGED","url":"https://github.com/linux2010/orion-code/pull/42"}',
      expected: { action: 'merge', status: 'passed', observedValue: 'MERGED' },
    },
  ])('derives a typed external assertion for $name', ({ command, output, expected }) => {
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command },
        result: { success: true, output },
        observedAt: 123,
      })
    ).toEqual(expect.objectContaining({ version: 1, observedAt: 123, ...expected }));
  });

  it('keeps mismatched/read failures typed without promoting display text', () => {
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'gh pr view 42 --json state' },
        result: { success: true, output: '{"state":"CLOSED"}' },
        observedAt: 123,
      })
    ).toEqual(expect.objectContaining({ action: 'pull_request', status: 'failed' }));
    expect(
      deriveToolExternalAssertion({
        name: 'web_search',
        args: { query: 'Pull request created' },
        result: { success: true, output: 'Pull request created' },
        observedAt: 123,
      })
    ).toBeUndefined();
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'npm publish || true' },
        result: { success: true, output: '+ @orion-agents/orion-code@0.1.2' },
        observedAt: 123,
      })
    ).toBeUndefined();
  });

  it('requires postcondition observations for PRs and GitHub releases', () => {
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'gh pr create --dry-run --repo linux2010/orion-code' },
        result: { success: true, output: 'https://github.com/linux2010/orion-code/pull/42' },
        observedAt: 123,
      })
    ).toBeUndefined();
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'gh pr merge 42 --auto --repo linux2010/orion-code' },
        result: { success: true, output: 'auto-merge enabled' },
        observedAt: 123,
      })
    ).toEqual(expect.objectContaining({ action: 'merge', status: 'inconclusive' }));
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'gh release create v0.1.2 --draft --repo linux2010/orion-code' },
        result: { success: true, output: 'draft created' },
        observedAt: 123,
      })
    ).toEqual(expect.objectContaining({ action: 'publish', status: 'inconclusive' }));
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: {
          command:
            'gh release view v0.1.2 --repo linux2010/orion-code --json isDraft,publishedAt,tagName,url',
        },
        result: {
          success: true,
          output:
            '{"isDraft":true,"publishedAt":null,"tagName":"v0.1.2","url":"https://github.com/linux2010/orion-code/releases/tag/v0.1.2"}',
        },
        observedAt: 123,
      })
    ).toEqual(expect.objectContaining({ action: 'publish', status: 'failed' }));
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: {
          command:
            'gh release view v0.1.2 --repo linux2010/orion-code --json isDraft,publishedAt,tagName,url',
        },
        result: {
          success: true,
          output:
            '{"isDraft":false,"publishedAt":"2026-08-02T00:00:00Z","tagName":"v0.1.2","url":"https://github.com/linux2010/orion-code/releases/tag/v0.1.2"}',
        },
        observedAt: 123,
      })
    ).toEqual(expect.objectContaining({ action: 'publish', status: 'passed' }));
  });

  it('parses only exact npm version observations and JSON publish receipts', () => {
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'npm view @orion-agents/orion-code description' },
        result: { success: true, output: 'Orion 0.1.2 package' },
        observedAt: 123,
      })
    ).toBeUndefined();
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'npm view --json @orion-agents/orion-code version' },
        result: { success: true, output: '"0.1.2"' },
        observedAt: 123,
      })
    ).toEqual(
      expect.objectContaining({
        action: 'registry',
        target: '@orion-agents/orion-code',
        observedValue: '0.1.2',
      })
    );
    expect(
      deriveToolExternalAssertion({
        name: 'exec_command',
        args: { command: 'npm publish --json' },
        result: {
          success: true,
          output:
            '{"name":"@orion-agents/orion-code","version":"0.1.2","id":"@orion-agents/orion-code@0.1.2"}',
        },
        observedAt: 123,
      })
    ).toEqual(
      expect.objectContaining({
        action: 'publish',
        status: 'passed',
        target: '@orion-agents/orion-code',
        observedValue: '0.1.2',
      })
    );
  });

  it('binds assertions to the successful tool invocation and exact git push receipt', () => {
    const now = 1_000;
    const assertion = deriveToolExternalAssertion({
      name: 'git_push',
      args: { message: 'release' },
      result: {
        success: true,
        output: 'Pushed branch: v0.1.2\nRemote: origin\nLatest commit: abc1234',
      },
      observedAt: now,
    })!;
    expect(assertion).toEqual(expect.objectContaining({ action: 'push', status: 'passed' }));
    expect(
      externalAssertionMatchesInvocation({
        assertion,
        name: 'git_push',
        args: { message: 'release' },
        success: true,
        now,
      })
    ).toBe(true);
    expect(
      externalAssertionMatchesInvocation({
        assertion,
        name: 'read_file',
        args: { path: '/tmp/file' },
        success: true,
        now,
      })
    ).toBe(false);
    expect(
      externalAssertionMatchesInvocation({
        assertion,
        name: 'git_push',
        args: { message: 'release' },
        success: false,
        now,
      })
    ).toBe(false);
    expect(
      deriveToolExternalAssertion({
        name: 'git_push',
        args: { message: 'release' },
        result: { success: true, output: 'Latest commit: abc1234' },
        observedAt: now,
      })
    ).toEqual(expect.objectContaining({ status: 'inconclusive' }));
  });

  it.each([
    ['registry package not found', undefined],
    ['no results for the requested release', undefined],
    ['status=404', undefined],
    ['request completed', 'verification failed'],
    ['未找到对应的发布版本', undefined],
  ])(
    'does not turn explicit negative external state into passed evidence: %s',
    (summary, error) => {
      expect(
        classifyGoalEvidenceResult({
          kind: 'external',
          success: true,
          summary,
          error,
        })
      ).toBe('failed');
    }
  );

  it('keeps ambiguous transport success inconclusive', () => {
    expect(
      classifyGoalEvidenceResult({
        kind: 'external',
        success: true,
        summary: 'HTTP request completed',
      })
    ).toBe('inconclusive');
  });

  it.each(['status=200', 'exists=true', 'release is published', '已发布'])(
    'accepts an explicit positive external assertion: %s',
    summary => {
      expect(classifyGoalEvidenceResult({ kind: 'external', success: true, summary })).toBe(
        'passed'
      );
    }
  );

  it.each([
    'Pull request created: https://github.example/pull/42',
    'Pull request merged',
    'npm publish succeeded',
    'GitHub Release created',
    'registry entry visible',
  ])('accepts an explicit completed external action: %s', summary => {
    expect(classifyGoalEvidenceResult({ kind: 'external', success: true, summary })).toBe('passed');
  });

  it.each([
    'Pull request not created',
    'Pull request not merged',
    'npm package not published',
    'GitHub Release not available',
    'registry entry not found',
  ])('keeps explicit external action failures negative: %s', summary => {
    expect(classifyGoalEvidenceResult({ kind: 'external', success: true, summary })).toBe('failed');
  });
});
