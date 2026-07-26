/**
 * orion code - 工具集
 *
 * 定义 Agent 可用的工具（Tool System v2）：
 *   - read_file: 读取文件内容
 *   - write_file: 写入文件
 *   - list_files: 列出目录
 *   - exec_command: 执行 shell 命令
 *
 * 使用 buildTool() 工厂模式。
 */

import { spawn } from 'child_process';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  createReadStream,
  lstatSync,
} from 'fs';
import { join, resolve, relative } from 'path';
import { createInterface } from 'readline';
import {
  buildTool,
  type OpenHorseTool,
  type ToolResult,
  type ToolContext,
} from '../framework/tool';
import { setToolState } from '../framework/tool-state';
import { ARTIFACT_THRESHOLD, storeArtifact, truncateForContext } from '../core/tool-artifacts';
import { ENV } from '../product/environment';
import {
  saveMemory,
  loadMemory,
  loadAllMemories,
  searchMemories,
  deleteMemory,
  type MemoryEntry,
  type MemoryType,
} from '../memory';
import { getSemanticSearchService, isSemanticEnabled } from '../memory/semantic-search';
import { readSessionMessages, loadSessionMeta, listSessions } from '../services/session-storage';
import { WEB_TOOLS } from './web';
import { MCP_TOOLS, mcpManager } from './mcp';
import { TODO_TOOLS } from './todo';
import { PLAN_TOOLS } from './plan';
import { GIT_TOOLS } from './git';
import { lspTools } from './lsp';
import { GOAL_TOOLS } from '../runtime/goals/tools';
import { assessCommandSecurity, isReadOnlyCommand } from './bash_security';

const BATCH_READ_ALLOWED_TOOLS = new Set(['git_status', 'list_files', 'glob', 'grep', 'read_file']);
const BATCH_READ_MAX_STEPS = 8;
const BATCH_READ_STEP_OUTPUT_MAX_BYTES = 1600;

function compactOneLine(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 3) return compact.slice(0, maxLength);

  const headLength = Math.ceil((maxLength - 3) * 0.55);
  const tailLength = Math.floor((maxLength - 3) * 0.45);
  return `${compact.slice(0, headLength)}...${compact.slice(-tailLength)}`;
}

function summarizeFailedToolResult(result: ToolResult): string {
  const details: string[] = [];
  if (result.error) {
    details.push(compactOneLine(result.error, 80));
  }

  const output = result.output ? compactOneLine(result.output, 120) : '';
  if (output && output !== result.error) {
    details.push(`output: ${output}`);
  }

  return details.join('; ');
}

// ============================================================================
// 工具集
// ============================================================================

