/**
 * openhorse - API Compatibility Tests
 *
 * Ensure public exports from src/index.ts are stable and callable.
 * Run before publishing patch releases to prevent breaking changes.
 */

import * as openhorse from '../src/index';
import type {
  QueryEvent,
  QueryParams,
  OpenHorseTool,
  ToolResult,
  ToolContext,
  PermissionResult,
  ContextCapsule,
  EvidenceRecord,
  HarnessState,
  IntentUpdate,
  IntentKind,
  TurnSummary,
  TaskContract,
  PromptAssemblyStats,
  AppState,
  PromptContext,
  PromptSection,
} from '../src/index';
import type { PreparedToolCall, ExecutedToolCall, ToolSchedule } from '../src/framework/tool-scheduler';
import type { ToolState, TodoItem } from '../src/framework/tool-state';
import type { Message, LLMResponse, CacheControl } from '../src/services/llm';
import type { SessionMeta, SessionMessage } from '../src/services/session-storage';
import type { SessionIndex } from '../src/services/session-index';
import type { DriftCheckResult, CompletionGateResult } from '../src/harness/types';

// ============================================================================
// Compile-time type assertions (TypeScript-level)
//
// These use `satisfies`, `as`, and conditional types to verify API contracts
// at compile time. If a type changes incompatibly, these lines will error.
// ============================================================================

// QueryEvent union members
const _requestStart: QueryEvent = { type: 'request_start', model: 'gpt-4o', turn: 1 };
const _promptAssembly: QueryEvent = {
  type: 'prompt_assembly',
  modelId: 'gpt-4o',
  estimatedTokens: 100,
  budgetTokens: 1000,
  coreTokens: 50,
  evidenceBudgetTokens: 200,
  recentTurnBudgetTokens: 150,
  sections: ['core'],
  includedEvidence: ['ledger-1:user_requirement:score=10:tokens=20'],
  omittedEvidence: [],
  includedEvidenceCount: 1,
  omittedEvidenceCount: 0,
};
const _assistantToolCalls: QueryEvent = {
  type: 'assistant_tool_calls',
  content: '',
  toolCalls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }],
};
const _toolCall: QueryEvent = { type: 'tool_call', name: 'x', args: {}, callId: '1' };
const _permissionDecision: QueryEvent = {
  type: 'permission_decision',
  name: 'x',
  args: {},
  callId: '1',
  decision: { behavior: 'ask', approved: true, source: 'user' },
};
const _toolResult: QueryEvent = {
  type: 'tool_result',
  name: 'x',
  args: {},
  callId: '1',
  result: 'ok',
  modelVisibleResult: 'ok',
  duration: 10,
  success: true,
};
const _strategyExhausted: QueryEvent = { type: 'strategy_exhausted', suggestion: 'try another way' };
const _message: QueryEvent = { type: 'message', role: 'assistant', content: 'hello' };
const _complete: QueryEvent = { type: 'complete', content: 'done', model: 'gpt-4o' };

// QueryEvent satisfies union (all variants accepted)
const _events: QueryEvent[] = [_requestStart, _promptAssembly, _assistantToolCalls, _toolCall, _permissionDecision, _toolResult, _strategyExhausted, _message, _complete];

// Message interface
const _sysMsg: Message = { role: 'system', content: 'hi', cacheControl: { type: 'ephemeral' } };
const _toolMsg: Message = { role: 'tool', content: 'result', tool_call_id: 'call-1' };
const _assistantMsg: Message = {
  role: 'assistant',
  content: '',
  tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }],
};

// CacheControl interface
const _cacheControl: CacheControl = { type: 'ephemeral' };

// LLMResponse interface
const _llmResponse: LLMResponse = {
  content: 'hello',
  model: 'gpt-4o',
  usage: { promptTokens: 10, completionTokens: 5 },
};

// ToolResult interface (with artifactRef)
const _toolResultShape: ToolResult = {
  success: true,
  output: 'result',
  summary: 'done',
  outputBytes: 42,
  artifactRef: { id: 'tool-1-abc', outputBytes: 50000 },
};

// PermissionResult interface
const _permAllow: PermissionResult = { behavior: 'allow' };
const _permAsk: PermissionResult = { behavior: 'ask', reason: 'Confirmation needed' };
const _permDeny: PermissionResult = { behavior: 'deny', reason: 'Dangerous' };

