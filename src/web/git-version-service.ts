/**
 * v0.3.17 S5 — historical file versions: conflict stages, arbitrary-revision blobs, LFS
 * pointer state and gitlink (submodule) entries.
 *
 * Plan G5/G6 constraints this module is responsible for:
 *   - a conflicted file must NOT be rendered as an ordinary staged diff: base / ours / theirs
 *     come from index stages 1/2/3, and a version that legitimately does not exist (add/add,
 *     modify/delete) is reported as absent rather than silently omitted;
 *   - a file that no longer exists in the working tree can still be read at a revision
 *     ("view that version");
 *   - LFS only reads local objects or reports pointer state — nothing is fetched;
 *   - submodules are never traversed or switched: only the recorded gitlink SHAs are read, and
 *     the dirty summary is explicitly reported as not inspected.
 */
import { isSensitiveFilePath } from '../services/redaction';
import { WebWorkbenchError } from './errors';

/** Upper bound on the bytes returned for one file version. */
const MAX_VERSION_BYTES = 256 * 1024;
/** Bytes inspected when deciding whether a file is an LFS pointer. */
const LFS_PROBE_BYTES = 512;

export type GitVersionLabelV1 = 'base' | 'ours' | 'theirs' | 'worktree' | 'revision';

export interface GitFileVersionV1 {
  readonly label: GitVersionLabelV1;
  /** The blob OID, or null when this version does not exist for this conflict shape. */
  readonly oid: string | null;
  readonly exists: boolean;
  readonly binary: boolean;
  readonly byteSize: number;
  readonly truncated: boolean;
  /** Text content, or null when absent, binary or over the limit. */
  readonly content: string | null;
  /**
   * Set when the content is an LFS pointer: the pointer is shown as state, and the object is
   * never fetched.
   */
  readonly lfs: { readonly oid: string; readonly size: number | null } | null;
  /**
   * v0.3.17 S6 — a renderable data URL when this version is a bounded, known image.
   * Built from bytes already read locally; the plan forbids fetching anything.
   */
  readonly dataUrl?: string | null;
}

export type GitConflictShapeV1 =
  | 'both-modified'
  | 'both-added'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them'
  | 'both-deleted'
  | 'other';

export interface GitConflictVersionsV1 {
  readonly path: string;
  readonly shape: GitConflictShapeV1;
  readonly base: GitFileVersionV1;
  readonly ours: GitFileVersionV1;
  readonly theirs: GitFileVersionV1;
  readonly worktree: GitFileVersionV1;
}

export interface GitBlobResultV1 {
  readonly path: string;
  readonly rev: string;
  readonly oid: string;
  readonly binary: boolean;
  readonly byteSize: number;
  readonly truncated: boolean;
  readonly content: readonly string[];
  readonly lfs: { readonly oid: string; readonly size: number | null } | null;
  /** Present only when the blob is a bounded, known image. */
  readonly dataUrl: string | null;
}

export interface GitSubmoduleEntryV1 {
  readonly path: string;
  readonly gitlinkOid: string;
  /** Never inspected: plan G6 forbids traversing submodules to compute this. */
  readonly dirtySummary: null;
  readonly dirtyNote: string;
}

export interface GitVersionReader {
  conflict(path: string): Promise<GitConflictVersionsV1>;
  blob(input: { readonly path: string; readonly rev: string }): Promise<GitBlobResultV1>;
  submodules(): Promise<readonly GitSubmoduleEntryV1[]>;
}

export interface GitVersionReaderOptions {
  readonly runGit: (args: readonly string[]) => Promise<string>;
  /** Runs git and returns raw bytes, for content that may not be valid UTF-8. */
  readonly runGitBytes: (args: readonly string[]) => Promise<Buffer>;
}

function assertRelativePath(value: string, name = 'path'): string {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    throw new WebWorkbenchError(400, `A ${name} is required.`, 'git_path_invalid');
  }
  if (value.startsWith('/') || value.startsWith(':') || value.includes('\0')) {
    throw new WebWorkbenchError(400, 'Unsafe Git path.', 'git_path_unsafe');
  }
  if (value.split('/').some(segment => segment === '..' || segment === '.' || segment === '')) {
    throw new WebWorkbenchError(400, 'Unsafe Git path.', 'git_path_unsafe');
  }
  return value;
}

