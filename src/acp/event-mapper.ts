import type {
  EditPreviewRequest,
  FollowupQueueSnapshot,
  ModelPickerRequest,
  RuntimeHarnessDiagnostics,
  RuntimeSessionRestoredEvent,
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  SessionPickerRequest,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from '../runtime/ui-events';
import type { LoopStats } from '../framework/query';
import type { SessionMessage, SessionTraceEvent } from '../services/session-storage';
import type { OrionAcpRuntimeObserver, OrionAcpSessionUpdate } from './runtime-port';

interface ProjectedEntry {
  content: string;
  revision: number;
  role: TranscriptEntry['role'];
}

export class OrionAcpEventMapper implements UiEventSink {
  private readonly entries = new Map<string, ProjectedEntry>();
  private readonly toolNames = new Map<string, string>();
  private nextEntryId = 1;
  private pending = Promise.resolve();
  private pendingError: unknown;

  constructor(private readonly observer: () => OrionAcpRuntimeObserver | undefined) {}

  append(entry: TranscriptAppendEntry): string {
    const id = `orion-message-${this.nextEntryId++}`;
    this.projectEntry(id, { ...entry, id });
    return id;
  }

  update(id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>): void {
    const current = this.entries.get(id);
    if (!current) return;
    this.projectEntry(id, {
      id,
      role: patch.role ?? current.role,
      content: patch.content ?? current.content,
      title: patch.title,
      errorLayer: patch.errorLayer,
      statusTone: patch.statusTone,
      budgetStop: patch.budgetStop,
      toolActivity: patch.toolActivity,
      command: patch.command,
    });
  }

  finalize(id: string, patch: Partial<Omit<TranscriptEntry, 'id'>> = {}): void {
    this.update(id, patch);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  replaceTranscript(entries: TranscriptEntry[]): void {
    this.entries.clear();
    for (const entry of entries) this.projectEntry(entry.id, entry);
  }

  clearTranscript(): void {
    this.entries.clear();
    this.toolNames.clear();
  }

  replaySessionMessages(messages: readonly SessionMessage[]): void {
    this.clearTranscript();
    for (const [messageIndex, message] of messages.entries()) {
      const messageId = `orion-history-${messageIndex + 1}`;
      if (message.role === 'user' || message.role === 'assistant') {
        if (message.content) {
          this.projectEntry(messageId, {
            id: messageId,
            role: message.role,
            content: message.content,
          });
        }
      }

      if (message.role === 'assistant') {
        for (const [toolIndex, toolCall] of (message.tool_calls ?? []).entries()) {
          const toolCallId =
            toolCall.id.trim() || `orion-history-tool-${messageIndex + 1}-${toolIndex + 1}`;
          const toolName = toolCall.function.name.trim() || 'tool';
          this.toolNames.set(toolCallId, toolName);
          this.enqueue({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            status: 'in_progress',
            rawInput: parseToolArguments(toolCall.function.arguments),
          });
        }
      }

      if (message.role === 'tool') {
        const toolCallId = message.toolCallId?.trim() || `orion-history-tool-${messageIndex + 1}`;
        const title = this.toolNames.get(toolCallId) ?? 'tool';
        if (!this.toolNames.has(toolCallId)) {
          this.enqueue({
            sessionUpdate: 'tool_call',
            toolCallId,
            title,
            status: 'in_progress',
          });
        }
        this.enqueue({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          title,
          status: 'completed',
          rawOutput: message.content,
        });
        this.toolNames.delete(toolCallId);
      }
    }
  }

  setStatus(_message: string): void {}
  showSessionPicker(_request: SessionPickerRequest): void {}
  showModelPicker(_request: ModelPickerRequest): void {}
  showEditPreview(_request: EditPreviewRequest): void {}
  showPermissionRequest(_request: ToolPermissionRequest): void {}

  toolStarted(event: RuntimeToolStartedEvent): void {
    this.toolNames.set(event.callId, event.name);
    this.enqueue({
      sessionUpdate: 'tool_call',
      toolCallId: event.callId,
      title: event.name,
      status: 'in_progress',
      rawInput: event.args,
    });
  }

  toolFinished(event: RuntimeToolFinishedEvent): void {
    const title = this.toolNames.get(event.callId) ?? event.name;
    this.enqueue({
      sessionUpdate: 'tool_call_update',
      toolCallId: event.callId,
      title,
      status: event.success ? 'completed' : 'failed',
      rawOutput: event.success
        ? event.summary
        : { error: event.error ?? event.summary ?? 'Tool failed.' },
    });
    this.toolNames.delete(event.callId);
  }

  sessionRestored(_event: RuntimeSessionRestoredEvent): void {}
  loopStatsUpdated(_stats: LoopStats): void {}
  traceEventRecorded(_event: SessionTraceEvent): void {}
  harnessDiagnosticsUpdated(_diagnostics: RuntimeHarnessDiagnostics): void {}
  followupQueueChanged(_snapshot: FollowupQueueSnapshot): void {}
  setProcessing(_processing: boolean): void {}

  async drain(): Promise<void> {
    await this.pending;
    if (this.pendingError !== undefined) {
      const error = this.pendingError;
      this.pendingError = undefined;
      throw error;
    }
  }

  private projectEntry(id: string, entry: TranscriptEntry): void {
    const previous = this.entries.get(id);
    const revision = previous?.revision ?? 0;
    let content = entry.content;
    let messageId = revision === 0 ? id : `${id}:r${revision}`;

    if (previous) {
      if (entry.role === previous.role && content.startsWith(previous.content)) {
        content = content.slice(previous.content.length);
      } else {
        messageId = `${id}:r${revision + 1}`;
      }
    }

    const nextRevision =
      previous && messageId !== (revision === 0 ? id : `${id}:r${revision}`)
        ? revision + 1
        : revision;
    this.entries.set(id, { content: entry.content, revision: nextRevision, role: entry.role });
    if (!content) return;

    const sessionUpdate = mapTranscriptRole(entry.role);
    if (!sessionUpdate) return;
    this.enqueue({
      sessionUpdate,
      messageId,
      content: { type: 'text', text: content },
    });
  }

  private enqueue(update: OrionAcpSessionUpdate): void {
    const observer = this.observer();
    if (!observer) return;
    this.pending = this.pending.then(async () => {
      try {
        await observer.update(update);
      } catch (error) {
        this.pendingError ??= error;
      }
    });
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function mapTranscriptRole(
  role: TranscriptEntry['role']
): 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk' | null {
  switch (role) {
    case 'user':
      return 'user_message_chunk';
    case 'assistant':
    case 'error':
      return 'agent_message_chunk';
    case 'system':
    case 'status':
      return 'agent_thought_chunk';
    case 'tool':
    case 'command':
      return null;
  }
}
