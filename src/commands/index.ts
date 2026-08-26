/**
 * Orion Code slash-command registry.
 *
 * Command definitions are grouped by product domain while handler implementations
 * remain isolated from registry lookup. Keep the concatenation order stable: aliases
 * and duplicate detection use first-registration semantics.
 */

import type { CommandContext, RegisteredSlashCommand, SlashCommand } from './types';
import { registerBuiltinCommands } from './registry';
import { sortCommands } from './core-command-handlers';
import { WORKFLOW_COMMANDS } from './workflow-commands';
import { SESSION_COMMANDS } from './session-commands';
import { CONTEXT_COMMANDS } from './context-commands';
import { TOOL_COMMANDS } from './tool-commands';
import { MODEL_COMMANDS } from './model-commands';
import { createSystemCommands } from './system-commands';
import { DIAGNOSTIC_COMMANDS } from './diagnostic-commands';

export function getVisibleCommands(
  renderer?: CommandContext['uiRenderer']
): RegisteredSlashCommand[] {
  return sortCommands(
    COMMANDS.filter(
      command =>
        !command.isHidden &&
        command.audience !== 'internal' &&
        (!renderer || !command.rendererScope || command.rendererScope.includes(renderer))
    )
  );
}

const SYSTEM_COMMANDS = createSystemCommands(getVisibleCommands);

const COMMAND_DEFINITIONS: SlashCommand[] = [
  ...WORKFLOW_COMMANDS,
  ...SESSION_COMMANDS,
  ...CONTEXT_COMMANDS,
  ...TOOL_COMMANDS,
  ...MODEL_COMMANDS,
  ...SYSTEM_COMMANDS,
  ...DIAGNOSTIC_COMMANDS,
];

const COMMANDS = registerBuiltinCommands(COMMAND_DEFINITIONS);

export function getCommands(): RegisteredSlashCommand[] {
  return sortCommands(COMMANDS);
}

export function findCommand(name: string): RegisteredSlashCommand | undefined {
  const normalized = name.toLowerCase();
  return COMMANDS.find(
    command =>
      command.name.toLowerCase() === normalized ||
      command.aliases?.some(alias => alias.toLowerCase() === normalized)
  );
}

export function getCommandNames(): string[] {
  return getVisibleCommands().map(command => command.name);
}

export { getCommandCategoryLabel, sortCommands } from './core-command-handlers';
