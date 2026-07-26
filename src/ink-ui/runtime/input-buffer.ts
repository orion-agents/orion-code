/**
 * Compatibility re-export.
 *
 * The input buffer reducer has been migrated to the shared runtime
 * composer module at `src/runtime/composer/buffer.ts`.
 * This file re-exports from the shared location so existing Ink tests
 * and components continue to work without changes.
 */

export {
  reduceInputBuffer,
  reduceInputChunk,
  clampInputCursor,
  moveInputCursor,
  initialInputBuffer,
  type InputBuffer,
  type InputBufferAction,
} from '../../runtime/composer/buffer';
