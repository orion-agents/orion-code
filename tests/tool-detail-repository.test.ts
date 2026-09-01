/**
 * v0.2.23 Slice 5 — Tool Detail Repository tests.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileToolDetailRepository } from '../src/runtime/tool-detail-repository';
import { TOOL_ARTIFACT_WEB_SAFE_SUFFIX } from '../src/core/tool-artifacts';
import { redactTraceText } from '../src/services/redaction';

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
    try {
      rmSync(process.env.ORION_CODE_CONFIG_DIR ?? '', { recursive: true, force: true });
    } catch {}
  });

  describe('read()', () => {
    it('returns detail unavailable when artifact is missing', async () => {
      const page = await repo.read(
        { callId: 'call_1', sequence: 1, outputBytes: 100 },
        { offsetBytes: 0, limitBytes: 1024 },
        projectDir
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
      writeFileSync(
        join(artifactDir, `test-1-abc.txt${TOOL_ARTIFACT_WEB_SAFE_SUFFIX}`),
        redactTraceText(content),
        'utf8'
      );

      const page = await repo.read(
        { callId: 'call_1', sequence: 1, artifactId: 'test-1-abc', outputBytes: content.length },
        { offsetBytes: 0, limitBytes: 1024 },
        projectDir
      );
      expect(page.content).toBe(content);
      expect(page.totalBytes).toBe(content.length);
      expect(page.nextOffsetBytes).toBeUndefined();
      expect(page.redacted).toBe(true);
    });

    it('supports paginated reads with offset', async () => {
      const { getProjectArtifactsDir } = require('../src/services/config-dir');
      const artifactDir = getProjectArtifactsDir(projectDir);
      mkdirSync(artifactDir, { recursive: true });

      const content = '0123456789ABCDEF';
      writeFileSync(join(artifactDir, 'test-pg-abc.txt'), content, 'utf8');
      writeFileSync(
        join(artifactDir, `test-pg-abc.txt${TOOL_ARTIFACT_WEB_SAFE_SUFFIX}`),
        redactTraceText(content),
        'utf8'
      );

      // Read first 5 bytes.
      const page1 = await repo.read(
        { callId: 'call_1', sequence: 1, artifactId: 'test-pg-abc', outputBytes: content.length },
        { offsetBytes: 0, limitBytes: 5 },
        projectDir
      );
      expect(page1.content).toBe('01234');
      expect(page1.nextOffsetBytes).toBe(5);

      // Read next 5 bytes.
      const page2 = await repo.read(
        { callId: 'call_1', sequence: 1, artifactId: 'test-pg-abc', outputBytes: content.length },
        { offsetBytes: 5, limitBytes: 5 },
        projectDir
      );
      expect(page2.content).toBe('56789');
      expect(page2.nextOffsetBytes).toBe(10);
    });

    it('fails closed for legacy raw artifacts without a browser-safe derivative', async () => {
      const { getProjectArtifactsDir } = require('../src/services/config-dir');
      const artifactDir = getProjectArtifactsDir(projectDir);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'legacy-raw.txt'), 'token=OPAQUE_LEGACY_SECRET', 'utf8');

      const page = await repo.read(
        {
          callId: 'call_legacy',
          sequence: 1,
          artifactId: 'legacy-raw',
          outputBytes: 26,
        },
        { offsetBytes: 6, limitBytes: 1024 },
        projectDir
      );

      expect(page.content).toBe('detail unavailable');
      expect(page.content).not.toContain('OPAQUE_LEGACY_SECRET');
    });

    it('never exposes a secret through arbitrary offsets into the safe derivative', async () => {
      const { getProjectArtifactsDir } = require('../src/services/config-dir');
      const artifactDir = getProjectArtifactsDir(projectDir);
      mkdirSync(artifactDir, { recursive: true });
      const marker = 'OPAQUE_TOOL_DETAIL_7NQ4';
      const raw = `prefix token=${marker} suffix`;
      const safe = redactTraceText(raw);
      writeFileSync(join(artifactDir, 'secret-page.txt'), raw, 'utf8');
      writeFileSync(
        join(artifactDir, `secret-page.txt${TOOL_ARTIFACT_WEB_SAFE_SUFFIX}`),
        safe,
        'utf8'
      );

      for (let offsetBytes = 0; offsetBytes <= Buffer.byteLength(safe); offsetBytes += 1) {
        const page = await repo.read(
          {
            callId: 'call_secret',
            sequence: 1,
            artifactId: 'secret-page',
            outputBytes: Buffer.byteLength(raw),
          },
          { offsetBytes, limitBytes: 3 },
          projectDir
        );
        expect(page.content).not.toContain(marker);
      }
    });

    it('refuses a browser-safe derivative that is a symbolic link', async () => {
      const { getProjectArtifactsDir } = require('../src/services/config-dir');
      const artifactDir = getProjectArtifactsDir(projectDir);
      mkdirSync(artifactDir, { recursive: true });
      const outside = join(process.env.ORION_CODE_CONFIG_DIR!, 'outside-secret.txt');
      writeFileSync(outside, 'OPAQUE_SYMLINK_SECRET', 'utf8');
      writeFileSync(join(artifactDir, 'linked.txt'), 'raw artifact', 'utf8');
      symlinkSync(outside, join(artifactDir, `linked.txt${TOOL_ARTIFACT_WEB_SAFE_SUFFIX}`));

      const page = await repo.read(
        {
          callId: 'call_linked',
          sequence: 1,
          artifactId: 'linked',
          outputBytes: 12,
        },
        { offsetBytes: 0, limitBytes: 1024 },
        projectDir
      );

      expect(page.content).toBe('detail unavailable');
      expect(page.content).not.toContain('OPAQUE_SYMLINK_SECRET');
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
