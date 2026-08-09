/**
 * Orion Code slash-command registry.
 *
 * Command definitions are grouped by product domain while handler implementations
 * remain isolated from registry lookup. Keep the concatenation order stable: aliases
 * and duplicate detection use first-registration semantics.
 */

import type { CommandContext, SlashCommand } from './types';
import { sortCommands } from './core-command-handlers';
import { WORKFLOW_COMMANDS } from './workflow-commands';
import { SESSION_COMMANDS } from './session-commands';
import { CONTEXT_COMMANDS } from './context-commands';
import { TOOL_COMMANDS } from './tool-commands';
import { MODEL_COMMANDS } from './model-commands';
import { createSystemCommands } from './system-commands';
import { DIAGNOSTIC_COMMANDS } from './diagnostic-commands';
import { LEGACY_COMMANDS } from './legacy-commands';

export function getVisibleCommands(renderer?: CommandContext['uiRenderer']): SlashCommand[] {
  return sortCommands(
    COMMANDS.filter(
      command =>
        !command.isHidden &&
        (!renderer || !command.rendererScope || command.rendererScope.includes(renderer))
    )
  );
}

const SYSTEM_COMMANDS = createSystemCommands(getVisibleCommands);

const COMMANDS: SlashCommand[] = [
  ...WORKFLOW_COMMANDS,
  ...SESSION_COMMANDS,
  ...CONTEXT_COMMANDS,
  ...TOOL_COMMANDS,
  ...MODEL_COMMANDS,
  ...SYSTEM_COMMANDS,
  ...DIAGNOSTIC_COMMANDS,
  ...LEGACY_COMMANDS,
];

export function getCommands(): SlashCommand[] {
  return sortCommands(COMMANDS);
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find(command => command.name === name || command.aliases?.includes(name));
}

export function getCommandNames(): string[] {
  return getVisibleCommands().map(command => command.name);
}

export {
  handleChat as executeChat,
  getCommandCategoryLabel,
  sortCommands,
} from './core-command-handlers';
