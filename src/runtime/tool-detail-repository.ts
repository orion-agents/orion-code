/**
 * v0.2.23 — Tool Detail Repository.
 *
 * Read-only interface for accessing tool output details from durable sources
 * (artifacts, session traces). Supports paginated reads with byte-offset
 * limits. Never loads full multi-MB artifacts into memory at once.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { listArtifacts } from '../core/tool-artifacts';
import { getProjectArtifactsDir } from '../services/config-dir';
import { redactTraceText } from '../services/redaction';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface ToolDetailSummary {
  callId: string;
  sequence: number;
  turnId?: string;
  toolName: string;
  state: 'success' | 'error' | 'skipped';
  outputBytes: number;
  artifactId?: string;
  hasArtifact: boolean;
}

export interface ToolDetailPage {
  content: string;
  offsetBytes: number;
  nextOffsetBytes?: number;
  totalBytes: number;
  redacted: boolean;
}

export interface ToolDetailRepository {
  list(projectPath: string): Promise<ToolDetailSummary[]>;
  read(
    ref: ToolDetailRef,
    options: { offsetBytes: number; limitBytes: number },
    projectPath: string,
  ): Promise<ToolDetailPage>;
}

export interface ToolDetailRef {
  callId: string;
  sequence: number;
  artifactId?: string;
  outputBytes: number;
}

// ============================================================================
// Implementation
// ============================================================================

const MAX_PAGE_BYTES = 1024 * 1024; // 1 MB max per page
const DEFAULT_LIMIT_BYTES = 64 * 1024; // 64 KB default page

export class FileToolDetailRepository implements ToolDetailRepository {
  async list(projectPath: string): Promise<ToolDetailSummary[]> {
    try {
      const artifacts = listArtifacts(projectPath);
      return artifacts.map(a => ({
        callId: artifactIdToCallId(a.id),
        sequence: 0, // sequence not stored in artifact metadata currently
        toolName: a.toolName,
        state: 'success' as const,
        outputBytes: a.outputBytes,
        artifactId: a.id,
        hasArtifact: true,
      }));
    } catch {
      return [];
    }
  }

  async read(
    ref: ToolDetailRef,
    options: { offsetBytes: number; limitBytes: number },
    projectPath: string,
  ): Promise<ToolDetailPage> {
    const limitBytes = Math.min(options.limitBytes || DEFAULT_LIMIT_BYTES, MAX_PAGE_BYTES);
    const offsetBytes = Math.max(0, options.offsetBytes || 0);

    // Try reading from artifact file on disk.
    if (ref.artifactId) {
      // v0.2.23: reject path traversal in artifact IDs.
      if (ref.artifactId.includes('..') || ref.artifactId.includes('/') || ref.artifactId.includes('\\')) {
        return { content: 'detail unavailable', offsetBytes: 0, totalBytes: 0, redacted: false };
      }
      try {
        const artifactDir = getProjectArtifactsDir(projectPath);
        const filePath = join(artifactDir, `${ref.artifactId}.txt`);
        if (existsSync(filePath)) {
          const totalBytes = statSync(filePath).size;
          if (offsetBytes >= totalBytes) {
            return { content: '', offsetBytes, totalBytes, redacted: false };
          }
          const requestedBytes = Math.min(limitBytes + 3, totalBytes - offsetBytes);
          const buffer = Buffer.allocUnsafe(requestedBytes);
          const fd = openSync(filePath, 'r');
          let bytesRead = 0;
          try {
            bytesRead = readSync(fd, buffer, 0, requestedBytes, offsetBytes);
          } finally {
            closeSync(fd);
          }
          const targetBytes = Math.min(limitBytes, bytesRead);
          const safeBytes = utf8SafePrefixLength(buffer.subarray(0, targetBytes));
          const consumedBytes = safeBytes > 0
            ? safeBytes
            : Math.min(bytesRead, utf8SequenceLength(buffer[0]));
          const rawPage = buffer.subarray(0, consumedBytes).toString('utf8');
          const content = redactTraceText(rawPage);
          const nextOffset = offsetBytes + consumedBytes;
          return {
            content,
            offsetBytes,
            nextOffsetBytes: nextOffset < totalBytes ? nextOffset : undefined,
            totalBytes,
            redacted: content !== rawPage,
          };
        }
      } catch {
        // Fall through to unavailable.
      }
    }

    return {
      content: 'detail unavailable',
      offsetBytes: 0,
      totalBytes: 0,
      redacted: false,
    };
  }
}

function artifactIdToCallId(id: string): string {
  // artifact IDs look like "toolName-seq-random" — use as callId fallback.
  return id;
}

function utf8SafePrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const first = buffer[lead];
  const expected = (first & 0x80) === 0
    ? 1
    : (first & 0xe0) === 0xc0
      ? 2
      : (first & 0xf0) === 0xe0
        ? 3
        : (first & 0xf8) === 0xf0
          ? 4
          : 1;
  return buffer.length - lead < expected ? lead : buffer.length;
}

function utf8SequenceLength(first: number): number {
  if ((first & 0x80) === 0) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  return 1;
}
