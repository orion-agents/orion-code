import type { AgentRuntimeEvent } from '../runtime/agent-runtime-protocol';
import type { AgentRuntimeControllerInput } from '../runtime/agent-runtime-controller';
import type { GoalRuntimeControlV2 } from '../runtime/goal-runtime-coordinator';
import type { RuntimeEventEnvelopeV1 } from '../runtime/protocol/runtime-protocol-v1';
import type { ToolDetailPage, ToolDetailSummary } from '../runtime/tool-detail-repository';
import type { SessionMeta } from '../services/session-storage';
import type { ToolConfirmationPolicy } from '../services/global-config';

export const WEB_API_VERSION = 1 as const;
export const WEB_NONCE_HEADER = 'x-orion-web-nonce';
export const WEB_MAX_BODY_BYTES = 1024 * 1024;

export interface WebModelSummaryV1 {
  readonly id: string;
  readonly label: string;
  readonly provider?: string;
}

export type WebSettingsSourceV1 = 'internal' | 'model' | 'global' | 'project' | 'session';
export type WebSettingsScopeV1 = 'global' | 'project' | 'session';
export type WebSettingsAppliesV1 = 'live' | 'next-logical-request' | 'new-session' | 'restart';
export type WebSettingsStateV1 = 'ready' | 'invalid' | 'read-only' | 'unavailable';
export type WebThemePreferenceV1 = 'system' | 'light' | 'dark';
export type WebMotionPreferenceV1 = 'system' | 'reduced';
export type WebEffortPreferenceV1 =
  | 'auto'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface WebSettingsFieldViewV1<T> {
  readonly effectiveValue: T;
  readonly explicitValue?: T;
  readonly inheritedValue?: T;
  readonly source: WebSettingsSourceV1;
  readonly scope: WebSettingsScopeV1;
  readonly applies: WebSettingsAppliesV1;
  readonly overridden: boolean;
  readonly writable: boolean;
  readonly blockedReason?: 'runtime_busy' | 'read_only' | 'invalid_document';
}

export interface WebCredentialSlotViewV1 {
  readonly providerId: string;
  readonly state: 'ready' | 'missing' | 'unavailable';
  readonly source: 'environment' | 'legacy' | 'none';
  readonly writable: false;
}

export interface WebSettingsDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly state: WebSettingsStateV1;
  readonly writable: boolean;
  readonly hasDocument: boolean;
  readonly workspace: string;
  readonly sections: {
    readonly appearance: {
      readonly theme: WebSettingsFieldViewV1<WebThemePreferenceV1>;
      readonly motion: WebSettingsFieldViewV1<WebMotionPreferenceV1>;
    };
    readonly defaults: {
      readonly model: WebSettingsFieldViewV1<string>;
      readonly effort: WebSettingsFieldViewV1<WebEffortPreferenceV1>;
    };
    readonly permissions: {
      readonly toolConfirmation: WebSettingsFieldViewV1<ToolConfirmationPolicy>;
    };
  };
  readonly models: readonly WebModelSummaryV1[];
  readonly credentials: readonly WebCredentialSlotViewV1[];
  readonly currentSession?: {
    readonly model: string;
    readonly effort: WebEffortPreferenceV1;
    readonly overridesProjectEffort: boolean;
  };
  readonly diagnostic?: { readonly code: string; readonly message: string };
}

/** Compatibility name retained inside the unreleased v0.3 Web implementation. */
export type WebSettingsSnapshotV1 = WebSettingsDocumentV1;

export type WebSettingsKeyV1 =
  | 'appearance.theme'
  | 'appearance.motion'
  | 'defaults.model'
  | 'defaults.effort'
  | 'permissions.toolConfirmation';

export type WebSettingsOperationV1 =
  | { readonly op: 'set'; readonly key: 'appearance.theme'; readonly value: WebThemePreferenceV1 }
  | { readonly op: 'unset'; readonly key: 'appearance.theme' }
  | { readonly op: 'set'; readonly key: 'appearance.motion'; readonly value: WebMotionPreferenceV1 }
  | { readonly op: 'unset'; readonly key: 'appearance.motion' }
  | { readonly op: 'set'; readonly key: 'defaults.model'; readonly value: string }
  | { readonly op: 'unset'; readonly key: 'defaults.model' }
  | { readonly op: 'set'; readonly key: 'defaults.effort'; readonly value: WebEffortPreferenceV1 }
  | { readonly op: 'unset'; readonly key: 'defaults.effort' }
  | {
      readonly op: 'set';
      readonly key: 'permissions.toolConfirmation';
      readonly value: ToolConfirmationPolicy;
    }
  | { readonly op: 'unset'; readonly key: 'permissions.toolConfirmation' };

