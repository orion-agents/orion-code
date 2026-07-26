import { randomUUID } from 'crypto';
import type { IntentKind, IntentUpdate, TurnSummary } from './types';

export interface SessionMessageLike {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface CreateTurnSummaryInput {
  turn: number;
  taskEpoch: number;
  intent: IntentUpdate;
  userInput: string;
  assistantContent: string;
  sessionMessages?: SessionMessageLike[];
}

function compact(text: string, max = 260): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function pathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file', 'filePath', 'targetPath']) {
    const value = readString(args[key]);
    if (value) return value;
  }
  return undefined;
}

function commandFromArgs(args: Record<string, unknown>): string | undefined {
  return readString(args.command);
}

function isVerificationCommand(command: string | undefined): boolean {
  return !!command && /\b(test|jest|vitest|tsc|lint|typecheck|build)\b/i.test(command);
}

function toolOutputLine(content: string): string {
  const parsed = parseJsonObject(content);
  if (!parsed) return compact(content, 180);
  const output = readString(parsed.output) || readString(parsed.error) || readString(parsed.message);
  return compact(output ?? content, 180);
}

function extractUnresolved(assistantContent: string, failedVerification: string[]): string[] {
  const unresolved: string[] = [...failedVerification];
  const text = assistantContent.toLowerCase();
  if (/(未完成|无法|不能|失败|blocked|failed|todo|next step|incomplete|cannot)/i.test(assistantContent)) {
    unresolved.push(compact(assistantContent, 180));
  }
  if (text.includes('needs verification') || text.includes('not verified')) {
    unresolved.push('Assistant indicated remaining verification is needed.');
  }
  return unique(unresolved).slice(0, 8);
}

export function createTurnSummary(input: CreateTurnSummaryInput): TurnSummary {
  const toolsUsed: string[] = [];
  const filesTouched: string[] = [];
  const commandsRun: string[] = [];
  const passed: string[] = [];
  const failed: string[] = [];
  const toolArgsById = new Map<string, Record<string, unknown>>();

  for (const message of input.sessionMessages ?? []) {
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) {
        toolsUsed.push(call.function.name);
        const args = parseJsonObject(call.function.arguments) ?? {};
        toolArgsById.set(call.id, args);
        const path = pathFromArgs(args);
        if (path && /write|edit|patch|apply|file/i.test(call.function.name)) {
          filesTouched.push(path);
        }
        const command = commandFromArgs(args);
        if (isVerificationCommand(command)) {
          commandsRun.push(command!);
        }
      }
    }

    if (message.role === 'tool') {
      const callId = message.toolCallId ?? message.tool_call_id;
      const args = callId ? toolArgsById.get(callId) : undefined;
      const command = args ? commandFromArgs(args) : undefined;
      const parsed = parseJsonObject(message.content);
      const success = parsed?.success === true;
      const explicitFailure = parsed?.success === false;
      const line = command
        ? `${command}: ${toolOutputLine(message.content)}`
        : toolOutputLine(message.content);

      if (isVerificationCommand(command)) {
        if (success) {
          passed.push(compact(line));
        } else if (explicitFailure) {
          failed.push(compact(line));
        }
      }
    }
  }

  const assistantOutcome = compact(input.assistantContent || 'No assistant text was produced.');
  const decisions = assistantOutcome ? [assistantOutcome] : [];

  return {
    id: randomUUID(),
    turn: input.turn,
    taskEpoch: input.taskEpoch,
    intentKind: input.intent.kind as IntentKind,
    userIntent: compact(input.userInput),
    assistantOutcome,
    filesTouched: unique(filesTouched).slice(0, 20),
    toolsUsed: unique(toolsUsed).slice(0, 20),
    decisions,
    verification: {
      commandsRun: unique(commandsRun).slice(0, 12),
      passed: unique(passed).slice(0, 12),
      failed: unique(failed).slice(0, 12),
    },
    unresolved: extractUnresolved(input.assistantContent, failed),
    createdAt: Date.now(),
  };
}
