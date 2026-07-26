/**
 * v0.2.23 Slice 5 — Tool Detail Repository tests.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FileToolDetailRepository,
} from '../src/runtime/tool-detail-repository';

describe('ToolDetailRepository', () => {
  const repo = new FileToolDetailRepository();
  let projectDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    origConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const base = join(tmpdir(), `openhorse-detail-${randomUUID().slice(0, 8)}`);
    process.env.ORION_CODE_CONFIG_DIR = base;
    mkdirSync(base, { recursive: true });
    projectDir = join(base, 'test-project');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(base, 'projects'), { recursive: true });
  });

  afterEach(() => {
    if (origConfigDir !== undefined) {
      process.env.ORION_CODE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.ORION_CODE_CONFIG_DIR;
    }
    try { rmSync(process.env.ORION_CODE_CONFIG_DIR ?? '', { recursive: true, force: true }); } catch {}
  });

  describe('read()', () => {
    it('returns detail unavailable when artifact is missing', async () => {
      const page = await repo.read(
        { callId: 'call_1', sequence: 1, outputBytes: 100 },
        { offsetBytes: 0, limitBytes: 1024 },
        projectDir,
      );
      expect(page.content).toBe('detail unavailable');
    });

    it('returns content from file on disk when available', async () => {
      // Create a mock artifact directory matching what getProjectArtifactsDir resolves to.
      const encodedDir = join(process.env.ORION_CODE_CONFIG_DIR!, 'projects');
      // Use getProjectArtifactsDir from config-dir to find the correct path.
      const { getProjectArtifactsDir } = require('../src/services/config-dir');
      const artifactDir = getProjectArtifactsDir(projectDir);
      mkdirSync(artifactDir, { recursive: true });

      const content = 'Hello from artifact file!';
      writeFileSync(join(artifactDir, 'test-1-abc.txt'), content, 'utf8');

      const page = await repo.read(
        { callId: 'call_1', sequence: 1, artifactId: 'test-1-abc', outputBytes: content.length },
        { offsetBytes: 0, limitBytes: 1024 },
        projectDir,
      );
      expect(page.content).toBe(content);
      expect(page.totalBytes).toBe(content.length);
      expect(page.nextOffsetBytes).toBeUndefined();
    });

    it('supports paginated reads with offset', async () => {
      const { getProjectArtifactsDir } = require('../src/services/config-dir');
      const artifactDir = getProjectArtifactsDir(projectDir);
      mkdirSync(artifactDir, { recursive: true });

      const content = '0123456789ABCDEF';
      writeFileSync(join(artifactDir, 'test-pg-abc.txt'), content, 'utf8');

      // Read first 5 bytes.
      const page1 = await repo.read(
        { callId: 'call_1', sequence: 1, artifactId: 'test-pg-abc', outputBytes: content.length },
        { offsetBytes: 0, limitBytes: 5 },
        projectDir,
      );
      expect(page1.content).toBe('01234');
      expect(page1.nextOffsetBytes).toBe(5);

      // Read next 5 bytes.
      const page2 = await repo.read(
        { callId: 'call_1', sequence: 1, artifactId: 'test-pg-abc', outputBytes: content.length },
        { offsetBytes: 5, limitBytes: 5 },
        projectDir,
      );
      expect(page2.content).toBe('56789');
      expect(page2.nextOffsetBytes).toBe(10);
    });
  });

  describe('list()', () => {
    it('returns empty list for project with no artifacts', async () => {
      const summaries = await repo.list(projectDir);
      expect(Array.isArray(summaries)).toBe(true);
      expect(summaries).toHaveLength(0);
    });
  });
});