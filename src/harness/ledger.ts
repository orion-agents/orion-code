import { randomUUID } from 'crypto';
import type { ContextLedgerEntry, LedgerEntryType, LedgerSource } from './types';
import { classifyVerificationCommand } from './verification';

export interface AddLedgerEntryInput {
  type: LedgerEntryType;
  content: string;
  source: LedgerSource;
  importance?: 1 | 2 | 3 | 4 | 5;
  ttl?: 'turn' | 'task' | 'session' | 'persistent';
  metadata?: Record<string, unknown>;
}

function truncate(text: string, max = 900): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

function parseToolPayload(result: string): {
  structured: boolean;
  success?: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  sourceSha?: string;
  artifactHash?: string;
} {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        structured: typeof record.success === 'boolean',
        success: typeof record.success === 'boolean' ? record.success : undefined,
        output: typeof record.output === 'string' ? record.output : undefined,
        error: typeof record.error === 'string' ? record.error : undefined,
        exitCode:
          typeof record.exitCode === 'number' && Number.isInteger(record.exitCode)
            ? record.exitCode
            : undefined,
        sourceSha: typeof record.sourceSha === 'string' ? record.sourceSha : undefined,
        artifactHash: typeof record.artifactHash === 'string' ? record.artifactHash : undefined,
      };
    }
  } catch {
    // Plain text tool output remains useful context, but not proof of success.
  }
  return { structured: false, output: result };
}

function commandFromArgs(args: Record<string, unknown>): string | undefined {
  return typeof args.command === 'string' ? args.command : undefined;
}

function pathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file', 'filePath', 'targetPath']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function cwdFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['cwd', 'workdir']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export class ContextLedger {
  static readonly MAX_ENTRIES = 200;
  private entries: ContextLedgerEntry[];

  constructor(entries: ContextLedgerEntry[] = []) {
    this.entries = [...entries];
  }

  add(input: AddLedgerEntryInput): ContextLedgerEntry {
    const entry: ContextLedgerEntry = {
      id: randomUUID(),
      type: input.type,
      content: truncate(input.content),
      source: input.source,
      importance: input.importance ?? 3,
      ttl: input.ttl ?? 'task',
      createdAt: Date.now(),
      metadata: input.metadata,
    };
    this.entries.push(entry);
    // Bound entries: evict low-importance old items when over capacity.
    if (this.entries.length > ContextLedger.MAX_ENTRIES) {
      const sorted = [...this.entries].sort(
        (a, b) => a.importance - b.importance || a.createdAt - b.createdAt
      );
      const toRemove = sorted.slice(0, this.entries.length - ContextLedger.MAX_ENTRIES);
      // Key removal on entry id (unique). Keying on source.ref is wrong: many
      // entries share a ref (e.g. every read_file call has ref 'read_file'),
      // so a Set of refs collapses to one element and the filter would remove
      // ALL entries with that ref, over-evicting the ledger toward zero.
      const removeIds = new Set(toRemove.map(e => e.id));
      this.entries = this.entries.filter(e => !removeIds.has(e.id));
    }
    return entry;
  }

  recordUserRequirement(content: string): ContextLedgerEntry {
    return this.add({
      type: 'user_requirement',
      content,
      source: { kind: 'user' },
      importance: 5,
      ttl: 'task',
    });
  }

  recordAssistantDecision(content: string): ContextLedgerEntry | null {
    if (!content.trim()) return null;
    return this.add({
      type: 'decision',
      content,
      source: { kind: 'agent' },
      importance: 2,
      ttl: 'turn',
    });
  }

  recordToolResult(params: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    duration: number;
    success: boolean;
    error?: string;
    summary?: string;
  }): ContextLedgerEntry {
    const parsed = parseToolPayload(params.result);
    const command = commandFromArgs(params.args);
    const path = pathFromArgs(params.args);
    const cwd = cwdFromArgs(params.args);
    // Use summary when available to reduce evidence size
    const output = params.summary || parsed.error || params.error || parsed.output || params.result;
    const verificationKind = classifyVerificationCommand(command);
    const isVerification = verificationKind !== 'generic';
    const evidenceSuccess = parsed.structured
      ? parsed.success === true && params.success === true
      : undefined;
    const type: LedgerEntryType = isVerification ? 'verification' : 'tool_result';
    const content = [
      parsed.structured
        ? `${params.name}${evidenceSuccess ? ' succeeded' : ' failed'} in ${params.duration}ms.`
        : `${params.name} returned opaque output in ${params.duration}ms.`,
      command ? `Command: ${command}` : '',
      path ? `Path: ${path}` : '',
      output ? `Result: ${output}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    return this.add({
      type,
      content,
      source: { kind: isVerification ? 'test' : 'tool', ref: params.name },
      importance: evidenceSuccess ? (isVerification ? 5 : 3) : evidenceSuccess === false ? 4 : 3,
      ttl: isVerification ? 'task' : 'turn',
      metadata: {
        toolName: params.name,
        command,
        cwd,
        path,
        exitCode: parsed.exitCode ?? (isVerification && evidenceSuccess === true ? 0 : undefined),
        sourceSha: parsed.sourceSha,
        artifactHash: parsed.artifactHash,
        recordedAt: Date.now(),
        freshness: 'current_run',
        verificationKind,
        success: evidenceSuccess,
        resultTrust: parsed.structured ? 'structured' : 'opaque',
        error: params.error || parsed.error,
        changedFile: evidenceSuccess && /write|edit|patch/i.test(params.name) ? path : undefined,
      },
    });
  }

  getEntries(): ContextLedgerEntry[] {
    return [...this.entries];
  }

  getImportant(limit = 12): ContextLedgerEntry[] {
    return [...this.entries]
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  getByType(type: LedgerEntryType): ContextLedgerEntry[] {
    return this.entries.filter(entry => entry.type === type);
  }

  toJSON(): ContextLedgerEntry[] {
    return this.getEntries();
  }
}