export interface WebSettingsUpdateRequestV1 {
  readonly requestId: string;
  readonly expectedRevision: string;
  readonly operations: readonly WebSettingsOperationV1[];
}

export interface WebOpenSettingsDocumentRequestV1 {
  readonly requestId: string;
}

export interface WebPendingPermissionV1 {
  readonly id: string;
  readonly toolName: string;
  readonly reason?: string;
  readonly sanitizedArguments: Readonly<Record<string, unknown>>;
  readonly allowedScopes: readonly ['once', 'project', 'global'];
}

export interface WebPageV1<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface WebTranscriptMessageV1 {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly timestamp: number;
  readonly modelVisibleContent?: string;
  readonly toolCallId?: string;
  readonly tool_calls?: readonly unknown[];
  readonly appliedSkills?: readonly string[];
}

export interface WebGoalViewV1 {
  readonly authority: 'turn_commit';
  readonly digest: string;
  readonly state: unknown;
}

export interface WebPlanViewV1 {
  readonly body: string;
  readonly returnMode: 'build' | 'auto';
  readonly digest: string;
}

export interface WebSessionSnapshotV1 {
  readonly apiVersion: 1;
  readonly session: WebSessionSummaryV1;
  readonly threadId: string | null;
  readonly threadCursor: number;
  readonly eventCursor: number;
  readonly projectionDigest?: string;
  readonly threadStatus: 'new' | 'active' | 'idle' | 'legacy';
  readonly activeTurnId?: string;
  readonly transcript: WebPageV1<WebTranscriptMessageV1>;
  readonly runtime: {
    readonly active: boolean;
    readonly processing: boolean;
    readonly agentMode: string;
    readonly permissionMode: string;
    readonly status: string;
    readonly followups: readonly {
      readonly id: string;
      readonly text: string;
      readonly queuedAt: number;
    }[];
    readonly followupLimit: number;
    readonly contextUsage: unknown;
    readonly tokenUsage: unknown;
  };
  readonly pendingApprovals: readonly WebPendingPermissionV1[];
  readonly goal: WebGoalViewV1 | null;
  readonly plan: WebPlanViewV1 | null;
  readonly recoveryDiagnostics: readonly unknown[];
}

export interface WebSkillSummaryV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly providerId: string;
  readonly sourceScope: string;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly requestedCapabilities: readonly string[];
  readonly digest: string;
}

export interface WebMcpServerSummaryV1 {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly transport: string;
  readonly tags: readonly string[];
  readonly disabled: boolean;
  readonly state: string;
  readonly generation: number;
  readonly toolCount: number;
  readonly activeCallCount: number;
  readonly failure?: string;
}

export interface WebWorkspaceSummaryV1 {
  readonly path: string;
  readonly label: string;
  readonly active: boolean;
  readonly sessionCount: number;
}

export type WebToolDetailSummaryV1 = ToolDetailSummary;
export type WebToolDetailPageV1 = ToolDetailPage;

export interface WebBootstrapV1 {
  readonly apiVersion: 1;
  readonly productVersion: string;
  readonly nonce: string;
  readonly workspace: string;
  readonly configured: boolean;
  readonly activeSessionId: string | null;
  readonly settings: WebSettingsSnapshotV1;
  readonly capabilities: {
    readonly goal: true;
    readonly plan: true;
    readonly skills: true;
    readonly mcp: true;
    readonly diagnostics: true;
  };
}

export interface WebSessionSummaryV1 {
  readonly id: string;
  readonly projectPath: string;
  readonly name?: string;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly taskSummary?: string;
  readonly activeGoalId?: string;
  readonly activeGoalObjective?: string;
}

export type WebCommandTypeV1 =
  | 'submit'
  | 'queue_followup'
  | 'remove_followup'
  | 'clear_followups'
  | 'interrupt'
  | 'permission_decision'
  | 'goal_control'
  | 'permission_mode_change'
  | 'cycle_agent_mode'
  | 'set_agent_mode';

export interface WebCommandV1 {
  readonly requestId: string;
  readonly type: WebCommandTypeV1;
  readonly text?: string;
  readonly itemId?: string;
  readonly requestPermissionId?: string;
  readonly approved?: boolean;
  readonly scope?: 'once' | 'project' | 'global';
  readonly goalAction?: GoalRuntimeControlV2['action'];
  readonly objective?: string;
  readonly toolConfirmation?: ToolConfirmationPolicy;
  readonly agentMode?: 'interactive' | 'plan' | 'auto';
}

