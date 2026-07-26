import { getNextPermissionMode, getModeDisplayText, PERMISSION_MODES, type PermissionMode } from '../src/commands/types';

describe('Permission Mode', () => {
  describe('PERMISSION_MODES', () => {
    test('contains expected modes', () => {
      expect(PERMISSION_MODES).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    });
  });

  describe('getNextPermissionMode', () => {
    test('cycles from default to acceptEdits', () => {
      expect(getNextPermissionMode('default')).toBe('acceptEdits');
    });

    test('cycles from acceptEdits to plan', () => {
      expect(getNextPermissionMode('acceptEdits')).toBe('plan');
    });

    test('cycles from plan to auto', () => {
      expect(getNextPermissionMode('plan')).toBe('auto');
    });

    test('cycles from auto back to default', () => {
      expect(getNextPermissionMode('auto')).toBe('default');
    });
  });

  describe('getModeDisplayText', () => {
    test('returns empty string for default mode', () => {
      expect(getModeDisplayText('default')).toBe('');
    });

    test('returns "plan mode on" for plan mode', () => {
      expect(getModeDisplayText('plan')).toBe('plan mode on');
    });

    test('returns "auto-accept edits" for acceptEdits mode', () => {
      expect(getModeDisplayText('acceptEdits')).toBe('auto-accept edits');
    });

    test('returns "auto mode" for auto mode', () => {
      expect(getModeDisplayText('auto')).toBe('auto mode');
    });
  });
});