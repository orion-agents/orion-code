import type { SlashCommand } from '../../commands/types';
import type { SuggestionItem } from './types';

export const DEFAULT_COMMAND_LIMIT = 8;
export const FILTERED_COMMAND_LIMIT = 6;

export interface CommandSuggestionResult {
  query: string;
  total: number;
  limit: number;
  moreCount: number;
  items: SuggestionItem[];
  commands: SlashCommand[];
}

export interface BuildCommandSuggestionsOptions {
  defaultLimit?: number;
  filteredLimit?: number;
}

export function buildCommandSuggestions(
  commands: SlashCommand[],
  query: string = '',
  options: BuildCommandSuggestionsOptions = {}
): CommandSuggestionResult {
  const normalizedQuery = normalizeQuery(query);
  const defaultLimit = options.defaultLimit ?? DEFAULT_COMMAND_LIMIT;
  const filteredLimit = options.filteredLimit ?? FILTERED_COMMAND_LIMIT;
  const limit = normalizedQuery ? filteredLimit : defaultLimit;

  const visibleCommands = commands.filter(cmd => !cmd.isHidden);
  const matches = normalizedQuery
    ? visibleCommands
      .filter(cmd => commandMatches(cmd, normalizedQuery))
      .sort((a, b) => commandMatchRank(a, normalizedQuery) - commandMatchRank(b, normalizedQuery))
    : visibleCommands;
  const limitedCommands = matches.slice(0, limit);

  return {
    query: normalizedQuery,
    total: matches.length,
    limit,
    moreCount: Math.max(0, matches.length - limitedCommands.length),
    items: limitedCommands.map(commandToSuggestion),
    commands: limitedCommands,
  };
}

export function commandToSuggestion(command: SlashCommand): SuggestionItem {
  const shortcut = command.aliases?.[0];
  return {
    id: `command:${command.name}`,
    kind: 'command',
    label: `/${command.name}`,
    detail: command.description,
    shortcut,
    value: `/${command.name}`,
    metadata: {
      argumentHint: command.argumentHint,
      type: command.type,
      aliases: command.aliases ?? [],
    },
  };
}

function commandMatches(command: SlashCommand, query: string): boolean {
  const name = command.name.toLowerCase();
  if (name.startsWith(query)) return true;
  return command.aliases?.some(alias => alias.toLowerCase().startsWith(query)) ?? false;
}

function commandMatchRank(command: SlashCommand, query: string): number {
  const name = command.name.toLowerCase();
  const aliases = command.aliases?.map(alias => alias.toLowerCase()) ?? [];

  if (name === query) return 0;
  if (aliases.some(alias => alias === query)) return 1;
  if (name.startsWith(query)) return 2;
  if (aliases.some(alias => alias.startsWith(query))) return 3;
  return 4;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/^\//, '').toLowerCase();
}