export interface WebCommandResultV1 {
  readonly requestId: string;
  readonly result: string;
  readonly detail?: string;
}

export interface WebSessionMutationResultV1 {
  readonly requestId: string;
  readonly session: WebSessionSummaryV1;
}

export interface WebSettingsMutationResultV1 {
  readonly requestId: string;
  readonly revision: string;
  readonly appliedKeys: readonly WebSettingsKeyV1[];
  readonly settings: WebSettingsDocumentV1;
}

export type WebWorkbenchEventV1 =
  | { readonly type: 'runtime_event'; readonly value: AgentRuntimeEvent }
  | { readonly type: 'thread_event'; readonly value: RuntimeEventEnvelopeV1 }
  | {
      readonly type: 'workbench_state';
      readonly workspace: string;
      readonly activeSessionId: string | null;
    }
  | {
      readonly type: 'settings_invalidated';
      readonly revision: string;
      readonly reason: 'local-write' | 'external-edit' | 'workspace-change';
      readonly state: 'ready' | 'invalid';
    }
  | { readonly type: 'replay_reset'; readonly reason: string };

interface WebEventEnvelopeBaseV1 {
  readonly apiVersion: 1;
  readonly eventId: string;
  readonly cursor: number;
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly durable: boolean;
  readonly timestamp: string;
}

export type WebEventEnvelopeV1 = WebEventEnvelopeBaseV1 &
  (
    | {
        readonly type: 'runtime_event';
        readonly payload: {
          readonly eventType: AgentRuntimeEvent['type'];
          readonly value: AgentRuntimeEvent;
        };
      }
    | {
        readonly type: 'thread_event';
        readonly sessionId: string;
        readonly threadId: string;
        readonly durable: true;
        readonly payload: {
          readonly sequence: number;
          readonly eventType: string;
          readonly value: RuntimeEventEnvelopeV1;
        };
      }
    | {
        readonly type: 'workbench_state';
        readonly payload: { readonly workspace: string; readonly activeSessionId: string | null };
      }
    | {
        readonly type: 'settings_invalidated';
        readonly durable: false;
        readonly payload: {
          readonly revision: string;
          readonly reason: 'local-write' | 'external-edit' | 'workspace-change';
          readonly state: 'ready' | 'invalid';
        };
      }
    | {
        readonly type: 'replay_reset';
        readonly durable: true;
        readonly payload: { readonly reason: string; readonly snapshotRequired: true };
      }
  );

export class WebProtocolError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code = 'invalid_request'
  ) {
    super(message);
    this.name = 'WebProtocolError';
  }
}

const SETTINGS_REVISION_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SETTINGS_MAX_OPERATIONS = 20;
const SETTINGS_MAX_BODY_BYTES = 64 * 1024;

export function parseWebSettingsUpdate(value: unknown): WebSettingsUpdateRequestV1 {
  try {
    return parseWebSettingsUpdateValue(value);
  } catch (error) {
    if (error instanceof WebProtocolError) {
      throw new WebProtocolError(error.message, 'settings_invalid_operation');
    }
    throw error;
  }
}

export function parseWebOpenSettingsDocument(value: unknown): WebOpenSettingsDocumentRequestV1 {
  const row = requireRecord(value, 'Open Settings request');
  assertOnlyKeys(row, ['requestId'], 'open Settings request');
  const requestId = requireBoundedString(row.requestId, 'requestId', 128);
  if (!UUID_PATTERN.test(requestId)) throw new WebProtocolError('requestId must be a UUID');
  return Object.freeze({ requestId });
}

function parseWebSettingsUpdateValue(value: unknown): WebSettingsUpdateRequestV1 {
  const row = requireRecord(value, 'Settings request');
  assertOnlyKeys(row, ['requestId', 'expectedRevision', 'operations'], 'settings');
  if (Buffer.byteLength(JSON.stringify(row), 'utf8') > SETTINGS_MAX_BODY_BYTES) {
    throw new WebProtocolError(`Settings request exceeds ${SETTINGS_MAX_BODY_BYTES} bytes`);
  }
  const requestId = requireBoundedString(row.requestId, 'requestId', 128);
  if (!UUID_PATTERN.test(requestId)) throw new WebProtocolError('requestId must be a UUID');
  const expectedRevision = requireBoundedString(row.expectedRevision, 'expectedRevision', 128);
  if (!SETTINGS_REVISION_PATTERN.test(expectedRevision)) {
    throw new WebProtocolError('expectedRevision is not a valid Settings revision');
  }
  if (
    !Array.isArray(row.operations) ||
    row.operations.length < 1 ||
    row.operations.length > SETTINGS_MAX_OPERATIONS
  ) {
    throw new WebProtocolError(
      `operations must contain between 1 and ${SETTINGS_MAX_OPERATIONS} entries`
    );
  }
  const seen = new Set<WebSettingsKeyV1>();
  const operations = row.operations.map((entry, index) => {
    const operation = parseSettingsOperation(entry, index);
    if (seen.has(operation.key)) {
      throw new WebProtocolError(`Settings key appears more than once: ${operation.key}`);
    }
    seen.add(operation.key);
    return operation;
  });
  return Object.freeze({
    requestId,
    expectedRevision,
    operations: Object.freeze(operations),
  });
}