export const TOOLS: OpenHorseTool[] = [
  // Web tools (P0)
  ...WEB_TOOLS,

  // MCP tools (P0)
  ...MCP_TOOLS,

  // Git tools (P0 - Issue #18/#23)
  ...GIT_TOOLS,

  // LSP tools (P0 - Phase 6)
  ...lspTools,

  // Todo tools (P1)
  ...TODO_TOOLS,

  // Plan mode tools (P1)
  ...PLAN_TOOLS,

  // Goal tools (P0 - v0.2.24)
  ...GOAL_TOOLS,

  // File tools
  buildTool({
    name: 'read_file',
    description: '读取文件内容，支持从指定行开始分页。返回文件内容字符串。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（绝对路径或相对路径）',
        },
        maxLines: {
          type: 'number',
          description: '最大读取行数（可选，默认 500 行）',
        },
        offset: {
          type: 'number',
          description: '开始读取的行号（可选，1-based，默认第 1 行）',
        },
      },
      required: ['path'],
    },
    execute: async (args, context) => {
      // Ensure path is a valid string
      const path = args.path;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'read_file requires a path parameter' };
      }
      const maxLines = readPositiveInteger(args.maxLines, 'maxLines', 500);
      if (typeof maxLines === 'string') {
        return { success: false, output: '', error: maxLines };
      }
      const offset = readPositiveInteger(args.offset, 'offset', 1);
      if (typeof offset === 'string') {
        return { success: false, output: '', error: offset };
      }
      return readFileSync_(path, maxLines, offset, context.cwd);
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: args => `Read ${args.path as string}`,
    getSummary: (args, result) => {
      const path = args.path as string;
      if (!result.success) return `📄 read ${path} → error`;
      const lines = result.output.split('\n').length;
      const bytes = Buffer.byteLength(result.output, 'utf8');
      return `📄 read ${path} (${lines}L, ${bytes}B)`;
    },
  }),

  buildTool({
    name: 'write_file',
    description: '将内容写入文件。如果文件不存在则创建，存在则覆盖。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（绝对路径或相对路径）',
        },
        content: {
          type: 'string',
          description: '要写入的文件内容',
        },
      },
      required: ['path', 'content'],
    },
    execute: async (args, context) => {
      // Ensure path and content are valid strings
      const path = args.path;
      const content = args.content;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'write_file requires a path parameter' };
      }
      if (typeof content !== 'string') {
        return { success: false, output: '', error: 'write_file requires a content parameter' };
      }
      return writeFileSync_(path, content, context.cwd);
    },
    isDestructive: () => true,
    checkPermissions: (_args, _context) => {
      // Destructive operation - ask for confirmation in default mode
      return { behavior: 'ask', reason: 'Write operation may modify existing files' };
    },
    userFacingName: args => `Write ${args.path as string}`,
    getSummary: (args, result) => {
      const path = args.path as string;
      if (!result.success) return `💾 write ${path} → error`;
      const bytes = Buffer.byteLength((args.content as string) || '', 'utf8');
      return `💾 write ${path} (${bytes}B)`;
    },
  }),

  buildTool({
    name: 'list_files',
    description: '列出指定目录中的文件和子目录。支持控制递归深度。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径（绝对路径或相对路径）',
        },
        maxDepth: {
          type: 'number',
          description: '最大递归深度（可选，默认 2）',
        },
      },
      required: ['path'],
    },
    execute: async (args, context) => {
      // Ensure path is a valid string
      const path = args.path;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'list_files requires a path parameter' };
      }
      return listFiles_(path, args.maxDepth as number | undefined, context.cwd);
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: args => `List ${args.path as string}`,
    getSummary: (args, result) => {
      const path = args.path as string;
      if (!result.success) return `📁 list ${path} → error`;
      const count = result.output.split('\n').filter(Boolean).length;
      return `📁 list ${path} (${count} entries)`;
    },
  }),

  buildTool({
    name: 'exec_command',
    description: '执行一个 shell 命令。返回 stdout 和 stderr。输出超过 maxOutput 会自动截断。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令',
        },
        cwd: {
          type: 'string',
          description: '工作目录（可选，默认当前目录）',
        },
        timeout: {
          type: 'number',
          description: '超时时间 ms（可选，默认 30000）',
        },
        maxOutput: {
          type: 'number',
          description: '最大输出字节数（可选，默认 51200 = 50KB，超出截断）',
        },
      },
      required: ['command'],
    },
    execute: async (args, context) => {
      // Ensure command is a valid string
      const command = args.command;
      if (!command || typeof command !== 'string') {
        return { success: false, output: '', error: 'exec_command requires a command parameter' };
      }
      // Issue #32 #3.2: 传递 abortSignal
      return execCommand_(
        command,
        args.cwd as string | undefined,
        args.timeout as number | undefined,
        args.maxOutput as number | undefined,
        context.abortSignal,
        context.cwd
      );
    },
    isDestructive: args => {
      const cmd = (args.command as string) || '';
      return /(rm\s+-rf|mkfs|dd\s)/.test(cmd);
    },
    checkPermissions: (args, _context) => {
      const cmd = (args.command as string) || '';

      // Use the bash_security module for comprehensive checks
      const security = assessCommandSecurity(cmd);

      if (security.level === 'blocked') {
        return {
          behavior: 'deny',
          reason: security.reason || `Command blocked by safety policy: ${cmd.slice(0, 50)}`,
        };
      }

      if (security.level === 'safe' && security.isReadOnly) {
        return { behavior: 'allow' };
      }

      if (security.level === 'caution') {
        return { behavior: 'ask', reason: security.reason || 'Command requires confirmation' };
      }

      // Default: ask for confirmation
      return { behavior: 'ask', reason: 'Command requires confirmation' };
    },
    isReadOnly: args => {
      const cmd = (args.command as string) || '';
      return isReadOnlyCommand(cmd);
    },
    isConcurrencySafe: args => {
      const cmd = (args.command as string) || '';
      return isReadOnlyCommand(cmd);
    },
    userFacingName: args => `Exec ${compactOneLine((args.command as string) || '', 80)}`,
    getSummary: (args, result) => {
      const command = (args.command as string) || '';
      const commandSummary = command ? `\n  $ ${compactOneLine(command, 160)}` : '';
      if (!result.success) {
        const detail = summarizeFailedToolResult(result);
        return `🔧 exec → error${detail ? ` (${detail})` : ''}${commandSummary}`;
      }
      const bytes = Buffer.byteLength(result.output, 'utf8');
      return `🔧 exec (${bytes}B output)${commandSummary}`;
    },
  }),

  buildTool({
    name: 'edit_file',
    description:
      '对文件进行精确字符串替换。old_string 必须在文件中唯一匹配，否则拒绝执行。使用 replace_all 可替换所有精确匹配；只有显式 fuzzy_match=true 时才尝试宽松空白匹配。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（绝对路径或相对路径）',
        },
        old_string: {
          type: 'string',
          description: '要替换的字符串（必须精确匹配）',
        },
        new_string: {
          type: 'string',
          description: '替换后的字符串',
        },
        replace_all: {
          type: 'boolean',
          description: '是否替换所有匹配（可选，默认 false）',
        },
        fuzzy_match: {
          type: 'boolean',
          description: '精确匹配失败时是否允许宽松空白匹配（可选，默认 false；多候选时总是拒绝）',
        },
        preview: {
          type: 'boolean',
          description: '预览匹配结果而不写入文件（可选，默认 false）',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    execute: async (args, context) => {
      // Ensure required parameters are valid strings
      const path = args.path;
      const old_string = args.old_string;
      const new_string = args.new_string;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'edit_file requires a path parameter' };
      }
      if (!old_string || typeof old_string !== 'string') {
        return { success: false, output: '', error: 'edit_file requires an old_string parameter' };
      }
      if (typeof new_string !== 'string') {
        return { success: false, output: '', error: 'edit_file requires a new_string parameter' };
      }
      const lastEditFileArgs: {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
        fuzzy_match?: boolean;
        sessionId?: string;
        turnId?: number | string;
        updatedAt: number;
      } = { path, old_string, new_string, updatedAt: Date.now() };
      if (typeof args.replace_all === 'boolean') lastEditFileArgs.replace_all = args.replace_all;
      if (typeof args.fuzzy_match === 'boolean') lastEditFileArgs.fuzzy_match = args.fuzzy_match;
      if (context?.sessionId) lastEditFileArgs.sessionId = context.sessionId;
      if (context?.turnId) lastEditFileArgs.turnId = context.turnId;
      lastEditFileArgs.updatedAt = Date.now();
      setToolState({ lastEditFileArgs });
      return editFile_(
        path,
        old_string,
        new_string,
        args.replace_all as boolean | undefined,
        args.fuzzy_match as boolean | undefined,
        args.preview as boolean | undefined,
        context.cwd
      );
    },
    isDestructive: () => true,
    checkPermissions: (_args, _context) => {
      return { behavior: 'ask', reason: 'Edit operation modifies file contents' };
    },
    userFacingName: args => `Edit ${args.path as string}`,
    getSummary: (args, result) => {
      const path = args.path as string;
      if (!result.success) return `✏️ edit ${path} → error`;
      const replaceAll = args.replace_all ? ' (all)' : '';
      return `✏️ edit ${path}${replaceAll}`;
    },
  }),

  buildTool({
    name: 'glob',
    description: '使用 glob 模式搜索文件。支持 **（递归）、*（任意字符）、?（单个字符）等通配符。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob 模式（如 **/*.ts, src/**/*.js）',
        },
        path: {
          type: 'string',
          description: '搜索起始目录（可选，默认当前目录）',
        },
      },
      required: ['pattern'],
    },
    execute: async (args, context) => {
      // Ensure pattern is a valid string
      const pattern = args.pattern;
      if (!pattern || typeof pattern !== 'string') {
        return { success: false, output: '', error: 'glob requires a pattern parameter' };
      }
      return glob_(pattern, args.path as string | undefined, context.cwd);
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: args => `Glob ${args.pattern as string}`,
    getSummary: (args, result) => {
      const pattern = args.pattern as string;
      if (!result.success) return `🔍 glob ${pattern} → error`;
      const count = result.output.split('\n').filter(Boolean).length;
      return `🔍 glob ${pattern} → ${count} matches`;
    },
  }),

  buildTool({
    name: 'grep',
    description: '在文件中搜索正则表达式模式。返回匹配的文件路径和行内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '正则表达式模式',
        },
        path: {
          type: 'string',
          description: '搜索路径（可选，默认当前目录）',
        },
        glob: {
          type: 'string',
          description: '文件过滤模式（可选，如 *.ts）',
        },
        context: {
          type: 'number',
          description: '上下文行数（可选，默认 0）',
        },
      },
      required: ['pattern'],
    },
    execute: async (args, context) => {
      // Ensure pattern is a valid string
      const pattern = args.pattern;
      if (!pattern || typeof pattern !== 'string') {
        return { success: false, output: '', error: 'grep requires a pattern parameter' };
      }
      return grep_(
        pattern,
        args.path as string | undefined,
        args.glob as string | undefined,
        args.context as number | undefined,
        context.cwd
      );
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: args => `Grep ${args.pattern as string}`,
    getSummary: (args, result) => {
      const pattern = args.pattern as string;
      if (!result.success) return `🔎 grep /${pattern}/ → error`;
      const count = result.output.split('\n').filter(l => l && !l.startsWith('--')).length;
      return `🔎 grep /${pattern}/ → ${count} matches`;
    },
  }),

  buildTool({
    name: 'batch_read',
    description:
      'Run up to 8 read-only exploration tool calls in one ordered batch. Allowed tools: git_status, list_files, glob, grep, read_file.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description:
            'Array of steps: [{ "tool": "read_file", "args": { "path": "package.json" } }]. Max 8 steps.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Allowed read-only tool name' },
              args: { type: 'object', description: 'Arguments for the tool' },
            },
            required: ['tool', 'args'],
          },
          maxItems: BATCH_READ_MAX_STEPS,
        },
        reason: {
          type: 'string',
          description: 'Optional reason for this read-only batch.',
        },
      },
      required: ['steps'],
    } as any,
    execute: async (args, context) => executeBatchRead(args, context),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: args => {
      const count = Array.isArray(args.steps) ? args.steps.length : 0;
      return `Batch read ${count} steps`;
    },
    getSummary: (args, result) => {
      if (!result.success) return '📚 batch_read → error';
      const count = Array.isArray(args.steps) ? args.steps.length : 0;
      return `📚 batch_read → ${count} steps`;
    },
  }),

  // Memory tools
  buildTool({
    name: 'memory_save',
    description:
      'Save a memory entry to the persistent memory system. Memories help tailor behavior to user preferences.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Memory name (kebab-case, e.g., "user-role", "feedback-style")',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory type',
        },
        description: {
          type: 'string',
          description: 'One-line description for memory index',
        },
        content: {
          type: 'string',
          description:
            'Memory content. For feedback/project: use rule + Why + How to apply structure',
        },
      },
      required: ['name', 'type', 'content'],
    },
    execute: async (args, context) => {
      const name = args.name as string;
      const type = args.type as MemoryType;
      const content = args.content as string;
      const description = (args.description as string) || content.slice(0, 80);

      if (!name || typeof name !== 'string') {
        return { success: false, output: '', error: 'memory_save requires a name parameter' };
      }
      if (!type || !['user', 'feedback', 'project', 'reference'].includes(type)) {
        return {
          success: false,
          output: '',
          error: 'memory_save requires a valid type: user, feedback, project, or reference',
        };
      }
      if (!content || typeof content !== 'string') {
        return { success: false, output: '', error: 'memory_save requires a content parameter' };
      }

      try {
        const projectPath = context?.cwd || process.cwd();
        const entry: MemoryEntry = {
          name,
          type,
          description,
          content,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        if (isSemanticEnabled()) {
          // saveAndIndex internally calls saveMemory + vectorStore.upsert
          await getSemanticSearchService().saveAndIndex(entry, projectPath);
        } else {
          saveMemory(entry, projectPath);
        }
        return { success: true, output: `Saved memory: ${name} (${type})` };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => false,
    userFacingName: args => `Memory save ${args.name as string}`,
    getSummary: (args, result) => {
      const name = args.name as string;
      const type = args.type as string;
      if (!result.success) return `🧠 save ${name} → error`;
      return `🧠 save ${name} (${type})`;
    },
  }),

  buildTool({
    name: 'memory_recall',
    description:
      'Recall memories from the memory system. Returns matching memories or all if no query.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (optional, returns all if empty)',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Filter by memory type (optional)',
        },
      },
      required: [],
    },
    execute: async (args, context) => {
      try {
        const projectPath = context?.cwd || process.cwd();
        const query = (args.query as string) || '';
        const type = args.type as MemoryType | undefined;

        let memories: MemoryEntry[];

        if (query && isSemanticEnabled()) {
          // Semantic path: ask the vector store, then fall back to keywords if it
          // returns nothing (e.g. embedding provider unreachable, empty index)
          try {
            const result = await getSemanticSearchService().search({
              query,
              projectPath,
              type,
            });
            memories = result.memories.map(m => ({
              name: m.name,
              type: m.type,
              description: m.description,
              content: m.content,
              createdAt: m.createdAt,
              updatedAt: m.createdAt,
            }));
            if (memories.length === 0) {
              memories = searchMemories(query, projectPath);
              if (type) memories = memories.filter(m => m.type === type);
            }
          } catch {
            memories = searchMemories(query, projectPath);
            if (type) memories = memories.filter(m => m.type === type);
          }
        } else if (type) {
          memories = loadAllMemories(projectPath).filter(m => m.type === type);
        } else if (query) {
          memories = searchMemories(query, projectPath);
        } else {
          memories = loadAllMemories(projectPath);
        }

        if (memories.length === 0) {
          return { success: true, output: 'No memories found' };
        }

        const lines: string[] = [];
        for (const mem of memories) {
          lines.push(`## ${mem.name} (${mem.type})`);
          lines.push(mem.description);
          lines.push(mem.content);
          lines.push('');
        }

        return { success: true, output: lines.join('\n') };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => true,
    userFacingName: args => `Memory recall ${(args.query as string) || 'all'}`,
    getSummary: (args, result) => {
      const query = (args.query as string) || 'all';
      if (!result.success) return `🧠 recall "${query}" → error`;
      if (result.output === 'No memories found') return `🧠 recall "${query}" → 0 found`;
      const count = result.output.split(/^## /m).length - 1;
      return `🧠 recall "${query}" → ${count} memories`;
    },
  }),

  buildTool({
    name: 'memory_forget',
    description: 'Delete a memory entry from the memory system.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Memory name to delete',
        },
      },
      required: ['name'],
    },
    execute: async (args, context) => {
      const name = args.name as string;
      if (!name || typeof name !== 'string') {
        return { success: false, output: '', error: 'memory_forget requires a name parameter' };
      }

      try {
        const projectPath = context?.cwd || process.cwd();
        const existing = loadMemory(name, projectPath);
        if (!existing) {
          return { success: false, output: '', error: `Memory not found: ${name}` };
        }
        deleteMemory(name, projectPath);

        if (isSemanticEnabled()) {
          try {
            const { getVectorStore } = require('../memory/vector-store');
            getVectorStore().delete(name, projectPath);
          } catch {
            // Vector store cleanup is best-effort
          }
        }

        return { success: true, output: `Deleted memory: ${name}` };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => false,
    userFacingName: args => `Memory forget ${args.name as string}`,
    getSummary: (args, result) => {
      const name = args.name as string;
      if (!result.success) return `🧠 forget ${name} → error`;
      return `🧠 forget ${name}`;
    },
  }),

  // History search tool
  buildTool({
    name: 'history_search',
    description:
      'Search previous tool operations in current or past sessions. Helps find what was done before.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (tool name, file path, keyword)',
        },
        sessionId: {
          type: 'string',
          description: 'Session ID to search (optional, defaults to searching recent sessions)',
        },
        limit: {
          type: 'number',
          description: 'Max results (optional, default 10)',
        },
      },
      required: ['query'],
    },
    execute: async args => {
      const query = args.query as string;
      if (!query || typeof query !== 'string') {
        return { success: false, output: '', error: 'history_search requires a query parameter' };
      }

      try {
        const limit = (args.limit as number) || 10;
        const sessionId = args.sessionId as string | undefined;

        // If sessionId provided, search that session; otherwise search all recent sessions
        const sessions = sessionId
          ? [loadSessionMeta(sessionId)!].filter(Boolean)
          : listSessions(5);

        const results: Array<{
          sessionId: string;
          tool: string;
          args: string;
          resultPreview: string;
          timestamp: number;
        }> = [];

        for (const session of sessions) {
          if (!session) continue;
          const messages = readSessionMessages(session.id);

          // Search through messages for tool calls matching query
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'assistant' && msg.tool_calls) {
              for (const tc of msg.tool_calls) {
                // Match tool name or arguments content
                const matchesQuery =
                  tc.function.name.toLowerCase().includes(query.toLowerCase()) ||
                  tc.function.arguments.toLowerCase().includes(query.toLowerCase());

                if (matchesQuery) {
                  // Find corresponding tool result
                  const nextMsg = messages[i + 1];
                  const resultPreview =
                    nextMsg?.role === 'tool' && nextMsg.toolCallId === tc.id
                      ? nextMsg.content.slice(0, 200)
                      : '(no result)';

                  results.push({
                    sessionId: session.id.slice(0, 8),
                    tool: tc.function.name,
                    args: tc.function.arguments.slice(0, 100),
                    resultPreview,
                    timestamp: msg.timestamp,
                  });
                }
              }
            }
          }
        }

        // Sort by timestamp (newest first) and limit
        results.sort((a, b) => b.timestamp - a.timestamp);
        const limited = results.slice(0, limit);

        if (limited.length === 0) {
          return { success: true, output: 'No matching tool operations found' };
        }

        const lines: string[] = [];
        lines.push(`Found ${limited.length} matching operations:`);
        lines.push('');
        for (const r of limited) {
          lines.push(`Session ${r.sessionId}: ${r.tool}`);
          lines.push(`  Args: ${r.args}`);
          lines.push(`  Result: ${r.resultPreview.slice(0, 100)}...`);
          lines.push('');
        }

        return { success: true, output: lines.join('\n') };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => true,
    userFacingName: args => `History search ${args.query as string}`,
    getSummary: (args, result) => {
      const query = args.query as string;
      if (!result.success) return `📜 history "${query}" → error`;
      if (result.output.startsWith('No matching')) return `📜 history "${query}" → 0 found`;
      const match = result.output.match(/Found (\d+) matching/);
      const count = match ? match[1] : '?';
      return `📜 history "${query}" → ${count} found`;
    },
  }),
];

