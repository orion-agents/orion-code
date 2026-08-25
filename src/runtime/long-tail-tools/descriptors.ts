import type { PermissionResult, ToolInputJSONSchema, ToolResult } from '../../framework/tool';
import type { ToolRiskMetadataV1 } from '../step-snapshot';

export type FirstPartyLongTailToolGroupV1 = 'git' | 'lsp' | 'web';

export type FirstPartyLongTailToolNameV1 =
  | 'git_branch'
  | 'git_commit'
  | 'git_diff'
  | 'git_log'
  | 'git_push'
  | 'git_status'
  | 'lsp_get_definition'
  | 'lsp_get_diagnostics'
  | 'lsp_get_hover'
  | 'lsp_get_references'
  | 'web_fetch'
  | 'web_search';

export interface LongTailToolDescriptorSpecV1 {
  readonly name: FirstPartyLongTailToolNameV1;
  readonly group: FirstPartyLongTailToolGroupV1;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly parameters: ToolInputJSONSchema;
  readonly risk: ToolRiskMetadataV1;
  readonly permission: (args: Readonly<Record<string, unknown>>) => PermissionResult;
  readonly readOnly: (args: Readonly<Record<string, unknown>>) => boolean;
  readonly concurrencySafe: (args: Readonly<Record<string, unknown>>) => boolean;
  readonly destructive: (args: Readonly<Record<string, unknown>>) => boolean;
  readonly fileEdit: (args: Readonly<Record<string, unknown>>) => boolean;
  readonly userFacingName: (args: Readonly<Record<string, unknown>>) => string;
  readonly summarize?: (args: Readonly<Record<string, unknown>>, result: ToolResult) => string;
}

const allow = (): PermissionResult => ({ behavior: 'allow' });
const always = (): boolean => true;
const never = (): boolean => false;

const WORKSPACE_READ_RISK: ToolRiskMetadataV1 = {
  readOnly: true,
  destructive: false,
  fileEdit: false,
  effect: 'workspace_read',
  network: 'none',
};
const WORKSPACE_WRITE_RISK: ToolRiskMetadataV1 = {
  readOnly: false,
  destructive: true,
  fileEdit: false,
  effect: 'workspace_write',
  network: 'none',
};
const EXTERNAL_WRITE_RISK: ToolRiskMetadataV1 = {
  readOnly: false,
  destructive: true,
  fileEdit: false,
  effect: 'external_write',
  network: 'write',
};
const NETWORK_READ_RISK: ToolRiskMetadataV1 = {
  readOnly: true,
  destructive: false,
  fileEdit: false,
  effect: 'none',
  network: 'read',
};

const PREAPPROVED_WEB_FETCH_HOSTS = new Set([
  'github.com',
  'docs.google.com',
  'stackoverflow.com',
  'npmjs.com',
  'nodejs.org',
  'typescriptlang.org',
  'reactjs.org',
  'vuejs.org',
  'python.org',
  'golang.org',
  'rust-lang.org',
  'mdn.mozilla.org',
  'developer.mozilla.org',
  'wikipedia.org',
  'arxiv.org',
]);

export function isPreapprovedWebFetchHostV1(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return [...PREAPPROVED_WEB_FETCH_HOSTS].some(
    host => normalized === host || normalized.endsWith(`.${host}`)
  );
}