function parseSettingsOperation(value: unknown, index: number): WebSettingsOperationV1 {
  const row = requireRecord(value, `operations[${index}]`);
  const op = requireEnum(row.op, `operations[${index}].op`, ['set', 'unset'] as const);
  const key = requireEnum(row.key, `operations[${index}].key`, [
    'appearance.theme',
    'appearance.motion',
    'defaults.model',
    'defaults.effort',
    'permissions.toolConfirmation',
  ] as const);
  assertOnlyKeys(row, op === 'set' ? ['op', 'key', 'value'] : ['op', 'key'], 'settings operation');
  if (op === 'unset') return { op, key } as WebSettingsOperationV1;
  if (row.value === undefined) {
    throw new WebProtocolError(`operations[${index}].value is required for set`);
  }
  switch (key) {
    case 'appearance.theme':
      return {
        op,
        key,
        value: requireEnum(row.value, `operations[${index}].value`, [
          'system',
          'light',
          'dark',
        ] as const),
      };
    case 'appearance.motion':
      return {
        op,
        key,
        value: requireEnum(row.value, `operations[${index}].value`, ['system', 'reduced'] as const),
      };
    case 'defaults.model':
      return { op, key, value: requireBoundedString(row.value, 'model', 200) };
    case 'defaults.effort':
      return {
        op,
        key,
        value: requireEnum(row.value, `operations[${index}].value`, [
          'auto',
          'none',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ] as const),
      };
    case 'permissions.toolConfirmation':
      return {
        op,
        key,
        value: requireEnum(row.value, `operations[${index}].value`, [
          'allow',
          'ask',
          'deny',
        ] as const),
      };
  }
}

export function parseWebCommand(value: unknown): WebCommandV1 {
  const row = requireRecord(value, 'Command body');
  assertOnlyKeys(row, [
    'requestId',
    'type',
    'text',
    'itemId',
    'requestPermissionId',
    'approved',
    'scope',
    'goalAction',
    'objective',
    'toolConfirmation',
    'agentMode',
  ]);
  const requestId = requireBoundedString(row.requestId, 'requestId', 128);
  const type = requireEnum(row.type, 'type', [
    'submit',
    'queue_followup',
    'remove_followup',
    'clear_followups',
    'interrupt',
    'permission_decision',
    'goal_control',
    'permission_mode_change',
    'cycle_agent_mode',
    'set_agent_mode',
  ] as const);
  const command: WebCommandV1 = {
    requestId,
    type,
    ...(row.text === undefined
      ? {}
      : { text: requireBoundedString(row.text, 'text', WEB_MAX_BODY_BYTES) }),
    ...(row.itemId === undefined
      ? {}
      : { itemId: requireBoundedString(row.itemId, 'itemId', 256) }),
    ...(row.requestPermissionId === undefined
      ? {}
      : {
          requestPermissionId: requireBoundedString(
            row.requestPermissionId,
            'requestPermissionId',
            256
          ),
        }),
    ...(row.approved === undefined ? {} : { approved: requireBoolean(row.approved, 'approved') }),
    ...(row.scope === undefined
      ? {}
      : { scope: requireEnum(row.scope, 'scope', ['once', 'project', 'global'] as const) }),
    ...(row.goalAction === undefined
      ? {}
      : {
          goalAction: requireEnum(row.goalAction, 'goalAction', [
            'create',
            'status',
            'pause',
            'resume',
            'clear',
          ] as const),
        }),
    ...(row.objective === undefined
      ? {}
      : { objective: requireBoundedString(row.objective, 'objective', WEB_MAX_BODY_BYTES) }),
    ...(row.toolConfirmation === undefined
      ? {}
      : {
          toolConfirmation: requireEnum(row.toolConfirmation, 'toolConfirmation', [
            'allow',
            'ask',
            'deny',
          ] as const),
        }),
    ...(row.agentMode === undefined
      ? {}
      : {
          agentMode: requireEnum(row.agentMode, 'agentMode', [
            'interactive',
            'plan',
            'auto',
          ] as const),
        }),
  };
  validateCommandFields(command);
  return Object.freeze(command);
}

