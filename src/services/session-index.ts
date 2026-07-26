/**
 * orion code - Session Index
 *
 * Per-session index for fast lookup of files, tools, and topics.
 * Enables quick session search without parsing full JSONL files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectSessionsDir } from './config-dir';
import { redactTraceText } from './redaction';

// ============================================================================
// Types
// ============================================================================

export interface SessionIndex {
  sessionId: string;
  files: string[];            // All file paths referenced in tool calls
  tools: Record<string, number>; // Tool call counts: {read_file: 5, exec_command: 3}
  topics: string[];            // User message topics (first 50 chars)
  updatedAt: number;
}

export interface SessionSearchCandidate {
  id: string;
  projectPath: string;
}

// ============================================================================
// Index Management
// ============================================================================

/**
 * Update the session index with a new message.
 * Called on every appendSessionMessage.
 */
export function updateSessionIndex(
  sessionId: string,
  projectPath: string,
  message: {
    role: string;
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  }
): void {
  const index = loadSessionIndex(sessionId, projectPath) ?? createEmptyIndex(sessionId);

  // Track user topics
  if (message.role === 'user' && message.content) {
    const topic = redactTraceText(message.content).slice(0, 50).trim();
    if (topic && !index.topics.includes(topic)) {
      index.topics.push(topic);
      // Keep only last 20 topics
      if (index.topics.length > 20) {
        index.topics = index.topics.slice(-20);
      }
    }
  }

  // Track tool calls and file paths
  if (message.role === 'assistant' && message.tool_calls) {
    for (const tc of message.tool_calls) {
      const toolName = tc.function.name;
      index.tools[toolName] = (index.tools[toolName] || 0) + 1;

      // Extract file paths from common file tools
      try {
        const args = JSON.parse(tc.function.arguments);
        const filePath = args.path || args.file || args.file_path;
        if (filePath && typeof filePath === 'string') {
          const safeFilePath = redactTraceText(filePath);
          if (index.files.includes(safeFilePath)) continue;
          index.files.push(safeFilePath);
          // Keep only last 100 files
          if (index.files.length > 100) {
            index.files = index.files.slice(-100);
          }
        }
      } catch {
        // Invalid JSON arguments — skip
      }
    }
  }

  index.updatedAt = Date.now();
  saveSessionIndex(sessionId, projectPath, index);
}

/**
 * Load session index from disk.
 */
export function loadSessionIndex(sessionId: string, projectPath: string): SessionIndex | null {
  try {
    const dir = getProjectSessionsDir(projectPath);
    const indexPath = path.join(dir, `${sessionId}.index.json`);
    if (!fs.existsSync(indexPath)) return null;
    const data = fs.readFileSync(indexPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Save session index to disk.
 */
export function saveSessionIndex(sessionId: string, projectPath: string, index: SessionIndex): void {
  try {
    const dir = getProjectSessionsDir(projectPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const indexPath = path.join(dir, `${sessionId}.index.json`);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort — don't fail the main flow
  }
}

/**
 * Delete session index.
 */
export function deleteSessionIndex(sessionId: string, projectPath: string): void {
  try {
    const dir = getProjectSessionsDir(projectPath);
    const indexPath = path.join(dir, `${sessionId}.index.json`);
    if (fs.existsSync(indexPath)) {
      fs.unlinkSync(indexPath);
    }
  } catch {
    // Best-effort
  }
}

/**
 * Search sessions by query (file path, tool name, or topic keyword).
 * Returns matching session IDs sorted by relevance.
 */
export function searchSessions(
  query: string,
  projectPath: string,
  sessionIds: string[]
): string[];
export function searchSessions(
  query: string,
  candidates: SessionSearchCandidate[]
): string[];
export function searchSessions(
  query: string,
  projectPathOrCandidates: string | SessionSearchCandidate[],
  sessionIds: string[] = []
): string[] {
  const q = query.toLowerCase();
  const scored: Array<{ id: string; score: number; updatedAt: number }> = [];
  const candidates = Array.isArray(projectPathOrCandidates)
    ? projectPathOrCandidates
    : sessionIds.map(id => ({ id, projectPath: projectPathOrCandidates }));

  for (const candidate of candidates) {
    const index = loadSessionIndex(candidate.id, candidate.projectPath);
    if (!index) continue;

    let score = 0;

    // File path match
    if (index.files.some(f => f.toLowerCase().includes(q))) {
      score += 10;
    }

    // Tool name match
    if (Object.keys(index.tools).some(t => t.toLowerCase().includes(q))) {
      score += 5;
    }

    // Topic match
    if (index.topics.some(t => t.toLowerCase().includes(q))) {
      score += 8;
    }

    if (score > 0) {
      scored.push({
        id: candidate.id,
        score,
        updatedAt: index.updatedAt,
      });
    }
  }

  // Sort by score descending, then latest update, then stable id tie-breaker
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });
  return scored.map(s => s.id);
}

function createEmptyIndex(sessionId: string): SessionIndex {
  return {
    sessionId,
    files: [],
    tools: {},
    topics: [],
    updatedAt: Date.now(),
  };
}
