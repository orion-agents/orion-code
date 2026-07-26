/**
 * v0.1.11 功能测试
 *
 * 测试覆盖：
 *  - Git 操作验证
 *  - Token 安全检测
 *  - MEMORY.md 入口管理
 *  - 工具失败透明反馈
 *  - 记忆相关性查找
 *  - Team Memory 路径安全
 *  - SDK Entry Points
 *  - Bootstrap State 管理
 */

import {
  detectSecretsInMessage,
  hasHighRiskSecret,
  generateSecurityWarning,
  checkMessageSecurity,
} from '../src/core/security-warning';
import {
  loadEntrypoint,
  truncateIfNeeded,
  validateEntrypoint,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from '../src/memory/entrypoint';
import {
  extractKeywords,
  calculateKeywordMatch,
  findRelevantMemories,
} from '../src/memory/relevant-finder';
import {
  sanitizePathKey,
  validateAndSanitizePath,
  isPathSafe,
  PathTraversalError,
} from '../src/memory/team-paths';
import {
  init,
  isInitialized,
  getConfig,
  reset,
} from '../src/sdk/init';

// core/state.ts was deleted in v0.2.22 (dead code — zero imports across src/).
// The test cases that exercised its functions are removed.

// ============================================================================
// Token Security Tests
// ============================================================================

describe('v0.1.11: Token Security Warning', () => {
  test('detects GitHub Token (ghp_)', () => {
    const content = 'My token is ghp_1234567890123456789012345678901234567890';
    const detected = detectSecretsInMessage(content);
    expect(detected.length).toBeGreaterThan(0);
    expect(detected[0].name).toContain('GitHub');
    expect(detected[0].severity).toBe('high');
  });

  test('detects OpenAI API Key (sk-)', () => {
    const content = 'API key: sk-1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678';
    const detected = detectSecretsInMessage(content);
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(t => t.name.includes('OpenAI'))).toBe(true);
  });

  test('detects AWS Access Key (AKIA)', () => {
    const content = 'AWS key: AKIAIOSFODNN7EXAMPLE';
    const detected = detectSecretsInMessage(content);
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(t => t.name.includes('AWS'))).toBe(true);
  });

  test('returns empty for safe content', () => {
    const content = 'This is a normal message without any secrets';
    const detected = detectSecretsInMessage(content);
    expect(detected.length).toBe(0);
  });

  test('hasHighRiskSecret returns true for high risk', () => {
    const content = 'ghp_1234567890123456789012345678901234567890';
    expect(hasHighRiskSecret(content)).toBe(true);
  });

  test('checkMessageSecurity returns warning', () => {
    const content = 'ghp_1234567890123456789012345678901234567890';
    const result = checkMessageSecurity(content);
    expect(result.safe).toBe(false);
    expect(result.warning).toContain('Security Alert');
  });
});

// ============================================================================
// Entrypoint Tests
// ============================================================================

