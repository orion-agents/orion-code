/**
 * v0.3.23 T23-B — symbol index, incremental maintenance, and recall tests.
 *
 * Builds a real fixture repo on disk (TS sources with imports), asserts
 * extraction correctness, incremental rebuild behavior, the recall scoring
 * with reasons, budget selection (user-pinned files kept), and Recall@K on a
 * small annotated task.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RepoSymbolIndexV1 } from '../src/services/repo-intelligence/symbol-index';
import { recallFiles, selectWithinBudget } from '../src/services/repo-intelligence/recall';
import { isRepoIntelligenceEnabled } from '../src/services/repo-intelligence';

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'src/agent-loop.ts': `import { ToolGateway } from './tool-gateway';\nexport class AgentLoop {\n  run(): void {}\n}\n`,
  'src/tool-gateway.ts': `export interface ToolInvocation {\n  id: string;\n}\nexport class ToolGateway {\n  invoke(): void {}\n}\n`,
  'src/session-memory.ts': `export const MEMORY_LIMIT = 100;\nexport function recallMemory(): string[] {\n  return [];\n}\n`,
  'tests/agent-loop.test.ts': `import { AgentLoop } from '../src/agent-loop';\n// exercises AgentLoop\n`,
};

function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orion-repo-intel-'));
  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

describe('RepoSymbolIndexV1 (T23-B1/B2)', () => {
  let root: string;
  let index: RepoSymbolIndexV1;

  beforeEach(() => {
    root = buildFixtureRepo();
    index = new RepoSymbolIndexV1(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('extracts symbols, exportedness, and resolved import edges', () => {
    const stats = index.build();
    expect(stats.files).toBe(4);
    expect(stats.symbols).toBeGreaterThanOrEqual(6);

    const agentLoop = index.findSymbol('AgentLoop');
    expect(agentLoop).toHaveLength(1);
    expect(agentLoop[0]).toMatchObject({
      file: 'src/agent-loop.ts',
      kind: 'class',
      exported: true,
    });

    // The relative import './tool-gateway' resolves to src/tool-gateway.ts.
    expect(index.importersOf('src/tool-gateway.ts')).toEqual(['src/agent-loop.ts']);
    const gatewayRecord = index.getSnapshot().get('src/tool-gateway.ts');
    expect(gatewayRecord?.imports).toEqual(['src/tool-gateway.ts'].length >= 0 ? [] : []);
    expect(gatewayRecord?.exportedNames).toEqual(
      expect.arrayContaining(['ToolGateway', 'ToolInvocation'])
    );
  });

  test('incremental update re-parses only stale files', () => {
    index.build();
    // Touch one file's mtime without changing others.
    const target = join(root, 'src/session-memory.ts');
    const future = new Date(Date.now() + 5_000);
    utimesSync(target, future, future);
    writeFileSync(target, `${FIXTURE_FILES['src/session-memory.ts']}\nexport const EXTRA = 1;\n`);

    const stats = index.update();
    expect(stats.incremental).toBe(true);
    expect(stats.parsed).toBe(1);
    expect(index.findSymbol('EXTRA')).toHaveLength(1);
  });

  test('deleted files drop out of the index', () => {
    index.build();
    rmSync(join(root, 'src/session-memory.ts'));
    index.update();
    expect(index.findSymbol('recallMemory')).toHaveLength(0);
    expect(index.getSnapshot().has('src/session-memory.ts')).toBe(false);
  });

  test('skips node_modules, hidden entries, and non-source files', () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ignore.js'), 'module.exports = 1;');
    writeFileSync(join(root, '.hidden.ts'), 'export const hidden = 1;');
    writeFileSync(join(root, 'README.txt'), 'not source');
    const stats = index.build();
    expect(stats.files).toBe(4);
  });
});

describe('recallFiles + budget selection (T23-B3/B4)', () => {
  let root: string;
  let index: RepoSymbolIndexV1;

  beforeEach(() => {
    root = buildFixtureRepo();
    index = new RepoSymbolIndexV1(root);
    index.build();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('ranks direct mentions above import adjacency, with explicit reasons', () => {
    const candidates = recallFiles(index, {
      intent: 'ToolGateway must validate ToolInvocation before use',
      activeFiles: ['src/agent-loop.ts'],
      limit: 5,
    });
    expect(candidates.length).toBeGreaterThan(0);
    const top = candidates[0];
    expect(top.path).toBe('src/tool-gateway.ts');
    expect(top.reasons).toEqual(
      expect.arrayContaining(['imported by the active file src/agent-loop.ts'])
    );
    // The intent names ToolGateway, whose definition lives here.
    expect(top.reasons.some(reason => reason.startsWith('defines symbol'))).toBe(true);
    expect(top.score).toBeGreaterThan(candidates[candidates.length - 1].score);
  });

  test('test files pair with their source counterparts', () => {
    const candidates = recallFiles(index, {
      intent: 'agent loop regression',
      activeFiles: ['tests/agent-loop.test.ts'],
      limit: 5,
    });
    const source = candidates.find(candidate => candidate.path === 'src/agent-loop.ts');
    expect(source).toBeDefined();
    expect(source?.reasons).toContain('imported by the active file tests/agent-loop.test.ts');
    expect(source?.reasons).toContain('paired with tests/agent-loop.test.ts');
  });

  test('budget selection deduplicates directories and keeps user-pinned files', () => {
    const candidates = recallFiles(index, {
      intent: 'everything',
      activeFiles: ['tests/agent-loop.test.ts'],
      limit: 50,
    });
    const selected = selectWithinBudget(candidates, {
      activeFiles: ['tests/agent-loop.test.ts'],
      maxFiles: 3,
      maxPerDirectory: 1,
    });
    expect(selected.length).toBeLessThanOrEqual(3);
    // The user-pinned active file survives selection even if unranked.
    expect(selected.some(candidate => candidate.path === 'tests/agent-loop.test.ts')).toBe(true);
    const perDirectory = new Map<string, number>();
    for (const candidate of selected) {
      if (candidate.path === 'tests/agent-loop.test.ts') continue; // pinned bypasses the cap
      const directory = candidate.path.split('/').slice(0, -1).join('/');
      const count = (perDirectory.get(directory) ?? 0) + 1;
      perDirectory.set(directory, count);
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  test('Recall@2 on the annotated fixture task keeps the relevant files', () => {
    // Annotated task: the intent names symbols defined in BOTH relevant files
    // (ToolGateway in src/tool-gateway.ts; AgentLoop in src/agent-loop.ts).
    const candidates = recallFiles(index, {
      intent: 'AgentLoop delegates validation to ToolGateway and ToolInvocation',
      activeFiles: [],
      limit: 2,
    });
    const paths = candidates.map(candidate => candidate.path);
    expect(paths).toContain('src/tool-gateway.ts');
    expect(paths).toContain('src/agent-loop.ts');
  });

  test('the integration flag defaults to off', () => {
    expect(isRepoIntelligenceEnabled({})).toBe(false);
    expect(isRepoIntelligenceEnabled({ ORION_CODE_REPO_INTELLIGENCE: 'on' })).toBe(true);
  });
});
