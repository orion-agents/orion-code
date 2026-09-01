import {
  dirtySettingsKeys,
  hydrateSettingsDraft,
  markDraftConflict,
  rebaseSettingsDraft,
  resetDraftValue,
  setDraftValue,
  type SettingsDraftV1,
} from './settings-draft';
import type {
  SettingsKeyV1,
  SettingsProblemCodeV1,
  SettingsValueMapV1,
  WebSettingsDocumentV1,
} from './types';

export type SettingsSectionId = 'general' | 'models' | 'permissions' | 'advanced';
export type SettingsEditorPhase =
  | 'closed'
  | 'ready'
  | 'saving'
  | 'success'
  | 'conflict'
  | 'rejected';

export interface SettingsEditorState {
  readonly phase: SettingsEditorPhase;
  readonly section: SettingsSectionId;
  readonly draft: SettingsDraftV1 | null;
  readonly message: string | null;
  readonly problemCode: SettingsProblemCodeV1 | string | null;
  readonly confirmDiscard: boolean;
}

export type SettingsEditorAction =
  | { readonly type: 'open'; readonly document: WebSettingsDocumentV1 }
  | { readonly type: 'close' }
  | { readonly type: 'select_section'; readonly section: SettingsSectionId }
  | {
      readonly type: 'set_value';
      readonly key: SettingsKeyV1;
      readonly value: SettingsValueMapV1[SettingsKeyV1];
    }
  | { readonly type: 'reset_value'; readonly key: SettingsKeyV1 }
  | { readonly type: 'save_started' }
  | { readonly type: 'save_succeeded'; readonly document: WebSettingsDocumentV1 }
  | {
      readonly type: 'save_failed';
      readonly code: SettingsProblemCodeV1 | string;
      readonly message: string;
      readonly latest?: WebSettingsDocumentV1;
    }
  | { readonly type: 'server_updated'; readonly document: WebSettingsDocumentV1 }
  | { readonly type: 'adopt_server' }
  | { readonly type: 'rebase' }
  | { readonly type: 'request_discard' }
  | { readonly type: 'cancel_discard' }
  | { readonly type: 'clear_status' };

export const initialSettingsEditorState: SettingsEditorState = {
  phase: 'closed',
  section: 'general',
  draft: null,
  message: null,
  problemCode: null,
  confirmDiscard: false,
};

export function settingsEditorReducer(
  state: SettingsEditorState,
  action: SettingsEditorAction
): SettingsEditorState {
  switch (action.type) {
    case 'open':
      return {
        ...initialSettingsEditorState,
        phase: 'ready',
        draft: hydrateSettingsDraft(action.document),
      };
    case 'close':
      return initialSettingsEditorState;
    case 'select_section':
      return { ...state, section: action.section, confirmDiscard: false };
    case 'set_value':
      if (!state.draft || state.phase === 'saving') return state;
      return {
        ...state,
        phase: 'ready',
        draft: setDraftValue(state.draft, action.key, action.value),
        message: null,
        problemCode: null,
        confirmDiscard: false,
      };
    case 'reset_value':
      if (!state.draft || state.phase === 'saving') return state;
      return {
        ...state,
        phase: 'ready',
        draft: resetDraftValue(state.draft, action.key),
        message: null,
        problemCode: null,
        confirmDiscard: false,
      };
    case 'save_started':
      return {
        ...state,
        phase: 'saving',
        message: '正在原子应用设置…',
        problemCode: null,
        confirmDiscard: false,
      };
    case 'save_succeeded':
      return {
        ...state,
        phase: 'success',
        draft: hydrateSettingsDraft(action.document),
        message: '设置已安全保存并应用。',
        problemCode: null,
        confirmDiscard: false,
      };
    case 'save_failed': {
      if (!state.draft) return state;
      const conflict = action.code === 'settings_revision_conflict';
      return {
        ...state,
        phase: conflict ? 'conflict' : 'rejected',
        draft: action.latest ? markDraftConflict(state.draft, action.latest) : state.draft,
        message: action.message,
        problemCode: action.code,
        confirmDiscard: false,
      };
    }
    case 'server_updated': {
      if (!state.draft) {
        return { ...state, phase: 'ready', draft: hydrateSettingsDraft(action.document) };
      }
      if (state.phase === 'saving') {
        return state;
      }
      if (state.draft.base.revision === action.document.revision) {
        const dirty = dirtySettingsKeys(state.draft).length > 0;
        return {
          ...state,
          draft: dirty
            ? { ...state.draft, base: action.document }
            : hydrateSettingsDraft(action.document),
        };
      }
      if (
        state.draft.workspace !== action.document.workspace ||
        dirtySettingsKeys(state.draft).length === 0
      ) {
        return {
          ...state,
          phase: 'ready',
          draft: hydrateSettingsDraft(action.document),
          message: '已采用 Host 的最新设置。',
          problemCode: null,
          confirmDiscard: false,
        };
      }
      return {
        ...state,
        phase: 'conflict',
        draft: markDraftConflict(state.draft, action.document),
        message: 'Host 设置已更新。你的草稿仍被保留，请选择如何继续。',
        problemCode: 'settings_revision_conflict',
        confirmDiscard: false,
      };
    }
    case 'adopt_server':
      if (!state.draft?.serverLatest) return state;
      return {
        ...state,
        phase: 'ready',
        draft: hydrateSettingsDraft(state.draft.serverLatest),
        message: '已采用服务器最新值。',
        problemCode: null,
      };
    case 'rebase':
      if (!state.draft?.serverLatest) return state;
      return {
        ...state,
        phase: 'ready',
        draft: rebaseSettingsDraft(state.draft),
        message: '草稿已基于服务器最新值重放；请确认后再次应用。',
        problemCode: null,
      };
    case 'request_discard':
      return { ...state, confirmDiscard: true };
    case 'cancel_discard':
      return { ...state, confirmDiscard: false };
    case 'clear_status':
      return { ...state, phase: 'ready', message: null, problemCode: null };
  }
}
