/**
 * Orion Code - initialization configuration and startup entry point.
 *
 * Unified init entry: config loading → Harness → Memory → Agents → Brain → start.
 */

import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import { BaseAgent, AgentConfig, Task, TaskResult } from './core/agent';
import { Brain, BrainConfig } from './core/brain';
import { LeaderAgent } from './agents/leader';
import { CoderAgent } from './agents/coder';
import { SafetyChecker, SafetyPolicy } from './harness/safety';
import { MemoryStore } from './memory/store';
import { ENV } from './product/environment';

// ============================================================================
// 1. Config type definitions
// ============================================================================

/** Orion Code global configuration */
export interface OrionCodeConfig {
  name: string;
  mode: 'development' | 'production' | 'test';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  brain: BrainConfig;
  harness: HarnessConfig;
  memory: MemoryConfig;
  safety: SafetyConfig;
  agents: AgentRegistryEntry[];
}

/** @deprecated Use OrionCodeConfig instead. */
export type OpenHorseConfig = OrionCodeConfig;

/** Harness system configuration */
export interface HarnessConfig {
  goalConstraint: boolean;
  maxSteps: number;
  boundaryCheck: boolean;
  allowedActions: string[];
  blockedActions: string[];
  resultValidation: boolean;
  sandbox: boolean;
  timeout: number;
}

/** Memory system configuration */
export interface MemoryConfig {
  workingCapacity: number;
  shortTermCapacity: number;
  longTermBackend: 'memory' | 'file';
  longTermPath?: string;
}

/** Safety policy configuration */
export interface SafetyConfig {
  enabled: boolean;
  policy?: Partial<SafetyPolicy>;
}

/** Agent registry entry */
export interface AgentRegistryEntry {
  type: 'leader' | 'coder' | string;
  config?: Partial<AgentConfig>;
}

// ============================================================================
// 2. Harness system
// ============================================================================

/** Harness verdict */
export interface HarnessVerdict {
  passed: boolean;
  stage: 'pre-exec' | 'post-exec';
  reason?: string;
}

/** Harness system — provides constraints, checks & validation for agent execution */
export class Harness extends EventEmitter {
  private config: HarnessConfig;

  constructor(config: Partial<HarnessConfig> = {}) {
    super();
    this.config = {
      goalConstraint: true,
      maxSteps: 50,
      boundaryCheck: true,
      allowedActions: ['*'],
      blockedActions: ['rm -rf /', 'eval', 'exec'],
      resultValidation: true,
      sandbox: false,
      timeout: 60000,
      ...config,
    };
  }

  preCheck(task: Task): HarnessVerdict {
    if (this.config.blockedActions.length > 0 && task.params?.actions) {
      const actions = task.params.actions;
      if (Array.isArray(actions) && actions.every(a => typeof a === 'string')) {
        const blocked = (actions as string[]).filter(a => this.config.blockedActions.includes(a));
        if (blocked.length > 0) {
          return { passed: false, stage: 'pre-exec', reason: `Blocked actions detected: ${blocked.join(', ')}` };
        }
      }
    }

    if (this.config.allowedActions[0] !== '*' && task.params?.actions) {
      const actions = task.params.actions;
      if (Array.isArray(actions) && actions.every(a => typeof a === 'string')) {
        const disallowed = (actions as string[]).filter(a => !this.config.allowedActions.includes(a));
        if (disallowed.length > 0) {
          return { passed: false, stage: 'pre-exec', reason: `Actions not in whitelist: ${disallowed.join(', ')}` };
        }
      }
    }

    return { passed: true, stage: 'pre-exec' };
  }

  postValidate(result: TaskResult, _task: Task): HarnessVerdict {
    if (!this.config.resultValidation) {
      return { passed: true, stage: 'post-exec' };
    }
    if (result.duration && result.duration > this.config.timeout) {
      return { passed: false, stage: 'post-exec', reason: `Execution exceeded timeout: ${result.duration}ms > ${this.config.timeout}ms` };
    }
    return { passed: true, stage: 'post-exec' };
  }