/**
 * Runtime tool pool.
 *
 * Static Orion Code tools are always present. Connected MCP server tools are
 * exposed as first-class tools named mcp__<server>__<tool>, matching the
 * convention used by Claude Code, Codex, and OpenClaude.
 */
export function getRuntimeTools(): OpenHorseTool[] {
  return [...TOOLS, ...mcpManager.getOrionCodeTools()];
}

// ============================================================================
// 工具实现
// ============================================================================

/** Normalize model/tool path strings before resolving them on disk. */
function normalizeToolPath(input: string): string {
  let value = input.trim();

  const markdownLink = value.match(/^!?\[[^\]]*\]\(([\s\S]+)\)$/u);
  if (markdownLink) {
    value = markdownLink[1].trim();
    if (value.startsWith('<')) {
      const end = value.indexOf('>');
      if (end >= 0) {
        value = value.slice(1, end);
      }
    } else {
      value = value.replace(/\s+["'][\s\S]*["']$/u, '');
    }
  }

  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  if (value.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return value.replace(/^file:\/\//u, '');
    }
  }

  // Plain filesystem paths are not URLs: do NOT percent-decode them, or a
  // literal filename like "lit%41.txt" is silently rewritten to "litA.txt".
  return value;
}

/** Safely stat a path, returning null for dangling symlinks or missing files
 *  instead of throwing ENOENT. Uses lstatSync to avoid following symlinks
 *  when checking existence. */
function safeStatSync(resolved: string): ReturnType<typeof statSync> | null {
  try {
    // lstatSync does NOT follow symlinks — safe for dangling ones.
    const lst = lstatSync(resolved);
    if (lst.isSymbolicLink()) {
      // For symlinks, use statSync (follows the link) inside try/catch.
      // If the target doesn't exist, statSync throws ENOENT — catch and return null.
      try {
        return statSync(resolved);
      } catch {
        return null; // dangling symlink
      }
    }
    return statSync(resolved);
  } catch {
    return null; // path doesn't exist at all
  }
}

/** Read a file safely, returning null for dangling symlinks or unreadable files. */
function safeReadFileSync(resolved: string): string | null {
  try {
    // Check if it's a dangling symlink before attempting read.
    const st = safeStatSync(resolved);
    if (!st || st.isDirectory()) return null;
    return readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
}

/** Resolve tool path parameters relative to the current tool cwd. */
function safePath(input: string, cwd = process.cwd()): string {
  return resolve(cwd, normalizeToolPath(input));
}

/**
 * Truncate text to at most maxBytes UTF-8 bytes, cutting on a character
 * boundary (never inside a multi-byte sequence or surrogate pair). Returns the
 * truncated text and the byte length it was cut at. String.slice counts UTF-16
 * code units, not bytes, so it is wrong for enforcing a byte budget on CJK or
 * emoji content and can split a surrogate pair.
 */
function truncateToBytes(text: string, maxBytes: number): { text: string; bytes: number } {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return { text, bytes: buf.length };
  let cut = maxBytes;
  // Walk back past UTF-8 continuation bytes (0x80-0xBF) to a lead-byte boundary.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf-8'), bytes: cut };
}

function readPositiveInteger(value: unknown, name: string, defaultValue: number): number | string {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return `read_file ${name} must be a positive integer`;
  }
  return value;
}

async function readFileSync_(
  path: string,
  maxLines: number,
  offset: number,
  cwd?: string
): Promise<ToolResult> {
  try {
    const normalizedPath = normalizeToolPath(path);
    const resolved = safePath(path, cwd);
    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${normalizedPath}` };
    }
    const st = safeStatSync(resolved);
    if (!st) {
      return {
        success: false,
        output: '',
        error: `Cannot access file: ${normalizedPath} (may be a dangling symlink or missing)`,
      };
    }
    if (st.isDirectory()) {
      return {
        success: false,
        output: '',
        error: `Path is a directory, not a file: ${normalizedPath}`,
      };
    }

    const content = safeReadFileSync(resolved);
    if (content === null) {
      return {
        success: false,
        output: '',
        error: `Cannot read file: ${normalizedPath}`,
      };
    }
    const lines = content.split('\n');
    const maxBytes = 51200; // 50KB byte limit
    if (offset > lines.length) {
      return {
        success: false,
        output: '',
        error: `read_file offset ${offset} is beyond the file (${lines.length} lines)`,
      };
    }

    const startIndex = offset - 1;
    const selectedLines = lines.slice(startIndex, startIndex + maxLines);
    const selected = selectedLines.join('\n');
    const remainingLines = Math.max(0, lines.length - startIndex - selectedLines.length);

    if (remainingLines > 0) {
      const byteLen = Buffer.byteLength(selected, 'utf8');
      const notice = `\n\n[... truncated, ${remainingLines} more lines; showing lines ${offset}-${offset + selectedLines.length - 1} of ${lines.length}]`;
      if (byteLen > maxBytes) {
        const cut = truncateToBytes(selected, maxBytes);
        return {
          success: true,
          output: cut.text + `\n\n[... truncated at ${cut.bytes}B]`,
        };
      }
      return { success: true, output: selected + notice };
    }

    // Also apply byte limit to the selected page.
    const byteLen = Buffer.byteLength(selected, 'utf8');
    if (byteLen > maxBytes) {
      const cut = truncateToBytes(selected, maxBytes);
      return {
        success: true,
        output: cut.text + `\n\n[... truncated at ${cut.bytes}B of ${byteLen}B]`,
      };
    }

    return { success: true, output: selected };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

async function writeFileSync_(path: string, content: string, cwd?: string): Promise<ToolResult> {
  try {
    const normalizedPath = normalizeToolPath(path);
    const resolved = safePath(path, cwd);
    writeFileSync(resolved, content, 'utf-8');
    return {
      success: true,
      output: `Wrote ${content.split('\n').length} lines to ${normalizedPath}`,
    };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

async function listFiles_(path: string, maxDepth?: number, cwd?: string): Promise<ToolResult> {
  const normalizedPath = normalizeToolPath(path);
  const resolved = safePath(path, cwd);
  if (!existsSync(resolved)) {
    return { success: false, output: '', error: `Path not found: ${normalizedPath}` };
  }
  if (!statSync(resolved).isDirectory()) {
    return { success: true, output: normalizedPath };
  }

  const depth = maxDepth ?? 2;
  const results: string[] = [];

  function walk(dir: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          results.push(`${relPath}/`);
          walk(fullPath, currentDepth + 1, relPath);
        } else {
          results.push(relPath);
        }
      }
    } catch {
      // skip unreadable directories
    }
  }

  walk(resolved, 1, '');

  // Limit output to 500 entries
  const maxEntries = 500;
  const output =
    results.length > maxEntries
      ? results.slice(0, maxEntries).join('\n') +
        `\n\n[... truncated, ${results.length - maxEntries} more entries]`
      : results.join('\n');

  return { success: true, output };
}

// Issue #32 #3.2: execCommand_ 支持 abortSignal
async function execCommand_(
  command: string,
  cwd?: string,
  timeout?: number,
  maxOutput?: number,
  abortSignal?: AbortSignal,
  baseCwd?: string
): Promise<ToolResult> {
  return new Promise(resolve => {
    const workdir = cwd ? safePath(cwd, baseCwd) : (baseCwd ?? process.cwd());
    const timeoutMs = timeout ?? 30000;
    const maxBytes = maxOutput ?? 51200; // Default 50KB, Issue #28 fix

    // Use spawn for streaming output with truncation support
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn('sh', ['-c', command], {
      cwd: workdir,
      detached: useProcessGroup,
    });

    let stdoutData = '';
    let stderrData = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    // Issue #32 修复：使用独立计数器
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let interrupted: 'aborted' | 'timeout' | null = null;

    // Issue #32 #3.2: AbortSignal 处理
    let timeoutId: NodeJS.Timeout | undefined;
    let killTimerId: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimerId) clearTimeout(killTimerId);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      resolve(result);
    };

    const terminateChild = () => {
      if (!child.pid || child.killed) return;
      try {
        if (useProcessGroup) {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        child.kill('SIGTERM');
      }

      killTimerId = setTimeout(() => {
        if (!child.pid || child.killed || settled) return;
        try {
          if (useProcessGroup) {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          child.kill('SIGKILL');
        }
      }, 500);
      killTimerId.unref?.();
    };

    const abortHandler = () => {
      interrupted = 'aborted';
      terminateChild();
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler);
      if (abortSignal.aborted) {
        abortHandler();
      }
    }

    // Timeout handling
    timeoutId = setTimeout(() => {
      if (!interrupted) {
        interrupted = 'timeout';
        terminateChild();
      }
    }, timeoutMs);

    // Stream stdout with truncation
    child.stdout.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        const chunk = data.toString();
        stdoutBytes += chunk.length;

        if (stdoutBytes > maxBytes) {
          stdoutTruncated = true;
          stdoutData += chunk.slice(0, maxBytes - stdoutData.length);
        } else {
          stdoutData += chunk;
        }
      }
    });

    // Stream stderr with truncation (Issue #32 修复：使用独立计数器)
    child.stderr.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        const chunk = data.toString();
        stderrBytes += chunk.length;

        if (stderrBytes > maxBytes) {
          stderrTruncated = true;
          stderrData += chunk.slice(0, maxBytes - stderrData.length);
        } else {
          stderrData += chunk;
        }
      }
    });

    child.on('close', code => {
      if (interrupted === 'aborted') {
        finish({
          success: false,
          output: stdoutData.slice(0, maxBytes),
          error: 'Command aborted by user',
        });
        return;
      }

      if (interrupted === 'timeout') {
        finish({
          success: false,
          output: stdoutData.slice(0, maxBytes),
          error: `Command timed out after ${timeoutMs}ms`,
        });
        return;
      }

      const output = stdoutData.trim();
      const errOutput = stderrData.trim();

      // Add truncation notice if output was truncated
      let finalOutput = output;
      if (stdoutTruncated) {
        finalOutput += '\n\n[... output truncated, exceeded 50KB limit]';
      }

      if (code !== 0) {
        finish({
          success: false,
          output: finalOutput || errOutput,
          error: `Command exited with code ${code}`,
        });
      } else {
        finish({
          success: true,
          output: finalOutput || '(no output)',
          error: stderrTruncated
            ? errOutput + '\n\n[... stderr truncated]'
            : errOutput || undefined,
        });
      }
    });

    child.on('error', err => {
      finish({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}

/**
 * Fuzzy match result
 */
interface FuzzyMatchResult {
  matches: string[]; // Actual strings found in content
  strategy: 'whitespace' | 'line';
}

function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split('\n').length;
}

function findAllMatchIndexes(content: string, needle: string, limit = 20): number[] {
  const indexes: number[] = [];
  let cursor = 0;
  while (indexes.length < limit) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) break;
    indexes.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return indexes;
}

function previewLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export interface EditPreviewCandidate {
  index: number;
  line: number;
  match: string;
  contextBefore: string;
  contextAfter: string;
  isReplaceAll: boolean;
}

function buildEditCandidates(params: {
  kind: 'exact' | 'fuzzy';
  content: string;
  matches: string[];
  newString: string;
  strategy?: string;
  count?: number;
}): EditPreviewCandidate[] {
  const cursorByMatch = new Map<string, number>();
  return params.matches.slice(0, 20).map((match, index) => {
    const cursor = cursorByMatch.get(match) ?? 0;
    const matchIndex = params.content.indexOf(match, cursor);
    cursorByMatch.set(match, matchIndex >= 0 ? matchIndex + Math.max(match.length, 1) : cursor);
    const lineNum = matchIndex >= 0 ? lineNumberForIndex(params.content, matchIndex) : 0;

    // Get context lines (3 before, 3 after)
    const allLines = params.content.split('\n');
    const contextBefore = allLines.slice(Math.max(0, lineNum - 4), lineNum).join('\n');
    const contextAfter = allLines.slice(lineNum + 1, lineNum + 4).join('\n');

    return {
      index,
      line: lineNum,
      match,
      contextBefore,
      contextAfter,
      isReplaceAll: (params.count ?? 1) > 1,
    };
  });
}

function formatEditPreview(params: {
  kind: 'exact' | 'fuzzy';
  content: string;
  matches: string[];
  newString: string;
  strategy?: string;
}): string {
  const cursorByMatch = new Map<string, number>();
  const lines = [
    `Preview: ${params.kind === 'fuzzy' ? `Fuzzy ${params.strategy ?? 'match'}` : 'Exact match'} candidates (${params.matches.length})`,
  ];

  params.matches.slice(0, 20).forEach((match, index) => {
    const cursor = cursorByMatch.get(match) ?? 0;
    const matchIndex = params.content.indexOf(match, cursor);
    cursorByMatch.set(match, matchIndex >= 0 ? matchIndex + Math.max(match.length, 1) : cursor);
    const lineNum = matchIndex >= 0 ? lineNumberForIndex(params.content, matchIndex) : '?';
    lines.push(`${index + 1}. line ${lineNum}: "${previewLine(match)}"`);
  });

  if (params.matches.length > 20) {
    lines.push(`... ${params.matches.length - 20} more candidates omitted`);
  }
  lines.push(`Would replace with: "${previewLine(params.newString)}"`);
  return lines.join('\n');
}

/**
 * Attempt to find old_string in content using fuzzy matching strategies.
 * Returns null if no match found, or the matched strings.
 */
function fuzzyMatch(content: string, oldString: string): FuzzyMatchResult | null {
  // Strategy 1: Line-by-line matching (allow different indentation)
  const oldLines = oldString
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const contentLines = content.split('\n');
  const lineMatches: string[] = [];

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== oldLines[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      const matchedStr = contentLines.slice(i, i + oldLines.length).join('\n');
      lineMatches.push(matchedStr);
    }
  }

  if (lineMatches.length > 0) {
    return { matches: lineMatches, strategy: 'line' };
  }

  // Strategy 2: Whitespace-tolerant token match. This preserves the actual
  // matched span without consuming unrelated leading/trailing blank lines.
  const tokens = oldString.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const pattern = tokens.map(escapeRegExp).join('\\s+');
  const regex = new RegExp(pattern, 'g');
  const wsMatches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[0]) {
      wsMatches.push(match[0]);
    }
    if (wsMatches.length > 5) break; // Safety limit
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }

  if (wsMatches.length > 0) {
    return { matches: wsMatches, strategy: 'whitespace' };
  }

  return null;
}

async function editFile_(
  path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean,
  fuzzy_match?: boolean,
  preview?: boolean,
  cwd?: string
): Promise<ToolResult> {
  try {
    const normalizedPath = normalizeToolPath(path);
    const resolved = safePath(path, cwd);
    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${normalizedPath}` };
    }
    const fileStat = safeStatSync(resolved);
    if (!fileStat) {
      return { success: false, output: '', error: `Cannot access file: ${normalizedPath} (may be a dangling symlink)` };
    }
    if (fileStat.isDirectory()) {
      return {
        success: false,
        output: '',
        error: `Path is a directory, not a file: ${normalizedPath}`,
      };
    }

    const content = safeReadFileSync(resolved);
    if (content === null) {
      return { success: false, output: '', error: `Cannot read file: ${normalizedPath}` };
    }

    // Check if old_string exists exactly
    const count = (content.match(new RegExp(escapeRegExp(old_string), 'g')) || []).length;

    if (count > 0 && preview) {
      const matchIndexes = findAllMatchIndexes(content, old_string);
      const matches = matchIndexes.map(() => old_string);
      return {
        success: true,
        output: formatEditPreview({
          kind: 'exact',
          content,
          matches,
          newString: new_string,
        }),
        metadata: {
          candidates: buildEditCandidates({
            kind: 'exact',
            content,
            matches,
            newString: new_string,
            count,
          }),
        },
      };
    }

    if (count === 0) {
      if (!fuzzy_match) {
        return {
          success: false,
          output: '',
          error: `old_string not found in file: ${old_string.slice(0, 100)}...`,
        };
      }

      // Try fuzzy match strategies
      const fuzzyResult = fuzzyMatch(content, old_string);

      if (fuzzyResult === null) {
        return {
          success: false,
          output: '',
          error: `old_string not found in file: ${old_string.slice(0, 100)}...`,
        };
      }

      if (preview) {
        return {
          success: true,
          output: formatEditPreview({
            kind: 'fuzzy',
            content,
            matches: fuzzyResult.matches,
            newString: new_string,
            strategy: fuzzyResult.strategy,
          }),
          metadata: {
            candidates: buildEditCandidates({
              kind: 'fuzzy',
              content,
              matches: fuzzyResult.matches,
              newString: new_string,
              strategy: fuzzyResult.strategy,
            }),
          },
        };
      }

      if (fuzzyResult.matches.length > 1) {
        return {
          success: false,
          output: '',
          error: `Fuzzy match found ${fuzzyResult.matches.length} candidates. Provide a more specific string. First 3 candidates:\n${fuzzyResult.matches
            .slice(0, 3)
            .map((m, i) => `  ${i + 1}: "${m.slice(0, 80)}..."`)
            .join('\n')}`,
        };
      }

      // Use the single fuzzy match only.
      const match = fuzzyResult.matches[0];

      const idx = content.indexOf(match);
      const newContent = content.slice(0, idx) + new_string + content.slice(idx + match.length);

      writeFileSync(resolved, newContent, 'utf-8');
      return {
        success: true,
        output: `Fuzzy edited ${normalizedPath} (matched by ${fuzzyResult.strategy}, "${match.slice(0, 50)}...")`,
      };
    }

    // If not replace_all, require unique match
    if (!replace_all && count > 1) {
      return {
        success: false,
        output: '',
        error: `old_string found ${count} times in file. Use replace_all=true to replace all occurrences, or provide a more specific string that matches exactly once.`,
      };
    }

    // Perform replacement
    let newContent: string;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
    } else {
      // Replace first occurrence only
      const idx = content.indexOf(old_string);
      newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
    }

    writeFileSync(resolved, newContent, 'utf-8');

    return {
      success: true,
      output: `Replaced ${count} occurrence(s) of old_string with new_string in ${normalizedPath}`,
    };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

