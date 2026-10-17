/**
 * v0.3.17 S2 — structured Git diff document.
 *
 * The v1 diff page exposed raw unified-diff text lines and a `## Staged` style section
 * banner. That shape made line numbers, side-by-side rendering, hunk folding and the
 * "jump to next change" navigation impossible without re-parsing text in the browser.
 *
 * This module parses the raw lines the Host already produces into a hunk/line model with
 * real old/new line numbers, a stable line id, per-hunk completeness, and the write
 * capabilities that apply to the selected comparison source.
 *
 * Deliberate limits for S2:
 *   - No hunk or line level writes. `capabilities.stageHunk` / `stageLines` are always
 *     false and carry a reason; staging granularity is S3 (plan §10).
 *   - Word level highlighting and ignore-whitespace views are S5. This model preserves the
 *     original text so those can be computed later without a protocol change.
 */
import type { WebGitFileSourceV1 } from './git-file-source';

export type GitDiffLineKindV2 = 'context' | 'addition' | 'deletion' | 'meta';

export interface GitDiffLineV2 {
  /** Stable inside one document: `<hunkId>#<index>`. */
  readonly lineId: string;
  readonly kind: GitDiffLineKindV2;
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  /** Content without the leading `+`/`-`/space marker. */
  readonly text: string;
  /** The original line including its marker, so copy never loses fidelity. */
  readonly raw: string;
}

export interface GitHunkV2 {
  readonly hunkId: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly contextLabel: string;
  readonly lines: readonly GitDiffLineV2[];
  /** False when pagination cut this hunk; partial hunks must not be written (plan G3). */
  readonly complete: boolean;
}

export type GitDiffDocumentKindV2 = 'text' | 'binary' | 'symlink' | 'submodule' | 'metadata';

/**
 * v0.3.26 #275 — parser state for a hunk that a page boundary split. Carried in
 * the continuation cursor so the next page re-opens the hunk with its stable
 * identity (`index:oldStart:newStart`) and correct running line cursors instead
 * of demoting the continuation rows to document meta.
 */
export interface GitDiffHunkResumeV1 {
  readonly header: string;
  readonly index: number;
  readonly oldCursor: number;
  readonly newCursor: number;
}

export interface GitDiffCapabilitiesV2 {
  readonly stageFile: boolean;
  readonly unstageFile: boolean;
  readonly stageHunk: boolean;
  readonly unstageHunk: boolean;
  readonly stageLines: boolean;
  readonly reason?: string;
}

