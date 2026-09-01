import { randomUUID } from 'crypto';

import {
  parseWebCommand,
  parseWebComposerAction,
  parseWebContextActivate,
  parseWebOpenSettingsDocument,
  parseWebSettingsUpdate,
  toAgentRuntimeInput,
  WebProtocolError,
} from '../src/web/protocol';

describe('Web protocol v1', () => {
  test('parses an atomic Context activation CAS and rejects loose identities', () => {
    const requestId = randomUUID();
    const expectedContextRevision = randomUUID();
    const workspaceId = randomUUID();
    expect(
      parseWebContextActivate({
        requestId,
        expectedContextRevision,
        workspaceId,
        sessionId: null,
      })
    ).toEqual({ requestId, expectedContextRevision, workspaceId, sessionId: null });
    expect(() =>
      parseWebContextActivate({
        requestId,
        expectedContextRevision: 'stale',
        workspaceId,
        sessionId: null,
      })
    ).toThrow('expectedContextRevision must be a UUID');
    expect(() =>
      parseWebContextActivate({
        requestId,
        expectedContextRevision,
        workspaceId,
        sessionId: null,
        path: '/must-not-be-an-identity',
      })
    ).toThrow('Unknown context activation request field');
  });

  test('parses a typed submit command and preserves its stable request id', () => {
    const requestId = randomUUID();
    const target = commandTarget();
    const command = parseWebCommand({
      requestId,
      ...target,
      type: 'submit',
      text: 'ship v0.3.0',
    });

    expect(command).toEqual({
      requestId,
      ...target,
      type: 'submit',
      text: 'ship v0.3.0',
    });
    expect(toAgentRuntimeInput(command)).toEqual({
      type: 'submit',
      text: 'ship v0.3.0',
      source: 'programmatic',
    });
  });

  test('supports exact BUILD, PLAN and AUTO selection', () => {
    const command = parseWebCommand({
      requestId: randomUUID(),
      ...commandTarget(),
      type: 'set_agent_mode',
      agentMode: 'plan',
    });

    expect(toAgentRuntimeInput(command)).toEqual({
      type: 'set_agent_mode',
      mode: 'plan',
      source: 'programmatic',
    });
  });

  test('requires an opaque queue identity when cancelling a queued Session turn', () => {
    const queueId = randomUUID();
    expect(
      parseWebCommand({
        requestId: randomUUID(),
        ...commandTarget(),
        type: 'cancel_queued_turn',
        queueId,
      })
    ).toMatchObject({ type: 'cancel_queued_turn', queueId });
    expect(() =>
      parseWebCommand({
        requestId: randomUUID(),
        ...commandTarget(),
        type: 'cancel_queued_turn',
      })
    ).toThrow('cancel_queued_turn requires queueId');
  });

  test('requires an item-local revision for every queue mutation', () => {
    const base = {
      requestId: randomUUID(),
      workspaceId: randomUUID(),
      expectedContextRevision: randomUUID(),
      expectedSessionId: randomUUID(),
      expectedSessionRuntimeRevision: randomUUID(),
      expectedControlRevision: randomUUID(),
    };
    expect(
      parseWebComposerAction({
        ...base,
        type: 'edit_queue_item',
        itemId: 'followup-1',
        expectedItemRevision: 2,
        text: 'updated',
      })
    ).toMatchObject({ type: 'edit_queue_item', expectedItemRevision: 2 });
    expect(() =>
      parseWebComposerAction({
        ...base,
        type: 'remove_queue_item',
        itemId: 'followup-1',
      })
    ).toThrow('expectedItemRevision must be a positive safe integer');
  });

  test('uses the production permission scopes and rejects ambiguous bodies', () => {
    expect(
      toAgentRuntimeInput(
        parseWebCommand({
          requestId: randomUUID(),
          ...commandTarget(),
          type: 'permission_decision',
          requestPermissionId: 'permission-1',
          approved: true,
          scope: 'global',
        })
      )
    ).toMatchObject({ type: 'permission_decision', scope: 'global' });

    expect(() =>
      parseWebCommand({
        requestId: randomUUID(),
        ...commandTarget(),
        type: 'permission_decision',
        requestPermissionId: 'permission-1',
        approved: true,
        scope: 'session',
      })
    ).toThrow(WebProtocolError);
    expect(() =>
      parseWebCommand({
        requestId: randomUUID(),
        ...commandTarget(),
        type: 'submit',
        text: 'x',
        extra: true,
      })
    ).toThrow('Unknown command field');
    expect(() => parseWebCommand({ requestId: randomUUID(), type: 'submit', text: 'x' })).toThrow(
      'workspaceId must be a non-empty string'
    );
  });

  test('parses one bounded atomic Settings batch and rejects duplicate or loose operations', () => {
    const requestId = randomUUID();
    const expectedRevision = `hmac-sha256:${'a'.repeat(64)}`;
    expect(
      parseWebSettingsUpdate({
        requestId,
        expectedRevision,
        operations: [
          { op: 'set', key: 'appearance.style', value: 'orion-blocksmith' },
          { op: 'set', key: 'appearance.theme', value: 'dark' },
          { op: 'unset', key: 'defaults.effort' },
          { op: 'set', key: 'permissions.toolConfirmation', value: 'ask' },
        ],
      })
    ).toEqual({
      requestId,
      expectedRevision,
      operations: [
        { op: 'set', key: 'appearance.style', value: 'orion-blocksmith' },
        { op: 'set', key: 'appearance.theme', value: 'dark' },
        { op: 'unset', key: 'defaults.effort' },
        { op: 'set', key: 'permissions.toolConfirmation', value: 'ask' },
      ],
    });

    expect(() =>
      parseWebSettingsUpdate({
        requestId,
        expectedRevision,
        operations: [
          { op: 'set', key: 'appearance.theme', value: 'light' },
          { op: 'set', key: 'appearance.theme', value: 'dark' },
        ],
      })
    ).toThrow('Settings key appears more than once');
    expect(() =>
      parseWebSettingsUpdate({
        requestId,
        expectedRevision,
        operations: [{ op: 'unset', key: 'appearance.theme', value: 'dark' }],
      })
    ).toThrow('Unknown settings operation field: value');
    try {
      parseWebSettingsUpdate({
        requestId,
        expectedRevision: '1',
        operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
      });
      throw new Error('Expected invalid Settings revision to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: 'settings_invalid_operation' });
    }
  });

  test('keeps the advanced Settings action pathless and UUID-bound', () => {
    const requestId = randomUUID();
    expect(parseWebOpenSettingsDocument({ requestId })).toEqual({ requestId });
    expect(() => parseWebOpenSettingsDocument({ requestId, path: '/tmp/orion.json' })).toThrow(
      'Unknown open Settings request field: path'
    );
    expect(() => parseWebOpenSettingsDocument({ requestId: 'open-settings' })).toThrow(
      'requestId must be a UUID'
    );
  });
});

function commandTarget() {
  return {
    workspaceId: randomUUID(),
    expectedContextRevision: randomUUID(),
    expectedSessionId: randomUUID(),
    expectedSessionRuntimeRevision: randomUUID(),
  } as const;
}
