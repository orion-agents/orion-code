import { randomUUID } from 'crypto';

import { truncateForContext } from '../core/tool-artifacts';
import type { OrionCodeTool, ToolResult } from '../framework/tool';
import type { BoundToolExecutionResultV1 } from './step-snapshot';
import type { NestedToolExecutionServiceV1, ToolInvocationResultV1 } from './tool-gateway';

export const BATCH_READ_SERVICE_VERSION_V1 = 1 as const;
export const BATCH_READ_MAX_STEPS_V1 = 8 as const;
export const BATCH_READ_CHILD_OUTPUT_BYTES_V1 = 1_600 as const;
export const BATCH_READ_ALLOWED_TOOLS_V1 = Object.freeze([
  'git_status',
  'glob',
  'grep',
  'list_files',
  'read_file',
] as const);

export type BatchReadChildToolV1 = (typeof BATCH_READ_ALLOWED_TOOLS_V1)[number];

export interface BatchReadStepV1 {
  readonly tool: BatchReadChildToolV1;
  readonly args: Readonly<Record<string, unknown>>;
}

export class BatchReadInputError extends Error {
  readonly code = 'ORION_BATCH_READ_INPUT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'BatchReadInputError';
  }
}

/**
 * A descriptor-only facade. Its concrete execute function deliberately cannot
 * run: ToolGateway owns the nested implementation and every child re-enters
 * Capability → Policy → Approval → Sandbox → Execute.
 */
export function createBatchReadToolV1(): OrionCodeTool {
  return {
    name: 'batch_read',
    aliases: [],
    description:
      'Run 1-8 independent local read steps sequentially. Each child is separately authorized, sandboxed, executed, and recorded with parent invocation lineage.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered local read operations.',
          minItems: 1,
          maxItems: BATCH_READ_MAX_STEPS_V1,
          items: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                enum: [...BATCH_READ_ALLOWED_TOOLS_V1],
                description: 'Allowed read-only child tool.',
              },
              args: {
                type: 'object',
                description: 'Arguments passed to the selected child tool.',
                properties: {},
              },
            },
            required: ['tool', 'args'],
          },
        },
      },
      required: ['steps'],
    },
    validateInput: args => batchReadInputError(args),
    checkPermissions: () => ({ behavior: 'allow' }),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    isFileEdit: () => false,
    userFacingName: () => 'batch read',
    execute: async () => ({
      success: false,
      output: '',
      error: 'batch_read must execute through the ToolGateway nested execution service.',
    }),
  };
}

/** Deterministic, bounded composite reader with durable child lineage. */
export class BatchReadExecutionServiceV1 implements NestedToolExecutionServiceV1 {
  handles(descriptor: Parameters<NestedToolExecutionServiceV1['handles']>[0]): boolean {
    return descriptor.name === 'batch_read';
  }

  async run(
    input: Parameters<NestedToolExecutionServiceV1['run']>[0]
  ): Promise<BoundToolExecutionResultV1> {
    const startedAt = Date.now();
    const steps = parseBatchReadStepsV1(input.invocation.args);
    const results: BatchReadOutputStepV1[] = [];
    let interrupted = input.invocation.abortSignal?.aborted === true;

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (interrupted || input.invocation.abortSignal?.aborted) {
        interrupted = true;
        results.push(skippedStep(index, step, 'Parent batch was interrupted.'));
        continue;
      }
      const child = await input.invokeChild({
        invocationId: randomUUID(),
        toolName: step.tool,
        args: step.args,
      });
      results.push(completedStep(index, step, child));
      if (child.receipt.terminal === 'interrupted') interrupted = true;
    }

