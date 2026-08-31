import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import { MCP_FIXTURE_ECHO_TOOL } from './mcp-server';

export const OPENAI_FIXTURE_MODEL = 'ark-code-latest';
export const OPENAI_FIXTURE_ALTERNATE_MODEL = 'ark-code-fast';

export const OPENAI_FIXTURE_PROMPTS = Object.freeze({
  denyWrite: 'fixture:deny-write',
  approveWriteExec: 'fixture:approve-write-exec',
  pending: 'fixture:pending',
  /** Backward-friendly descriptive alias for the same pending-approval scenario. */
  pendingApproval: 'fixture:pending-approval',
  plan: 'fixture:plan',
  goal: 'fixture:goal',
  largeOutput: 'fixture:large-output',
  autoAllowed: 'fixture:auto-allowed',
  autoEscape: 'fixture:auto-escape',
  mcpEcho: 'fixture:mcp-echo use the web_e2e MCP server fixture_echo tool',
  settingsProbe: 'fixture:settings-probe',
  estimatedUsage: 'fixture:estimated-usage',
});

export const OPENAI_FIXTURE_MARKERS = Object.freeze({
  denyWriteDone: 'DENY_WRITE_DONE',
  approveWriteExecDone: 'APPROVE_WRITE_EXEC_DONE',
  pendingResolved: 'PENDING_APPROVAL_RESOLVED',
  planReady: 'WEB_E2E_PLAN_READY',
  planExecutionDone: 'WEB_E2E_PLAN_EXECUTION_DONE',
  goalPlanReady: 'WEB_E2E_GOAL_PLAN_READY',
  goalHeld: 'WEB_E2E_GOAL_ACTIVE_HOLD',
  goalComplete: 'WEB_E2E_GOAL_COMPLETE',
  largeOutputDone: 'WEB_E2E_LARGE_OUTPUT_DONE',
  autoAllowedDone: 'WEB_E2E_AUTO_ALLOWED_DONE',
  autoEscapeBlocked: 'WEB_E2E_AUTO_ESCAPE_BLOCKED',
  mcpEchoDone: 'WEB_E2E_MCP_ECHO_DONE',
  settingsProbeDone: 'WEB_E2E_SETTINGS_PROBE_DONE',
  estimatedUsageDone: 'WEB_E2E_ESTIMATED_USAGE_DONE',
  unknownScenario: 'WEB_E2E_UNKNOWN_SCENARIO',
});

export const OPENAI_FIXTURE_FILES = Object.freeze({
  deniedWrite: 'denied-write.txt',
  approvedWrite: 'approved-write.txt',
  execProof: 'exec-proof.txt',
  pendingWrite: 'pending-write.txt',
  goalWrite: 'goal-write.txt',
  autoAllowedWrite: 'auto-allowed.txt',
  autoEscapeWrite: 'auto-escape.txt',
});

export type OpenAiFixtureScenario =
  | 'deny-write'
  | 'approve-write-exec'
  | 'pending'
  | 'plan'
  | 'goal'
  | 'large-output'
  | 'auto-allowed'
  | 'auto-escape'
  | 'mcp-echo'
  | 'settings-probe'
  | 'estimated-usage'
  | 'unknown';

export interface OpenAiFixtureRequest {
  readonly sequence: number;
  readonly scenario: OpenAiFixtureScenario;
  readonly model: string;
  readonly stream: boolean;
  readonly reasoningEffort?: string;
  readonly systemText: string;
  readonly lastUserText: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
}

export interface OpenAiProviderFixtureOptions {
  readonly model?: string;
  readonly largeOutputBytes?: number;
  readonly requestBodyLimitBytes?: number;
}

export interface OpenAiProviderFixture {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly baseUrl: string;
  readonly model: string;
  readonly server: Server;
  readonly requests: readonly OpenAiFixtureRequest[];
  waitForRequest(
    predicate: (request: OpenAiFixtureRequest) => boolean,
    timeoutMs?: number
  ): Promise<OpenAiFixtureRequest>;
  releaseHeldResponses(scenario?: OpenAiFixtureScenario): void;
  close(): Promise<void>;
}

