/**
 * v0.1.3 功能测试
 *
 * 测试：
 * - Session 存储 tool_calls
 * - Memory 项目维度路径
 * - history_search 工具
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import {
  createSession,
  appendSessionMessage,
  appendSessionMessages,
  readSessionMessages,
  loadSessionHistory,
  saveSessionMeta,
  loadSessionMeta,
  updateSessionSummary,
  endSession,
  type SessionMessage,
  type ToolCallRecord,
} from '../src/services/session-storage';
import {
  getProjectHash,
  getMemoryDir,
  getLegacyMemoryDir,
  ensureMemoryDir,
  saveMemory,
  loadAllMemories,
  searchMemories,
  loadMemory,
  deleteMemory,
} from '../src/memory/storage';
import type { MemoryEntry } from '../src/memory/types';
import { TOOLS, executeTool } from '../src/tools';

// ============================================================================
// 测试环境设置
// ============================================================================

const TEST_DIR = join(tmpdir(), 'openhorse-v0.1.3-test');
const PROJECT_A = join(TEST_DIR, 'project-a');
const PROJECT_B = join(TEST_DIR, 'project-b');

function setupTestEnv() {
  // Clean up
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(PROJECT_A, { recursive: true });
  mkdirSync(PROJECT_B, { recursive: true });
}

function teardownTestEnv() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// ============================================================================
// Session tool_calls 测试
// ============================================================================

describe('Session tool_calls storage', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  test('SessionMessage stores tool_calls with complete structure', () => {
    const toolCalls: ToolCallRecord[] = [
      {
        id: 'call_abc123',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"/src/cli.ts"}',
        },
      },
    ];

    const msg: SessionMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      tool_calls: toolCalls,
    };

    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0].function.name).toBe('read_file');
    expect(msg.tool_calls![0].function.arguments).toBe(JSON.stringify({ path: '/src/cli.ts' }));
  });

  test('loadSessionHistory returns complete Message format with tool_calls', () => {
    const session = createSession(PROJECT_A, 'gpt-4o');

    // Store assistant message with tool_calls
    const toolCallMsg: SessionMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      tool_calls: [
        {
          id: 'call_test',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: '{"path":"test.ts","content":"hello"}',
          },
        },
      ],
    };
    appendSessionMessage(session.id, toolCallMsg);

    // Store tool result
    const toolResultMsg: SessionMessage = {
      role: 'tool',
      content: '{"success":true}',
      timestamp: Date.now(),
      toolCallId: 'call_test',
    };
    appendSessionMessage(session.id, toolResultMsg);

    // Load and verify
    const history = loadSessionHistory(session.id);
    expect(history).toHaveLength(2);

    // First message should have tool_calls
    const first = history[0];
    expect(first.role).toBe('assistant');
    expect(first.tool_calls).toBeDefined();
    expect(first.tool_calls![0].function.name).toBe('write_file');

    // Second message should have tool_call_id
    const second = history[1];
    expect(second.role).toBe('tool');
    expect(second.tool_call_id).toBe('call_test');
  });
});

// ============================================================================
// Memory 项目维度测试
// ============================================================================

describe('Memory project dimension', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  test('getProjectHash produces consistent 16-char hash', () => {
    const hashA = getProjectHash(PROJECT_A);
    const hashB = getProjectHash(PROJECT_B);

    expect(hashA).toHaveLength(16);
    expect(hashB).toHaveLength(16);
    expect(hashA).not.toBe(hashB);

    // Same path produces same hash
    const hashA2 = getProjectHash(PROJECT_A);
    expect(hashA).toBe(hashA2);
  });

  test('getMemoryDir returns project-specific path', () => {
    const dirA = getMemoryDir(PROJECT_A);
    const dirB = getMemoryDir(PROJECT_B);
    const legacyDirA = getLegacyMemoryDir(PROJECT_A);
    const dirGlobal = getMemoryDir(); // No project = global

    expect(dirA).toContain('projects');
    expect(dirA).toContain('project-a');
    expect(legacyDirA).toContain(getProjectHash(PROJECT_A));
    expect(dirA).not.toBe(dirB);
    expect(dirA).not.toBe(legacyDirA);

    // Global path should be different structure
    expect(dirGlobal).not.toContain('projects');
  });

  test('saveMemory stores in project-specific directory', () => {
    const entry: MemoryEntry = {
      name: 'test-memory',
      type: 'project',
      description: 'Test memory',
      content: 'This is a test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveMemory(entry, PROJECT_A);

    const dirA = getMemoryDir(PROJECT_A);
    const filePath = join(dirA, 'test-memory.md');

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('type: project');
    expect(content).toContain('This is a test');
  });

  test('loadAllMemories returns only project-specific memories', () => {
    // Use unique names to avoid collision with previous test
    const entryA: MemoryEntry = {
      name: 'unique-memory-a',
      type: 'user',
      description: 'Memory for A',
      content: 'Project A specific',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveMemory(entryA, PROJECT_A);

    // Save memory in project B
    const entryB: MemoryEntry = {
      name: 'unique-memory-b',
      type: 'user',
      description: 'Memory for B',
      content: 'Project B specific',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveMemory(entryB, PROJECT_B);

    // Load from A and find our specific memory
    const memoriesA = loadAllMemories(PROJECT_A);
    const ourMemoryA = memoriesA.find(m => m.name === 'unique-memory-a');
    expect(ourMemoryA).toBeDefined();
    expect(ourMemoryA!.content).toBe('Project A specific');

    // Load from B
    const memoriesB = loadAllMemories(PROJECT_B);
    const ourMemoryB = memoriesB.find(m => m.name === 'unique-memory-b');
    expect(ourMemoryB).toBeDefined();
    expect(ourMemoryB!.content).toBe('Project B specific');

    // A's memory not in B
    const memoryAinB = loadMemory('unique-memory-a', PROJECT_B);
    expect(memoryAinB).toBeNull();
  });

  test('loadAllMemories reads legacy hash memory and canonical overrides same name', () => {
    const memoryName = `shared-memory-${Date.now()}`;
    const legacyDir = getLegacyMemoryDir(PROJECT_A);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, `${memoryName}.md`), `---
name: ${memoryName}
description: Legacy memory
type: project
---

Legacy content`, 'utf-8');

    let memories = loadAllMemories(PROJECT_A);
    expect(memories.find(m => m.name === memoryName)?.content).toBe('Legacy content');

    saveMemory({
      name: memoryName,
      type: 'project',
      description: 'Canonical memory',
      content: 'Canonical content',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, PROJECT_A);

    memories = loadAllMemories(PROJECT_A);
    const shared = memories.filter(m => m.name === memoryName);
    expect(shared).toHaveLength(1);
    expect(shared[0].content).toBe('Canonical content');
  });

  test('deleteMemory preserves legacy when canonical same-name memory exists', () => {
    const memoryName = `forget-memory-${Date.now()}`;
    const legacyDir = getLegacyMemoryDir(PROJECT_A);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, `${memoryName}.md`), `---
name: ${memoryName}
description: Legacy memory
type: project
---

Legacy content`, 'utf-8');

    saveMemory({
      name: memoryName,
      type: 'project',
      description: 'Canonical memory',
      content: 'Canonical content',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, PROJECT_A);

    deleteMemory(memoryName, PROJECT_A);

    expect(readFileSync(join(legacyDir, `${memoryName}.md`), 'utf-8')).toContain('Legacy content');
    expect(loadMemory(memoryName, PROJECT_A)?.content).toBe('Legacy content');
  });

  test('deleteMemory removes legacy when no canonical same-name memory exists', () => {
    const memoryName = `legacy-only-${Date.now()}`;
    const legacyDir = getLegacyMemoryDir(PROJECT_A);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, `${memoryName}.md`), `---
name: ${memoryName}
description: Legacy only
type: project
---

Legacy only content`, 'utf-8');

    deleteMemory(memoryName, PROJECT_A);

    expect(existsSync(join(legacyDir, `${memoryName}.md`))).toBe(false);
    expect(loadMemory(memoryName, PROJECT_A)).toBeNull();
  });

  test('searchMemories is project-scoped', () => {
    // Save memories with same keyword in different projects
    saveMemory({
      name: 'typescript-a',
      type: 'project',
      description: 'TS config for A',
      content: 'Project A uses TypeScript',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, PROJECT_A);

    saveMemory({
      name: 'typescript-b',
      type: 'project',
      description: 'TS config for B',
      content: 'Project B uses TypeScript too',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, PROJECT_B);

    // Search for "typescript" in A
    const resultsA = searchMemories('typescript', PROJECT_A);
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].name).toBe('typescript-a');

    // Search in B
    const resultsB = searchMemories('typescript', PROJECT_B);
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].name).toBe('typescript-b');
  });
});

// ============================================================================
// history_search 工具测试
// ============================================================================

describe('history_search tool', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  test('history_search tool exists in TOOLS', () => {
    const tool = TOOLS.find(t => t.name === 'history_search');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('Search previous tool operations');
  });

  test('history_search requires query parameter', async () => {
    const result = await executeTool('history_search', {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('requires a query parameter');
  });

  test('history_search finds matching tool calls', async () => {
    // Create session with tool history
    const session = createSession(PROJECT_A, 'gpt-4o');

    // Add assistant message with tool_call
    appendSessionMessage(session.id, {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"src/main.ts"}',
          },
        },
      ],
    });

    // Add tool result
    appendSessionMessage(session.id, {
      role: 'tool',
      content: '{"success":true,"output":"file content"}',
      timestamp: Date.now(),
      toolCallId: 'call_read',
    });

    // Search for "read_file"
    const result = await executeTool('history_search', { query: 'read_file' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toContain('read_file');
    expect(parsed.output).toContain('src/main.ts');
  });
});

// ============================================================================
// Session summary 测试
// ============================================================================

describe('Session summary', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  test('updateSessionSummary extracts tools and files', () => {
    const session = createSession(PROJECT_A, 'gpt-4o');

    // Add messages with tool calls
    appendSessionMessage(session.id, {
      role: 'user',
      content: '读取 src/main.ts 并修改 src/config.ts',
      timestamp: Date.now(),
    });

    appendSessionMessage(session.id, {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"src/main.ts"}',
          },
        },
        {
          id: 'call_edit',
          type: 'function',
          function: {
            name: 'edit_file',
            arguments: '{"path":"src/config.ts","old_string":"old","new_string":"new"}',
          },
        },
      ],
    });

    appendSessionMessage(session.id, {
      role: 'tool',
      content: '{"success":true}',
      timestamp: Date.now(),
      toolCallId: 'call_read',
    });

    appendSessionMessage(session.id, {
      role: 'tool',
      content: '{"success":true}',
      timestamp: Date.now(),
      toolCallId: 'call_edit',
    });

    // Update summary
    const messages = readSessionMessages(session.id);
    updateSessionSummary(session.id, messages);

    // Verify summary was saved
    const updatedSession = loadSessionMeta(session.id);
    expect(updatedSession).not.toBeNull();
    expect(updatedSession!.taskSummary).toBe('读取 src/main.ts 并修改 src/config.ts');
    expect(updatedSession!.toolsUsed).toContain('read_file');
    expect(updatedSession!.toolsUsed).toContain('edit_file');
    expect(updatedSession!.filesModified).toContain('src/config.ts');
    // read_file should not be in filesModified
    expect(updatedSession!.filesModified).not.toContain('src/main.ts');
  });

  test('endSession sets endTime', () => {
    const session = createSession(PROJECT_A, 'gpt-4o');
    expect(session.endTime).toBeUndefined();

    endSession(session.id);

    const updatedSession = loadSessionMeta(session.id);
    expect(updatedSession!.endTime).toBeDefined();
    expect(updatedSession!.endTime).toBeGreaterThanOrEqual(session.startTime);
  });
});