    const succeeded = results.filter(step => step.state === 'completed' && step.success).length;
    const failed = results.filter(step => step.state === 'completed' && !step.success).length;
    const skipped = results.filter(step => step.state === 'skipped').length;
    const success = failed === 0 && skipped === 0 && succeeded === steps.length;
    const summary = `batch_read completed ${succeeded}/${steps.length} steps`;
    const payload = {
      version: BATCH_READ_SERVICE_VERSION_V1,
      success,
      summary,
      succeeded,
      failed,
      skipped,
      steps: results,
    } as const;
    const output = JSON.stringify(payload);
    const result: ToolResult = {
      schemaVersion: 1,
      success,
      output,
      summary,
      outputBytes: Buffer.byteLength(output, 'utf8'),
      ...(!success
        ? { error: interrupted ? 'batch_read was interrupted.' : `${failed} child step(s) failed.` }
        : {}),
      metadata: {
        nested: true,
        parentInvocationId: input.invocation.invocationId,
        childInvocationIds: results.flatMap(step => (step.invocationId ? [step.invocationId] : [])),
      },
    };
    return {
      terminal: interrupted ? 'interrupted' : success ? 'completed' : 'failed',
      result,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

export function parseBatchReadStepsV1(
  args: Readonly<Record<string, unknown>>
): readonly BatchReadStepV1[] {
  if (!Array.isArray(args.steps)) {
    throw new BatchReadInputError('batch_read.steps must be an array.');
  }
  if (args.steps.length < 1 || args.steps.length > BATCH_READ_MAX_STEPS_V1) {
    throw new BatchReadInputError(
      `batch_read.steps must contain 1-${BATCH_READ_MAX_STEPS_V1} entries.`
    );
  }
  return Object.freeze(
    args.steps.map((value, index) => {
      if (!isRecord(value)) {
        throw new BatchReadInputError(`batch_read.steps[${index}] must be an object.`);
      }
      if (
        typeof value.tool !== 'string' ||
        !BATCH_READ_ALLOWED_TOOLS_V1.includes(value.tool as BatchReadChildToolV1)
      ) {
        throw new BatchReadInputError(
          `batch_read.steps[${index}].tool must be one of ${BATCH_READ_ALLOWED_TOOLS_V1.join(', ')}.`
        );
      }
      if (!isRecord(value.args)) {
        throw new BatchReadInputError(`batch_read.steps[${index}].args must be an object.`);
      }
      return Object.freeze({
        tool: value.tool as BatchReadChildToolV1,
        args: Object.freeze(structuredClone(value.args)),
      });
    })
  );
}

function batchReadInputError(args: Record<string, unknown>): string | undefined {
  try {
    parseBatchReadStepsV1(args);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface BatchReadOutputStepV1 {
  readonly index: number;
  readonly tool: BatchReadChildToolV1;
  readonly args: Readonly<Record<string, unknown>>;
  readonly state: 'completed' | 'skipped';
  readonly success: boolean;
  readonly summary: string;
  readonly output: string;
  readonly outputBytes: number;
  readonly invocationId?: string;
  readonly receiptDigest?: string;
  readonly terminal?: ToolInvocationResultV1['receipt']['terminal'];
  readonly error?: string;
}

function completedStep(
  index: number,
  step: BatchReadStepV1,
  child: ToolInvocationResultV1
): BatchReadOutputStepV1 {
  const raw = child.result.output || child.result.error || '';
  return Object.freeze({
    index: index + 1,
    tool: step.tool,
    args: step.args,
    state: 'completed',
    success: child.receipt.success,
    summary: child.result.summary ?? summarize(raw),
    output: truncateForContext(raw, BATCH_READ_CHILD_OUTPUT_BYTES_V1),
    outputBytes: Buffer.byteLength(raw, 'utf8'),
    invocationId: child.receipt.invocationId,
    receiptDigest: child.receipt.digest,
    terminal: child.receipt.terminal,
    ...(child.result.error ? { error: child.result.error } : {}),
  });
}

function skippedStep(index: number, step: BatchReadStepV1, reason: string): BatchReadOutputStepV1 {
  return Object.freeze({
    index: index + 1,
    tool: step.tool,
    args: step.args,
    state: 'skipped',
    success: false,
    summary: reason,
    output: '',
    outputBytes: 0,
    error: reason,
  });
}

function summarize(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
