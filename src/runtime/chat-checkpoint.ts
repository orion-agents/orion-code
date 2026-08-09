/**
 * Pre-edit checkpoint target resolution and trace integration.
 *
 * The helper accepts provider tool-call data, keeps targets project-scoped, and
 * delegates durable trace recording through chat-trace without importing the
 * controller or commands.
 */

import * as path from 'path';
import type { Message } from '../services/llm';
import { createCheckpoint, shouldCreateMultiFileCheckpoint } from '../core/checkpoint';
import type { UiEventSink } from './ui-events';
import { recordTraceEvent } from './chat-trace';

export function parseToolCallArgsForRuntime(
  toolCall: NonNullable<Message['tool_calls']>[number]
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveProjectScopedPath(cwd: string, filePath: string): string | null {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolute;
}

export function checkpointTargetsFromToolCalls(
  cwd: string,
  toolCalls: NonNullable<Message['tool_calls']>
): string[] {
  const targets = new Set<string>();
  for (const toolCall of toolCalls) {
    const name = toolCall.function.name;
    if (name !== 'write_file' && name !== 'edit_file') continue;

    const args = parseToolCallArgsForRuntime(toolCall);
    if (!args || typeof args.path !== 'string') continue;
    if (name === 'edit_file' && args.preview === true) continue;

    const target = resolveProjectScopedPath(cwd, args.path);
    if (target) targets.add(target);
  }
  return Array.from(targets);
}

export function createPreToolCheckpoint(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  checkpointId: string,
  cwd: string,
  toolCalls: NonNullable<Message['tool_calls']>
): { created: boolean; targetCount: number; risky: boolean } {
  const targets = checkpointTargetsFromToolCalls(cwd, toolCalls);
  if (targets.length === 0) return { created: false, targetCount: 0, risky: false };

  const risky = shouldCreateMultiFileCheckpoint(targets.length);
  const checkpoint = createCheckpoint(cwd, checkpointId, targets);
  if (!sessionId) return { created: checkpoint !== null, targetCount: targets.length, risky };

  const relativeTargets = targets.map(target => path.relative(cwd, target));
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'checkpoint',
    checkpointId,
    checkpointFileCount: checkpoint?.files.length ?? 0,
    checkpointFiles: checkpoint?.files.map(file => file.path) ?? [],
    workspaceFiles: relativeTargets,
    note: checkpoint
      ? risky
        ? 'risky_multi_file_checkpoint'
        : 'pre_edit_checkpoint'
      : 'pre_edit_checkpoint_skipped',
  });
  return { created: checkpoint !== null, targetCount: targets.length, risky };
}