export function toAgentRuntimeInput(command: WebCommandV1): AgentRuntimeControllerInput {
  switch (command.type) {
    case 'submit':
      return { type: 'submit', text: command.text as string, source: 'programmatic' };
    case 'queue_followup':
      return { type: 'queue_followup', text: command.text as string, source: 'programmatic' };
    case 'remove_followup':
      return {
        type: 'manage_followup_queue',
        action: 'remove',
        itemId: command.itemId,
        source: 'programmatic',
      };
    case 'clear_followups':
      return { type: 'manage_followup_queue', action: 'clear', source: 'programmatic' };
    case 'interrupt':
      return { type: 'interrupt', source: 'programmatic' };
    case 'permission_decision':
      return {
        type: 'permission_decision',
        requestId: command.requestPermissionId as string,
        approved: command.approved as boolean,
        scope: command.scope,
        source: 'programmatic',
      };
    case 'goal_control':
      return goalControlInput(command);
    case 'permission_mode_change':
      return {
        type: 'permission_mode_change',
        value: command.toolConfirmation as ToolConfirmationPolicy,
        source: 'programmatic',
      };
    case 'cycle_agent_mode':
      return { type: 'cycle_agent_mode', source: 'programmatic' };
    case 'set_agent_mode':
      return {
        type: 'set_agent_mode',
        mode: command.agentMode as 'interactive' | 'plan' | 'auto',
        source: 'programmatic',
      };
  }
}

export function projectSessionSummary(session: SessionMeta): WebSessionSummaryV1 {
  const createdAt = session.createdAt ?? new Date(session.startTime).toISOString();
  const updatedAt =
    session.updatedAtIso ?? new Date(session.updatedAt ?? session.startTime).toISOString();
  return Object.freeze({
    id: session.id,
    projectPath: session.projectPath,
    ...(session.name ? { name: session.name } : {}),
    model: session.model,
    createdAt,
    updatedAt,
    messageCount: session.messageCount ?? 0,
    ...(session.taskSummary ? { taskSummary: session.taskSummary } : {}),
    ...(session.activeGoalId ? { activeGoalId: session.activeGoalId } : {}),
    ...(session.activeGoalObjective ? { activeGoalObjective: session.activeGoalObjective } : {}),
  });
}

function goalControlInput(command: WebCommandV1): AgentRuntimeControllerInput {
  const action = command.goalAction as GoalRuntimeControlV2['action'];
  if (action === 'create') {
    return {
      type: 'goal_control',
      action,
      objective: command.objective as string,
      source: 'programmatic',
    };
  }
  return { type: 'goal_control', action, source: 'programmatic' };
}

function validateCommandFields(command: WebCommandV1): void {
  if ((command.type === 'submit' || command.type === 'queue_followup') && !command.text?.trim()) {
    throw new WebProtocolError(`${command.type} requires non-empty text`);
  }
  if (command.type === 'remove_followup' && !command.itemId) {
    throw new WebProtocolError('remove_followup requires itemId');
  }
  if (
    command.type === 'permission_decision' &&
    (!command.requestPermissionId || typeof command.approved !== 'boolean')
  ) {
    throw new WebProtocolError('permission_decision requires requestPermissionId and approved');
  }
  if (command.type === 'goal_control') {
    if (!command.goalAction) throw new WebProtocolError('goal_control requires goalAction');
    if (command.goalAction === 'create' && !command.objective?.trim()) {
      throw new WebProtocolError('Goal creation requires a non-empty objective');
    }
  }
  if (command.type === 'permission_mode_change' && !command.toolConfirmation) {
    throw new WebProtocolError('permission_mode_change requires toolConfirmation');
  }
  if (command.type === 'set_agent_mode' && !command.agentMode) {
    throw new WebProtocolError('set_agent_mode requires agentMode');
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
  subject = 'command'
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(row).find(key => !allowed.has(key));
  if (unknown) throw new WebProtocolError(`Unknown ${subject} field: ${unknown}`);
}

function requireBoundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WebProtocolError(`${name} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new WebProtocolError(`${name} exceeds ${maxLength} bytes`);
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new WebProtocolError(`${name} must be a boolean`);
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T
): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new WebProtocolError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}
