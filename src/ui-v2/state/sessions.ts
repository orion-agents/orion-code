/**
 * UI v2 session suggestion builders.
 */

import { basename } from 'path';
import type { SessionMeta } from '../../services/session-storage';
import { formatBytes } from '../../services/format';
import type { SuggestionItem } from '../types';

export { formatBytes } from '../../services/format';

export interface BuildSessionSuggestionsOptions {
  showProject?: boolean;
  now?: number;
}

export function buildSessionSuggestions(
  sessions: SessionMeta[],
  options: BuildSessionSuggestionsOptions = {}
): SuggestionItem[] {
  return sessions.map((session, index) => sessionToSuggestion(session, index, options));
}

export function sessionToSuggestion(
  session: SessionMeta,
  index: number,
  options: BuildSessionSuggestionsOptions = {}
): SuggestionItem {
  const shortId = session.id.slice(0, 8);
  const title = sessionDisplayTitle(session);
  const updatedAt = session.updatedAt ?? session.startTime;
  const detailParts = [
    shortId,
    session.model,
    `${session.messageCount ?? 0} msg`,
    formatBytes(session.historySizeBytes ?? 0),
    formatRelativeTime(updatedAt, options.now ?? Date.now()),
  ];

  if (options.showProject && session.projectPath) {
    detailParts.push(basename(session.projectPath) || session.projectPath);
  }

  return {
    id: `session:${session.id}`,
    kind: 'session',
    label: `#${index + 1} ${title}`,
    detail: detailParts.join('  '),
    value: session.id,
    metadata: {
      index: index + 1,
      sessionId: session.id,
      projectPath: session.projectPath,
      updatedAt,
      messageCount: session.messageCount ?? 0,
    },
  };
}

export function sessionDisplayTitle(session: SessionMeta): string {
  return session.name || session.taskSummary || '(untitled)';
}

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}
