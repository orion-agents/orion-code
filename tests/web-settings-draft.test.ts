import {
  conflictSettingsKeys,
  draftOperations,
  hydrateSettingsDraft,
  resetDraftValue,
  setDraftValue,
} from '../web/src/settings/settings-draft';
import { SettingsMirror } from '../web/src/settings/settings-mirror';
import { parseSettingsDocument } from '../web/src/settings/contract';
import {
  initialSettingsEditorState,
  settingsEditorReducer,
} from '../web/src/settings/settings-reducer';
import type { SettingsFieldViewV1, WebSettingsDocumentV1 } from '../web/src/settings/types';

describe('Web Settings draft and mirror', () => {
  test('normalizes rolling schema v1 documents to the built-in Blocksmith style', () => {
    const current = settingsDocument(`hmac-sha256:${'9'.repeat(64)}`);
    const legacy = {
      ...current,
      schemaVersion: 1,
      sections: {
        ...current.sections,
        appearance: {
          theme: current.sections.appearance.theme,
          motion: current.sections.appearance.motion,
        },
      },
    };

    expect(parseSettingsDocument(legacy)).toMatchObject({
      schemaVersion: 2,
      sections: {
        appearance: {
          style: {
            effectiveValue: 'orion-blocksmith',
            inheritedValue: 'orion-blocksmith',
            source: 'internal',
            applies: 'live',
          },
        },
      },
    });
  });

  test('hydrates, edits and resets an explicit value with typed set/unset operations', () => {
    const base = settingsDocument('hmac-sha256:a'.padEnd(76, 'a'), {
      theme: explicitField('dark', 'system', 'global', 'global', 'live'),
    });
    let draft = hydrateSettingsDraft(base);

    draft = setDraftValue(draft, 'appearance.motion', 'reduced');
    expect(draftOperations(draft)).toEqual([
      { op: 'set', key: 'appearance.motion', value: 'reduced' },
    ]);

    draft = resetDraftValue(draft, 'appearance.theme');
    expect(draft.values['appearance.theme']).toBe('system');
    expect(draftOperations(draft)).toEqual([
      { op: 'unset', key: 'appearance.theme' },
      { op: 'set', key: 'appearance.motion', value: 'reduced' },
    ]);
  });

  test('keeps a dirty draft on invalidation and rebases only the user intents', () => {
    const base = settingsDocument('hmac-sha256:b'.padEnd(76, 'b'));
    const latest = settingsDocument('hmac-sha256:c'.padEnd(76, 'c'), {
      permission: explicitField('deny', 'allow', 'global', 'global', 'next-logical-request'),
    });
    const dirty = setDraftValue(hydrateSettingsDraft(base), 'appearance.theme', 'dark');
    let state = settingsEditorReducer(initialSettingsEditorState, {
      type: 'open',
      document: base,
    });
    state = { ...state, draft: dirty };

    state = settingsEditorReducer(state, { type: 'server_updated', document: latest });
    expect(state.phase).toBe('conflict');
    expect(state.draft?.values['appearance.theme']).toBe('dark');
    expect(state.draft?.serverLatest?.revision).toBe(latest.revision);
    expect(conflictSettingsKeys(state.draft!)).toEqual([]);

    state = settingsEditorReducer(state, { type: 'rebase' });
    expect(state.phase).toBe('ready');
    expect(state.draft?.base.revision).toBe(latest.revision);
    expect(state.draft?.values['appearance.theme']).toBe('dark');
    expect(state.draft?.values['permissions.toolConfirmation']).toBe('deny');
    expect(draftOperations(state.draft!)).toEqual([
      { op: 'set', key: 'appearance.theme', value: 'dark' },
    ]);
  });

  test('adopts a clean server update and distinguishes busy from revision conflict', () => {
    const base = settingsDocument('hmac-sha256:d'.padEnd(76, 'd'));
    const latest = settingsDocument('hmac-sha256:e'.padEnd(76, 'e'));
    let state = settingsEditorReducer(initialSettingsEditorState, {
      type: 'open',
      document: base,
    });

    state = settingsEditorReducer(state, { type: 'server_updated', document: latest });
    expect(state.phase).toBe('ready');
    expect(state.draft?.base.revision).toBe(latest.revision);

    state = settingsEditorReducer(state, {
      type: 'save_failed',
      code: 'runtime_busy',
      message: '当前回合正在运行',
    });
    expect(state.phase).toBe('rejected');
    expect(state.problemCode).toBe('runtime_busy');

    state = settingsEditorReducer(state, {
      type: 'save_failed',
      code: 'settings_revision_conflict',
      message: 'Host 设置已更新',
      latest: base,
    });
    expect(state.phase).toBe('conflict');
    expect(state.draft?.serverLatest?.revision).toBe(base.revision);
  });

  test('folds same-revision availability metadata without discarding a dirty draft', () => {
    const base = settingsDocument('hmac-sha256:5'.padEnd(76, '5'));
    const readOnly: WebSettingsDocumentV1 = {
      ...base,
      state: 'read-only',
      writable: false,
      sections: {
        ...base.sections,
        appearance: {
          ...base.sections.appearance,
          theme: {
            ...base.sections.appearance.theme,
            writable: false,
            blockedReason: 'read_only',
          },
        },
      },
    };
    let state = settingsEditorReducer(initialSettingsEditorState, {
      type: 'open',
      document: base,
    });
    state = settingsEditorReducer(state, {
      type: 'set_value',
      key: 'appearance.theme',
      value: 'dark',
    });

    state = settingsEditorReducer(state, { type: 'server_updated', document: readOnly });

    expect(state.draft?.base.state).toBe('read-only');
    expect(state.draft?.base.writable).toBe(false);
    expect(state.draft?.base.sections.appearance.theme.writable).toBe(false);
    expect(state.draft?.values['appearance.theme']).toBe('dark');
    expect(draftOperations(state.draft!)).toEqual([
      { op: 'set', key: 'appearance.theme', value: 'dark' },
    ]);
  });

  test('coalesces invalidations and discards a stale in-flight read after an accepted write', async () => {
    const stale = settingsDocument('hmac-sha256:f'.padEnd(76, 'f'));
    const accepted = settingsDocument(`hmac-sha256:${'1'.repeat(64)}`, {
      theme: explicitField('dark', 'system', 'global', 'global', 'live'),
    });
    let resolveFirst!: (document: WebSettingsDocumentV1) => void;
    let reads = 0;
    const mirror = new SettingsMirror(() => {
      reads += 1;
      if (reads === 1) {
        return new Promise<WebSettingsDocumentV1>(resolve => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(accepted);
    });

    const pending = mirror.refresh();
    await Promise.resolve();
    mirror.accept(accepted);
    resolveFirst(stale);
    await pending;

    expect(reads).toBe(2);
    expect(mirror.getSnapshot().document).toBe(accepted);
    expect(mirror.getSnapshot().document?.revision).not.toBe(stale.revision);
    mirror.dispose();
  });
});

interface DocumentOverrides {
  readonly theme?: SettingsFieldViewV1<'system' | 'light' | 'dark'>;
  readonly style?: SettingsFieldViewV1<'classic' | 'orion-blocksmith'>;
  readonly permission?: SettingsFieldViewV1<'ask' | 'allow' | 'deny'>;
}

function settingsDocument(
  revision: string,
  overrides: DocumentOverrides = {}
): WebSettingsDocumentV1 {
  return {
    schemaVersion: 2,
    revision,
    state: 'ready',
    writable: true,
    hasDocument: true,
    workspace: '/fixture/workspace',
    sections: {
      appearance: {
        style: overrides.style ?? inheritedField('orion-blocksmith', 'internal', 'global', 'live'),
        theme: overrides.theme ?? inheritedField('system', 'internal', 'global', 'live'),
        motion: inheritedField('system', 'internal', 'global', 'live'),
      },
      defaults: {
        model: explicitField('fixture-model', 'internal-model', 'global', 'global', 'new-session'),
        effort: inheritedField('auto', 'model', 'project', 'next-logical-request'),
      },
      permissions: {
        toolConfirmation:
          overrides.permission ??
          inheritedField('allow', 'internal', 'global', 'next-logical-request'),
      },
    },
    models: [{ id: 'fixture-model', label: 'Fixture Model', provider: 'fixture' }],
    credentials: [
      {
        providerId: 'fixture',
        state: 'ready',
        source: 'environment',
        writable: false,
      },
    ],
  };
}

function inheritedField<T>(
  value: T,
  source: SettingsFieldViewV1<T>['source'],
  scope: SettingsFieldViewV1<T>['scope'],
  applies: SettingsFieldViewV1<T>['applies']
): SettingsFieldViewV1<T> {
  return {
    effectiveValue: value,
    inheritedValue: value,
    source,
    scope,
    applies,
    overridden: false,
    writable: true,
  };
}

function explicitField<T>(
  value: T,
  inheritedValue: T,
  source: SettingsFieldViewV1<T>['source'],
  scope: SettingsFieldViewV1<T>['scope'],
  applies: SettingsFieldViewV1<T>['applies']
): SettingsFieldViewV1<T> {
  return {
    effectiveValue: value,
    explicitValue: value,
    inheritedValue,
    source,
    scope,
    applies,
    overridden: false,
    writable: true,
  };
}
