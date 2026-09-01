import type {
  CredentialSlotViewV1,
  EffortPreference,
  MotionPreference,
  SettingsAppliesV1,
  SettingsBlockedReasonV1,
  SettingsFieldViewV1,
  SettingsInvalidatedEventV1,
  SettingsKeyV1,
  SettingsScopeV1,
  SettingsSourceV1,
  ThemePreference,
  ToolConfirmationPreference,
  UiStylePreference,
  WebModelSummaryV1,
  WebSettingsDocumentV1,
  WebSettingsMutationResultV1,
} from './types';

const REVISION_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_KEY_PATTERN =
  /^(?:api[-_]?key|authorization|cookie|password|secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|credential[-_]?value|headers?|env(?:ironment)?[-_]?name)$/i;

const SETTINGS_STATES = ['ready', 'invalid', 'read-only', 'unavailable'] as const;
const SOURCES: readonly SettingsSourceV1[] = ['internal', 'model', 'global', 'project', 'session'];
const SCOPES: readonly SettingsScopeV1[] = ['global', 'project', 'session'];
const APPLIES: readonly SettingsAppliesV1[] = [
  'live',
  'next-logical-request',
  'new-session',
  'restart',
];
const BLOCKED_REASONS: readonly SettingsBlockedReasonV1[] = [
  'runtime_busy',
  'read_only',
  'invalid_document',
];
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const MOTIONS: readonly MotionPreference[] = ['system', 'reduced'];
const UI_STYLES: readonly UiStylePreference[] = ['classic', 'orion-blocksmith'];
const EFFORTS: readonly EffortPreference[] = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const CONFIRMATIONS: readonly ToolConfirmationPreference[] = ['ask', 'allow', 'deny'];
const SETTING_KEYS: readonly SettingsKeyV1[] = [
  'appearance.style',
  'appearance.theme',
  'appearance.motion',
  'defaults.model',
  'defaults.effort',
  'permissions.toolConfirmation',
];