export const LONG_TAIL_TOOL_DESCRIPTORS = deepFreeze<readonly LongTailToolDescriptorSpecV1[]>([
  {
    name: 'git_status',
    group: 'git',
    aliases: [],
    description: '检查 Git 工作区状态，返回未暂存和未提交的文件列表。',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '工作目录（可选，默认当前目录）' },
      },
      required: [],
    },
    risk: WORKSPACE_READ_RISK,
    permission: allow,
    readOnly: always,
    concurrencySafe: always,
    destructive: never,
    fileEdit: never,
    userFacingName: () => 'Git Status',
  },
  {
    name: 'git_push',
    group: 'git',
    aliases: [],
    description: `安全执行 git push，自动验证 git status、显式 staging 边界和认证状态。

工作流程：
1. 检查 git status --porcelain（未暂存/未提交的文件）
2. 仅对显式文件 paths 执行 git add -- <paths>；拒绝目录、glob/pathspec 和预暂存越界文件
3. git commit（如果需要）
4. 若提交后仍有未提交文件，在任何远程写入前停止
5. 检查远程认证状态
6. git push
7. 验证 push 成功

Issue #18/#23 修复：不再在未验证的情况下声称成功。`,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message（如果有变更需要提交）' },
        add_all: {
          type: 'boolean',
          description: '已废弃且禁止；请使用 paths 显式列出要暂存的文件',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要暂存的精确仓库相对文件路径；存在工作区变更时必填',
        },
        cwd: { type: 'string', description: '工作目录（可选）' },
        verify: { type: 'boolean', description: '是否验证远程认证（默认 true）' },
      },
      required: ['message'],
    },
    risk: EXTERNAL_WRITE_RISK,
    permission: args => ({
      behavior: 'ask',
      reason:
        Array.isArray(args.paths) && args.paths.length > 0
          ? `git push will stage ${args.paths.length} explicit path(s), commit, and modify the remote repository`
          : 'git push will modify the remote repository and refuses uncommitted changes without explicit paths',
    }),
    readOnly: never,
    concurrencySafe: never,
    destructive: always,
    fileEdit: never,
    userFacingName: args => `Git Push: ${String(args.message ?? '').slice(0, 30)}`,
  },
  {
    name: 'git_commit',
    group: 'git',
    aliases: [],
    description: `提交工作区变更到本地仓库。

工作流程：
1. 检查 git status --porcelain
2. 仅对显式 paths 暂存
3. git commit -m <message>
4. 验证 commit 成功

安全：要求明确 message；拒绝盲目暂存未受控文件。`,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message（必填）' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要暂存的精确仓库相对文件路径；与 all 互斥',
        },
        all: { type: 'boolean', description: '已废弃且禁止；必须使用 paths 精确列出文件' },
        cwd: { type: 'string', description: '工作目录（可选）' },
      },
      required: ['message'],
    },
    risk: WORKSPACE_WRITE_RISK,
    permission: () => ({
      behavior: 'ask',
      reason: 'git commit will create a new commit in the local repository',
    }),
    readOnly: never,
    concurrencySafe: never,
    destructive: always,
    fileEdit: never,
    userFacingName: args => `Git Commit: ${String(args.message ?? '').slice(0, 30)}`,
  },
  {
    name: 'git_diff',
    group: 'git',
    aliases: [],
    description:
      '显示 Git 差异。默认工作区 vs 暂存区；staged=true 显示已暂存 vs HEAD；可指定 paths。',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: '显示已暂存变更（vs HEAD），默认 false' },
        stat: { type: 'boolean', description: '仅显示统计摘要（默认 false）' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '限定路径（可选）',
        },
        cwd: { type: 'string', description: '工作目录（可选）' },
      },
      required: [],
    },
    risk: WORKSPACE_READ_RISK,
    permission: allow,
    readOnly: always,
    concurrencySafe: always,
    destructive: never,
    fileEdit: never,
    userFacingName: () => 'Git Diff',
  },
  {
    name: 'git_log',
    group: 'git',
    aliases: [],
    description: '显示提交历史。可指定条数与格式。',
    parameters: {
      type: 'object',
      properties: {
        max_count: { type: 'number', description: '返回的最大提交数（默认 20，上限 200）' },
        oneline: { type: 'boolean', description: '单行精简格式（默认 true）' },
        cwd: { type: 'string', description: '工作目录（可选）' },
      },
      required: [],
    },
    risk: WORKSPACE_READ_RISK,
    permission: allow,
    readOnly: always,
    concurrencySafe: always,
    destructive: never,
    fileEdit: never,
    userFacingName: () => 'Git Log',
  },
  {
    name: 'git_branch',
    group: 'git',
    aliases: [],
    description: `分支操作。

action:
- list（默认）: 列出本地分支，标记当前分支（*）与上游跟踪
- create: 基于当前 HEAD 创建新分支（不切换）
- switch: 切换到已有分支
- delete: 删除本地分支（需 force 才允许未合并删除）`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'switch', 'delete'],
          description: '操作类型（默认 list）',
        },
        name: { type: 'string', description: '分支名（create/switch/delete 必填）' },
        force: { type: 'boolean', description: 'delete 时允许删除未合并分支（默认 false）' },
        cwd: { type: 'string', description: '工作目录（可选）' },
      },
      required: [],
    },
    risk: WORKSPACE_WRITE_RISK,
    permission: args => {
      const action = typeof args.action === 'string' ? args.action : 'list';
      if (action === 'list') return { behavior: 'allow' };
      const name = typeof args.name === 'string' ? args.name : '<unnamed>';
      const reason =
        action === 'switch'
          ? `git switch ${name} will change the checked-out branch and update working-tree files`
          : action === 'delete'
            ? `git branch delete will remove the local branch ${name}`
            : `git branch ${action} will modify local branch state`;
      return { behavior: 'ask', reason };
    },
    readOnly: args => (typeof args.action === 'string' ? args.action : 'list') === 'list',
    concurrencySafe: never,
    destructive: args => (typeof args.action === 'string' ? args.action : 'list') !== 'list',
    fileEdit: never,
    userFacingName: args => `Git Branch: ${String(args.action ?? 'list')}`,
  },
  {
    name: 'lsp_get_definition',
    group: 'lsp',
    aliases: [],
    description:
      'Get definition location for a symbol at a position. Supports TypeScript, JavaScript, Python.',
    parameters: positionSchema(),
    risk: WORKSPACE_READ_RISK,
    permission: allow,
    readOnly: always,
    concurrencySafe: never,
    destructive: never,
    fileEdit: never,
    userFacingName: () => 'lsp_get_definition',
  },
  {
    name: 'lsp_get_references',
    group: 'lsp',
    aliases: [],
    description:
      'Get all references to a symbol at a position. Supports TypeScript, JavaScript, Python.',
    parameters: {
      ...positionSchema(),
      properties: {
        ...positionSchema().properties,
        include_declaration: {
          type: 'boolean',
          description: 'Include declaration in results (default: true)',
        },
      },
    },
    risk: WORKSPACE_READ_RISK,
    permission: allow,
    readOnly: always,
    concurrencySafe: never,
    destructive: never,
    fileEdit: never,
    userFacingName: () => 'lsp_get_references',
  },
  {
    name: 'lsp_get_hover',
    group: 'lsp',
    aliases: [],
    description:
      'Get hover information (type, docs) for a symbol at a position. Supports TypeScript, JavaScript, Python.',
    parameters: positionSchema(),
    risk: WORKSPACE_READ_RISK,
    permission: allow,
    readOnly: always,
    concurrencySafe: never,
    destructive: never,
    fileEdit: never,
    userFacingName: () => 'lsp_get_hover',
  },
  {
    name: 'lsp_get_diagnostics',
    group: 'lsp',
    aliases: [],
    description:
      'Get diagnostics (errors, warnings) for a file. Supports TypeScript, JavaScript, Python.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['file_path'],
    },
    risk: WORKSPACE_READ_RISK,
    permission: allow,
    readOnly: always,
    concurrencySafe: never,
    destructive: never,
    fileEdit: never,
    userFacingName: () => 'lsp_get_diagnostics',
  },
  {
    name: 'web_fetch',
    group: 'web',
    aliases: [],
    description: `Fetch content from a URL and process with a prompt.
IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs.
Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub).`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch content from (must be a valid URL)' },
        prompt: {
          type: 'string',
          description:
            'The prompt to run on the fetched content (e.g. "extract the title", "summarize the content")',
        },
      },
      required: ['url', 'prompt'],
    },
    risk: NETWORK_READ_RISK,
    permission: args => {
      try {
        const url = new URL(String(args.url ?? ''));
        if (isPreapprovedWebFetchHostV1(url.hostname)) {
          return { behavior: 'allow', reason: 'Preapproved host' };
        }
      } catch {
        // Invalid input remains an execution-time validation error.
      }
      return { behavior: 'ask', reason: 'Fetching external URL' };
    },
    readOnly: always,
    concurrencySafe: always,
    destructive: never,
    fileEdit: never,
    userFacingName: args => {
      try {
        return `Fetch ${new URL(String(args.url ?? '')).hostname}`;
      } catch {
        return `Fetch ${String(args.url ?? '')}`;
      }
    },
  },
  {
    name: 'web_search',
    group: 'web',
    aliases: [],
    description: `Search the web through the built-in WebSearch provider chain.
Orion Code tries provider-native MCP first in auto mode, then falls back to configured search adapters such as Tavily, Brave, custom search, or DuckDuckGo.
You MUST include the Sources section with markdown hyperlinks in your response.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (minimum 2 characters)' },
        limit: { type: 'number', description: 'Maximum number of results (optional, default 5)' },
      },
      required: ['query'],
    },
    risk: NETWORK_READ_RISK,
    permission: () => ({
      behavior: 'ask',
      reason: 'Web search may query external services',
    }),
    readOnly: always,
    concurrencySafe: always,
    destructive: never,
    fileEdit: never,
    userFacingName: args => `Search "${String(args.query ?? '').slice(0, 30)}"`,
  },
]);

export function longTailToolDescriptorV1(
  name: FirstPartyLongTailToolNameV1
): LongTailToolDescriptorSpecV1 {
  const descriptor = LONG_TAIL_TOOL_DESCRIPTORS.find(candidate => candidate.name === name);
  if (!descriptor) throw new Error(`Unknown first-party long-tail tool descriptor: ${name}`);
  return descriptor;
}

function positionSchema(): ToolInputJSONSchema {
  return {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      line: { type: 'number', description: 'Line number (1-based)' },
      character: { type: 'number', description: 'Character position (1-based)' },
    },
    required: ['file_path', 'line', 'character'],
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
