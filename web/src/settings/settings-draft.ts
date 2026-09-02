import {
  SETTINGS_KEYS,
  effectiveSettingsValues,
  settingsField,
  type SettingsKeyV1,
  type SettingsOperationV1,
  type SettingsValueMapV1,
  type SettingsValuesV1,
  type WebSettingsDocumentV1,
} from './types';

interface SetIntent {
  readonly op: 'set';
  readonly value: SettingsValueMapV1[SettingsKeyV1];
}

interface UnsetIntent {
  readonly op: 'unset';
}

export type SettingsDraftIntent = SetIntent | UnsetIntent;

export interface SettingsDraftV1 {
  readonly openedAtRevision: string;
  readonly workspace: string;
  readonly base: WebSettingsDocumentV1;
  readonly values: SettingsValuesV1;
  readonly intents: Readonly<Partial<Record<SettingsKeyV1, SettingsDraftIntent>>>;
  readonly serverLatest: WebSettingsDocumentV1 | null;
}

export function hydrateSettingsDraft(document: WebSettingsDocumentV1): SettingsDraftV1 {
  return {
    openedAtRevision: document.revision,
    workspace: document.workspace,
    base: document,
    values: controlValues(document),
    intents: {},
    serverLatest: null,
  };
}

export function setDraftValue<K extends SettingsKeyV1>(
  draft: SettingsDraftV1,
  key: K,
  value: SettingsValueMapV1[K]
): SettingsDraftV1 {
  const baseValue = controlValue(draft.base, key);
  const values = { ...draft.values, [key]: value } as SettingsValuesV1;
  const intents = { ...draft.intents };
  if (Object.is(value, baseValue)) delete intents[key];
  else intents[key] = { op: 'set', value };
  return { ...draft, values, intents, serverLatest: null };
}

export function resetDraftValue(draft: SettingsDraftV1, key: SettingsKeyV1): SettingsDraftV1 {
  const field = settingsField(draft.base, key);
  const intents = { ...draft.intents };
  if (field.explicitValue === undefined) {
    delete intents[key];
    return {
      ...draft,
      values: { ...draft.values, [key]: controlValue(draft.base, key) } as SettingsValuesV1,
      intents,
      serverLatest: null,
    };
  }
  intents[key] = { op: 'unset' };
  return {
    ...draft,
    values: {
      ...draft.values,
      [key]: field.inheritedValue ?? field.effectiveValue,
    } as SettingsValuesV1,
    intents,
    serverLatest: null,
  };
}

export function markDraftConflict(
  draft: SettingsDraftV1,
  latest: WebSettingsDocumentV1
): SettingsDraftV1 {
  return { ...draft, serverLatest: latest };
}

export function rebaseSettingsDraft(draft: SettingsDraftV1): SettingsDraftV1 {
  const latest = draft.serverLatest;
  if (!latest) return draft;
  let rebased = hydrateSettingsDraft(latest);
  for (const key of dirtySettingsKeys(draft)) {
    const intent = draft.intents[key];
    if (!intent) continue;
    if (intent.op === 'unset') {
      rebased = resetDraftValue(rebased, key);
      continue;
    }
    rebased = setDraftValue(rebased, key, intent.value);
  }
  return rebased;
}

export function dirtySettingsKeys(draft: SettingsDraftV1): readonly SettingsKeyV1[] {
  return SETTINGS_KEYS.filter(key => draft.intents[key] !== undefined);
}

export function draftOperations(draft: SettingsDraftV1): readonly SettingsOperationV1[] {
  return dirtySettingsKeys(draft).map(key => {
    const intent = draft.intents[key] as SettingsDraftIntent;
    return intent.op === 'unset'
      ? ({ op: 'unset', key } as SettingsOperationV1)
      : ({ op: 'set', key, value: intent.value } as SettingsOperationV1);
  });
}

export function conflictSettingsKeys(draft: SettingsDraftV1): readonly SettingsKeyV1[] {
  if (!draft.serverLatest) return [];
  return dirtySettingsKeys(draft).filter(key => {
    const before = settingsField(draft.base, key);
    const after = settingsField(draft.serverLatest as WebSettingsDocumentV1, key);
    return (
      !Object.is(before.effectiveValue, after.effectiveValue) ||
      !Object.is(before.explicitValue, after.explicitValue) ||
      before.overridden !== after.overridden ||
      before.source !== after.source
    );
  });
}

export function controlValue<K extends SettingsKeyV1>(
  document: WebSettingsDocumentV1,
  key: K
): SettingsValueMapV1[K] {
  const field = settingsField(document, key);
  return (field.explicitValue ?? field.effectiveValue) as SettingsValueMapV1[K];
}

function controlValues(document: WebSettingsDocumentV1): SettingsValuesV1 {
  const effective = effectiveSettingsValues(document);
  return {
    'appearance.style': controlValue(document, 'appearance.style') ?? effective['appearance.style'],
    'appearance.theme': controlValue(document, 'appearance.theme') ?? effective['appearance.theme'],
    'appearance.motion':
      controlValue(document, 'appearance.motion') ?? effective['appearance.motion'],
    'defaults.model': controlValue(document, 'defaults.model') ?? effective['defaults.model'],
    'defaults.effort': controlValue(document, 'defaults.effort') ?? effective['defaults.effort'],
    'permissions.toolConfirmation':
      controlValue(document, 'permissions.toolConfirmation') ??
      effective['permissions.toolConfirmation'],
  };
}