interface RequestWaiter {
  readonly predicate: (request: OpenAiFixtureRequest) => boolean;
  readonly resolve: (request: OpenAiFixtureRequest) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ProviderState {
  readonly model: string;
  readonly largeOutputBytes: number;
  readonly requestBodyLimitBytes: number;
  readonly requests: OpenAiFixtureRequest[];
  readonly waiters: Set<RequestWaiter>;
  readonly held: Map<OpenAiFixtureScenario, Set<ServerResponse>>;
  closed: boolean;
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const FIXED_CREATED_AT = 1_750_000_000;
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const DEFAULT_LARGE_OUTPUT_BYTES = 128 * 1024;
const PLAN_BODY = [
  '# WEB_E2E_PLAN',
  '',
  '1. Inspect `seed.txt` through the real read tool.',
  '2. Preserve both isolated workspaces and make no speculative changes.',
  '3. Verify the implementation in the separate BUILD request.',
  '',
  'Acceptance: the durable PlanReceipt is bound to this exact body and return mode.',
].join('\n');

/** Start a deterministic loopback OpenAI Chat Completions SSE provider. */
export async function startOpenAiProviderFixture(
  options: OpenAiProviderFixtureOptions = {}
): Promise<OpenAiProviderFixture> {
  const state: ProviderState = {
    model: options.model ?? OPENAI_FIXTURE_MODEL,
    largeOutputBytes: boundedInteger(
      options.largeOutputBytes ?? DEFAULT_LARGE_OUTPUT_BYTES,
      'largeOutputBytes',
      64 * 1024,
      1024 * 1024
    ),
    requestBodyLimitBytes: boundedInteger(
      options.requestBodyLimitBytes ?? DEFAULT_BODY_LIMIT,
      'requestBodyLimitBytes',
      1024,
      16 * 1024 * 1024
    ),
    requests: [],
    waiters: new Set(),
    held: new Map(),
    closed: false,
  };
  const server = createServer((request, response) => {
    void handleRequest(state, request, response).catch(error => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'OpenAI fixture request failed.' }));
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address() as AddressInfo;

  const waitForRequest: OpenAiProviderFixture['waitForRequest'] = (
    predicate,
    timeoutMs = 10_000
  ) => {
    const existing = state.requests.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (state.closed) return Promise.reject(new Error('OpenAI fixture is closed.'));
    return new Promise<OpenAiFixtureRequest>((resolve, reject) => {
      const onTimeout = () => {
        state.waiters.delete(waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for an OpenAI fixture request.`));
      };
      const waiter: RequestWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(onTimeout, timeoutMs),
      };
      state.waiters.add(waiter);
    });
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      state.closed = true;
      releaseHeldResponses(state);
      for (const waiter of state.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('OpenAI fixture closed before the request was observed.'));
      }
      state.waiters.clear();
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    })();
    return closing;
  };

  return Object.freeze({
    host: '127.0.0.1' as const,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: state.model,
    server,
    get requests() {
      return Object.freeze([...state.requests]);
    },
    waitForRequest,
    releaseHeldResponses: (scenario?: OpenAiFixtureScenario) =>
      releaseHeldResponses(state, scenario),
    close,
  });
}

async function handleRequest(
  state: ProviderState,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Fixture implements POST /v1/chat/completions only.' }));
    return;
  }

  const body = await readJsonBody(request, state.requestBodyLimitBytes);
  const messages = normalizeMessages(body.messages);
  const lastUserIndex = findLastUserIndex(messages);
  const lastUserText = lastUserIndex < 0 ? '' : messageText(messages[lastUserIndex]);
  const systemText = messages
    .filter(message => message.role === 'system')
    .map(messageText)
    .join('\n');
  const scenario = detectScenario(lastUserText, systemText);
  const observed = deepFreeze({
    sequence: state.requests.length + 1,
    scenario,
    model: typeof body.model === 'string' ? body.model : '',
    stream: body.stream === true,
    ...(typeof body.reasoning_effort === 'string'
      ? { reasoningEffort: body.reasoning_effort }
      : {}),
    systemText,
    lastUserText,
    messages,
  });
  state.requests.push(observed);
  settleWaiters(state, observed);

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'close',
  });
  respondToScenario(state, response, observed, lastUserIndex);
}

function respondToScenario(
  state: ProviderState,
  response: ServerResponse,
  request: OpenAiFixtureRequest,
  lastUserIndex: number
): void {
  const toolsAfterUser = toolNames(request.messages.slice(lastUserIndex + 1));
  switch (request.scenario) {
    case 'deny-write':
      if (toolsAfterUser.length === 0) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-deny-write',
          name: 'write_file',
          args: { path: OPENAI_FIXTURE_FILES.deniedWrite, content: 'THIS_MUST_NOT_EXIST\n' },
        });
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.denyWriteDone);
      }
      return;
    case 'approve-write-exec':
      if (toolsAfterUser.length === 0) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-approved-write',
          name: 'write_file',
          args: { path: OPENAI_FIXTURE_FILES.approvedWrite, content: 'WRITE_APPROVED\n' },
        });
      } else if (toolsAfterUser.length === 1) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-approved-exec',
          name: 'exec_command',
          args: {
            command: `npm test && node -e "require('node:fs').writeFileSync('${OPENAI_FIXTURE_FILES.execProof}', 'EXEC_APPROVED\\n')"`,
            timeout: 15_000,
          },
        });
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.approveWriteExecDone);
      }
      return;
    case 'pending':
      if (toolsAfterUser.length === 0) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-pending-write',
          name: 'write_file',
          args: { path: OPENAI_FIXTURE_FILES.pendingWrite, content: 'PENDING_APPROVED\n' },
        });
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.pendingResolved);
      }
      return;
    case 'plan':
      if (isPlanMode(request.systemText)) {
        if (toolsAfterUser.length === 0) {
          finishToolCall(state, response, request, {
            id: 'call-web-e2e-plan-read',
            name: 'read_file',
            args: { path: 'seed.txt' },
          });
        } else {
          finishText(
            state,
            response,
            request,
            `${OPENAI_FIXTURE_MARKERS.planReady}\n\n${PLAN_BODY}`
          );
        }
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.planExecutionDone);
      }
      return;
    case 'goal': {
      const lastTool = lastToolName(request.messages);
      if (!toolNames(request.messages).includes('update_goal_plan')) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-goal-plan',
          name: 'update_goal_plan',
          args: {
            phase: 'implementation',
            steps: [
              { description: 'Write the deterministic Goal marker', done: false },
              { description: 'Run the deterministic workspace test', done: false },
            ],
            next_action: 'Write the marker and verify the workspace',
            derived_criteria: [
              {
                statement: 'goal-write.txt stores the WEB_E2E_GOAL_OK marker',
                evidence_kinds: ['file'],
              },
              {
                statement: 'npm test -- goal-e2e-check passes',
                evidence_kinds: ['test'],
              },
            ],
          },
        });
      } else if (lastTool === 'update_goal_plan') {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-goal-write',
          name: 'write_file',
          args: { path: OPENAI_FIXTURE_FILES.goalWrite, content: 'WEB_E2E_GOAL_OK\n' },
        });
      } else if (lastTool === 'write_file') {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-goal-test',
          name: 'exec_command',
          args: { command: 'npm test -- goal-e2e-check', timeout: 15_000 },
        });
      } else if (lastTool === 'exec_command') {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-goal-read',
          name: 'get_goal',
          args: {},
        });
      } else if (lastTool === 'get_goal') {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-goal-complete',
          name: 'update_goal',
          args: { status: 'complete', criterion_evidence: goalCompletionMapping(request.messages) },
        });
      } else if (lastTool === 'update_goal') {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.goalComplete);
      } else {
        holdText(state, response, request, OPENAI_FIXTURE_MARKERS.goalHeld);
      }
      return;
    }
    case 'large-output':
      if (toolsAfterUser.length === 0) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-large-output',
          name: 'exec_command',
          args: {
            command: `node -e "process.stdout.write('L'.repeat(${state.largeOutputBytes}))"`,
            timeout: 15_000,
            maxOutput: state.largeOutputBytes + 1024,
          },
        });
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.largeOutputDone);
      }
      return;
    case 'auto-allowed':
      if (toolsAfterUser.length === 0) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-auto-allowed',
          name: 'write_file',
          args: { path: OPENAI_FIXTURE_FILES.autoAllowedWrite, content: 'AUTO_ALLOWED\n' },
        });
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.autoAllowedDone);
      }
      return;
    case 'auto-escape':
      if (toolsAfterUser.length === 0) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-auto-escape',
          name: 'write_file',
          args: {
            path: `../workspace-secondary/${OPENAI_FIXTURE_FILES.autoEscapeWrite}`,
            content: 'MUST_NOT_ESCAPE\n',
          },
        });
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.autoEscapeBlocked);
      }
      return;
    case 'mcp-echo':
      if (toolsAfterUser.length === 0) {
        finishToolCall(state, response, request, {
          id: 'call-web-e2e-mcp-echo',
          name: MCP_FIXTURE_ECHO_TOOL,
          args: { text: 'MCP_ECHO_OK' },
        });
      } else {
        finishText(state, response, request, OPENAI_FIXTURE_MARKERS.mcpEchoDone);
      }
      return;
    case 'settings-probe':
      finishText(state, response, request, OPENAI_FIXTURE_MARKERS.settingsProbeDone);
      return;
    case 'estimated-usage':
      finishTextWithoutUsage(state, response, request, OPENAI_FIXTURE_MARKERS.estimatedUsageDone);
      return;
    case 'unknown':
      finishText(state, response, request, OPENAI_FIXTURE_MARKERS.unknownScenario);
  }
}

function finishToolCall(
  state: ProviderState,
  response: ServerResponse,
  request: OpenAiFixtureRequest,
  call: ToolCall
): void {
  writeChunk(state, response, request, {
    tool_calls: [
      {
        index: 0,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      },
    ],
  });
  writeChunk(state, response, request, {}, 'tool_calls', usage(request));
  finishSse(response);
}

function finishText(
  state: ProviderState,
  response: ServerResponse,
  request: OpenAiFixtureRequest,
  text: string
): void {
  const boundary = Math.max(1, Math.floor(text.length / 2));
  for (const chunk of [text.slice(0, boundary), text.slice(boundary)].filter(Boolean)) {
    writeChunk(state, response, request, { content: chunk });
  }
  writeChunk(state, response, request, {}, 'stop', usage(request));
  finishSse(response);
}

function finishTextWithoutUsage(
  state: ProviderState,
  response: ServerResponse,
  request: OpenAiFixtureRequest,
  text: string
): void {
  const boundary = Math.max(1, Math.floor(text.length / 2));
  for (const chunk of [text.slice(0, boundary), text.slice(boundary)].filter(Boolean)) {
    writeChunk(state, response, request, { content: chunk });
  }
  writeChunk(state, response, request, {}, 'stop');
  finishSse(response);
}

function holdText(
  state: ProviderState,
  response: ServerResponse,
  request: OpenAiFixtureRequest,
  text: string
): void {
  writeChunk(state, response, request, { content: text });
  const held = state.held.get(request.scenario) ?? new Set<ServerResponse>();
  held.add(response);
  state.held.set(request.scenario, held);
  response.once('close', () => held.delete(response));
}

function releaseHeldResponses(state: ProviderState, scenario?: OpenAiFixtureScenario): void {
  for (const [heldScenario, responses] of state.held) {
    if (scenario && heldScenario !== scenario) continue;
    for (const response of responses) {
      if (!response.destroyed && !response.writableEnded) {
        const syntheticRequest: OpenAiFixtureRequest = {
          sequence: state.requests.length,
          scenario: heldScenario,
          model: state.model,
          stream: true,
          systemText: '',
          lastUserText: '',
          messages: [],
        };
        writeChunk(state, response, syntheticRequest, {}, 'stop', usage(syntheticRequest));
        finishSse(response);
      }
    }
    responses.clear();
    state.held.delete(heldScenario);
  }
}

function writeChunk(
  state: ProviderState,
  response: ServerResponse,
  request: OpenAiFixtureRequest,
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null = null,
  requestUsage?: Readonly<Record<string, number>>
): void {
  const payload = {
    id: `chatcmpl-web-e2e-${request.sequence}`,
    object: 'chat.completion.chunk',
    created: FIXED_CREATED_AT,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(requestUsage ? { usage: requestUsage } : {}),
  };
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finishSse(response: ServerResponse): void {
  response.end('data: [DONE]\n\n');
}

function usage(request: OpenAiFixtureRequest): Readonly<Record<string, number>> {
  const promptTokens = Math.max(
    32,
    Math.ceil(
      request.messages.reduce((total, message) => total + messageText(message).length, 0) / 4
    )
  );
  const completionTokens = 8;
  return Object.freeze({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  });
}

function detectScenario(lastUserText: string, systemText = ''): OpenAiFixtureScenario {
  if (lastUserText.includes(OPENAI_FIXTURE_PROMPTS.denyWrite)) return 'deny-write';
  if (lastUserText.includes(OPENAI_FIXTURE_PROMPTS.approveWriteExec)) {
    return 'approve-write-exec';
  }
  if (
    lastUserText.includes(OPENAI_FIXTURE_PROMPTS.pending) ||
    lastUserText.includes(OPENAI_FIXTURE_PROMPTS.pendingApproval)
  ) {
    return 'pending';
  }
  if (lastUserText.includes(OPENAI_FIXTURE_PROMPTS.plan) || lastUserText.includes('WEB_E2E_PLAN')) {
    return 'plan';
  }
  if (
    (lastUserText.includes('[Orion Plan Review V1]') && lastUserText.includes('action=approve')) ||
    (systemText.includes('[Durable PlanReceipt V1]') && systemText.includes('WEB_E2E_PLAN'))
  ) {
    return 'plan';
  }
  if (lastUserText.includes(OPENAI_FIXTURE_PROMPTS.goal)) return 'goal';
  if (lastUserText.includes(OPENAI_FIXTURE_PROMPTS.largeOutput)) return 'large-output';
  if (lastUserText.includes(OPENAI_FIXTURE_PROMPTS.autoAllowed)) return 'auto-allowed';
  if (lastUserText.includes(OPENAI_FIXTURE_PROMPTS.autoEscape)) return 'auto-escape';
  if (lastUserText.includes('fixture:mcp-echo')) return 'mcp-echo';
  if (lastUserText.includes('fixture:settings-probe')) return 'settings-probe';
  if (lastUserText.includes('fixture:estimated-usage')) return 'estimated-usage';
  return 'unknown';
}

function isPlanMode(systemText: string): boolean {
  return systemText.includes('[Plan Mode]') || systemText.includes('[Plan-to-Execution Mode]');
}

function toolNames(messages: readonly Readonly<Record<string, unknown>>[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      if (typeof call.function.name === 'string') names.push(call.function.name);
    }
  }
  return names;
}

function lastToolName(messages: readonly Readonly<Record<string, unknown>>[]): string | undefined {
  const names = toolNames(messages);
  return names.at(-1);
}

function goalCompletionMapping(
  messages: readonly Readonly<Record<string, unknown>>[]
): readonly Readonly<Record<string, unknown>>[] {
  const toolMessage = [...messages].reverse().find(message => message.role === 'tool');
  const outer = parseJsonRecord(toolMessage?.content);
  const payload = parseJsonRecord(typeof outer?.output === 'string' ? outer.output : outer);
  const criteria = Array.isArray(payload?.successCriteria) ? payload.successCriteria : [];
  const evidence = Array.isArray(payload?.recentEvidence) ? payload.recentEvidence : [];
  const used = new Set<string>();
  return criteria.map(rawCriterion => {
    if (!isRecord(rawCriterion) || typeof rawCriterion.id !== 'string') {
      throw new Error('Goal fixture received an invalid success criterion.');
    }
    const requiredKinds = Array.isArray(rawCriterion.requiredEvidenceKinds)
      ? rawCriterion.requiredEvidenceKinds.map(String)
      : [];
    const match = [...evidence].reverse().find(rawEvidence => {
      if (!isRecord(rawEvidence) || typeof rawEvidence.id !== 'string') return false;
      return (
        !used.has(rawEvidence.id) &&
        rawEvidence.result === 'passed' &&
        requiredKinds.includes(String(rawEvidence.kind))
      );
    });
    if (!isRecord(match) || typeof match.id !== 'string') {
      throw new Error(`Goal fixture found no fresh evidence for criterion ${rawCriterion.id}.`);
    }
    used.add(match.id);
    return { criterion_id: rawCriterion.id, evidence_ids: [match.id] };
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findLastUserIndex(messages: readonly Readonly<Record<string, unknown>>[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return index;
  }
  return -1;
}

function messageText(message: Readonly<Record<string, unknown>>): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

function normalizeMessages(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return deepFreeze(value.filter(isRecord).map(message => JSON.parse(JSON.stringify(message))));
}

async function readJsonBody(
  request: IncomingMessage,
  limitBytes: number
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limitBytes) throw new Error('OpenAI fixture request body exceeded its limit.');
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!isRecord(parsed)) throw new Error('OpenAI fixture request must be a JSON object.');
  return parsed;
}

function settleWaiters(state: ProviderState, request: OpenAiFixtureRequest): void {
  for (const waiter of [...state.waiters]) {
    let matches = false;
    try {
      matches = waiter.predicate(request);
    } catch (error) {
      clearTimeout(waiter.timer);
      state.waiters.delete(waiter);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
      continue;
    }
    if (!matches) continue;
    clearTimeout(waiter.timer);
    state.waiters.delete(waiter);
    waiter.resolve(request);
  }
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
