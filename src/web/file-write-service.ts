import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeSync,
} from 'fs';

import { WebWorkbenchError } from './errors';
import { fingerprintStat, isBinary, FileReadServiceV1 } from './file-read-service';

const MAX_WRITE_BYTES = 512 * 1024;
const WRITE_SAMPLE_BYTES = 8192;

export interface WebFileWriteResultV1 {
  readonly fileId: string;
  readonly revision: string;
  readonly sizeBytes: number;
}

/**
 * v0.3.14 — bounded, CAS-guarded writes for an existing in-root text file.
 *
 * Safety stack mirrors the read path: the file id resolves through the read
 * service's fenced registry (workspace escape, symlink escape and sensitive
 * paths fail closed there), the payload must be valid UTF-8 text without NULs
 * within 512 KiB, and the write commits only when the on-disk revision still
 * matches the caller's `expectedRevision` (compare-and-swap against the same
 * stat fingerprint the read path returns).
 */
/**
 * A bounded sample can end inside one UTF-8 code point (very likely for CJK
 * text at an 8 KiB boundary); drop the trailing partial byte before judging the
 * file as binary, mirroring the read path's `validUtf8Prefix`.
 */
function completeUtf8Tail(buffer: Buffer): Buffer {
  for (let trim = 0; trim <= Math.min(3, Math.max(0, buffer.length - 1)); trim += 1) {
    const candidate = buffer.subarray(0, buffer.length - trim);
    if (!isBinary(candidate)) return candidate;
  }
  return buffer;
}

export class FileWriteServiceV1 {
  constructor(private readonly fileService: FileReadServiceV1) {}

  writeContent(input: {
    readonly fileId: string;
    readonly content: string;
    readonly expectedRevision: string;
  }): WebFileWriteResultV1 {
    const content = input.content;
    if (typeof content !== 'string') {
      throw new WebWorkbenchError(400, 'File content must be a string.', 'file_content_invalid');
    }
    if (content.includes('\0')) {
      throw new WebWorkbenchError(
        415,
        'Files containing NUL bytes are not editable in the Web Workbench.',
        'file_binary'
      );
    }
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > MAX_WRITE_BYTES) {
      throw new WebWorkbenchError(
        413,
        'Edited file content exceeds the 512 KiB Web editor limit.',
        'file_too_large'
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(input.expectedRevision)) {
      throw new WebWorkbenchError(400, 'expectedRevision is invalid.', 'file_revision_invalid');
    }

    const preflight = this.fileService.writePreflight(input.fileId);
    if (preflight.sizeBytes > MAX_WRITE_BYTES) {
      throw new WebWorkbenchError(
        413,
        'Target file exceeds the 512 KiB Web editor limit.',
        'file_too_large'
      );
    }

    const payload = Buffer.from(content, 'utf8');
    // Phase 1 (read descriptor): CAS + binary re-check. An O_WRONLY descriptor
    // cannot readSync, so the preflight opens its own read handle first.
    const readDescriptor = openSync(preflight.canonicalPath, constants.O_RDONLY);
    let beforeSize: bigint;
    try {
      const before = fstatSync(readDescriptor, { bigint: true });
      beforeSize = before.size;
      const sample = Buffer.alloc(Math.min(WRITE_SAMPLE_BYTES, Number(before.size)));
      if (sample.length > 0) {
        readSync(readDescriptor, sample, 0, sample.length, 0);
        if (isBinary(completeUtf8Tail(sample))) {
          throw new WebWorkbenchError(415, 'Target file is not UTF-8 text.', 'file_binary');
        }
      }
      if (fingerprintStat(before) !== input.expectedRevision) {
        throw new WebWorkbenchError(
          409,
          'The file changed on disk before the save could run; reload it first.',
          'file_revision_conflict'
        );
      }
    } finally {
      closeSync(readDescriptor);
    }
    // Phase 2 (write descriptor): CAS is re-checked by the kernel fingerprint
    // window being as short as possible between the two handles.
    const writeDescriptor = openSync(preflight.canonicalPath, constants.O_WRONLY);
    try {
      const before = fstatSync(writeDescriptor, { bigint: true });
      if (fingerprintStat(before) !== input.expectedRevision) {
        throw new WebWorkbenchError(
          409,
          'The file changed on disk before the save could run; reload it first.',
          'file_revision_conflict'
        );
      }
      writeSync(writeDescriptor, payload, 0, payload.length, 0);
      // Shrink keeps the file exactly as long as the payload.
      if (beforeSize > BigInt(payload.length)) {
        truncateSync(preflight.canonicalPath, payload.length);
      }
      const after = statSync(preflight.canonicalPath, { bigint: true });
      return Object.freeze({
        fileId: input.fileId,
        revision: fingerprintStat(after),
        sizeBytes: Number(after.size),
      });
    } finally {
      closeSync(writeDescriptor);
    }
  }
}