  getConfig(): HarnessConfig {
    return { ...this.config };
  }
}

// ============================================================================
// 3. Memory system
// ============================================================================

export interface MemoryEntry {
  id: string;
  content: any;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  tags?: string[];
}

export type MemoryTier = 'working' | 'short-term' | 'long-term';

export class MemorySystem extends EventEmitter {
  private workingMemory: MemoryEntry[] = [];
  private shortTermMemory: MemoryEntry[] = [];
  private longTermMemory: Map<string, MemoryEntry> = new Map();
  private config: MemoryConfig;

  constructor(config: Partial<MemoryConfig> = {}) {
    super();
    this.config = { workingCapacity: 10, shortTermCapacity: 100, longTermBackend: 'memory', ...config };
  }

  writeToWorking(content: any, tags?: string[]): MemoryEntry {
    const entry = this.createEntry(content, tags);
    this.workingMemory.push(entry);
    if (this.workingMemory.length > this.config.workingCapacity) {
      const evicted = this.workingMemory.shift();
      if (evicted) { this.addToShortTerm(evicted); this.emit('evicted', { tier: 'working', id: evicted.id }); }
    }
    this.emit('write', { tier: 'working', id: entry.id });
    return entry;
  }

  readWorking(): MemoryEntry[] { this.touchEntries(this.workingMemory); return [...this.workingMemory]; }

  clearWorking(): void {
    const important = this.workingMemory.filter(e => e.accessCount >= 3);
    important.forEach(e => this.addToShortTerm(e));
    this.workingMemory = [];
    this.emit('cleared', { tier: 'working' });
  }

  writeToShortTerm(content: any, tags?: string[]): MemoryEntry {
    const entry = this.createEntry(content, tags);
    this.addToShortTerm(entry);
    this.emit('write', { tier: 'short-term', id: entry.id });
    return entry;
  }

  readShortTerm(): MemoryEntry[] { this.touchEntries(this.shortTermMemory); return [...this.shortTermMemory]; }

  writeToLongTerm(content: any, tags?: string[]): MemoryEntry {
    const entry = this.createEntry(content, tags);
    this.longTermMemory.set(entry.id, entry);
    this.emit('write', { tier: 'long-term', id: entry.id });
    return entry;
  }

  readLongTerm(id: string): MemoryEntry | undefined {
    const entry = this.longTermMemory.get(id);
    if (entry) { entry.lastAccessedAt = Date.now(); entry.accessCount++; }
    return entry;
  }

  search(query: string, tier?: MemoryTier): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const lowerQuery = query.toLowerCase();
    const searchTier = (entries: MemoryEntry[]) => {
      entries.forEach(e => {
        const content = JSON.stringify(e.content).toLowerCase();
        const tags = (e.tags ?? []).join(' ').toLowerCase();
        if (content.includes(lowerQuery) || tags.includes(lowerQuery)) results.push(e);
      });
    };
    if (!tier || tier === 'working') searchTier(this.workingMemory);
    if (!tier || tier === 'short-term') searchTier(this.shortTermMemory);
    if (!tier || tier === 'long-term') searchTier(Array.from(this.longTermMemory.values()));
    return results;
  }

  getStatus(): Record<MemoryTier, number> {
    return { working: this.workingMemory.length, 'short-term': this.shortTermMemory.length, 'long-term': this.longTermMemory.size };
  }

  private createEntry(content: any, tags?: string[]): MemoryEntry {
    const now = Date.now();
    return { id: uuidv4(), content, createdAt: now, lastAccessedAt: now, accessCount: 0, tags };
  }

  private addToShortTerm(entry: MemoryEntry): void {
    entry.lastAccessedAt = Date.now();
    this.shortTermMemory.push(entry);
    if (this.shortTermMemory.length > this.config.shortTermCapacity) {
      const evicted = this.shortTermMemory.shift();
      if (evicted) { this.longTermMemory.set(evicted.id, evicted); this.emit('evicted', { tier: 'short-term', id: evicted.id }); }
    }
  }

  private touchEntries(entries: MemoryEntry[]): void {
    entries.forEach(e => { e.lastAccessedAt = Date.now(); e.accessCount++; });
  }
}

