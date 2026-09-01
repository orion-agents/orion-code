import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { listProjectDurableToolReceiptRefsV1 } from '../src/runtime/durable-tool-receipt-reader';
import {
  materializeLegacyThreadV1,
  openSessionStorageV1,
} from '../src/runtime/legacy-thread-materializer';
import { canonicalRuntimeJson, digestRuntimeValue } from '../src/runtime/protocol/canonical';
import type { ThreadEventStore } from '../src/runtime/thread-event-store';
import type { ToolInvocationReceiptV1 } from '../src/runtime/tool-gateway';
import { createSession } from '../src/services/session-storage';

describe('durable ToolInvocationReceipt reader', () => {
  let root: string;
  let projectPath: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-receipt-reader-'));
    projectPath = join(root, 'workspace');
    mkdirSync(projectPath);
    previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test('projects digests only after canonical receipt and durable fact both validate', () => {
    const fixture = createThreadFixture('valid');

    const refs = listProjectDurableToolReceiptRefsV1(projectPath);

    expect(refs).toEqual([
      {
        sessionId: fixture.sessionId,
        threadId: fixture.threadId,
        callId: fixture.receipt.invocationId,
        sequence: fixture.terminalSeq,
        toolName: 'exec_command',
        terminal: 'completed',
        success: true,
        outputBytes: 2,
        hasArtifact: false,
        executionPolicyDigest: fixture.receipt.executionPolicyDigest,
        receiptDigest: fixture.receipt.digest,
        finishedAt: fixture.receipt.finishedAt,
      },
    ]);
  });

  test('fails closed when canonical receipt content is tampered without its digest', () => {
    createThreadFixture('tampered');

    expect(() => listProjectDurableToolReceiptRefsV1(projectPath)).toThrow(
      expect.objectContaining({
        code: 'ORION_DURABLE_TOOL_RECEIPT_SOURCE_CORRUPT',
      })
    );
  });

  test('fails closed when the durable tool.receipt fact mismatches the canonical receipt', () => {
    createThreadFixture('mismatched');

    expect(() => listProjectDurableToolReceiptRefsV1(projectPath)).toThrow(
      expect.objectContaining({
        code: 'ORION_DURABLE_TOOL_RECEIPT_SOURCE_CORRUPT',
      })
    );
  });

  test('fails closed when the authoritative Thread hash chain is corrupt', () => {
    const fixture = createThreadFixture('valid');
    const logPath = join(fixture.store.rootDir, `${fixture.threadId}.events.v1.jsonl`);
    const source = readFileSync(logPath, 'utf8');
    const corrupt = source.replace(
      /"hash":"([0-9a-f])/u,
      (_match, first: string) => `"hash":"${first === '0' ? '1' : '0'}`
    );
    expect(corrupt).not.toBe(source);
    writeFileSync(logPath, corrupt, { mode: 0o600 });

    expect(() => listProjectDurableToolReceiptRefsV1(projectPath)).toThrow(
      expect.objectContaining({
        code: 'ORION_DURABLE_TOOL_RECEIPT_SOURCE_CORRUPT',
      })
    );
  });

  function createThreadFixture(mode: 'valid' | 'tampered' | 'mismatched'): {
    readonly sessionId: string;
    readonly threadId: string;
    readonly terminalSeq: number;
    readonly receipt: ToolInvocationReceiptV1;
    readonly store: ThreadEventStore;
  } {
    const session = createSession(projectPath, 'fixture:model');
    materializeLegacyThreadV1({ projectPath, sessionId: session.id });
    const opened = openSessionStorageV1(projectPath, session.id);
    if (opened.resolution.kind !== 'thread' || !('store' in opened)) {
      throw new Error('Fixture Session did not resolve to a Thread store.');
    }
    const store = opened.store;
    const threadId = opened.resolution.threadId;
    const turnId = randomUUID();
    const stepId = randomUUID();
    const invocationId = randomUUID();
    const receipt = createReceipt({ threadId, turnId, stepId, invocationId });
    const terminalReceipt =
      mode === 'tampered' ? { ...receipt, executionPolicyDigest: 'f'.repeat(64) } : receipt;
    const commit = store.appendDurableBatch([
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'verify receipt', mode: 'build' } },
      },
      {
        turnId,
        stepId,
        itemId: invocationId,
        payload: {
          type: 'item.started',
          data: { kind: 'command', name: 'exec_command', inputDigest: digestRuntimeValue({}) },
        },
      },
      {
        turnId,
        stepId,
        itemId: invocationId,
        payload: {
          type: 'tool.receipt',
          data: {
            invocationId,
            terminal: receipt.terminal,
            success: receipt.success,
            outputDigest: receipt.outputDigest,
            receiptDigest: mode === 'mismatched' ? 'e'.repeat(64) : receipt.digest,
            intentDigest: receipt.intentDigest,
          },
        },
      },
      {
        turnId,
        stepId,
        itemId: invocationId,
        payload: {
          type: 'item.completed',
          data: {
            summary: 'ok',
            outputDigest: receipt.outputDigest,
            receipt: canonicalRuntimeJson(terminalReceipt),
          },
        },
      },
      {
        turnId,
        payload: { type: 'turn.completed', data: { outcome: 'receipt fixture complete' } },
      },
    ]);
    return {
      sessionId: session.id,
      threadId,
      terminalSeq: commit.events[3].seq,
      receipt,
      store,
    };
  }
});

function createReceipt(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly invocationId: string;
}): ToolInvocationReceiptV1 {
  const result = {
    schemaVersion: 1,
    success: true,
    output: 'ok',
    summary: 'ok',
    outputBytes: 2,
  };
  const policyContent = { behavior: 'allow' as const, source: 'allowlist:fixture' };
  const policy = { ...policyContent, digest: digestRuntimeValue(policyContent) };
  const content = {
    version: 1 as const,
    invocationId: input.invocationId,
    threadId: input.threadId,
    turnId: input.turnId,
    stepId: input.stepId,
    toolName: 'exec_command',
    snapshotDigest: digestRuntimeValue({ type: 'snapshot' }),
    routerDigest: digestRuntimeValue({ type: 'router' }),
    authorityDigest: digestRuntimeValue({ type: 'authority' }),
    executionPolicyDigest: digestRuntimeValue({ type: 'execution-policy' }),
    intentDigest: digestRuntimeValue({ type: 'intent' }),
    policy,
    terminal: 'completed' as const,
    terminalPhase: 'execute' as const,
    success: true,
    result,
    outputDigest: digestRuntimeValue(result),
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_005,
    durationMs: 5,
  };
  return { ...content, digest: digestRuntimeValue(content) };
}
