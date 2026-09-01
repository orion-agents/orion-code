export type ThemePreference = 'system' | 'light' | 'dark';
export type MotionPreference = 'system' | 'reduced';
export type ToolConfirmationPreference = 'ask' | 'allow' | 'deny';
export type EffortPreference =
  | 'auto'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type SettingsSourceV1 = 'internal' | 'model' | 'global' | 'project' | 'session';
export type SettingsScopeV1 = 'global' | 'project' | 'session';
export type SettingsAppliesV1 = 'live' | 'next-logical-request' | 'new-session' | 'restart';
export type SettingsBlockedReasonV1 = 'runtime_busy' | 'read_only' | 'invalid_document';

export interface SettingsFieldViewV1<T> {
  readonly effectiveValue: T;
  readonly explicitValue?: T;
  readonly inheritedValue?: T;
  readonly source: SettingsSourceV1;
  readonly scope: SettingsScopeV1;
  readonly applies: SettingsAppliesV1;
  readonly overridden: boolean;
  readonly writable: boolean;
  readonly blockedReason?: SettingsBlockedReasonV1;
}

export interface WebModelSummaryV1 {
  readonly id: string;
  readonly label: string;
  readonly provider?: string;
}

export interface CredentialSlotViewV1 {
  readonly providerId: string;
  readonly state: 'ready' | 'missing' | 'unavailable';
  readonly source: 'environment' | 'legacy' | 'none';
  readonly writable: false;
}

export interface WebSettingsDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly state: 'ready' | 'invalid' | 'read-only' | 'unavailable';
  readonly writable: boolean;
  readonly hasDocument: boolean;
  readonly workspace: string;
  readonly sections: {
    readonly appearance: {
      readonly theme: SettingsFieldViewV1<ThemePreference>;
      readonly motion: SettingsFieldViewV1<MotionPreference>;
    };
    readonly defaults: {
      readonly model: SettingsFieldViewV1<string>;
      readonly effort: SettingsFieldViewV1<EffortPreference>;
    };
    readonly permissions: {
      readonly toolConfirmation: SettingsFieldViewV1<ToolConfirmationPreference>;
    };
  };
  readonly models: readonly WebModelSummaryV1[];
  readonly credentials: readonly CredentialSlotViewV1[];
  readonly currentSession?: {
    readonly model: string;
    readonly effort: EffortPreference;
    readonly overridesProjectEffort: boolean;
  };
  readonly diagnostic?: {
    readonly code: string;
    readonly message: string;
  };
}

export type SettingsKeyV1 =
  | 'appearance.theme'
  | 'appearance.motion'
  | 'defaults.model'
  | 'defaults.effort'
  | 'permissions.toolConfirmation';

export interface SettingsValueMapV1 {
  readonly 'appearance.theme': ThemePreference;
  readonly 'appearance.motion': MotionPreference;
  readonly 'defaults.model': string;
  readonly 'defaults.effort': EffortPreference;
  readonly 'permissions.toolConfirmation': ToolConfirmationPreference;
}

export type SettingsValuesV1 = { readonly [K in SettingsKeyV1]: SettingsValueMapV1[K] };

export type SettingsOperationV1 = {
  [K in SettingsKeyV1]:
    | { readonly op: 'set'; readonly key: K; readonly value: SettingsValueMapV1[K] }
    | { readonly op: 'unset'; readonly key: K };
}[SettingsKeyV1];

export interface WebSettingsMutationResultV1 {
  readonly requestId: string;
  readonly revision: string;
  readonly appliedKeys: readonly SettingsKeyV1[];
  readonly settings: WebSettingsDocumentV1;
}

export type SettingsProblemCodeV1 =
  | 'settings_invalid_operation'
  | 'settings_write_forbidden'
  | 'settings_revision_conflict'
  | 'request_id_conflict'
  | 'runtime_busy'
  | 'settings_rejected'
  | 'settings_document_invalid'
  | 'settings_recovery_required';

export interface SettingsInvalidatedEventV1 {
  readonly apiVersion: 1;
  readonly eventId: string;
  readonly cursor: number;
  readonly sessionId: null;
  readonly threadId: null;
  readonly durable: false;
  readonly timestamp: string;
  readonly type: 'settings_invalidated';
  readonly payload: {
    readonly revision: string;
    readonly reason: 'local-write' | 'external-edit' | 'workspace-change';
    readonly state: 'ready' | 'invalid';
  };
}

export const SETTINGS_KEYS: readonly SettingsKeyV1[] = [
  'appearance.theme',
  'appearance.motion',
  'defaults.model',
  'defaults.effort',
  'permissions.toolConfirmation',
];

export function settingsField<K extends SettingsKeyV1>(
  document: WebSettingsDocumentV1,
  key: K
): SettingsFieldViewV1<SettingsValueMapV1[K]> {
  const field =
    key === 'appearance.theme'
      ? document.sections.appearance.theme
      : key === 'appearance.motion'
        ? document.sections.appearance.motion
        : key === 'defaults.model'
          ? document.sections.defaults.model
          : key === 'defaults.effort'
            ? document.sections.defaults.effort
            : document.sections.permissions.toolConfirmation;
  return field as SettingsFieldViewV1<SettingsValueMapV1[K]>;
}

export function effectiveSettingsValues(document: WebSettingsDocumentV1): SettingsValuesV1 {
  return {
    'appearance.theme': document.sections.appearance.theme.effectiveValue,
    'appearance.motion': document.sections.appearance.motion.effectiveValue,
    'defaults.model': document.sections.defaults.model.effectiveValue,
    'defaults.effort': document.sections.defaults.effort.effectiveValue,
    'permissions.toolConfirmation': document.sections.permissions.toolConfirmation.effectiveValue,
  };
}
