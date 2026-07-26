import { getVisibleCommands } from '../commands';
import { createFilePickerState, getFileMentionQuery } from '../runtime/ui-view-model';
import { matchFiles } from '../services/file-glob';

export type ReadlineCompleter = (line: string) => [string[], string];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function completeSlashCommand(line: string): [string[], string] {
  const match = line.match(/^\/([^\s]*)$/u);
  if (!match) return [[], line];

  const partial = match[1];
  const commands = getVisibleCommands();
  const nameMatches = commands.filter(command => command.name.startsWith(partial));
  const aliasMatches = nameMatches.length > 0
    ? []
    : commands.filter(command => command.aliases?.some(alias => alias.startsWith(partial)));
  const completions = [...nameMatches, ...aliasMatches].map(command => `/${command.name} `);

  return [unique(completions), line];
}

export function completeFileMention(line: string, cwd: string): [string[], string] {
  const query = getFileMentionQuery(line);
  if (!query) return [[], line];

  const state = createFilePickerState({
    input: line,
    files: matchFiles(query.query, cwd),
  });
  const prefix = `${query.base}@`;
  const completions = state?.visibleItems.map(file =>
    `${prefix}${file.value}${file.isDirectory ? '' : ' '}`
  ) ?? [];

  return [unique(completions), line];
}

export function createTerminalCompleter(cwd: string): ReadlineCompleter {
  return (line: string): [string[], string] => {
    const slash = completeSlashCommand(line);
    if (slash[0].length > 0) return slash;

    return completeFileMention(line, cwd);
  };
}

export interface TerminalTabCompletionResult {
  value: string;
  matches: string[];
  changed: boolean;
}

export function applySingleTerminalTabCompletion(input: string, cwd: string): TerminalTabCompletionResult {
  const completer = createTerminalCompleter(cwd);
  const [matches] = completer(input);
  if (matches.length === 1) {
    return { value: matches[0], matches, changed: matches[0] !== input };
  }

  const prefix = commonPrefix(matches);
  if (prefix && prefix.length > input.length) {
    return { value: prefix, matches, changed: true };
  }

  return { value: input, matches, changed: false };
}

export function summarizeTerminalCompletions(matches: string[], maxItems = 8): string {
  if (matches.length === 0) return 'No completions.';
  const visible = matches.slice(0, maxItems).map(match => match.trim()).join('  ');
  const suffix = matches.length > maxItems ? `  +${matches.length - maxItems} more` : '';
  return `Completions: ${visible}${suffix}`;
}

export function applyTerminalTabCompletion(input: string, cwd: string): string {
  if (!input.includes('\t')) return input;

  let current = '';
  for (const chunk of input.split(/(\t+)/u)) {
    if (!chunk) continue;
    if (!chunk.includes('\t')) {
      current += chunk;
      continue;
    }

    for (let i = 0; i < chunk.length; i++) {
      current = applySingleTerminalTabCompletion(current, cwd).value;
    }
  }

  return current;
}