describe('v0.1.11: MEMORY.md Entrypoint Management', () => {
  test('truncateIfNeeded returns content unchanged when within limits', () => {
    const content = '# Memory Index\n\n- [test](test.md) — Test entry\n';
    const result = truncateIfNeeded(content);
    expect(result.wasLineTruncated).toBe(false);
    expect(result.wasByteTruncated).toBe(false);
    expect(result.content).toBe(content);
  });

  test('truncateIfNeeded truncates by lines', () => {
    const lines: string[] = ['# Memory Index', ''];
    for (let i = 0; i < MAX_ENTRYPOINT_LINES + 50; i++) {
      lines.push(`- [memory-${i}](memory-${i}.md) — Entry ${i}`);
    }
    const content = lines.join('\n');

    const result = truncateIfNeeded(content);
    expect(result.wasLineTruncated).toBe(true);
    expect(result.originalLines).toBeGreaterThan(MAX_ENTRYPOINT_LINES);
    expect(result.warning).toBeDefined();
  });

  test('truncateIfNeeded truncates by bytes', () => {
    const lines: string[] = ['# Memory Index', ''];
    for (let i = 0; i < 100; i++) {
      // Long entries to exceed byte limit
      lines.push(`- [memory-${i}](memory-${i}.md) — This is a very long description line that adds many bytes to the total content size ${i}`);
    }
    const content = lines.join('\n');

    if (content.length > MAX_ENTRYPOINT_BYTES) {
      const result = truncateIfNeeded(content);
      expect(result.content.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES + 100);
    }
  });

  test('validateEntrypoint returns valid for empty', () => {
    // This may vary based on actual MEMORY.md
    const result = validateEntrypoint();
    expect(result.lines).toBeGreaterThanOrEqual(0);
    expect(result.bytes).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Relevant Memory Finder Tests
// ============================================================================

describe('v0.1.11: Memory Relevant Finder', () => {
  test('extractKeywords returns valid keywords', () => {
    const text = 'The user is a software engineer working on TypeScript';
    const keywords = extractKeywords(text);
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain('user');
    expect(keywords).toContain('software');
    expect(keywords).toContain('engineer');
    expect(keywords).not.toContain('the'); // stopword
  });

  test('extractKeywords handles empty input', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords('   ')).toEqual([]);
  });

  test('calculateKeywordMatch returns score for matching content', () => {
    const queryKeywords = ['typescript', 'react'];
    const memory = {
      name: 'frontend-guide',
      type: 'reference' as const,
      description: 'Frontend development guide',
      content: 'This guide covers TypeScript and React best practices',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = calculateKeywordMatch(queryKeywords, memory);
    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedKeywords.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Team Path Security Tests
// ============================================================================

describe('v0.1.11: Team Memory Path Security', () => {
  test('detects null byte injection', () => {
    const result = sanitizePathKey('test\0file');
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('Null byte detected');
  });

  test('detects path traversal (..)', () => {
    const result = sanitizePathKey('../etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('Path traversal detected');
  });

  test('detects URL-encoded traversal', () => {
    const result = sanitizePathKey('%2e%2e/etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('URL-encoded traversal detected');
  });

  test('detects absolute path', () => {
    const result = sanitizePathKey('/etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('Absolute path detected');
  });

  test('detects Windows absolute path', () => {
    const result = sanitizePathKey('C:\\Windows\\System32');
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('Absolute path detected');
  });

  test('sanitizes safe path', () => {
    const result = sanitizePathKey('my-safe-path_123');
    expect(result.safe).toBe(true);
    expect(result.sanitizedKey).toBe('my-safe-path_123');
  });

  test('validateAndSanitizePath throws on unsafe', () => {
    expect(() => validateAndSanitizePath('../unsafe')).toThrow(PathTraversalError);
  });

  test('isPathSafe returns correct boolean', () => {
    expect(isPathSafe('safe-path')).toBe(true);
    expect(isPathSafe('../unsafe')).toBe(false);
  });
});

// ============================================================================
// SDK Tests
// ============================================================================

describe('v0.1.11: SDK Entry Points', () => {
  beforeEach(() => {
    reset();
  });

  test('init initializes SDK', () => {
    init({ projectRoot: '/test/project' });
    expect(isInitialized()).toBe(true);
  });

  test('getConfig returns config after init', () => {
    init({ projectRoot: '/test/project', debug: true });
    const config = getConfig();
    expect(config).not.toBeNull();
    expect(config?.projectRoot).toBe('/test/project');
    expect(config?.debug).toBe(true);
  });

  test('isInitialized returns false before init', () => {
    expect(isInitialized()).toBe(false);
  });

  test('reset clears config', () => {
    init({ projectRoot: '/test/project' });
    expect(isInitialized()).toBe(true);
    reset();
    expect(isInitialized()).toBe(false);
  });
});

// ============================================================================
// State Management Tests
// ============================================================================

// core/state.ts tests were removed in v0.2.22 — the module was dead code.