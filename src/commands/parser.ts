/**
 * orion code - Command Parser
 *
 * 解析输入，区分 `/` 前缀命令和非命令 chat 输入。
 * 提供命令建议功能。
 */

import { findCommand, getCommandNames } from './index';

// ============================================================================
// 解析结果
// ============================================================================

export interface ParsedInput {
  isCommand: boolean;
  name: string;
  args: string;
  /** Exact argument bytes after the command separator, excluding that separator. */
  rawArgs?: string;
  /** Opaque tail after a standalone `--`; never tokenized or shell-expanded. */
  opaqueTail?: string;
  /** Stable id when the exact name or alias resolves to a registered command. */
  commandId?: string;
  canonicalName?: string;
}

function isPathLikeSlashInput(input: string): boolean {
  const firstToken = input.split(/\s+/u, 1)[0] || '';
  const slashBody = firstToken.slice(1);
  return slashBody.includes('/') || slashBody.includes('.');
}

// ============================================================================
// 解析器
// ============================================================================

/**
 * 解析用户输入
 * - `/` 前缀 → 命令
 * - 非 `/` 前缀 → 直接作为 chat 输入
 */
export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (!trimmed) {
    return { isCommand: false, name: '', args: '' };
  }

  // `/` 前缀且不是绝对路径 → 命令
  if (line.startsWith('/') && !isPathLikeSlashInput(line)) {
    const match = line.match(/^\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:[ \t]+([\s\S]*))?$/u);
    if (!match) return { isCommand: false, name: '', args: line };

    const name = (match[1] ?? '').toLowerCase();
    const rawArgs = match[2] ?? '';
    const args = rawArgs.trim();
    const opaqueMatch = rawArgs.match(/(?:^|[ \t])--(?:[ \t]+|$)([\s\S]*)$/u);
    const command = findCommand(name);
    return {
      isCommand: true,
      name,
      args,
      rawArgs,
      ...(opaqueMatch ? { opaqueTail: opaqueMatch[1] ?? '' } : {}),
      ...(command ? { commandId: command.id, canonicalName: command.name } : {}),
    };
  }

  // 非 `/` 前缀 → 直接作为 chat 输入
  return { isCommand: false, name: '', args: trimmed };
}

/**
 * 构建命令建议（用于 Tab 补全和未知命令提示）
 */
export function buildCommandSuggestions(partial: string): string[] {
  const names = getCommandNames();
  const normalized = partial.toLowerCase();
  if (!normalized) return names;
  return names.filter(n => n.startsWith(normalized));
}

/**
 * Complete an exact command's first typed subcommand. Suggestions are display
 * candidates only; the parser still requires an exact name/alias to execute.
 */
export function buildCommandLineSuggestions(line: string): string[] {
  if (!line.startsWith('/') || isPathLikeSlashInput(line)) return [];
  const match = line.match(/^\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:[ \t]+([^ \t]*))?$/u);
  if (!match) return [];

  const name = match[1].toLowerCase();
  const command = findCommand(name);
  if (!command) return buildCommandSuggestions(name).map(candidate => `/${candidate}`);

  const subcommands = command.argumentSchema.subcommands;
  if (!subcommands?.length || match[2] === undefined) return [];
  const partial = match[2].toLowerCase();
  return subcommands
    .filter(candidate => candidate.startsWith(partial))
    .map(candidate => `/${command.name} ${candidate}`);
}

/**
 * Readline completer 函数
 */
export function createCompleter(): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const trimmed = line.trim();
    if (trimmed.startsWith('/') && !isPathLikeSlashInput(trimmed)) {
      const lineSuggestions = buildCommandLineSuggestions(line);
      if (lineSuggestions.length > 0) return [lineSuggestions, line];
      const partial = trimmed.slice(1);
      if (/\s/u.test(partial)) return [[], line];
      const suggestions = buildCommandSuggestions(partial);
      // 返回补全后的完整行（带 `/` 前缀）
      const completions = suggestions.map(s => '/' + s);
      return [completions, line];
    }
    return [[], line];
  };
}
