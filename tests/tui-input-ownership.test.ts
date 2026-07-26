/**
 * v0.2.23 Slice 6 — TUI Input Ownership tests.
 */

import {
  TuiInputOwnershipController,
  type TuiInputDraftSnapshot,
  type TuiInputOwner,
} from '../src/tui-ui/input-ownership';

function makeSnapshot(value = 'test draft', cursor = 10): TuiInputDraftSnapshot {
  return {
    value,
    cursor,
    parserState: {
      mode: 'normal',
      incompleteUtf8: Buffer.alloc(0),
      pasteBuffer: '',
      pendingEscape: '',
    },
  };
}

describe('TUI Input Ownership', () => {
  let ctrl: TuiInputOwnershipController;

  beforeEach(() => {
    ctrl = new TuiInputOwnershipController();
  });

  it('starts with prompt as default owner', () => {
    expect(ctrl.owner).toBe('prompt');
    expect(ctrl.isModal).toBe(false);
  });

  it('captures current state and activates modal owner', () => {
    const snap = makeSnapshot();
    ctrl.capture('inspector', snap);
    expect(ctrl.owner).toBe('inspector');
    expect(ctrl.isModal).toBe(true);
  });

  it('restore returns snapshot and goes back to prompt', () => {
    const snap = makeSnapshot();
    ctrl.capture('inspector', snap);

    const restored = ctrl.restore();
    expect(ctrl.owner).toBe('prompt');
    expect(ctrl.isModal).toBe(false);
    expect(restored).toEqual(snap);
  });

  it('restore is idempotent when owner is prompt', () => {
    const restored = ctrl.restore();
    expect(restored).toBeNull();
    expect(ctrl.owner).toBe('prompt');
  });

  it('does not nest modals', () => {
    ctrl.capture('inspector', makeSnapshot('draft-A'));
    ctrl.capture('permission', makeSnapshot('draft-B'));

    // Should still be in inspector, not permission.
    expect(ctrl.owner).toBe('inspector');
  });

  it('routesToOwner checks current owner', () => {
    expect(ctrl.routesToOwner('prompt')).toBe(true);

    ctrl.capture('inspector', makeSnapshot());
    expect(ctrl.routesToOwner('prompt')).toBe(false);
    expect(ctrl.routesToOwner('inspector')).toBe(true);
  });

  it('reset forces back to prompt', () => {
    ctrl.capture('inspector', makeSnapshot());
    ctrl.reset();
    expect(ctrl.owner).toBe('prompt');
    expect(ctrl.isModal).toBe(false);
  });
});