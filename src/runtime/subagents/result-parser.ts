/**
 * SubagentResultParser: normalize a child's final text into a fixed schema.
 *
 * Children are instructed to emit a single JSON object. In practice they may
 * wrap it in prose, emit invalid JSON, or omit fields. This parser is the
 * single chokepoint that produces a well-typed {@link SubtaskResult} regardless
 * of provider quirks, so the root Agent only ever sees structured data.
 */

import type {
  SubagentRole,
  SubtaskFinding,
  SubtaskResult,
  SubtaskResultStatus,
} from './types';
import { EMPTY_SUBTASK_USAGE } from './types';

const MAX_FINDINGS = 20;
const MAX_FILES = 50;
const MAX_COMMANDS = 20;
const MAX_VERIFICATION = 10;
const MAX_RISKS = 10;
const MAX_FIELD_LEN = 2000;

export interface ParsedSubtaskPayload {
  summary?: unknown;
  findings?: unknown;
  files?: unknown;
  commands?: unknown;
  verification?: unknown;
  risks?: unknown;
}

/**
 * Extract the first balanced JSON object from text that may contain prose
 * around it. Returns the parsed object or null if none is found / invalid.
 */
export function extractJsonObject(text: string): unknown {
  if (!text) return null;

  // Iterate over every top-level '{' start position. A child's text may contain
  // prose with brace fragments (e.g. "{ result above }") before the real JSON
  // object, so a candidate that is balanced but not valid JSON must not abort
  // the search — we keep scanning for the next '{'.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) return null;

    // Scan for the matching closing brace, respecting nested objects and strings.
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) {
      // Unbalanced from this start; try a last-ditch parse of the tail.
      try {
        return JSON.parse(text.slice(start));
      } catch {
        return null;
      }
    }

    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Balanced but not valid JSON (prose fragment). Continue past it.
      searchFrom = end + 1;
    }
  }
  return null;
}

function str(value: unknown, max = MAX_FIELD_LEN): string {
  if (typeof value === 'string') return truncate(value.trim(), max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function parseFindings(raw: unknown): SubtaskFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: SubtaskFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = str(obj.title, 200);
    if (!title) continue;
    out.push({
      title,
      severity: parseSeverity(obj.severity),
      evidence: str(obj.evidence, 1500),
      file: obj.file != null ? str(obj.file, 500) : undefined,
      line: typeof obj.line === 'number' && Number.isFinite(obj.line) ? Math.max(0, Math.floor(obj.line)) : undefined,
    });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

function parseSeverity(value: unknown): SubtaskFinding['severity'] {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low' || value === 'info') {
    return value;
  }
  return undefined;
}

function parseStringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const s = str(item, 500);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function parseCommands(raw: unknown): SubtaskResult['commands'] {
  if (!Array.isArray(raw)) return [];
  const out: SubtaskResult['commands'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const command = str(obj.command, 500);
    if (!command) continue;
    out.push({ command, purpose: str(obj.purpose, 500), executed: false });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}

/**
 * Parse a child's final text into a {@link SubtaskResult}.
 *
 * @param id         Runtime-generated task id.
 * @param role       The role the child ran as.
 * @param content    The child's final assistant text (may contain prose + JSON).
 * @param status     Terminal status. `completed` requires parseable JSON;
 *                   otherwise the summary records the failure mode.
 * @param usage      Observed usage; defaults to empty.
 */
export function parseSubtaskResult(args: {
  id: string;
  role: SubagentRole;
  content: string;
  status: SubtaskResultStatus;
  usage?: SubtaskResult['usage'];
}): SubtaskResult {
  const { id, role, content, status } = args;
  const usage = args.usage ?? EMPTY_SUBTASK_USAGE;

  if (status !== 'completed') {
    return {
      id,
      role,
      status,
      summary: summarizeFailure(status, content),
      findings: [],
      files: [],
      commands: [],
      verification: [],
      risks: [`child did not complete: ${status}`],
      usage,
    };
  }

  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== 'object') {
    return {
      id,
      role,
      status: 'failed',
      summary: truncate(content.trim() || '(no output)', MAX_FIELD_LEN),
      findings: [],
      files: [],
      commands: [],
      verification: [],
      risks: ['child returned non-JSON output'],
      usage,
    };
  }

  const payload = parsed as ParsedSubtaskPayload;
  const summary = str(payload.summary, MAX_FIELD_LEN);
  if (!summary) {
    return {
      id,
      role,
      status: 'failed',
      summary: truncate(content.trim().slice(0, MAX_FIELD_LEN), MAX_FIELD_LEN),
      findings: parseFindings(payload.findings),
      files: [],
      commands: [],
      verification: [],
      risks: ['child output missing required "summary" field'],
      usage,
    };
  }

  return {
    id,
    role,
    status: 'completed',
    summary,
    findings: parseFindings(payload.findings),
    files: parseStringArray(payload.files, MAX_FILES),
    commands: parseCommands(payload.commands),
    verification: parseStringArray(payload.verification, MAX_VERIFICATION),
    risks: parseStringArray(payload.risks, MAX_RISKS),
    usage,
  };
}

function summarizeFailure(status: SubtaskResultStatus, content: string): string {
  const tail = truncate(content.trim(), 300);
  switch (status) {
    case 'timed_out': return `Child timed out. Partial output: ${tail || '(none)'}`;
    case 'cancelled': return `Child was cancelled. Partial output: ${tail || '(none)'}`;
    case 'failed': return `Child failed. Output: ${tail || '(none)'}`;
    case 'rejected': return `Child was rejected by policy before running.`;
    default: return tail || '(no output)';
  }
}
