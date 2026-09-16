/**
 * v0.3.17 S3 — Host-side patch builder for hunk and line level staging.
 *
 * Plan §7.6 is unambiguous: the Host rebuilds the patch from the content the user actually
 * reviewed, and the browser never submits a patch, a path, a Git flag or a shell command.
 * §7.8 adds the other half: a partial operation is **refused** when the target bytes cannot
 * be reconstructed faithfully, rather than guessing and staging different content.
 *
 * Reconstruction rules for a partial selection of one hunk:
 *   - an unselected deletion becomes context (the line stays in the index);
 *   - an unselected addition is dropped entirely (it never enters the index);
 *   - selected deletions/additions keep their marker.
 * That is exactly "apply only what was ticked", expressed as a patch whose pre-image is the
 * untouched index and whose post-image is index + selection.
 */
import type { GitDiffDocumentV2, GitHunkV2 } from './git-diff-document';

export interface PatchSelectionRequest {
  readonly hunkIds?: readonly string[];
  readonly lineIds?: readonly string[];
}

export type PatchBuildResult =
  | { readonly ok: true; readonly patch: string; readonly selectedChanges: number }
  | { readonly ok: false; readonly reason: string };

/** Sources whose comparison can be expressed as an index patch. */
const PATCHABLE_SOURCES = new Set(['unstaged', 'staged']);

function refusal(doc: GitDiffDocumentV2): string | null {
  if (!PATCHABLE_SOURCES.has(doc.source)) {
    return doc.source === 'untracked'
      ? '未跟踪文件首版仅支持整文件暂存。'
      : '冲突文件本版不提供部分暂存，请在 Files 中处理。';
  }
  if (doc.kind !== 'text') {
    return doc.kind === 'binary'
      ? '二进制差异无法重建为可应用的 patch。'
      : '仅元数据（mode/rename）变化无法进行部分暂存。';
  }
  if (doc.completeness !== 'complete') {
    return 'Diff 未完整加载，未加载的 Hunk 不能执行任何写入。';
  }
  if (doc.hunks.some(hunk => !hunk.complete)) {
    return '存在未完整加载的 Hunk，无法重建可应用的 patch。';
  }
  if (doc.hunks.length === 0) {
    return '没有可暂存的文本改动。';
  }
  // A partial patch for an added/removed/renamed file needs a different pre-image shape.
  // Rather than emit a patch we cannot prove, the file stays a whole-file operation
  // (plan §7.8: refuse when the target bytes cannot be reconstructed faithfully).
  const structural = doc.meta.find(line =>
    /^(new file mode|deleted file mode|rename from|rename to|old mode|new mode|similarity index)/u.test(
      line
    )
  );
  if (structural) {
    return '新增、删除、重命名或纯权限变化的文件不支持部分暂存，请使用整文件操作。';
  }
  return null;
}

/** Escapes a path for the `diff --git` / `---` / `+++` headers. */
function patchPath(path: string): string {
  return /[\s"\\]/u.test(path) ? `"${path.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"` : path;
}

function buildHunkBody(
  hunk: GitHunkV2,
  selection: { readonly whole: boolean; readonly lineIds: ReadonlySet<string> }
): { readonly body: readonly string[]; readonly oldCount: number; readonly newCount: number; readonly changes: number } {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let changes = 0;
  for (const line of hunk.lines) {
    const selected = selection.whole || selection.lineIds.has(line.lineId);
    if (line.kind === 'context') {
      body.push(line.raw);
      oldCount += 1;
      newCount += 1;
      continue;
    }
    if (line.kind === 'meta') {
      // `\ No newline at end of file` only belongs after a change we are actually applying.
      if (selected) body.push(line.raw);
      continue;
    }
    if (line.kind === 'deletion') {
      if (selected) {
        body.push(line.raw);
        oldCount += 1;
        changes += 1;
      } else {
        // Kept in the index: becomes context.
        //
        // The original raw line is reused with its prefix swapped for a space, NOT
        // `line.text`. `text` is the normalised display form, so rebuilding from it dropped
        // the `\r` of a CRLF file and the patch then failed to apply against the real index.
        body.push(` ${line.raw.slice(1)}`);
        oldCount += 1;
        newCount += 1;
      }
      continue;
    }
    // addition
    if (selected) {
      body.push(line.raw);
      newCount += 1;
      changes += 1;
    }
    // An unselected addition is simply absent from the post-image.
  }
  return { body, oldCount, newCount, changes };
}

export function buildSelectionPatch(
  doc: GitDiffDocumentV2,
  request: PatchSelectionRequest
): PatchBuildResult {
  const blocked = refusal(doc);
  if (blocked) return { ok: false, reason: blocked };

  const wholeHunks = new Set(request.hunkIds ?? []);
  const selectedLines = new Set(request.lineIds ?? []);
  if (wholeHunks.size === 0 && selectedLines.size === 0) {
    return { ok: false, reason: '没有选择任何 Hunk 或行。' };
  }

  // Selected line ids must belong to this document; an unknown id means the reader's view is
  // stale and applying anything would be guesswork.
  if (selectedLines.size > 0) {
    const known = new Set(doc.hunks.flatMap(hunk => hunk.lines.map(line => line.lineId)));
    for (const lineId of selectedLines) {
      if (!known.has(lineId)) {
        return { ok: false, reason: '选中的行已不在当前 Diff 中，请刷新后重试。' };
      }
    }
  }

  // Standard orientation for both directions. Unstaging is the same patch applied with
  // `git apply --reverse`, so the headers must NOT be swapped for the staged source.
  const headers = [
    `diff --git a/${patchPath(doc.path)} b/${patchPath(doc.path)}`,
    `--- a/${patchPath(doc.path)}`,
    `+++ b/${patchPath(doc.path)}`,
  ];

  const bodyParts: string[] = [];
  let cumulativeDelta = 0;
  let totalChanges = 0;

  for (const hunk of doc.hunks) {
    const whole = wholeHunks.has(hunk.hunkId);
    const built = buildHunkBody(hunk, { whole, lineIds: selectedLines });
    // A hunk with nothing ticked contributes neither content nor offset.
    if (built.changes === 0) continue;
    const appliedDelta = built.newCount - built.oldCount;
    const oldStart = hunk.oldStart;
    // The post-image offset absorbs only the deltas we are actually applying.
    const newStart = oldStart + cumulativeDelta;
    cumulativeDelta += appliedDelta;
    totalChanges += built.changes;
    bodyParts.push(
      `@@ -${oldStart},${built.oldCount} +${newStart},${built.newCount} @@${hunk.contextLabel ? ` ${hunk.contextLabel}` : ''}`,
      ...built.body
    );
  }

  if (totalChanges === 0) {
    return { ok: false, reason: '选中的内容没有实际改动。' };
  }
  return {
    ok: true,
    patch: `${[...headers, ...bodyParts].join('\n')}\n`,
    selectedChanges: totalChanges,
  };
}