export interface GitDiffDocumentV2 {
  readonly schemaVersion: 2;
  readonly fileToken: string;
  readonly path: string;
  readonly source: WebGitFileSourceV1;
  /** Set only for a historical comparison: the base tree and how it was chosen. */
  readonly baseOid?: string;
  readonly baseLabel?: string;
  readonly repositoryRevision: string;
  readonly kind: GitDiffDocumentKindV2;
  readonly binary: boolean;
  readonly hunks: readonly GitHunkV2[];
  /** Metadata lines that are not part of any hunk (file headers, mode changes, …). */
  readonly meta: readonly string[];
  /**
   * v0.3.26 #275 — the hunk still open when this page ended, for the
   * continuation cursor. Null when the page ends on a hunk boundary.
   */
  readonly pendingHunk: GitDiffHunkResumeV1 | null;
  readonly completeness: 'complete' | 'paged' | 'limited';
  readonly additions: number;
  readonly deletions: number;
  readonly lineCount: number;
  readonly nextCursor: string | null;
  readonly capabilities: GitDiffCapabilitiesV2;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;
const NO_NEWLINE = '\\ No newline at end of file';

/** Document level header lines Git emits before the first hunk. */
function isMetaLine(line: string): boolean {
  return (
    line.startsWith('## ') ||
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('dissimilarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('copy from ') ||
    line.startsWith('copy to ') ||
    line.startsWith('Binary files ') ||
    line.startsWith('GIT binary patch') ||
    line.startsWith('Submodule ')
  );
}

function detectKind(lines: readonly string[]): GitDiffDocumentKindV2 {
  if (lines.some(line => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))) {
    return 'binary';
  }
  if (lines.some(line => line.startsWith('Submodule '))) return 'submodule';
  if (lines.some(line => line.startsWith('old mode ') || line.startsWith('new mode '))) {
    return 'metadata';
  }
  return 'text';
}

/** Write capabilities implied by the comparison source. */
function capabilitiesFor(source: WebGitFileSourceV1): GitDiffCapabilitiesV2 {
  const hunkWritesUnavailable = 'Hunk 与选中行级写入将在 S3 提供。';
  if (source === 'staged') {
    return Object.freeze({
      stageFile: false,
      unstageFile: true,
      stageHunk: false,
      unstageHunk: false,
      stageLines: false,
      reason: hunkWritesUnavailable,
    });
  }
  if (source === 'unstaged' || source === 'untracked') {
    return Object.freeze({
      stageFile: true,
      unstageFile: false,
      stageHunk: false,
      unstageHunk: false,
      stageLines: false,
      reason: hunkWritesUnavailable,
    });
  }
  return Object.freeze({
    stageFile: false,
    unstageFile: false,
    stageHunk: false,
    unstageHunk: false,
    stageLines: false,
    reason: '冲突文件本版不提供一键解决，请在 Files 打开处理。',
  });
}

export function parseGitDiffDocument(input: {
  readonly fileToken: string;
  readonly path: string;
  readonly source: WebGitFileSourceV1;
  readonly repositoryRevision: string;
  readonly lines: readonly string[];
  readonly hasMore: boolean;
  /** Host-signed continuation cursor, or null. Never synthesised here. */
  readonly nextCursor: string | null;
  /** v0.3.26 #275 — hunk state from the previous page's `pendingHunk`. */
  readonly resume?: GitDiffHunkResumeV1 | null;
}): GitDiffDocumentV2 {
  const kind = detectKind(input.lines);
  const binary = kind === 'binary';
  const meta: string[] = [];
  const hunks: GitHunkV2[] = [];
  let additions = 0;
  let deletions = 0;

  let current:
    | {
        header: string;
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        contextLabel: string;
        lines: GitDiffLineV2[];
        oldCursor: number;
        newCursor: number;
        index: number;
      }
    | undefined;

  const openHunk = (header: string, index: number, oldCursor: number, newCursor: number): void => {
    const headerMatch = HUNK_HEADER.exec(header);
    if (!headerMatch) return;
    const oldStart = Number(headerMatch[1]);
    const newStart = Number(headerMatch[3]);
    current = {
      header,
      oldStart,
      oldLines: headerMatch[2] === undefined ? 1 : Number(headerMatch[2]),
      newStart,
      newLines: headerMatch[4] === undefined ? 1 : Number(headerMatch[4]),
      contextLabel: (headerMatch[5] ?? '').trim(),
      lines: [],
      oldCursor,
      newCursor,
      index,
    };
  };

  // v0.3.26 #275 — a continuation page starts mid-hunk: re-open it from the
  // resume state before the first line is classified. A page that happens to
  // start with its own `@@` header simply ignores the resume state.
  if (input.resume && !HUNK_HEADER.test(input.lines[0] ?? '')) {
    openHunk(
      input.resume.header,
      input.resume.index,
      input.resume.oldCursor,
      input.resume.newCursor
    );
  }

  const closeHunk = (): void => {
    if (!current) return;
    const hunkId = `${current.index}:${current.oldStart}:${current.newStart}`;
    // A hunk is complete when it accounts for every line its header promised. The final
    // hunk of a paged read is reported incomplete so callers cannot write a partial patch.
    const consumedOld = current.oldCursor - current.oldStart;
    const consumedNew = current.newCursor - current.newStart;
    const reached = consumedOld >= current.oldLines && consumedNew >= current.newLines;
    hunks.push(
      Object.freeze({
        hunkId,
        header: current.header,
        oldStart: current.oldStart,
        oldLines: current.oldLines,
        newStart: current.newStart,
        newLines: current.newLines,
        contextLabel: current.contextLabel,
        lines: Object.freeze(current.lines),
        complete: reached,
      })
    );
    current = undefined;
  };

  for (const raw of input.lines) {
    const headerMatch = HUNK_HEADER.exec(raw);
    if (headerMatch) {
      closeHunk();
      const oldStart = Number(headerMatch[1]);
      const newStart = Number(headerMatch[3]);
      current = {
        header: raw,
        oldStart,
        oldLines: headerMatch[2] === undefined ? 1 : Number(headerMatch[2]),
        newStart,
        newLines: headerMatch[4] === undefined ? 1 : Number(headerMatch[4]),
        contextLabel: (headerMatch[5] ?? '').trim(),
        lines: [],
        oldCursor: oldStart,
        newCursor: newStart,
        index: hunks.length,
      };
      continue;
    }

    if (!current) {
      // Everything before the first hunk is document metadata.
      if (raw) meta.push(raw);
      continue;
    }

    if (raw === NO_NEWLINE) {
      current.lines.push(
        Object.freeze({
          lineId: `${current.index}:${current.oldStart}:${current.newStart}#${current.lines.length}`,
          kind: 'meta' as const,
          oldLineNumber: null,
          newLineNumber: null,
          text: raw,
          raw,
        })
      );
      continue;
    }

    // v0.3.26 #274 — the body marker decides first. A deletion of a line that
    // itself starts with `-- ` produces the body row `--- old comment`, which a
    // header-first check mistook for the old-file header, closing the hunk and
    // demoting the remaining body to document meta. Genuine document-level lines
    // carry no body marker by construction: context rows start with a space,
    // additions with `+`, deletions with `-`, and file boundaries are announced
    // by a markerless `diff --git` line.
    const marker = raw[0];
    const isBodyRow = marker === '+' || marker === '-' || marker === ' ' || raw === '';
    if (!isBodyRow && isMetaLine(raw)) {
      // A file boundary inside one page (multi-command reads) closes the current hunk.
      closeHunk();
      if (raw) meta.push(raw);
      continue;
    }

    const text = raw.length > 0 ? raw.slice(1) : '';
    let lineKind: GitDiffLineKindV2;
    let oldLineNumber: number | null = null;
    let newLineNumber: number | null = null;
    if (marker === '+') {
      lineKind = 'addition';
      newLineNumber = current.newCursor;
      current.newCursor += 1;
      additions += 1;
    } else if (marker === '-') {
      lineKind = 'deletion';
      oldLineNumber = current.oldCursor;
      current.oldCursor += 1;
      deletions += 1;
    } else if (marker === ' ') {
      lineKind = 'context';
      oldLineNumber = current.oldCursor;
      newLineNumber = current.newCursor;
      current.oldCursor += 1;
      current.newCursor += 1;
    } else if (raw === '') {
      // An empty line in a hunk body is a context line for an empty source line.
      lineKind = 'context';
      oldLineNumber = current.oldCursor;
      newLineNumber = current.newCursor;
      current.oldCursor += 1;
      current.newCursor += 1;
    } else {
      lineKind = 'meta';
    }

    current.lines.push(
      Object.freeze({
        lineId: `${current.index}:${current.oldStart}:${current.newStart}#${current.lines.length}`,
        kind: lineKind,
        oldLineNumber,
        newLineNumber,
        text,
        raw,
      })
    );
  }
  // v0.3.26 #275 — a page that ends inside a hunk publishes the hunk state for
  // the continuation cursor; a page ending on a boundary has nothing to resume.
  const pendingHunk: GitDiffHunkResumeV1 | null =
    input.hasMore && current
      ? Object.freeze({
          header: current.header,
          index: current.index,
          oldCursor: current.oldCursor,
          newCursor: current.newCursor,
        })
      : null;
  closeHunk();

  const frozenHunks = Object.freeze(hunks);
  let completeness: GitDiffDocumentV2['completeness'] = 'complete';
  if (input.hasMore) completeness = 'paged';
  else if (frozenHunks.some(hunk => !hunk.complete)) completeness = 'limited';

  return Object.freeze({
    schemaVersion: 2,
    fileToken: input.fileToken,
    // A digest keeps the document self-describing without leaking the raw path shape.
    path: input.path,
    source: input.source,
    repositoryRevision: input.repositoryRevision,
    kind,
    binary,
    hunks: frozenHunks,
    meta: Object.freeze(meta),
    pendingHunk,
    completeness,
    additions,
    deletions,
    lineCount: input.lines.length,
    nextCursor: input.nextCursor,
    capabilities: capabilitiesFor(input.source),
  });
}
