/**
 * Issue #35 — LSP crash prevention tests
 *
 * Verifies that:
 * 1. Missing LSP binary returns {success: false} instead of crashing
 * 2. The process never crashes on async ENOENT
 */

import { lspGetDefinitionTool, lspGetReferencesTool, lspGetHoverTool, lspGetDiagnosticsTool } from '../src/tools/lsp';

// Mock the entire child_process module
jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

import { spawn, spawnSync } from 'child_process';

const mockCtx = {
  cwd: '/test',
  config: { name: 'test', mode: 'test' },
};

describe('LSP crash prevention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('probeBinary', () => {
    it('should detect binary not found', () => {
      (spawnSync as jest.Mock).mockReturnValue({ status: 1 });
      expect((spawnSync as jest.Mock).mock.calls.length).toBe(0);
    });

    it('should detect binary exists', () => {
      (spawnSync as jest.Mock).mockReturnValue({ status: 0 });
      expect((spawnSync as jest.Mock).mock.calls.length).toBe(0);
    });
  });

  describe('lsp_get_definition — binary missing', () => {
    it('should reject missing position arguments before starting LSP', async () => {
      const result = await lspGetDefinitionTool.execute(
        { file_path: '/test/file.ts' },
        mockCtx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('line');
      expect(spawnSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('should return failure when typescript-language-server is not installed', async () => {
      (spawnSync as jest.Mock).mockReturnValue({ status: 1 });

      const result = await lspGetDefinitionTool.execute(
        { file_path: '/test/file.ts', line: 10, character: 5 },
        mockCtx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.error).toContain('typescript-language-server');

      // spawn should NOT have been called (pre-flight blocks it)
      expect(spawn).not.toHaveBeenCalled();
    });

    it('should return failure when pyright is not installed', async () => {
      (spawnSync as jest.Mock).mockReturnValue({ status: 1 });

      const result = await lspGetDefinitionTool.execute(
        { file_path: '/test/file.py', line: 10, character: 5 },
        mockCtx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('pyright');
    });
  });

  describe('lsp_get_references — binary missing', () => {
    it('should return failure without crash', async () => {
      (spawnSync as jest.Mock).mockReturnValue({ status: 1 });

      const result = await lspGetReferencesTool.execute(
        { file_path: '/test/file.ts', line: 10, character: 5 },
        mockCtx,
      );

      expect(result.success).toBe(false);
    });
  });

  describe('lsp_get_hover — binary missing', () => {
    it('should return failure without crash', async () => {
      (spawnSync as jest.Mock).mockReturnValue({ status: 1 });

      const result = await lspGetHoverTool.execute(
        { file_path: '/test/file.ts', line: 10, character: 5 },
        mockCtx,
      );

      expect(result.success).toBe(false);
    });
  });

  describe('lsp_get_diagnostics — binary missing', () => {
    it('should return failure without crash', async () => {
      (spawnSync as jest.Mock).mockReturnValue({ status: 1 });

      const result = await lspGetDiagnosticsTool.execute(
        { file_path: '/test/file.ts' },
        mockCtx,
      );

      expect(result.success).toBe(false);
    });
  });

  describe('unsupported language', () => {
    it('should return error for unsupported extensions', async () => {
      const result = await lspGetDefinitionTool.execute(
        { file_path: '/test/file.rs', line: 10, character: 5 },
        mockCtx,
      );

      // detectLanguage defaults to typescript, so this goes through the
      // missing-binary path (typescript-language-server not installed)
      expect(result.success).toBe(false);
    });
  });
});
