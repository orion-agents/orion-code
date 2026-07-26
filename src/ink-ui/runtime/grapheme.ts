/**
 * Compatibility re-export.
 *
 * The grapheme segmentation algorithm has been migrated to the shared
 * runtime composer module at `src/runtime/composer/grapheme.ts`.
 * This file re-exports from the shared location so existing Ink tests
 * and components continue to work without changes.
 */

export {
  segmentGraphemes,
  previousGraphemeBoundary,
  nextGraphemeBoundary,
  floorGraphemeBoundary,
  type GraphemeSegment,
} from '../../runtime/composer/grapheme';