/** Escape special regex characters for literal matching */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Glob/Grep 工具实现
// ============================================================================

/**
 * Glob 模式匹配 - 简化版实现
 * 支持: **（递归目录）、*（任意字符）、?（单个字符）
 */
async function glob_(pattern: string, basePath?: string, cwd?: string): Promise<ToolResult> {
  try {
    const normalizedBasePath = basePath ? normalizeToolPath(basePath) : (cwd ?? process.cwd());
    const base = basePath ? safePath(basePath, cwd) : (cwd ?? process.cwd());
    if (!existsSync(base)) {
      return { success: false, output: '', error: `Path not found: ${normalizedBasePath}` };
    }
    if (!statSync(base).isDirectory()) {
      return {
        success: false,
        output: '',
        error: `Path is not a directory: ${normalizedBasePath}`,
      };
    }

    const results: string[] = [];

    // Convert glob pattern to regex.
    // Escape ALL regex metacharacters first, then translate glob wildcards.
    // Escaping only `.` (the old behavior) left parens/brackets/+/^/$/| as
    // regex syntax: a literal "(group)" became a capture group (so the real
    // file stopped matching) and an unbalanced "[" made new RegExp throw.
    function globToRegex(pat: string): RegExp {
      // Use placeholders for glob wildcards so escaping does not touch them.
      let regex = pat;

      // **/ at start - matches optional path (including empty)
      regex = regex.replace(/^\*\*\//, '<<STARSTAR_SLASH_START>>');

      // **/ in middle - matches any number of path segments
      regex = regex.replace(/\*\*\//g, '<<STARSTAR_SLASH>>');

      // standalone ** - matches anything
      regex = regex.replace(/\*\*/g, '<<STARSTAR>>');

      // Escape every regex metacharacter in the remaining literal text.
      // NOTE: * and ? are glob wildcards, handled below - do not escape them.
      regex = regex.replace(/[.+^${}()|[\]\\]/g, '\\$&');

      // * matches anything except /
      regex = regex.replace(/\*/g, '[^/]*');

      // ? matches single char except /
      regex = regex.replace(/\?/g, '[^/]');

      // Now restore ** placeholders
      regex = regex.replace(/<<STARSTAR_SLASH_START>>/g, '(.*\\/)?');
      regex = regex.replace(/<<STARSTAR_SLASH>>/g, '([^/]+\\/)*');
      regex = regex.replace(/<<STARSTAR>>/g, '.*');

      return new RegExp(`^${regex}$`);
    }

    const regex = globToRegex(pattern);

    // Recursive walk with a depth cap so a pathological tree (or symlink loop)
    // cannot hang or OOM the tool.
    const MAX_DEPTH = 16;
    function walk(dir: string, prefix: string, depth: number) {
      if (depth > MAX_DEPTH) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;

          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(join(dir, entry.name), relPath, depth + 1);
          } else {
            if (regex.test(relPath)) {
              results.push(relPath);
            }
          }
        }
      } catch {
        // skip unreadable directories
      }
    }

    walk(base, '', 0);

    if (results.length === 0) {
      return { success: true, output: 'No files found matching pattern' };
    }

    // Limit output to 200 matches
    const maxMatches = 200;
    const sorted = results.sort();
    const output =
      sorted.length > maxMatches
        ? sorted.slice(0, maxMatches).join('\n') +
          `\n\n[... truncated, ${sorted.length - maxMatches} more matches]`
        : sorted.join('\n');

    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

/**
 * Grep 搜索 - 在文件中搜索正则表达式
 */
async function grep_(
  pattern: string,
  basePath?: string,
  globPattern?: string,
  contextLines?: number,
  cwd?: string
): Promise<ToolResult> {
  try {
    const normalizedBasePath = basePath ? normalizeToolPath(basePath) : (cwd ?? process.cwd());
    const base = basePath ? safePath(basePath, cwd) : (cwd ?? process.cwd());
    if (!existsSync(base)) {
      return { success: false, output: '', error: `Path not found: ${normalizedBasePath}` };
    }

    const regex = new RegExp(pattern);
    const context = contextLines ?? 0;
    const results: string[] = [];
    const maxResults = 100;

    // Get list of files to search
    const files: string[] = [];
    const skippedDangling: string[] = [];

    function collectFiles(dir: string) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            collectFiles(fullPath);
          } else {
            // Check glob filter if provided
            if (globPattern) {
              if (!matchGlobSimple(entry.name, globPattern)) continue;
            }
            // Skip dangling symlinks — collect their paths for a warning.
            if (entry.isSymbolicLink()) {
              try {
                statSync(fullPath);
              } catch {
                skippedDangling.push(fullPath);
                continue;
              }
            }
            files.push(fullPath);
          }
        }
      } catch {
        // skip unreadable
      }
    }

    function matchGlobSimple(name: string, pat: string): boolean {
      const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${regex}$`).test(name);
    }

    const baseStat = safeStatSync(base);
    if (!baseStat) {
      return { success: false, output: '', error: `Cannot access path: ${base} (may be a dangling symlink or missing)` };
    }
    if (baseStat.isDirectory()) {
      collectFiles(base);
    } else {
      // Skip dangling symlinks / unreadable single files early.
      const fileStat = safeStatSync(base);
      if (fileStat && fileStat.isFile()) {
        files.push(base);
      }
    }

    // Search each file
    for (const file of files) {
      if (results.length >= maxResults) break;

      try {
        // Skip dangling symlinks and unreadable files before creating the stream.
        const fileStat = safeStatSync(file);
        if (!fileStat || !fileStat.isFile()) continue;

        const stream = createReadStream(file, { encoding: 'utf-8' });
        const rl = createInterface({
          input: stream,
          crlfDelay: Infinity,
        });

        const lines: string[] = [];
        const relPath = relative(base, file);

        rl.on('line', line => {
          lines.push(line);
        });

        // Guard against stream errors (dangling symlinks, permission denied, etc.)
        await new Promise<void>((resolve, reject) => {
          stream.on('error', reject);
          rl.on('close', resolve);
        });

        // Search for matches
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            // Format: file:line:content
            const start = Math.max(0, i - context);
            const end = Math.min(lines.length - 1, i + context);

            if (context > 0) {
              results.push(`${relPath}:${i + 1}:`);
              for (let j = start; j <= end; j++) {
                const prefix = j === i ? '>' : ' ';
                results.push(`  ${prefix}${j + 1}: ${lines[j]}`);
              }
              results.push('');
            } else {
              results.push(`${relPath}:${i + 1}: ${lines[i]}`);
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    const symlinkWarning = skippedDangling.length > 0
      ? `\n⚠️  Skipped ${skippedDangling.length} dangling symlink(s): ${skippedDangling.slice(0, 3).join(', ')}${skippedDangling.length > 3 ? '...' : ''}\n`
      : '';

    if (results.length === 0) {
      return { success: true, output: 'No matches found' + symlinkWarning };
    }

    return { success: true, output: results.slice(0, maxResults).join('\n') + symlinkWarning };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

interface BatchReadStepInput {
  tool: string;
  args: Record<string, unknown>;
}

interface BatchReadStepOutput {
  index: number;
  tool: string;
  args?: Record<string, unknown>;
  success: boolean;
  summary?: string;
  error?: string;
  output: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBatchReadSteps(rawSteps: unknown): { steps?: BatchReadStepInput[]; error?: string } {
  let value = rawSteps;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: 'batch_read steps must be an array or a valid JSON array string' };
    }
  }

  if (!Array.isArray(value)) {
    return { error: 'batch_read requires steps to be an array' };
  }
  if (value.length === 0) {
    return { error: 'batch_read requires at least one step' };
  }
  if (value.length > BATCH_READ_MAX_STEPS) {
    return { error: `batch_read supports at most ${BATCH_READ_MAX_STEPS} steps` };
  }

  const steps: BatchReadStepInput[] = [];
  for (let i = 0; i < value.length; i++) {
    const step = value[i];
    if (!isRecord(step)) {
      return { error: `batch_read step ${i + 1} must be an object` };
    }
    if (typeof step.tool !== 'string' || !step.tool) {
      return { error: `batch_read step ${i + 1} requires a tool string` };
    }

    let stepArgs = step.args;
    if (typeof stepArgs === 'string') {
      try {
        stepArgs = JSON.parse(stepArgs);
      } catch {
        return {
          error: `batch_read step ${i + 1} args must be an object or valid JSON object string`,
        };
      }
    }
    if (!isRecord(stepArgs)) {
      return { error: `batch_read step ${i + 1} requires args to be an object` };
    }

    steps.push({ tool: step.tool, args: stepArgs });
  }

  return { steps };
}

function buildBatchReadPayload(
  success: boolean,
  summary: string,
  steps: BatchReadStepOutput[],
  error?: string
): ToolResult {
  const payload: Record<string, unknown> = {
    success,
    output: steps
      .map(
        step =>
          `${step.index}. ${step.tool}: ${step.summary || (step.success ? 'ok' : step.error || 'error')}`
      )
      .join('\n'),
    summary,
    steps,
  };
  if (error) {
    payload.error = error;
  }

  return {
    success,
    output: JSON.stringify(payload, null, 2),
    summary,
    error,
  };
}

async function executeBatchRead(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const parsed = parseBatchReadSteps(args.steps);
  if (parsed.error || !parsed.steps) {
    return buildBatchReadPayload(
      false,
      parsed.error || 'Invalid batch_read request',
      [],
      parsed.error
    );
  }

  const runtimeTools = getRuntimeTools();
  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const tool = runtimeTools.find(t => t.name === step.tool);
    if (!BATCH_READ_ALLOWED_TOOLS.has(step.tool)) {
      const error = `Tool ${step.tool} is not allowed in batch_read`;
      return buildBatchReadPayload(
        false,
        error,
        [
          {
            index: i + 1,
            tool: step.tool,
            args: step.args,
            success: false,
            error,
            output: '',
          },
        ],
        error
      );
    }
    if (!tool || tool.isReadOnly?.(step.args) !== true) {
      const error = `Tool ${step.tool} is unavailable or not read-only`;
      return buildBatchReadPayload(
        false,
        error,
        [
          {
            index: i + 1,
            tool: step.tool,
            args: step.args,
            success: false,
            error,
            output: '',
          },
        ],
        error
      );
    }
  }

  const stepResults: BatchReadStepOutput[] = [];

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    try {
      const rawResult = await executeTool(step.tool, step.args, context.abortSignal, context);
      const envelope = JSON.parse(rawResult) as {
        success?: boolean;
        output?: unknown;
        summary?: unknown;
        error?: unknown;
      };
      const output =
        typeof envelope.output === 'string'
          ? envelope.output
          : JSON.stringify(envelope.output ?? '');
      stepResults.push({
        index: i + 1,
        tool: step.tool,
        args: step.args,
        success: envelope.success === true,
        summary: typeof envelope.summary === 'string' ? envelope.summary : undefined,
        error: typeof envelope.error === 'string' ? envelope.error : undefined,
        output: truncateForContext(output, BATCH_READ_STEP_OUTPUT_MAX_BYTES),
      });
    } catch (err: any) {
      stepResults.push({
        index: i + 1,
        tool: step.tool,
        args: step.args,
        success: false,
        error: err?.message || String(err),
        output: '',
      });
    }
  }

  const okCount = stepResults.filter(step => step.success).length;
  const success = okCount === stepResults.length;
  const summary = `batch_read completed ${okCount}/${stepResults.length} steps`;
  return buildBatchReadPayload(success, summary, stepResults, success ? undefined : summary);
}

// ============================================================================
// 统一执行入口
// ============================================================================

/**
 * 执行一个工具调用，返回结构化结果字符串
 * Issue #32 #3.2: 支持 abortSignal
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  toolContext?: ToolContext
): Promise<string> {
  const runtimeTools = getRuntimeTools();
  const tool = runtimeTools.find(t => t.name === name);
  if (!tool) {
    return JSON.stringify({
      success: false,
      error: `Unknown tool: ${name}. Available tools: ${runtimeTools.map(t => t.name).join(', ')}`,
    });
  }

  const context: ToolContext = {
    cwd: toolContext?.cwd || process.cwd(),
    config: toolContext?.config || {
      name: process.env[ENV.NAME] || 'orion-code',
      mode: process.env[ENV.MODE] || 'development',
    },
    abortSignal, // Issue #32 #3.2: 透传 abortSignal
    sessionId: toolContext?.sessionId,
    turnId: toolContext?.turnId,
  };

  const result = await tool.execute(args, context);
  const summary = summarizeToolResult(tool, args, result);
  const outputBytes = Buffer.byteLength(result.output || '', 'utf8');

  let output = result.output || '';
  let artifactRef: { id: string; outputBytes: number } | undefined;

  if (outputBytes > ARTIFACT_THRESHOLD) {
    const artifact = storeArtifact(context.cwd, name, output, outputBytes);
    if (artifact) {
      artifactRef = { id: artifact.id, outputBytes: artifact.outputBytes };
      output = truncateForContext(output);
    }
  }

  const payload: Record<string, unknown> = {
    success: result.success,
    output,
    summary,
    outputBytes,
  };

  if (!result.success) {
    payload.error = result.error;
  }
  if (artifactRef) {
    payload.artifactRef = artifactRef;
  }

  return JSON.stringify(payload);
}

function summarizeToolResult(
  tool: OpenHorseTool,
  args: Record<string, unknown>,
  result: ToolResult
): string | undefined {
  try {
    return tool.getSummary?.(args, result);
  } catch {
    return undefined;
  }
}

/**
 * 获取可用工具名称列表
 */
export function getToolNames(): string {
  return getRuntimeTools()
    .map(t => t.name)
    .join(', ');
}

// Re-export bash_security module
export {
  READ_ONLY_COMMANDS,
  DANGEROUS_PATTERNS,
  POTENTIALLY_DESTRUCTIVE_PATTERNS,
  isReadOnlyCommand,
  checkDangerousCommand,
  isPotentiallyDestructive,
  assessCommandSecurity,
  wrapForSandbox,
  type SandboxOptions,
  DEFAULT_SANDBOX_OPTIONS,
} from './bash_security';