// IntentUpdate (complex — verify type exists and key fields compile)
const _intentKind: IntentKind = 'new_task';

const _driftOk: DriftCheckResult = { status: 'ok' };
const _driftWarn: DriftCheckResult = { status: 'warn', reason: 'slight drift' };
const _driftBlock: DriftCheckResult = { status: 'block', reason: 'off track', correction: 'do X instead' };

const _completionGate: CompletionGateResult = {
  canComplete: true,
  missing: [],
  evidence: ['test passed'],
};

const _capsule: ContextCapsule = {
  currentPlan: [],
  completed: ['step 1'],
  openTodos: ['step 2'],
  keyFacts: [],
  changedFiles: ['a.ts'],
  verification: { commandsRun: [], passed: [], failed: [], warnings: [] },
  nextAction: 'continue',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const _evidence: EvidenceRecord = {
  id: 'e1',
  kind: 'tool_result',
  content: 'evidence',
  source: 'ledger',
  importance: 3,
  createdAt: Date.now(),
  tokenEstimate: 10,
  tags: [],
  toolName: 'read_file',
  path: 'a.ts',
};

const _turnSummary = null as unknown as TurnSummary;
const _taskContract = null as unknown as TaskContract;
const _intentUpdate = null as unknown as IntentUpdate;

const _promptStats: PromptAssemblyStats = {
  createdAt: Date.now(),
  modelId: 'gpt-4o',
  budgetTokens: 1000,
  estimatedTokens: 500,
  coreTokens: 200,
  evidenceBudgetTokens: 300,
  recentTurnBudgetTokens: 100,
  includedEvidence: [],
  omittedEvidence: [],
  sections: ['core'],
};

const _harnessState: HarnessState = {
  version: 2,
  contract: _taskContract,
  ledger: [],
  capsule: _capsule,
  completionBlockCount: 0,
  taskEpoch: 1,
  rootObjective: 'do X',
  activeInstruction: 'do X',
  intentHistory: [_intentUpdate],
  activeConstraints: [],
  nonGoals: [],
  openQuestions: [],
  evidenceIndex: [_evidence],
  turnSummaries: [_turnSummary],
  updatedAt: Date.now(),
};

// Session types
const _sessionMeta: SessionMeta = {
  id: 'sess-1',
  projectPath: '/tmp',
  model: 'gpt-4o',
  startTime: Date.now(),
  updatedAt: Date.now(),
  messageCount: 5,
  tokenCount: 0,
  cost: 0,
};

const _sessionMessage: SessionMessage = {
  role: 'user',
  content: 'hello',
  timestamp: Date.now(),
};

const _sessionIndex: SessionIndex = {
  sessionId: 'sess-1',
  files: ['a.ts'],
  tools: { read_file: 2 },
  topics: ['topic'],
  updatedAt: Date.now(),
};

// Scheduler types
const _preparedToolCall: PreparedToolCall = {
  index: 0,
  tc: { id: '1', type: 'function', function: { name: 'x', arguments: '{}' } },
  args: {},
  tool: undefined,
  attemptId: 'a1',
  drift: undefined,
  permission: undefined,
  canRunConcurrently: true,
};

const _executedToolCall: ExecutedToolCall = {
  prepared: _preparedToolCall,
  result: 'ok',
  duration: 10,
  success: true,
  strategyResult: 'success',
};

const _toolSchedule: ToolSchedule = { parallel: [], serial: [] };

// Store types (AppState is a complex interface; verify it exists as a type)
const _appState = null as unknown as AppState;
const _permissionMode: import('../src/commands/types').PermissionMode = 'default';

// ============================================================================
// Runtime tests
// ============================================================================

// Tool state types
const _toolState: ToolState = {
  todos: [{ content: 'do X', status: 'pending', activeForm: 'doing X' }],
  planMode: false,
  currentPlan: null,
  lastEditFileArgs: null,
  goalActive: false,
  goalId: null,
  goalStatus: null,
};

const _todoItem: TodoItem = { content: 'do X', status: 'pending', activeForm: 'doing X' };

// Prompt types
const _promptCtx: PromptContext = {
  cwd: '/tmp',
  platform: 'darwin',
  nodeVersion: 'v20',
  tools: [],
};

const _promptSection: PromptSection = {
  name: 'intro',
  dynamic: false,
  render: () => 'intro',
};

// ============================================================================
// Runtime tests
// ============================================================================

describe('Public API', () => {
  describe('Core exports', () => {
    it('exports Brain', () => {
      expect(openhorse.Brain).toBeDefined();
      expect(typeof openhorse.Brain).toBe('function');
    });

    it('exports BaseAgent', () => {
      expect(openhorse.BaseAgent).toBeDefined();
      expect(typeof openhorse.BaseAgent).toBe('function');
    });

    it('exports LeaderAgent', () => {
      expect(openhorse.LeaderAgent).toBeDefined();
      expect(typeof openhorse.LeaderAgent).toBe('function');
    });

    it('exports CoderAgent', () => {
      expect(openhorse.CoderAgent).toBeDefined();
      expect(typeof openhorse.CoderAgent).toBe('function');
    });

    it('exports init', () => {
      expect(openhorse.init).toBeDefined();
      expect(typeof openhorse.init).toBe('function');
    });
  });

  describe('SDK compatibility', () => {
    it('exports HarnessEngine for backward compatibility', () => {
      expect(openhorse.HarnessEngine).toBeDefined();
      expect(typeof openhorse.HarnessEngine).toBe('function');
    });

    it('exports SafetyChecker', () => {
      expect(openhorse.SafetyChecker).toBeDefined();
      expect(typeof openhorse.SafetyChecker).toBe('function');
    });
  });

  describe('Framework exports', () => {
    it('exports buildTool', () => {
      expect(openhorse.buildTool).toBeDefined();
      expect(typeof openhorse.buildTool).toBe('function');
    });

    it('exports toOpenAITool', () => {
      expect(openhorse.toOpenAITool).toBeDefined();
      expect(typeof openhorse.toOpenAITool).toBe('function');
    });

    it('exports query', () => {
      expect(openhorse.query).toBeDefined();
      expect(typeof openhorse.query).toBe('function');
    });

    it('exports buildSystemPrompt', () => {
      expect(openhorse.buildSystemPrompt).toBeDefined();
      expect(typeof openhorse.buildSystemPrompt).toBe('function');
    });

    it('exports getSystemPrompt', () => {
      expect(openhorse.getSystemPrompt).toBeDefined();
      expect(typeof openhorse.getSystemPrompt).toBe('function');
    });

    it('exports Store', () => {
      expect(openhorse.Store).toBeDefined();
      expect(typeof openhorse.Store).toBe('function');
    });

    it('exports ContextHarness', () => {
      expect(openhorse.ContextHarness).toBeDefined();
      expect(typeof openhorse.ContextHarness).toBe('function');
    });

    it('exports ContextLedger', () => {
      expect(openhorse.ContextLedger).toBeDefined();
    });

    it('exports createContextCapsule', () => {
      expect(openhorse.createContextCapsule).toBeDefined();
      expect(typeof openhorse.createContextCapsule).toBe('function');
    });
  });

  describe('Tool API shape', () => {
    it('buildTool returns valid OpenHorseTool', () => {
      const tool = openhorse.buildTool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input' },
          },
          required: ['input'],
        },
        execute: async () => ({ success: true, output: 'done' }),
      });

      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: { input: { type: 'string', description: 'Input' } },
        required: ['input'],
      });
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.isReadOnly).toBe('function');
      expect(typeof tool.isDestructive).toBe('function');
      expect(typeof tool.isConcurrencySafe).toBe('function');
    });

    it('toOpenAITool converts to OpenAI format', () => {
      const tool = openhorse.buildTool({
        name: 'my_tool',
        description: 'My tool',
        parameters: {
          type: 'object',
          properties: { x: { type: 'string', description: 'X' } },
          required: ['x'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
      });

      const openAI = openhorse.toOpenAITool(tool);
      expect(openAI.type).toBe('function');
      expect(openAI.function.name).toBe('my_tool');
      expect(openAI.function.description).toBe('My tool');
      expect(openAI.function.parameters).toEqual({
        type: 'object',
        properties: { x: { type: 'string', description: 'X' } },
        required: ['x'],
      });
    });
  });

  describe('Type exports exist', () => {
    // These verify that TypeScript types are exported (no runtime check needed)
    it('has expected type exports available at build time', () => {
      // Type-only exports are compiled away, but we can verify the module structure
      const exports = Object.keys(openhorse);
      expect(exports).toContain('buildTool');
      expect(exports).toContain('query');
      expect(exports).toContain('ContextHarness');
      expect(exports).toContain('HarnessEngine');
    });
  });
});