// ============================================================================
// 4. Default config
// ============================================================================

const DEFAULT_CONFIG: OrionCodeConfig = {
  name: 'orion-code',
  mode: (process.env[ENV.MODE] as OrionCodeConfig['mode']) || 'development',
  logLevel: (process.env[ENV.LOG_LEVEL] as OrionCodeConfig['logLevel']) || 'info',
  brain: { strategy: 'priority', maxConcurrent: 5 },
  harness: {
    goalConstraint: true, maxSteps: 50, boundaryCheck: true,
    allowedActions: ['*'], blockedActions: ['rm -rf /', 'eval', 'exec'],
    resultValidation: true, sandbox: false, timeout: 60000,
  },
  memory: { workingCapacity: 10, shortTermCapacity: 100, longTermBackend: 'memory' },
  safety: { enabled: true, policy: { sandboxMode: false, allowedFileSystemOps: ['read', 'write'] } },
  agents: [{ type: 'leader' }, { type: 'coder' }],
};

// ============================================================================
// 5. Init entry
// ============================================================================

export interface OrionCodeRuntime {
  brain: Brain;
  harness: Harness;
  memory: MemorySystem;
  safety: SafetyChecker;
  store: MemoryStore;
  agents: BaseAgent[];
  config: OrionCodeConfig;
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/** @deprecated Use OrionCodeRuntime instead. */
export type OpenHorseRuntime = OrionCodeRuntime;

export async function init(userConfig: Partial<OrionCodeConfig> = {}): Promise<OrionCodeRuntime> {
  const logger = createLogger(userConfig.logLevel ?? DEFAULT_CONFIG.logLevel);
  const config: OrionCodeConfig = mergeConfig(DEFAULT_CONFIG, userConfig);
  const harness = new Harness(config.harness);
  const memory = new MemorySystem(config.memory);
  const safety = new SafetyChecker(config.safety?.policy);
  const store = new MemoryStore({ workingCapacity: config.memory.workingCapacity, shortTermCapacity: config.memory.shortTermCapacity });
  const brain = new Brain(config.brain);
  const agents = await registerAgents(brain, config.agents, harness, memory, logger);

  memory.writeToWorking({ event: 'system-start', timestamp: new Date().toISOString(), mode: config.mode, agentCount: agents.length }, ['system', 'startup']);

  const runtime: OrionCodeRuntime = {
    brain, harness, memory, safety, store, agents, config,
    async start() {
      memory.writeToWorking({ event: 'system-started', timestamp: new Date().toISOString() }, ['system']);
      agents.forEach(agent => {
        agent.on('task-failed', ({ task, error }) => {
          logger.error(`[Orion Code] Task "${task.name}" failed on ${agent.name}: ${error}`);
          memory.writeToShortTerm({ event: 'task-failed', taskId: task.id, agent: agent.name, error }, ['error', task.id]);
        });
      });
    },
    async shutdown() {
      agents.forEach(agent => agent.stop());
      const workingMemories = memory.readWorking();
      workingMemories.forEach(entry => { memory.writeToLongTerm(entry.content, entry.tags); });
      memory.clearWorking();
    },
  };

  return runtime;
}

// ============================================================================
// 6. Helpers
// ============================================================================

function createLogger(level: OrionCodeConfig['logLevel']) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const current = levels[level];
  return {
    debug(msg: string) { if (current <= levels.debug) console.debug(msg); },
    info(msg: string)  { if (current <= levels.info)  console.log(msg); },
    warn(msg: string)  { if (current <= levels.warn)  console.warn(msg); },
    error(msg: string) { console.error(msg); },
  };
}

