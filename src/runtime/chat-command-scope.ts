import type { CommandUiRenderer, RegisteredSlashCommand } from '../commands/types';
import type { UiEventSink } from './ui-events';

export function rejectUnsupportedRenderer(
  events: UiEventSink,
  command: RegisteredSlashCommand,
  activeRenderer: CommandUiRenderer
): boolean {
  if (!command.rendererScope || command.rendererScope.includes(activeRenderer)) return false;

  events.append({
    role: 'error',
    title: `/${command.name} unavailable`,
    content: `/${command.name} is not available in the ${activeRenderer} renderer. Supported renderers: ${command.rendererScope.join(', ')}.`,
    errorLayer: 'runtime',
    command: {
      id: command.id,
      name: command.name,
      source: command.source,
      success: false,
    },
  });
  return true;
}
