import {
  createLocalResearchRequest,
  subtaskResultToPacket,
  validatePacket,
} from '../src/runtime/subagents/research-contract';
import { EMPTY_SUBTASK_USAGE, type SubtaskResult } from '../src/runtime/subagents/types';

function result(overrides: Partial<SubtaskResult> = {}): SubtaskResult {
  return {
    id: 'task-path-boundary',
    role: 'research',
    status: 'completed',
    summary: 'path boundary result',
    findings: [],
    files: [],
    commands: [],
    verification: [],
    risks: [],
    usage: EMPTY_SUBTASK_USAGE,
    ...overrides,
  };
}

const request = createLocalResearchRequest('path boundary', '/repo');
const context = { sessionId: 'sess-path-boundary', projectPath: '/repo' };

describe('local research projectPath boundary (#107)', () => {
  it('normalizes safe files[] paths and drops absolute or escaping external paths', () => {
    const packet = subtaskResultToPacket(
      result({
        files: [
          'src/a.ts',
          '/repo/src/b.ts',
          'src/../src/c.ts',
          '/etc/passwd',
          '../outside.ts',
          '..\\outside-win.ts',
          'file:///etc/shadow',
          'C:\\Users\\outside.txt',
        ],
      }),
      request,
      context
    );

    expect(packet.sources.map(source => source.projectPath)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    expect(packet.sources.every(source => !source.projectPath?.startsWith('/'))).toBe(true);
    expect(validatePacket(packet)).toEqual({ ok: true, errors: [] });
  });

  it('never marks an out-of-project finding.file as observed', () => {
    const packet = subtaskResultToPacket(
      result({
        findings: [
          { title: 'absolute external', evidence: 'outside', file: '/etc/passwd' },
          { title: 'relative escape', evidence: 'outside', file: '../../secrets.txt' },
          { title: 'file URL', evidence: 'outside', file: 'file:///etc/shadow' },
          { title: 'inside absolute', evidence: 'inside', file: '/repo/src/inside.ts' },
        ],
      }),
      request,
      context
    );

    expect(packet.sources).toEqual([
      expect.objectContaining({ kind: 'file', projectPath: 'src/inside.ts' }),
    ]);
    expect(
      packet.claims
        .slice(0, 3)
        .every(
          claim =>
            claim.evidenceKind === 'inference' &&
            claim.verification === 'unverified' &&
            claim.sourceIds.length === 0
        )
    ).toBe(true);
    expect(packet.claims[3]).toEqual(
      expect.objectContaining({
        evidenceKind: 'file',
        verification: 'observed',
        sourceIds: ['src-1'],
      })
    );
  });

  it.each([
    '/repo/src/cli.ts',
    '../outside.ts',
    'src/../outside.ts',
    'src\\cli.ts',
    'file:///etc/passwd',
    '',
  ])('rejects persisted or replayed non-canonical file source path %p', projectPath => {
    const packet = subtaskResultToPacket(
      result({
        files: ['src/cli.ts'],
        findings: [{ title: 'finding', evidence: 'evidence', file: 'src/cli.ts' }],
      }),
      request,
      context
    );
    packet.sources[0].projectPath = projectPath;

    const validation = validatePacket(packet);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('source src-1 has invalid projectPath');
  });

  it('rejects replayed file sources without a projectPath', () => {
    const packet = subtaskResultToPacket(result({ files: ['src/cli.ts'] }), request, context);
    delete packet.sources[0].projectPath;

    expect(validatePacket(packet).errors).toContain('source src-1 has invalid projectPath');
  });
});
