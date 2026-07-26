import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createContextCapsule,
  createContextHarness,
  createTaskContract,
  upgradeHarnessState,
} from '../src/harness';
import { TOOLS } from '../src/tools';

const readFileTool = TOOLS.find(tool => tool.name === 'read_file');
const toolContext = {
  cwd: process.cwd(),
  config: { name: 'orion-code', mode: 'development' },
};

describe('session loop regressions', () => {
  describe('read_file pagination', () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'openhorse-read-offset-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('advertises and honors a one-based line offset', async () => {
      expect(readFileTool).toBeDefined();
      expect(readFileTool?.parameters.properties.offset).toBeDefined();

      const file = join(directory, 'lines.txt');
      writeFileSync(file, ['line-1', 'line-2', 'line-3', 'line-4', 'line-5'].join('\n'));

      const result = await readFileTool!.execute(
        { path: file, offset: 3, maxLines: 2 },
        toolContext
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('line-3\nline-4');
      expect(result.output).not.toContain('line-1');
    });

    it('returns a clear error when the offset is beyond the file', async () => {
      const file = join(directory, 'short.txt');
      writeFileSync(file, 'first\nsecond');

      const result = await readFileTool!.execute(
        { path: file, offset: 9, maxLines: 2 },
        toolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('offset 9');
      expect(result.error).toContain('2 lines');
    });
  });

  describe('Harness contract normalization', () => {
    it('does not turn section headings into success criteria', () => {
      const contract = createTaskContract(
        [
          '迁移 OpenHorse session 存储目录。',
          '验证要求：',
          '- 验证 session ID 和消息数量。',
          '写入要求：',
          '- 必须原子写入。',
        ].join('\n'),
        '/repo'
      );

      expect(contract.successCriteria).toContain('验证 session ID 和消息数量。');
      expect(contract.successCriteria).not.toContain('验证要求：');
      expect(contract.requirements).not.toContain('写入要求：');
    });

    it('prefers an explicit target section over a damaged leading fragment', () => {
      const contract = createTaskContract(
        [
          'l 目录，则标记为待迁移。',
          '其他说明。',
          '目标：',
          '将旧 session 迁移到 canonical 项目目录。',
        ].join('\n'),
        '/repo'
      );

      expect(contract.objective).toBe('将旧 session 迁移到 canonical 项目目录。');
    });

    it('keeps examples that complete a multiline target section', () => {
      const contract = createTaskContract(
        [
          'broken leading fragment',
          '目标：',
          '将旧目录，例如：',
          '',
          'Users-hope/',
          '迁移到 canonical 目录，例如：',
          'Users-hope-8df1b23f/',
          '执行要求：',
          '必须先备份。',
        ].join('\n'),
        '/repo'
      );

      expect(contract.objective).toBe(
        '将旧目录，例如： Users-hope/ 迁移到 canonical 目录，例如： Users-hope-8df1b23f/'
      );
    });

    it('does not persist operational follow-ups as permanent open todos', () => {
      const harness = createContextHarness({ cwd: '/repo', modelId: 'test-model' });
      harness.updateContractFromUserInput(
        ['迁移 OpenHorse session 存储目录。', '验证要求：', '- 验证 session ID 和消息数量。'].join(
          '\n'
        )
      );

      harness.updateContractFromUserInput('继续');
      harness.updateContractFromUserInput('push下改动');
      harness.updateContractFromUserInput('刚刚我们做了什么事情');

      const contract = harness.getContract();
      const capsule = harness.getCapsule();
      expect(contract?.successCriteria).not.toContain('Address the objective: 继续');
      expect(contract?.successCriteria).not.toContain('Address the objective: push下改动');
      expect(contract?.successCriteria).not.toContain(
        'Address the objective: 刚刚我们做了什么事情'
      );
      expect(capsule?.openTodos).toEqual([]);
      expect(capsule?.nextAction).not.toBe('验证要求：');
      expect(capsule?.nextAction).toContain('刚刚我们做了什么事情');
    });

    it('normalizes stale persisted criteria and capsule todos on resume', () => {
      const contract = createTaskContract('迁移 session，必须验证结果。', '/repo');
      const pollutedContract = {
        ...contract,
        successCriteria: [
          '验证要求：',
          '必须验证结果。',
          'Address the objective: 继续',
          'Address the objective: push下改动',
        ],
        userIntent: '刚刚我们做了什么事情',
      };
      const capsule = createContextCapsule(pollutedContract, []);
      const restored = upgradeHarnessState(
        {
          version: 2,
          contract: pollutedContract,
          capsule: {
            ...capsule,
            openTodos: pollutedContract.successCriteria,
            nextAction: '验证要求：',
          },
          ledger: [],
          rootObjective: 'l 目录，则标记为待迁移。',
          activeInstruction: '刚刚我们做了什么事情',
          diagnostics: [
            'latest transcript user message differs from active instruction; using stored active instruction',
          ],
          updatedAt: Date.now(),
        },
        {
          cwd: '/repo',
          messages: [
            {
              role: 'user',
              content: [
                'l 目录，则标记为待迁移。',
                '目标：',
                '将旧 session 迁移到 canonical 项目目录。',
              ].join('\n'),
            },
            { role: 'user', content: '刚刚我们做了什么事情' },
          ],
        }
      );

      expect(restored.contract?.successCriteria).toEqual(['必须验证结果。']);
      expect(restored.rootObjective).toBe('将旧 session 迁移到 canonical 项目目录。');
      expect(restored.capsule?.openTodos).toEqual([]);
      expect(restored.capsule?.nextAction).toContain('刚刚我们做了什么事情');
      expect(restored.diagnostics).not.toContain(
        'latest transcript user message differs from active instruction; using stored active instruction'
      );
      expect(restored.diagnostics).not.toContain(
        'root objective does not exactly match the first transcript user message; preserving harness root objective'
      );
    });
  });
});