function assertRev(value: string): string {
  // A revision expression here would be an injection surface; a plain ref or hash is enough.
  if (typeof value !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._/-]{0,250}$/u.test(value)) {
    throw new WebWorkbenchError(400, 'rev must be a ref name or commit hash.', 'git_ref_invalid');
  }
  if (value.includes('..')) {
    throw new WebWorkbenchError(400, 'rev must be a ref name or commit hash.', 'git_ref_invalid');
  }
  return value;
}

/**
 * Recognises the image formats the browser can render from a data URL, by magic bytes —
 * never by extension, which is user-controlled and proves nothing.
 */
const IMAGE_SIGNATURES: readonly {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly mime: string;
}[] = Object.freeze([
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
]);

/** Largest image that may be inlined as a data URL (bounded, and nothing is fetched). */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Returns a renderable data URL when the bytes are a known image, so the UI can show the
 * two versions of a picture side by side. The bytes were already read locally — the plan
 * forbids fetching anything.
 */
function imageDataUrl(bytes: Buffer): string | null {
  for (const signature of IMAGE_SIGNATURES) {
    if (bytes.length < signature.offset + signature.bytes.length) continue;
    const matches = signature.bytes.every(
      (byte, index) => bytes[signature.offset + index] === byte
    );
    if (matches) {
      return `data:${signature.mime};base64,${bytes.toString('base64')}`;
    }
  }
  return null;
}

/** Detects an LFS pointer and extracts its state. Never fetches anything. */
function parseLfsPointer(head: string): { readonly oid: string; readonly size: number | null } | null {
  if (!head.startsWith('version https://git-lfs.github.com/spec/')) return null;
  const oidMatch = /^oid sha256:([0-9a-f]{64})$/mu.exec(head);
  if (!oidMatch) return null;
  const sizeMatch = /^size (\d+)$/mu.exec(head);
  return Object.freeze({
    oid: oidMatch[1],
    size: sizeMatch ? Number(sizeMatch[1]) : null,
  });
}

