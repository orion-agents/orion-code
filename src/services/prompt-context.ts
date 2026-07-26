import type { Store } from '../framework/store';
import { loadProjectInstructions } from './project-instructions';

export function refreshProjectInstructions(store: Store, cwd: string): string {
  const content = loadProjectInstructions(cwd);
  const current = store.getSnapshot().projectInstructionsContent;
  if (content !== current) {
    store.setState({ projectInstructionsContent: content });
  }
  return content;
}
