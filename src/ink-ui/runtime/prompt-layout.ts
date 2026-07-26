/**
 * Compatibility re-export.
 *
 * The prompt layout algorithm has been migrated to the shared runtime
 * composer module at `src/runtime/composer/layout.ts`.
 * This file re-exports from the shared location so existing Ink tests
 * and components continue to work without changes.
 */

export {
  promptContentWidth,
  promptTextWidth,
  splitByVisualWidth,
  getPromptVisualLines,
  getVisiblePromptVisualLines,
  getPromptInputViewport,
  formatPromptVisualLine,
  PROMPT_CURSOR_GLYPH,
  type PromptVisualLine,
  type PromptInputViewport,
} from '../../runtime/composer/layout';
