export type OrionAcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export type OrionAcpPromptContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name: string;
      readonly title?: string | null;
      readonly description?: string | null;
      readonly mimeType?: string | null;
    }
  | { readonly type: 'image' | 'audio' | 'resource' };

export type OrionAcpSessionUpdate =
  | {
      readonly sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
      readonly content: { readonly type: 'text'; readonly text: string };
      readonly messageId: string;
    }
  | {
      readonly sessionUpdate: 'tool_call';
      readonly toolCallId: string;
      readonly title: string;
      readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
      readonly rawInput?: unknown;
    }
  | {
      readonly sessionUpdate: 'tool_call_update';
      readonly toolCallId: string;
      readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
      readonly title?: string;
      readonly rawOutput?: unknown;
    };

export interface OrionAcpPermissionRequest {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface OrionAcpRuntimeObserver {
  update(update: OrionAcpSessionUpdate): Promise<void>;
  requestPermission(request: OrionAcpPermissionRequest): Promise<boolean>;
}

export interface OrionAcpMcpEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly _meta?: Readonly<Record<string, unknown>> | null;
}

export interface OrionAcpMcpHttpHeader {
  readonly name: string;
  readonly value: string;
  readonly _meta?: Readonly<Record<string, unknown>> | null;
}

export type OrionAcpMcpServer =
  | {
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly OrionAcpMcpEnvironmentVariable[];
      readonly _meta?: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly type: 'http' | 'sse';
      readonly name: string;
      readonly url: string;
      readonly headers: readonly OrionAcpMcpHttpHeader[];
      readonly _meta?: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly type: 'acp';
      readonly name: string;
      readonly serverId: string;
      readonly _meta?: Readonly<Record<string, unknown>> | null;
    };

export interface OrionAcpCreateSessionInput {
  readonly cwd: string;
  readonly mcpServers: readonly OrionAcpMcpServer[];
  readonly additionalDirectories?: readonly string[];
}

export interface OrionAcpLoadSessionInput extends OrionAcpCreateSessionInput {
  readonly sessionId: string;
  readonly observer: OrionAcpRuntimeObserver;
}

export interface OrionAcpPromptInput {
  readonly sessionId: string;
  readonly prompt: readonly OrionAcpPromptContent[];
  readonly observer: OrionAcpRuntimeObserver;
  readonly signal?: AbortSignal;
}

export interface OrionAcpRuntimePort {
  createSession(input: OrionAcpCreateSessionInput): Promise<{ readonly sessionId: string }>;
  loadSession(input: OrionAcpLoadSessionInput): Promise<void>;
  prompt(input: OrionAcpPromptInput): Promise<OrionAcpStopReason>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export class OrionAcpError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'OrionAcpError';
  }
}