export function parseSettingsDocument(value: unknown): WebSettingsDocumentV1 {
  assertSecretFree(value);
  const row = record(value, 'Settings document');
  exactKeys(row, [
    'schemaVersion',
    'revision',
    'state',
    'writable',
    'hasDocument',
    'workspace',
    'sections',
    'models',
    'credentials',
    'currentSession',
    'diagnostic',
  ]);
  if (row.schemaVersion !== 1 && row.schemaVersion !== 2) {
    throw new Error('Settings schemaVersion is not supported.');
  }
  const schemaVersion = row.schemaVersion;
  const revision = string(row.revision, 'Settings revision');
  if (!REVISION_PATTERN.test(revision)) throw new Error('Settings revision is invalid.');
  const state = enumeration(row.state, 'Settings state', SETTINGS_STATES);
  const sections = record(row.sections, 'Settings sections');
  exactKeys(sections, ['appearance', 'defaults', 'permissions']);
  const appearance = record(sections.appearance, 'Appearance settings');
  exactKeys(appearance, schemaVersion === 1 ? ['theme', 'motion'] : ['style', 'theme', 'motion']);
  const defaults = record(sections.defaults, 'Default settings');
  exactKeys(defaults, ['model', 'effort']);
  const permissions = record(sections.permissions, 'Permission settings');
  exactKeys(permissions, ['toolConfirmation']);

  const models = array(row.models, 'Settings models').map(parseModel);
  const credentials = array(row.credentials, 'Credential status').map(parseCredential);
  const currentSession =
    row.currentSession === undefined ? undefined : parseCurrentSession(row.currentSession);
  const diagnostic = row.diagnostic === undefined ? undefined : parseDiagnostic(row.diagnostic);

  return {
    schemaVersion: 2,
    revision,
    state,
    writable: boolean(row.writable, 'Settings writable'),
    hasDocument: boolean(row.hasDocument, 'Settings document availability'),
    workspace: string(row.workspace, 'Settings workspace'),
    sections: {
      appearance: {
        style:
          schemaVersion === 1
            ? legacyStyleField(state, boolean(row.writable, 'Settings writable'))
            : parseField(appearance.style, 'Visual style', isUiStyle),
        theme: parseField(appearance.theme, 'Theme', isTheme),
        motion: parseField(appearance.motion, 'Motion', isMotion),
      },
      defaults: {
        model: parseField(defaults.model, 'Default model', isNonEmptyString),
        effort: parseField(defaults.effort, 'Default effort', isEffort),
      },
      permissions: {
        toolConfirmation: parseField(
          permissions.toolConfirmation,
          'Tool confirmation',
          isToolConfirmation
        ),
      },
    },
    models,
    credentials,
    ...(currentSession ? { currentSession } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export function parseSettingsMutationResult(value: unknown): WebSettingsMutationResultV1 {
  assertSecretFree(value);
  const row = record(value, 'Settings mutation result');
  exactKeys(row, ['requestId', 'revision', 'appliedKeys', 'settings']);
  const requestId = string(row.requestId, 'Settings requestId');
  if (!UUID_PATTERN.test(requestId)) throw new Error('Settings requestId is invalid.');
  const settings = parseSettingsDocument(row.settings);
  const revision = string(row.revision, 'Settings mutation revision');
  if (revision !== settings.revision) {
    throw new Error('Settings mutation revisions do not match.');
  }
  const appliedKeys = array(row.appliedKeys, 'Applied setting keys').map((entry, index) =>
    enumeration(entry, `Applied setting key ${index + 1}`, SETTING_KEYS)
  );
  if (new Set(appliedKeys).size !== appliedKeys.length) {
    throw new Error('Settings mutation contains duplicate applied keys.');
  }
  return { requestId, revision, appliedKeys, settings };
}

export function parseSettingsInvalidatedEvent(
  value: Record<string, unknown>
): SettingsInvalidatedEventV1 {
  const payload = record(value.payload, 'Settings invalidation payload');
  exactKeys(payload, ['revision', 'reason', 'state']);
  const revision = string(payload.revision, 'Settings invalidation revision');
  if (!REVISION_PATTERN.test(revision))
    throw new Error('Settings invalidation revision is invalid.');
  return {
    apiVersion: 1,
    eventId: string(value.eventId, 'Settings invalidation eventId'),
    cursor: safeInteger(value.cursor, 'Settings invalidation cursor'),
    sessionId: null,
    threadId: null,
    durable: false,
    timestamp: string(value.timestamp, 'Settings invalidation timestamp'),
    type: 'settings_invalidated',
    payload: {
      revision,
      reason: enumeration(payload.reason, 'Settings invalidation reason', [
        'local-write',
        'external-edit',
        'workspace-change',
      ] as const),
      state: enumeration(payload.state, 'Settings invalidation state', [
        'ready',
        'invalid',
      ] as const),
    },
  };
}

export function isSettingsProblemCode(value: string): boolean {
  return [
    'settings_invalid_operation',
    'settings_write_forbidden',
    'settings_revision_conflict',
    'request_id_conflict',
    'runtime_busy',
    'settings_rejected',
    'settings_document_invalid',
    'settings_recovery_required',
  ].includes(value);
}

function parseField<T>(
  value: unknown,
  name: string,
  validValue: (candidate: unknown) => candidate is T
): SettingsFieldViewV1<T> {
  const row = record(value, `${name} field`);
  exactKeys(row, [
    'effectiveValue',
    'explicitValue',
    'inheritedValue',
    'source',
    'scope',
    'applies',
    'overridden',
    'writable',
    'blockedReason',
  ]);
  if (!validValue(row.effectiveValue)) throw new Error(`${name} effective value is invalid.`);
  if (row.explicitValue !== undefined && !validValue(row.explicitValue)) {
    throw new Error(`${name} explicit value is invalid.`);
  }
  if (row.inheritedValue !== undefined && !validValue(row.inheritedValue)) {
    throw new Error(`${name} inherited value is invalid.`);
  }
  const explicitValue = row.explicitValue as T | undefined;
  const inheritedValue = row.inheritedValue as T | undefined;
  return {
    effectiveValue: row.effectiveValue,
    ...(explicitValue === undefined ? {} : { explicitValue }),
    ...(inheritedValue === undefined ? {} : { inheritedValue }),
    source: enumeration(row.source, `${name} source`, SOURCES),
    scope: enumeration(row.scope, `${name} scope`, SCOPES),
    applies: enumeration(row.applies, `${name} application timing`, APPLIES),
    overridden: boolean(row.overridden, `${name} override state`),
    writable: boolean(row.writable, `${name} writable state`),
    ...(row.blockedReason === undefined
      ? {}
      : {
          blockedReason: enumeration(row.blockedReason, `${name} blocked reason`, BLOCKED_REASONS),
        }),
  };
}

function parseModel(value: unknown, index: number): WebModelSummaryV1 {
  const row = record(value, `Model ${index + 1}`);
  exactKeys(row, ['id', 'label', 'provider']);
  return {
    id: string(row.id, `Model ${index + 1} id`),
    label: string(row.label, `Model ${index + 1} label`),
    ...(row.provider === undefined
      ? {}
      : { provider: string(row.provider, `Model ${index + 1} provider`) }),
  };
}

function parseCredential(value: unknown, index: number): CredentialSlotViewV1 {
  const row = record(value, `Credential ${index + 1}`);
  exactKeys(row, ['providerId', 'state', 'source', 'writable']);
  if (row.writable !== false) throw new Error('Browser credential status must be read-only.');
  return {
    providerId: string(row.providerId, `Credential ${index + 1} provider`),
    state: enumeration(row.state, `Credential ${index + 1} state`, [
      'ready',
      'missing',
      'unavailable',
    ] as const),
    source: enumeration(row.source, `Credential ${index + 1} source`, [
      'environment',
      'legacy',
      'none',
    ] as const),
    writable: false,
  };
}

function parseCurrentSession(value: unknown): NonNullable<WebSettingsDocumentV1['currentSession']> {
  const row = record(value, 'Current session settings');
  exactKeys(row, ['model', 'effort', 'overridesProjectEffort']);
  return {
    model: string(row.model, 'Current session model'),
    effort: enumeration(row.effort, 'Current session effort', EFFORTS),
    overridesProjectEffort: boolean(
      row.overridesProjectEffort,
      'Current session effort override state'
    ),
  };
}

function parseDiagnostic(value: unknown): NonNullable<WebSettingsDocumentV1['diagnostic']> {
  const row = record(value, 'Settings diagnostic');
  exactKeys(row, ['code', 'message']);
  return {
    code: string(row.code, 'Settings diagnostic code'),
    message: string(row.message, 'Settings diagnostic message'),
  };
}

function assertSecretFree(value: unknown, ancestors = new Set<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (ancestors.has(value)) throw new Error('Settings response contains a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertSecretFree(item, ancestors);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new Error('Settings response contains a forbidden secret-bearing field.');
      }
      assertSecretFree(child, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be text.`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean.`);
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value as number;
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T
): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as T[number];
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[]): void {
  const known = new Set(allowed);
  const unknown = Object.keys(row).find(key => !known.has(key));
  if (unknown) throw new Error(`Settings response contains an unknown field: ${unknown}.`);
}

function isTheme(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEMES.includes(value as ThemePreference);
}

function isUiStyle(value: unknown): value is UiStylePreference {
  return typeof value === 'string' && UI_STYLES.includes(value as UiStylePreference);
}

function legacyStyleField(
  state: WebSettingsDocumentV1['state'],
  writable: boolean
): SettingsFieldViewV1<UiStylePreference> {
  const blockedReason =
    state === 'invalid'
      ? ('invalid_document' as const)
      : state === 'ready' && writable
        ? undefined
        : ('read_only' as const);
  return {
    effectiveValue: 'orion-blocksmith',
    inheritedValue: 'orion-blocksmith',
    source: 'internal',
    scope: 'global',
    applies: 'live',
    overridden: false,
    writable: state === 'ready' && writable,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

function isMotion(value: unknown): value is MotionPreference {
  return typeof value === 'string' && MOTIONS.includes(value as MotionPreference);
}

function isEffort(value: unknown): value is EffortPreference {
  return typeof value === 'string' && EFFORTS.includes(value as EffortPreference);
}

function isToolConfirmation(value: unknown): value is ToolConfirmationPreference {
  return typeof value === 'string' && CONFIRMATIONS.includes(value as ToolConfirmationPreference);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}
