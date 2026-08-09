import {
  auditBlocked,
  auditCompletion,
  blockerFingerprint,
  blockersMatch,
  criterionRequiresExternalCompletionEvidence,
} from '../src/runtime/goals/completion-audit';
import type { GoalBlocker, GoalContract, GoalEvidenceRecord } from '../src/runtime/goals/types';
import type { ToolExternalAssertion } from '../src/framework/external-assertion';

const contract: GoalContract = {
  originalObjective: 'Fix authentication bug',
  objectiveRevision: 0,
  constraints: [],
  successCriteria: [
    {
      id: 'auth-test',
      statement: 'Authentication regression test passes',
      source: 'user',
      status: 'pending',
      requiredEvidenceKinds: ['test'],
      evidenceRefs: ['e-auth'],
    },
  ],
};

function evidence(overrides: Partial<GoalEvidenceRecord> = {}): GoalEvidenceRecord {
  const kind = overrides.kind ?? 'test';
  return {
    id: 'e-auth',
    goalId: 'goal-1',
    goalRevision: 2,
    objectiveRevision: contract.objectiveRevision,
    turnId: 'turn-1',
    kind,
    subject: 'authentication regression test',
    result: 'passed',
    sourceRef: 'tool:call-1:exec_command',
    capturedAt: 100,
    ...(kind === 'external' ? { expiresAt: 500 } : {}),
    workspaceFingerprint: 'workspace-current',
    redacted: true,
    ...overrides,
  };
}

function audit(records: GoalEvidenceRecord[]) {
  return auditCompletion({
    objective: contract.originalObjective,
    contract,
    evidenceLedger: records,
    goalId: 'goal-1',
    goalRevision: 2,
    requestedAt: 90,
    verificationSummary: 'runtime verification',
    workspaceFingerprint: 'workspace-current',
    now: 200,
  });
}

function packageContract(
  registryEvidenceRefs: string[],
  binaryEvidenceRefs: string[]
): GoalContract {
  return {
    originalObjective: 'Release the package',
    objectiveRevision: 0,
    constraints: [],
    successCriteria: [
      {
        id: 'registry-entry',
        statement: 'Published package smoke verifies registry entry',
        source: 'user',
        status: 'pending',
        requiredEvidenceKinds: ['external'],
        evidenceRefs: registryEvidenceRefs,
      },
      {
        id: 'binary-starts',
        statement: 'Installed package smoke verifies binary starts',
        source: 'user',
        status: 'pending',
        requiredEvidenceKinds: ['external'],
        evidenceRefs: binaryEvidenceRefs,
      },
    ],
  };
}

function packageEvidence(id: string, subject: string): GoalEvidenceRecord {
  return evidence({ id, subject, kind: 'external', sourceRef: `external:${id}` });
}

function auditPackageContract(releaseContract: GoalContract, records: GoalEvidenceRecord[]) {
  return auditCompletion({
    objective: releaseContract.originalObjective,
    contract: releaseContract,
    evidenceLedger: records,
    goalId: 'goal-1',
    goalRevision: 2,
    requestedAt: 90,
    verificationSummary: 'package release verification',
    workspaceFingerprint: 'workspace-current',
    now: 200,
  });
}

