import type { ToolInputJSONSchema } from '../../framework/tool';

export type FirstPartyCoreToolNameV1 =
  | 'edit_file'
  | 'exec_command'
  | 'glob'
  | 'grep'
  | 'list_files'
  | 'read_file'
  | 'write_file';

export interface CoreToolDescriptorSpecV1 {
  readonly name: FirstPartyCoreToolNameV1;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly parameters: ToolInputJSONSchema;
  readonly permission: 'allow' | 'ask';
  readonly permissionReason?: string;
  readonly readOnly: boolean;
  readonly concurrencySafe: boolean;
  readonly destructive: boolean;
  readonly fileEdit: boolean;
}

export const CORE_TOOL_DESCRIPTORS = deepFreeze<readonly CoreToolDescriptorSpecV1[]>([
  {
    name: 'read_file',
    aliases: [],
    description: '读取文件内容，支持从指定行开始分页。返回文件内容字符串。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
        maxLines: { type: 'number', description: '最大读取行数（可选，默认 500 行）' },
        offset: {
          type: 'number',
          description: '开始读取的行号（可选，1-based，默认第 1 行）',
        },
      },
      required: ['path'],
    },
    permission: 'allow',
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    fileEdit: false,
  },
  {
    name: 'write_file',
    aliases: [],
    description: '将内容写入文件。如果文件不存在则创建，存在则覆盖。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
        content: { type: 'string', description: '要写入的文件内容' },
      },
      required: ['path', 'content'],
    },
    permission: 'ask',
    permissionReason: 'Write operation may modify existing files',
    readOnly: false,
    concurrencySafe: false,
    destructive: true,
    fileEdit: true,
  },
  {
    name: 'list_files',
    aliases: [],
    description: '列出指定目录中的文件和子目录。支持控制递归深度。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径（绝对路径或相对路径）' },
        maxDepth: {
          type: 'number',
          description: '最大递归深度（可选，默认 2，范围 0-8）',
          minimum: 0,
          maximum: 8,
        },
      },
      required: ['path'],
    },
    permission: 'allow',
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    fileEdit: false,
  },
  {
    name: 'exec_command',
    aliases: [],
    description: '执行一个 shell 命令。返回 stdout 和 stderr。输出超过 maxOutput 会自动截断。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录（可选，默认当前目录）' },
        timeout: {
          type: 'number',
          description: '超时时间 ms（可选，默认 30000，范围 1-600000）',
          minimum: 1,
          maximum: 600000,
        },
        maxOutput: {
          type: 'number',
          description: '最大输出字节数（可选，默认 51200，范围 1024-10485760，超出截断）',
          minimum: 1024,
          maximum: 10485760,
        },
      },
      required: ['command'],
    },
    permission: 'ask',
    permissionReason: 'Command requires confirmation',
    readOnly: false,
    concurrencySafe: false,
    destructive: true,
    fileEdit: false,
  },
  {
    name: 'edit_file',
    aliases: [],
    description:
      '对文件进行精确字符串替换。old_string 必须在文件中唯一匹配，否则拒绝执行。使用 replace_all 可替换所有精确匹配；只有显式 fuzzy_match=true 时才尝试宽松空白匹配。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
        old_string: { type: 'string', description: '要替换的字符串（必须精确匹配）' },
        new_string: { type: 'string', description: '替换后的字符串' },
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
    permission: 'ask',
    permissionReason: 'Edit operation modifies file contents',
    readOnly: false,
    concurrencySafe: false,
    destructive: true,
    fileEdit: true,
  },
  {
    name: 'glob',
    aliases: [],
    description: '使用 glob 模式搜索文件。支持 **（递归）、*（任意字符）、?（单个字符）等通配符。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob 模式（如 **/*.ts, src/**/*.js）' },
        path: { type: 'string', description: '搜索起始目录（可选，默认当前目录）' },
      },
      required: ['pattern'],
    },
    permission: 'allow',
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    fileEdit: false,
  },
  {
    name: 'grep',
    aliases: [],
    description: '在文件中搜索正则表达式模式。返回匹配的文件路径和行内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式模式' },
        path: { type: 'string', description: '搜索路径（可选，默认当前目录）' },
        glob: { type: 'string', description: '文件过滤模式（可选，如 *.ts）' },
        context: { type: 'number', description: '上下文行数（可选，默认 0）' },
      },
      required: ['pattern'],
    },
    permission: 'allow',
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    fileEdit: false,
  },
]);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

export function coreToolDescriptorV1(name: FirstPartyCoreToolNameV1): CoreToolDescriptorSpecV1 {
  const descriptor = CORE_TOOL_DESCRIPTORS.find(candidate => candidate.name === name);
  if (!descriptor) throw new Error(`Unknown first-party core tool descriptor: ${name}`);
  return descriptor;
}