export function createGitVersionReader(options: GitVersionReaderOptions): GitVersionReader {
  const { runGit, runGitBytes } = options;

  /**
   * Reads one blob by OID, bounded, with binary and LFS detection.
   *
   * The size is read first so an enormous historical file is reported by its size instead of
   * being pulled into memory just to be truncated.
   */
  const readVersion = async (
    label: GitVersionLabelV1,
    oid: string | null
  ): Promise<GitFileVersionV1> => {
    if (oid === null) {
      return Object.freeze({
        label,
        oid: null,
        exists: false,
        binary: false,
        byteSize: 0,
        truncated: false,
        content: null,
        lfs: null,
      });
    }
    const sizeRaw = (await runGit(['cat-file', '-s', oid])).trim();
    const byteSize = Number(sizeRaw) || 0;
    if (byteSize > MAX_VERSION_BYTES) {
      return Object.freeze({
        label,
        oid,
        exists: true,
        binary: false,
        byteSize,
        truncated: true,
        content: null,
        lfs: null,
      });
    }
    const bytes = await runGitBytes(['cat-file', 'blob', oid]);
    const probe = bytes.subarray(0, LFS_PROBE_BYTES).toString('utf8');
    const lfs = parseLfsPointer(probe);
    if (lfs) {
      return Object.freeze({
        label,
        oid,
        exists: true,
        binary: false,
        byteSize,
        truncated: false,
        content: probe.trimEnd(),
        lfs,
      });
    }
    const binary = bytes.includes(0);
    // Only a bounded known image becomes a data URL; anything else stays an opaque count.
    const dataUrl = binary && byteSize <= MAX_IMAGE_BYTES ? imageDataUrl(bytes) : null;
    return Object.freeze({
      label,
      oid,
      exists: true,
      binary,
      byteSize,
      truncated: false,
      content: binary ? null : bytes.toString('utf8'),
      lfs: null,
      dataUrl,
    });
  };

  return {
    async conflict(pathInput) {
      const path = assertRelativePath(pathInput);
      if (isSensitiveFilePath(path)) {
        throw new WebWorkbenchError(
          403,
          'Sensitive file content is not available in the Web Workbench.',
          'sensitive_file_blocked'
        );
      }
      // `ls-files -u` lists one entry per unmerged stage, which is the authoritative record
      // of what the conflict actually contains. Stages absent here do not exist.
      const raw = await runGit(['ls-files', '-u', '-z', '--', path]);
      const stageOids = new Map<number, string>();
      for (const record of raw.split('\0')) {
        if (!record) continue;
        const [meta] = record.split('\t');
        const [mode, oid, stage] = meta.split(' ');
        if (!mode || !oid || !stage) continue;
        stageOids.set(Number(stage), oid);
      }
      const worktreeOid = (
        await runGit(['hash-object', '--path=' + path, '--', path]).catch(() => '')
      )
        .toString()
        .trim();
      const worktreeExists = /^[0-9a-f]{7,64}$/iu.test(worktreeOid);

      const [base, ours, theirs, worktree] = await Promise.all([
        readVersion('base', stageOids.get(1) ?? null),
        readVersion('ours', stageOids.get(2) ?? null),
        readVersion('theirs', stageOids.get(3) ?? null),
        worktreeExists ? readVersion('worktree', worktreeOid) : readVersion('worktree', null),
      ]);

      const hasBase = stageOids.has(1);
      const hasOurs = stageOids.has(2);
      const hasTheirs = stageOids.has(3);
      let shape: GitConflictShapeV1 = 'other';
      if (hasBase && hasOurs && hasTheirs) shape = 'both-modified';
      else if (!hasBase && hasOurs && hasTheirs) shape = 'both-added';
      // The delete shapes must be tested BEFORE the add shapes: a modify/delete conflict also
      // has exactly one side present, so a loose `hasOurs && !hasTheirs` would swallow it and
      // mislabel a deletion as an addition. A missing side only means 'added' when there is no
      // base to delete from.
      else if (hasBase && !hasOurs && hasTheirs) shape = 'deleted-by-us';
      else if (hasBase && hasOurs && !hasTheirs) shape = 'deleted-by-them';
      else if (hasOurs && !hasTheirs) shape = 'added-by-us';
      else if (!hasOurs && hasTheirs) shape = 'added-by-them';
      else if (hasBase && !hasOurs && !hasTheirs) shape = 'both-deleted';

      return Object.freeze({ path, shape, base, ours, theirs, worktree });
    },

    async blob(input) {
      const path = assertRelativePath(input.path);
      const rev = assertRev(input.rev);
      if (isSensitiveFilePath(path)) {
        throw new WebWorkbenchError(
          403,
          'Sensitive file content is not available in the Web Workbench.',
          'sensitive_file_blocked'
        );
      }
      // `rev:path` is a tree lookup, not a working-tree read: a file deleted since that
      // revision is still readable, which is the whole point of "view that version".
      const oid = (
        await runGit(['rev-parse', '--verify', '--quiet', `${rev}:${path}`]).catch(() => '')
      )
        .toString()
        .trim();
      if (!/^[0-9a-f]{7,64}$/iu.test(oid)) {
        throw new WebWorkbenchError(
          404,
          'That file does not exist at the requested revision.',
          'git_blob_not_found'
        );
      }
      const version = await readVersion('revision', oid);
      return Object.freeze({
        path,
        rev,
        oid,
        binary: version.binary,
        byteSize: version.byteSize,
        truncated: version.truncated,
        content: Object.freeze((version.content ?? '').split('\n')),
        lfs: version.lfs,
        dataUrl: version.dataUrl ?? null,
      });
    },

    async submodules() {
      // Only the recorded gitlink SHAs. `git submodule status` is deliberately NOT run: it
      // traverses every submodule, which plan G6 forbids.
      const raw = await runGit(['ls-files', '--stage', '-z']);
      const entries: GitSubmoduleEntryV1[] = [];
      for (const record of raw.split('\0')) {
        if (!record) continue;
        const [meta, filePath] = record.split('\t');
        const [mode, oid] = (meta ?? '').split(' ');
        if (mode !== '160000' || !oid || !filePath) continue;
        entries.push(
          Object.freeze({
            path: filePath,
            gitlinkOid: oid,
            dirtySummary: null,
            dirtyNote: '未检测：不遍历子模块（计划 G6）。',
          })
        );
      }
      return Object.freeze(entries);
    },
  };
}