describe('completion audit', () => {
  it.each([
    ['Publish the npm package, but do not merge the PR.', true],
    ['发布 npm 包，但不要合并 PR。', true],
    ['Do not merge the PR; then publish the npm package.', true],
    ['不要合并 PR；然后发布 npm 包。', true],
    ['Do not publish or merge anything.', false],
    ['不要发布或合并任何内容。', false],
  ])('detects external completion actions with local negation scope: %s', (statement, expected) => {
    expect(criterionRequiresExternalCompletionEvidence(statement)).toBe(expected);
  });

  it('requires evidence only for the positive action in a mixed publish/no-merge criterion', () => {
    const statement = 'Publish the npm package, but do not merge the PR.';
    const mixedContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external', 'user'],
          evidenceRefs: ['e-published'],
        },
      ],
    };
    const result = auditPackageContract(mixedContract, [
      packageEvidence('e-published', 'criterion:primary npm package published successfully'),
    ]);

    expect(result.passed).toBe(true);
    expect(result.evidenceRefs).toEqual(['e-published']);
  });

  it('passes only when every criterion has fresh relevant runtime evidence', () => {
    const result = audit([evidence()]);
    expect(result.passed).toBe(true);
    expect(result.criterionResults).toEqual([
      expect.objectContaining({
        criterionId: 'auth-test',
        passed: true,
        status: 'passed',
        evidenceRefs: ['e-auth'],
      }),
    ]);
  });

  it('fails when evidence is missing', () => {
    expect(audit([]).passed).toBe(false);
  });

  it('fails when evidence kind is unrelated', () => {
    expect(audit([evidence({ kind: 'file' })]).passed).toBe(false);
  });

  it('fails when a same-kind passing record is semantically unrelated', () => {
    const result = audit([evidence({ subject: 'unrelated billing export test' })]);
    expect(result.passed).toBe(false);
    expect(result.remainingRequirements[0]).toContain('not semantically related');
  });

  it('does not cross-close package criteria using only shared package smoke terms', () => {
    const releaseContract = packageContract(['e-binary'], ['e-registry']);
    const result = auditPackageContract(releaseContract, [
      packageEvidence('e-registry', 'package smoke registry entry'),
      packageEvidence('e-binary', 'package smoke binary starts'),
    ]);

    expect(result.passed).toBe(false);
    expect(result.criterionResults).toEqual([
      expect.objectContaining({
        criterionId: 'registry-entry',
        passed: false,
        status: 'pending',
        evidenceRefs: [],
      }),
      expect.objectContaining({
        criterionId: 'binary-starts',
        passed: false,
        status: 'pending',
        evidenceRefs: [],
      }),
    ]);
    expect(result.remainingRequirements).toEqual([
      expect.stringContaining('completed action/status'),
      expect.stringContaining('terms shared by multiple criteria'),
    ]);
  });

  it('matches explicitly referenced package evidence using criterion-specific terms', () => {
    const releaseContract = packageContract(['e-registry'], ['e-binary']);
    const result = auditPackageContract(releaseContract, [
      packageEvidence('e-registry', 'package published; registry entry visible'),
      packageEvidence('e-binary', 'package smoke binary starts'),
    ]);

    expect(result.passed).toBe(true);
    expect(result.criterionResults).toEqual([
      expect.objectContaining({
        criterionId: 'registry-entry',
        passed: true,
        evidenceRefs: ['e-registry'],
      }),
      expect.objectContaining({
        criterionId: 'binary-starts',
        passed: true,
        evidenceRefs: ['e-binary'],
      }),
    ]);
  });

  it('keeps the exact criterion id as an explicit strong association', () => {
    const releaseContract = packageContract(['e-registry'], ['e-binary']);
    const result = auditPackageContract(releaseContract, [
      packageEvidence('e-registry', 'registry-entry package published; registry entry visible'),
      packageEvidence('e-binary', 'release receipt for binary-starts'),
    ]);

    expect(result.passed).toBe(true);
    expect(result.evidenceRefs).toEqual(['e-registry', 'e-binary']);
  });

  it('does not let local version output complete a single publish criterion', () => {
    const releaseContract = packageContract(['e-version'], []).successCriteria[0];
    const actionContract: GoalContract = {
      originalObjective: 'Publish Orion package',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          ...releaseContract,
          id: 'criterion:primary',
          statement: 'Publish Orion package',
          requiredEvidenceKinds: ['runtime'],
          evidenceRefs: ['e-version'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-version',
        kind: 'runtime',
        subject: 'criterion:primary Orion package orion --version',
      }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.remainingRequirements[0]).toContain('external or user evidence');
    expect(result.remainingRequirements[0]).toContain('publish/release');
  });

  it('does not let an external criterion id replace publish completion state', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Publish Orion package',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Publish Orion package',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external', 'user'],
          evidenceRefs: ['e-generic'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-generic',
        kind: 'external',
        subject: 'criterion:primary Orion package status',
        sourceRef: 'external:package',
      }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.remainingRequirements[0]).toContain('publish/release');
  });

  it('accepts completed external publication evidence for a legacy primary criterion', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Publish Orion package',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Publish Orion package',
          source: 'user',
          status: 'pending',
          // Older sidecars may still list only local kinds. The completion
          // audit must apply the external-action safety rule independently.
          requiredEvidenceKinds: ['runtime'],
          evidenceRefs: ['e-published'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-published',
        kind: 'external',
        subject: 'Orion package published to npm successfully',
        sourceRef: 'registry:@orion-agents/orion-code',
      }),
    ]);

    expect(result.passed).toBe(true);
    expect(result.evidenceRefs).toEqual(['e-published']);
  });

  it.each([
    {
      name: 'npm packages',
      statement: 'Publish orion-code and orion-sdk to npm',
      subject: 'multi-target orion-code published to npm successfully',
      sourceRef: 'registry:orion-code',
      missingTarget: 'orion-sdk',
    },
    {
      name: 'pull requests',
      statement: 'Open PR #41 and #42 in repository linux2010/orion-code',
      subject: 'multi-target PR is open: linux2010/orion-code#41',
      sourceRef: 'external:github-pr',
      missingTarget: 'linux2010/orion-code#42',
    },
    {
      name: 'GitHub releases',
      statement: 'Publish GitHub release v0.1.2 for acme/a and acme/b',
      subject: 'multi-target GitHub release is published for acme/a v0.1.2',
      sourceRef: 'external:release-state',
      missingTarget: 'GitHub release acme/b',
    },
  ])('fails closed for multiple exact $name without typed assertions', testCase => {
    const actionContract: GoalContract = {
      originalObjective: testCase.statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'multi-target',
          statement: testCase.statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['legacy-evidence'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'legacy-evidence',
        kind: 'external',
        subject: testCase.subject,
        sourceRef: testCase.sourceRef,
      }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.remainingRequirements[0]).toContain(testCase.missingTarget);
  });

  it('keeps trusted user confirmation valid for a multi-target criterion', () => {
    const statement = 'Publish orion-code and orion-sdk to npm';
    const actionContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'publish-both-confirmed',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external', 'user'],
          evidenceRefs: ['user-confirmation'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'user-confirmation',
        kind: 'user',
        subject: `User confirmed publish-both-confirmed: ${statement}`,
        sourceRef: 'user:/target-confirm',
        workspaceFingerprint: undefined,
      }),
    ]);

    expect(result.passed).toBe(true);
  });

  it('accepts explicit user confirmation that names the publish criterion and action', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Publish Orion package',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Publish Orion package',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external', 'user'],
          evidenceRefs: ['e-user'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-user',
        kind: 'user',
        subject: 'User confirmed criterion:primary: Publish Orion package',
        sourceRef: 'user:/target-confirm',
        workspaceFingerprint: undefined,
      }),
    ]);

    expect(result.passed).toBe(true);
    expect(result.evidenceRefs).toEqual(['e-user']);
  });

  it('requires external action evidence to carry an unexpired freshness bound', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Publish Orion package',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Publish Orion package',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external', 'user'],
          evidenceRefs: ['e-missing-expiry'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-missing-expiry',
        kind: 'external',
        subject: 'Orion package published to npm successfully',
        sourceRef: 'external:npm-publish',
        expiresAt: undefined,
      }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.criterionResults?.[0].status).toBe('stale');
  });

  it('rejects expired external action evidence but keeps trusted user confirmation valid', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Create the Orion pull request',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Create the Orion pull request',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external', 'user'],
          evidenceRefs: ['e-stale-pr'],
        },
      ],
    };
    const stale = auditPackageContract(actionContract, [
      evidence({
        id: 'e-stale-pr',
        kind: 'external',
        subject: 'Orion pull request created',
        sourceRef: 'external:github-pr',
        expiresAt: 150,
      }),
    ]);
    expect(stale.passed).toBe(false);
    expect(stale.criterionResults?.[0].status).toBe('stale');

    actionContract.successCriteria[0].evidenceRefs = ['e-user-pr'];
    const confirmed = auditPackageContract(actionContract, [
      evidence({
        id: 'e-user-pr',
        kind: 'user',
        subject: 'User confirmed criterion:primary: Create the Orion pull request',
        sourceRef: 'user:/target-confirm',
        workspaceFingerprint: undefined,
      }),
    ]);
    expect(confirmed.passed).toBe(true);
  });

  it('does not accept local or ordinary exec text as external completion evidence', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Publish Orion package',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Publish Orion package',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external', 'user'],
          evidenceRefs: ['e-fake-exec'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-fake-exec',
        kind: 'runtime',
        subject: 'echo npm publish succeeded',
        sourceRef: 'tool:call-fake:exec_command',
      }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.remainingRequirements[0]).toContain('external or user evidence');
  });

  it('does not accept web or browser display text as external completion proof', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Open the Orion pull request',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement: 'Open the Orion pull request',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-web'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-web',
        kind: 'external',
        subject: 'Orion pull request created',
        sourceRef: 'tool:call-web:web_search',
      }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.remainingRequirements[0]).toContain('pull request created/opened');
  });

  it('requires the typed registry assertion to match package and version', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Verify @orion-agents/orion-code v0.1.2 registry entry',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'registry-v012',
          statement: 'Verify @orion-agents/orion-code v0.1.2 registry entry',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-registry'],
        },
      ],
    };
    const typedEvidence = (version: string): GoalEvidenceRecord =>
      evidence({
        id: 'e-registry',
        kind: 'external',
        subject: `external registry passed provider=npm target=@orion-agents/orion-code observed=${version}`,
        sourceRef: 'tool:call-npm:exec_command',
        externalAssertion: {
          version: 1,
          action: 'registry',
          status: 'passed',
          provider: 'npm',
          target: '@orion-agents/orion-code',
          observedValue: version,
          observedAt: 100,
          details: {
            kind: 'npm',
            packageName: '@orion-agents/orion-code',
            version,
            field: 'version',
          },
        },
      });

    expect(auditPackageContract(actionContract, [typedEvidence('0.1.1')]).passed).toBe(false);
    expect(auditPackageContract(actionContract, [typedEvidence('0.1.2')]).passed).toBe(true);
  });

  it('requires a separate fresh npm assertion for every package named by one criterion', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Publish both packages',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'publish-both',
          statement: 'Publish @scope/a@0.1.2 and @scope/b@0.1.2 to npm',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-a', 'e-b'],
        },
      ],
    };
    const published = (id: string, packageName: string): GoalEvidenceRecord =>
      evidence({
        id,
        kind: 'external',
        subject: `publish-both ${packageName}@0.1.2 published`,
        sourceRef: `tool:${id}:exec_command`,
        externalAssertion: {
          version: 1,
          action: 'publish',
          status: 'passed',
          provider: 'npm',
          target: `${packageName}@0.1.2`,
          observedValue: '0.1.2',
          observedAt: 100,
          details: { kind: 'npm', packageName, version: '0.1.2', field: 'publish' },
        },
      });

    const onlyA = auditPackageContract(actionContract, [published('e-a', '@scope/a')]);
    expect(onlyA.passed).toBe(false);
    expect(onlyA.remainingRequirements[0]).toContain('@scope/b@0.1.2');

    expect(
      auditPackageContract(actionContract, [
        published('e-a', '@scope/a'),
        published('e-b', '@scope/b'),
      ]).passed
    ).toBe(true);
  });

  it('requires every unversioned npm package named in a publish conjunction', () => {
    const statement = 'Publish orion-code and orion-sdk to npm';
    const actionContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'publish-unversioned',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-code', 'e-sdk'],
        },
      ],
    };
    const published = (id: string, packageName: string): GoalEvidenceRecord =>
      evidence({
        id,
        kind: 'external',
        subject: `publish-unversioned ${packageName} published`,
        sourceRef: `tool:${id}:exec_command`,
        externalAssertion: {
          version: 1,
          action: 'publish',
          status: 'passed',
          provider: 'npm',
          target: packageName,
          observedValue: 'published',
          observedAt: 100,
          details: { kind: 'npm', packageName, field: 'publish' },
        },
      });

    const onlyCode = auditPackageContract(actionContract, [published('e-code', 'orion-code')]);
    expect(onlyCode.passed).toBe(false);
    expect(onlyCode.remainingRequirements[0]).toContain('orion-sdk');
    expect(
      auditPackageContract(actionContract, [
        published('e-code', 'orion-code'),
        published('e-sdk', 'orion-sdk'),
      ]).passed
    ).toBe(true);
  });

  it('matches each npm package against its own required version', () => {
    const statement = 'Publish @scope/a@0.1.2 and @scope/b@0.2.0 to npm';
    const actionContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'publish-mixed-versions',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-a', 'e-b'],
        },
      ],
    };
    const published = (id: string, packageName: string, version: string): GoalEvidenceRecord =>
      evidence({
        id,
        kind: 'external',
        subject: `publish-mixed-versions ${packageName}@${version} published`,
        sourceRef: `tool:${id}:exec_command`,
        externalAssertion: {
          version: 1,
          action: 'publish',
          status: 'passed',
          provider: 'npm',
          target: `${packageName}@${version}`,
          observedValue: version,
          observedAt: 100,
          details: { kind: 'npm', packageName, version, field: 'publish' },
        },
      });

    expect(
      auditPackageContract(actionContract, [
        published('e-a', '@scope/a', '0.1.2'),
        published('e-b', '@scope/b', '0.2.0'),
      ]).passed
    ).toBe(true);
    const wrongB = auditPackageContract(actionContract, [
      published('e-a', '@scope/a', '0.1.2'),
      published('e-b', '@scope/b', '0.1.2'),
    ]);
    expect(wrongB.passed).toBe(false);
    expect(wrongB.remainingRequirements[0]).toContain('@scope/b@0.2.0');
  });

  it('requires a separate fresh assertion for every pull request named by one criterion', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Open both pull requests',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'open-both-prs',
          statement: 'Open linux2010/orion-code#41 and linux2010/orion-code#42 pull requests',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-pr-41', 'e-pr-42'],
        },
      ],
    };
    const opened = (id: string, prNumber: number): GoalEvidenceRecord =>
      evidence({
        id,
        kind: 'external',
        subject: `open-both-prs linux2010/orion-code#${prNumber} OPEN`,
        sourceRef: `tool:${id}:exec_command`,
        externalAssertion: {
          version: 1,
          action: 'pull_request',
          status: 'passed',
          provider: 'github',
          target: `linux2010/orion-code#${prNumber}`,
          observedValue: 'OPEN',
          observedAt: 100,
          details: {
            kind: 'github_pr',
            repository: 'linux2010/orion-code',
            prNumber,
            state: 'OPEN',
          },
        },
      });

    const onlyFirst = auditPackageContract(actionContract, [opened('e-pr-41', 41)]);
    expect(onlyFirst.passed).toBe(false);
    expect(onlyFirst.remainingRequirements[0]).toContain('linux2010/orion-code#42');
    expect(
      auditPackageContract(actionContract, [opened('e-pr-41', 41), opened('e-pr-42', 42)]).passed
    ).toBe(true);
  });

  it('requires every PR number in a shared-repository shorthand conjunction', () => {
    const statement = 'Open PR #41, #42, and #43 in repository linux2010/orion-code';
    const actionContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'open-shorthand-prs',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-pr-41', 'e-pr-42', 'e-pr-43'],
        },
      ],
    };
    const opened = (id: string, prNumber: number): GoalEvidenceRecord =>
      evidence({
        id,
        kind: 'external',
        subject: `open-shorthand-prs linux2010/orion-code#${prNumber} OPEN`,
        sourceRef: `tool:${id}:exec_command`,
        externalAssertion: {
          version: 1,
          action: 'pull_request',
          status: 'passed',
          provider: 'github',
          target: `linux2010/orion-code#${prNumber}`,
          observedValue: 'OPEN',
          observedAt: 100,
          details: {
            kind: 'github_pr',
            repository: 'linux2010/orion-code',
            prNumber,
            state: 'OPEN',
          },
        },
      });

    const onlyFirst = auditPackageContract(actionContract, [opened('e-pr-41', 41)]);
    expect(onlyFirst.passed).toBe(false);
    expect(onlyFirst.remainingRequirements[0]).toContain('linux2010/orion-code#42');
    const onlyFirstTwo = auditPackageContract(actionContract, [
      opened('e-pr-41', 41),
      opened('e-pr-42', 42),
    ]);
    expect(onlyFirstTwo.passed).toBe(false);
    expect(onlyFirstTwo.remainingRequirements[0]).toContain('linux2010/orion-code#43');
    expect(
      auditPackageContract(actionContract, [
        opened('e-pr-41', 41),
        opened('e-pr-42', 42),
        opened('e-pr-43', 43),
      ]).passed
    ).toBe(true);
  });

  it('requires adjacent unprefixed PR numbers without treating an issue number as a PR', () => {
    const statement = 'Open PRs 41 and 42 in repository linux2010/orion-code, and close issue #99';
    const actionContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'open-unprefixed-prs',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-pr-41', 'e-pr-42'],
        },
      ],
    };
    const opened = (id: string, prNumber: number): GoalEvidenceRecord =>
      evidence({
        id,
        kind: 'external',
        subject: `open-unprefixed-prs linux2010/orion-code#${prNumber} OPEN`,
        sourceRef: `tool:${id}:exec_command`,
        externalAssertion: {
          version: 1,
          action: 'pull_request',
          status: 'passed',
          provider: 'github',
          target: `linux2010/orion-code#${prNumber}`,
          observedValue: 'OPEN',
          observedAt: 100,
          details: {
            kind: 'github_pr',
            repository: 'linux2010/orion-code',
            prNumber,
            state: 'OPEN',
          },
        },
      });

    const wrongSecond = auditPackageContract(actionContract, [
      opened('e-pr-41', 41),
      opened('e-pr-99', 99),
    ]);
    expect(wrongSecond.passed).toBe(false);
    expect(wrongSecond.remainingRequirements[0]).toContain('linux2010/orion-code#42');
    expect(
      auditPackageContract(actionContract, [opened('e-pr-41', 41), opened('e-pr-42', 42)]).passed
    ).toBe(true);
  });

  it('requires a separate fresh GitHub release assertion for every named repository', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Publish both GitHub releases',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'release-both',
          statement: 'Publish GitHub release v0.1.2 for acme/a and acme/b',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-release-a', 'e-release-b'],
        },
      ],
    };
    const released = (id: string, repository: string): GoalEvidenceRecord =>
      evidence({
        id,
        kind: 'external',
        subject: `release-both ${repository} v0.1.2 published`,
        sourceRef: `tool:${id}:exec_command`,
        externalAssertion: {
          version: 1,
          action: 'publish',
          status: 'passed',
          provider: 'github',
          target: `${repository}:v0.1.2`,
          observedValue: 'v0.1.2@2026-08-02T00:00:00Z',
          observedAt: 100,
          details: {
            kind: 'github_release',
            repository,
            tagName: 'v0.1.2',
            isDraft: false,
            publishedAt: '2026-08-02T00:00:00Z',
          },
        },
      });

    const onlyA = auditPackageContract(actionContract, [released('e-release-a', 'acme/a')]);
    expect(onlyA.passed).toBe(false);
    expect(onlyA.remainingRequirements[0]).toContain('GitHub release acme/b');
    expect(
      auditPackageContract(actionContract, [
        released('e-release-a', 'acme/a'),
        released('e-release-b', 'acme/b'),
      ]).passed
    ).toBe(true);
  });

  it('normalizes a GitHub URL to its exact release repository target', () => {
    const statement = 'Publish GitHub release v0.1.2 for https://github.com/acme/repo';
    const actionContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'release-url',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-release'],
        },
      ],
    };
    const released = (repository: string): GoalEvidenceRecord =>
      evidence({
        id: 'e-release',
        kind: 'external',
        subject: `release-url ${repository} v0.1.2 published`,
        sourceRef: 'tool:e-release:exec_command',
        externalAssertion: {
          version: 1,
          action: 'publish',
          status: 'passed',
          provider: 'github',
          target: `${repository}:v0.1.2`,
          observedValue: 'v0.1.2@2026-08-02T00:00:00Z',
          observedAt: 100,
          details: {
            kind: 'github_release',
            repository,
            tagName: 'v0.1.2',
            isDraft: false,
            publishedAt: '2026-08-02T00:00:00Z',
          },
        },
      });

    expect(auditPackageContract(actionContract, [released('acme/repo')]).passed).toBe(true);
    expect(auditPackageContract(actionContract, [released('evil/repo')]).passed).toBe(false);
  });

  it('rejects a stale typed observation wrapped in a fresh evidence record', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Verify @orion-agents/orion-code v0.1.2 registry entry',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'registry-v012',
          statement: 'Verify @orion-agents/orion-code v0.1.2 registry entry',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-registry'],
        },
      ],
    };
    const result = auditCompletion({
      objective: actionContract.originalObjective,
      contract: actionContract,
      evidenceLedger: [
        evidence({
          id: 'e-registry',
          kind: 'external',
          subject:
            'external registry passed provider=npm target=@orion-agents/orion-code observed=0.1.2',
          sourceRef: 'tool:call-npm:exec_command',
          capturedAt: 400_100,
          expiresAt: 700_000,
          externalAssertion: {
            version: 1,
            action: 'registry',
            status: 'passed',
            provider: 'npm',
            target: '@orion-agents/orion-code',
            observedValue: '0.1.2',
            observedAt: 100,
            details: {
              kind: 'npm',
              packageName: '@orion-agents/orion-code',
              version: '0.1.2',
              field: 'version',
            },
          },
        }),
      ],
      goalId: 'goal-1',
      goalRevision: 2,
      requestedAt: 400_000,
      verificationSummary: 'registry verification',
      workspaceFingerprint: 'workspace-current',
      now: 400_200,
    });

    expect(result.passed).toBe(false);
    expect(result.criterionResults?.[0]).toMatchObject({ status: 'stale', passed: false });
  });

  it('accepts a matching typed pull-request assertion from exec_command', () => {
    const actionContract: GoalContract = {
      originalObjective: 'Open Orion pull request #42',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'open-pr-42',
          statement: 'Open Orion pull request #42',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-pr'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-pr',
        kind: 'external',
        subject: 'external pull_request passed target=linux2010/orion-code#42 observed=OPEN',
        sourceRef: 'tool:call-gh:exec_command',
        externalAssertion: {
          version: 1,
          action: 'pull_request',
          status: 'passed',
          provider: 'github',
          target: 'linux2010/orion-code#42',
          observedValue: 'OPEN',
          observedAt: 100,
          details: {
            kind: 'github_pr',
            repository: 'linux2010/orion-code',
            prNumber: 42,
            state: 'OPEN',
          },
        },
      }),
    ]);

    expect(result.passed).toBe(true);
  });

  it.each<{
    name: string;
    statement: string;
    assertion: ToolExternalAssertion;
  }>([
    {
      name: 'scoped package prefix',
      statement: 'Verify @scope/foo v0.1.2 registry entry',
      assertion: {
        version: 1,
        action: 'registry',
        status: 'passed',
        provider: 'npm',
        target: '@scope/foobar',
        observedValue: '0.1.2',
        observedAt: 100,
        details: {
          kind: 'npm',
          packageName: '@scope/foobar',
          version: '0.1.2',
          field: 'version',
        },
      },
    },
    {
      name: 'unscoped package',
      statement: 'Verify orion-code@0.1.2 registry entry',
      assertion: {
        version: 1,
        action: 'registry',
        status: 'passed',
        provider: 'npm',
        target: 'evil-code',
        observedValue: '0.1.2',
        observedAt: 100,
        details: { kind: 'npm', packageName: 'evil-code', version: '0.1.2', field: 'version' },
      },
    },
    {
      name: 'version substring',
      statement: 'Verify orion-code@0.1.2 registry entry',
      assertion: {
        version: 1,
        action: 'registry',
        status: 'passed',
        provider: 'npm',
        target: 'orion-code',
        observedValue: '10.1.20',
        observedAt: 100,
        details: { kind: 'npm', packageName: 'orion-code', version: '10.1.20', field: 'version' },
      },
    },
    {
      name: 'GitHub repository',
      statement: 'Open linux2010/orion-code#42 pull request',
      assertion: {
        version: 1,
        action: 'pull_request',
        status: 'passed',
        provider: 'github',
        target: 'evil/repo#42',
        observedValue: 'OPEN',
        observedAt: 100,
        details: { kind: 'github_pr', repository: 'evil/repo', prNumber: 42, state: 'OPEN' },
      },
    },
    {
      name: 'GitHub release tag and repository',
      statement: 'Publish GitHub release v0.1.2 for repository linux2010/orion-code',
      assertion: {
        version: 1,
        action: 'publish',
        status: 'passed',
        provider: 'github',
        target: 'evil/repo:v0.1.3',
        observedValue: 'v0.1.3@2026-08-02T00:00:00Z',
        observedAt: 100,
        details: {
          kind: 'github_release',
          repository: 'evil/repo',
          tagName: 'v0.1.3',
          isDraft: false,
          publishedAt: '2026-08-02T00:00:00Z',
        },
      },
    },
    {
      name: 'git remote and branch',
      statement: 'Push branch release to remote origin',
      assertion: {
        version: 1,
        action: 'push',
        status: 'passed',
        provider: 'git',
        target: 'upstream#main',
        observedValue: 'abc1234',
        observedAt: 100,
        details: { kind: 'git_push', remote: 'upstream', branch: 'main', commit: 'abc1234' },
      },
    },
  ])('rejects a typed assertion with the wrong exact $name target', ({ statement, assertion }) => {
    const actionContract: GoalContract = {
      originalObjective: statement,
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'criterion:primary',
          statement,
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-external'],
        },
      ],
    };
    const result = auditPackageContract(actionContract, [
      evidence({
        id: 'e-external',
        kind: 'external',
        subject: `criterion:primary ${statement}`,
        sourceRef: 'tool:call-external:exec_command',
        externalAssertion: assertion,
      }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.criterionResults?.[0]).toMatchObject({ passed: false });
  });

  it('accepts exact structured GitHub release and git push assertions', () => {
    const cases: Array<{ statement: string; assertion: ToolExternalAssertion }> = [
      {
        statement: 'Publish GitHub release v0.1.2 for repository linux2010/orion-code',
        assertion: {
          version: 1,
          action: 'publish',
          status: 'passed',
          provider: 'github',
          target: 'linux2010/orion-code:v0.1.2',
          observedValue: 'v0.1.2@2026-08-02T00:00:00Z',
          observedAt: 100,
          details: {
            kind: 'github_release',
            repository: 'linux2010/orion-code',
            tagName: 'v0.1.2',
            isDraft: false,
            publishedAt: '2026-08-02T00:00:00Z',
          },
        },
      },
      {
        statement: 'Push branch release to remote origin',
        assertion: {
          version: 1,
          action: 'push',
          status: 'passed',
          provider: 'git',
          target: 'origin#release',
          observedValue: 'abc1234',
          observedAt: 100,
          details: { kind: 'git_push', remote: 'origin', branch: 'release', commit: 'abc1234' },
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const actionContract: GoalContract = {
        originalObjective: item.statement,
        objectiveRevision: 0,
        constraints: [],
        successCriteria: [
          {
            id: 'criterion:primary',
            statement: item.statement,
            source: 'user',
            status: 'pending',
            requiredEvidenceKinds: ['external'],
            evidenceRefs: [`e-${index}`],
          },
        ],
      };
      expect(
        auditPackageContract(actionContract, [
          evidence({
            id: `e-${index}`,
            kind: 'external',
            subject: `criterion:primary ${item.statement}`,
            sourceRef: 'tool:call-external:exec_command',
            externalAssertion: item.assertion,
          }),
        ]).passed
      ).toBe(true);
    }
  });

  it('recognizes branch push as an external completion action', () => {
    expect(criterionRequiresExternalCompletionEvidence('Push the release branch to GitHub')).toBe(
      true
    );
  });

  it.each([
    ['Publish Orion package', 'Orion package published to npm', 'publish/release'],
    ['Create GitHub Release v0.1.2', 'GitHub Release created for v0.1.2', 'publish/release'],
    ['Open an Orion pull request', 'Orion pull request opened', 'pull request created/opened'],
    ['Merge Orion pull request', 'Orion pull request merged', 'merge completed'],
    [
      'Verify Orion package registry entry',
      'Orion registry entry visible',
      'registry entry visible',
    ],
    ['发布 Orion 软件包', 'Orion 软件包已发布到 npm', 'publish/release'],
    ['创建 Orion PR', 'Orion PR 已创建', 'pull request created/opened'],
    ['合并 Orion PR', 'Orion PR 已合并', 'merge completed'],
    ['验证 Orion 软件包 registry 条目', 'Orion registry entry visible', 'registry entry visible'],
  ])(
    'requires matching completed external state for action criterion: %s',
    (statement, completedSubject, expectedAction) => {
      const actionContract: GoalContract = {
        originalObjective: statement,
        objectiveRevision: 0,
        constraints: [],
        successCriteria: [
          {
            id: 'criterion:primary',
            statement,
            source: 'user',
            status: 'pending',
            requiredEvidenceKinds: ['runtime'],
            evidenceRefs: ['e-local'],
          },
        ],
      };
      const localResult = auditPackageContract(actionContract, [
        evidence({
          id: 'e-local',
          kind: 'runtime',
          subject: 'criterion:primary Orion orion --version',
        }),
      ]);
      expect(localResult.passed).toBe(false);
      expect(localResult.remainingRequirements[0]).toContain(expectedAction);

      actionContract.successCriteria[0].evidenceRefs = ['e-external'];
      const externalResult = auditPackageContract(actionContract, [
        evidence({
          id: 'e-external',
          kind: 'external',
          subject: completedSubject,
          sourceRef: 'external:release-state',
        }),
      ]);
      expect(externalResult.passed).toBe(true);
    }
  );

  it('requires action-specific coverage across multiple external criteria', () => {
    const releaseContract: GoalContract = {
      originalObjective: 'Publish, merge, and verify the registry release',
      objectiveRevision: 0,
      constraints: [],
      successCriteria: [
        {
          id: 'publish-package',
          statement: 'Publish Orion package',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-publish'],
        },
        {
          id: 'merge-pr',
          statement: 'Merge Orion pull request',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-merge'],
        },
        {
          id: 'registry-entry',
          statement: 'Verify Orion package registry entry',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['external'],
          evidenceRefs: ['e-registry'],
        },
      ],
    };
    const genericBrandEvidence = ['e-publish', 'e-merge', 'e-registry'].map(id =>
      evidence({
        id,
        kind: 'external',
        subject: `${id} Orion status`,
        sourceRef: `external:${id}`,
      })
    );
    expect(auditPackageContract(releaseContract, genericBrandEvidence).passed).toBe(false);

    const completed = auditPackageContract(releaseContract, [
      evidence({
        id: 'e-publish',
        kind: 'external',
        subject: 'Orion package published successfully',
        sourceRef: 'external:release',
      }),
      evidence({
        id: 'e-merge',
        kind: 'external',
        subject: 'Orion pull request merged',
        sourceRef: 'external:merge',
      }),
      evidence({
        id: 'e-registry',
        kind: 'external',
        subject: 'Orion package registry entry visible',
        sourceRef: 'external:registry',
      }),
    ]);
    expect(completed.passed).toBe(true);
    expect(completed.evidenceRefs).toEqual(['e-publish', 'e-merge', 'e-registry']);
  });

  it('fails when evidence belongs to another goal', () => {
    expect(audit([evidence({ goalId: 'goal-other' })]).passed).toBe(false);
  });

  it('fails when evidence belongs to an older objective revision', () => {
    expect(audit([evidence({ objectiveRevision: contract.objectiveRevision - 1 })]).passed).toBe(
      false
    );
  });

  it('fails when relevant evidence failed', () => {
    const result = audit([evidence({ result: 'failed' })]);
    expect(result.passed).toBe(false);
    expect(result.remainingRequirements[0]).toContain('failed');
  });

  it('does not allow the model to omit a relevant failed ledger record', () => {
    const result = audit([
      evidence({ id: 'e-auth', result: 'passed' }),
      evidence({
        id: 'e-auth-failed',
        result: 'failed',
        subject: 'authentication integration test',
      }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.criterionResults?.[0]).toMatchObject({ status: 'failed', passed: false });
    expect(result.remainingRequirements[0]).toContain('e-auth-failed');
  });

  it('fails when evidence expired', () => {
    const result = audit([evidence({ expiresAt: 150 })]);
    expect(result.passed).toBe(false);
    expect(result.criterionResults?.[0].status).toBe('stale');
  });

  it.each([
    ['evidence fingerprint', undefined, 'workspace-current'],
    ['audit fingerprint', 'workspace-current', undefined],
  ])('fails closed when the %s is missing', (_label, evidenceFingerprint, auditFingerprint) => {
    const result = auditCompletion({
      objective: contract.originalObjective,
      contract,
      evidenceLedger: [evidence({ workspaceFingerprint: evidenceFingerprint })],
      goalId: 'goal-1',
      goalRevision: 2,
      requestedAt: 90,
      verificationSummary: 'runtime verification',
      workspaceFingerprint: auditFingerprint,
      now: 200,
    });
    expect(result.passed).toBe(false);
    expect(result.criterionResults?.[0].status).toBe('stale');
  });

  it('fails when workspace fingerprint is stale', () => {
    const result = auditCompletion({
      objective: contract.originalObjective,
      contract,
      evidenceLedger: [evidence({ workspaceFingerprint: 'old' })],
      goalId: 'goal-1',
      goalRevision: 2,
      requestedAt: 90,
      verificationSummary: 'runtime verification',
      workspaceFingerprint: 'new',
      now: 200,
    });
    expect(result.passed).toBe(false);
  });

  it('allows blocked only after the same blocker and no progress persist for 3 turns', () => {
    expect(
      auditBlocked({
        blocker: {
          category: 'permission',
          retryable: false,
          fingerprint: 'fp1',
          summary: 'Test',
          consecutiveTurns: 3,
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
        noProgressCount: 3,
      }).allowed
    ).toBe(true);
    expect(
      auditBlocked({
        blocker: {
          category: 'permission',
          retryable: false,
          fingerprint: 'fp1',
          summary: 'Test',
          consecutiveTurns: 2,
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
        noProgressCount: 3,
      }).allowed
    ).toBe(false);
    const insufficientNoProgress = auditBlocked({
      blocker: {
        category: 'permission',
        retryable: false,
        fingerprint: 'fp1',
        summary: 'Test',
        consecutiveTurns: 3,
        firstSeenAt: 1,
        lastSeenAt: 2,
      },
      noProgressCount: 2,
    });
    expect(insufficientNoProgress.allowed).toBe(false);
    expect(insufficientNoProgress.reason).toContain('2/3');
  });

  it('rejects retryable and non-allowlisted terminal blockers', () => {
    const base: GoalBlocker = {
      category: 'permission',
      retryable: false,
      fingerprint: 'fp1',
      summary: 'Test',
      consecutiveTurns: 3,
      firstSeenAt: 1,
      lastSeenAt: 2,
    };
    expect(
      auditBlocked({
        blocker: { ...base, retryable: true } as unknown as GoalBlocker,
        noProgressCount: 3,
      }).allowed
    ).toBe(false);
    expect(
      auditBlocked({
        blocker: { ...base, category: 'runtime' } as unknown as GoalBlocker,
        noProgressCount: 3,
      }).allowed
    ).toBe(false);
  });

  it('matches blocker fingerprints exactly', () => {
    const fp = blockerFingerprint('test', '500', 'error');
    expect(
      blockersMatch(
        {
          category: 'permission',
          retryable: false,
          fingerprint: fp,
          firstSeenAt: 0,
          lastSeenAt: 0,
          consecutiveTurns: 1,
          summary: '',
        },
        fp
      )
    ).toBe(true);
    expect(blockersMatch(undefined, fp)).toBe(false);
  });
});