function mergeConfig(defaults: OrionCodeConfig, override: Partial<OrionCodeConfig>): OrionCodeConfig {
  const result = { ...defaults };
  if (override.name !== undefined) result.name = override.name;
  if (override.mode !== undefined) result.mode = override.mode;
  if (override.logLevel !== undefined) result.logLevel = override.logLevel;
  if (override.brain) result.brain = { ...defaults.brain, ...override.brain };
  if (override.harness) result.harness = { ...defaults.harness, ...override.harness };
  if (override.memory) result.memory = { ...defaults.memory, ...override.memory };
  if (override.safety) result.safety = { ...defaults.safety, ...override.safety };
  if (override.agents) result.agents = override.agents;
  return result;
}

const AGENT_FACTORY: Record<string, (config?: Partial<AgentConfig>) => BaseAgent> = {
  leader: (cfg) => new LeaderAgent(cfg),
  coder: (cfg) => new CoderAgent(cfg),
};

async function registerAgents(
  brain: Brain, entries: AgentRegistryEntry[],
  harness: Harness, memory: MemorySystem,
  logger: ReturnType<typeof createLogger>,
): Promise<BaseAgent[]> {
  const agents: BaseAgent[] = [];
  for (const entry of entries) {
    const factory = AGENT_FACTORY[entry.type];
    if (!factory) { logger.warn(`[Orion Code] Unknown agent type: ${entry.type}, skipping.`); continue; }
    const agent = factory(entry.config);

    agent.on('task-started', (task: Task) => {
      const verdict = harness.preCheck(task);
      if (!verdict.passed) {
        logger.warn(`[Orion Code] Harness blocked task "${task.name}": ${verdict.reason}`);
        agent.emit('task-blocked', { task, verdict });
      }
    });

    agent.on('task-completed', ({ task, result }: { task: Task; result: TaskResult }) => {
      const verdict = harness.postValidate(result, task);
      if (!verdict.passed) {
        logger.warn(`[Orion Code] Harness validation failed for "${task.name}": ${verdict.reason}`);
      }
      memory.writeToShortTerm({
        event: 'task-completed', taskId: task.id, agent: agent.name, success: result.success, duration: result.duration,
      }, ['task', task.id]);
    });

    brain.registerAgent(agent);
    agents.push(agent);
  }
  return agents;
}

// ============================================================================
// 7. Startup entry
// ============================================================================

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          Orion Code                              ║');
  console.log('║  goal-driven coding agent for the terminal.      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  const runtime = await init({ mode: 'development', logLevel: 'debug' });

  process.on('SIGINT', async () => { await runtime.shutdown(); process.exit(0); });
  process.on('SIGTERM', async () => { await runtime.shutdown(); process.exit(0); });

  await runtime.start();

  console.log('\n[Orion Code] System Status:');
  console.log(JSON.stringify(runtime.brain.getStatus(), null, 2));
  console.log('\n[Orion Code] Memory Status:');
  console.log(JSON.stringify(runtime.memory.getStatus(), null, 2));
  console.log('\n[Orion Code] Harness Config:');
  console.log(JSON.stringify(runtime.harness.getConfig(), null, 2));

  console.log('\n[Orion Code] Submitting demo task...');
  runtime.brain.submitTask({
    id: 'init-task-001', name: 'Init verification task', description: 'Verify system init success',
    priority: 'P1', assignedTo: 'leader', status: 'pending',
  });
}

if (require.main === module) {
  main().catch(err => { console.error('[Orion Code] Fatal error:', err); process.exit(1); });
}

// ============================================================================
// Re-exports
// ============================================================================

export { SafetyChecker } from './harness/safety';
export { MemoryStore } from './memory/store';
export type { SafetyPolicy, SafetyCheck, SecurityLevel, AuditLogEntry } from './harness/safety';
export type { MemoryEntry as StoreMemoryEntry, MemoryTier as StoreMemoryTier, MemoryQuery, MemoryStoreConfig } from './memory/store';