/**
 * orion code - Agent Router
 *
 * 智能任务路由器，基于关键词和语义分析分配任务到合适的 Agent
 *
 * Status: EXPERIMENTAL (v0.1.4-plus). Not wired into the main REPL chat loop
 * yet. Planned for v0.1.6. Tests pass and unit-level usage is supported, but
 * `handleChat` still routes every request through the default agent profile.
 * See docs/roadmap/v0.1.4-plus.md Part 7 for the decision rationale.
 */


import type { Task } from '../core/agent';

// ============================================================================
// Types
// ============================================================================

/** Agent capability profile */
export interface AgentCapability {
  id: string;
  name: string;
  keywords: string[];
  patterns: RegExp[];
  priority: number;
  maxConcurrent: number;
}

/** Router configuration */
export interface RouterConfig {
  defaultAgent?: string;
  fallbackAgent?: string;
  maxRetries?: number;
}

/** Router result */
export interface RouterResult {
  agentId: string;
  confidence: number;
  reason: string;
}

// ============================================================================
// Task Classifier
// ============================================================================

/** Task classification categories */
const TASK_CATEGORIES = {
  coding: {
    keywords: ['implement', 'write', 'create', 'fix', 'refactor', 'code', 'function', 'class', 'bug'],
    patterns: [/write\s+(a|the|some)\s+(function|class|module)/i, /implement\s+\w+/i, /fix\s+(bug|issue|error)/i],
  },
  review: {
    keywords: ['review', 'check', 'audit', 'analyze', 'inspect', 'quality'],
    patterns: [/review\s+(code|changes|pr)/i, /check\s+\w+/i],
  },
  research: {
    keywords: ['search', 'find', 'explore', 'investigate', 'lookup', 'discover'],
    patterns: [/search\s+for/i, /find\s+\w+/i, /explore\s+(the|this)/i],
  },
  testing: {
    keywords: ['test', 'spec', 'coverage', 'unit', 'integration', 'verify'],
    patterns: [/write\s+(tests|specs)/i, /add\s+test/i, /run\s+test/i],
  },
  documentation: {
    keywords: ['document', 'readme', 'docs', 'comment', 'describe', 'explain'],
    patterns: [/write\s+(docs|documentation)/i, /update\s+readme/i],
  },
  security: {
    keywords: ['security', 'vulnerable', 'xss', 'injection', 'auth', 'encrypt'],
    patterns: [/security\s+check/i, /scan\s+for\s+vulner/i],
  },
};

/** Classify task by keywords and patterns */
export function classifyTask(taskName: string, taskDescription?: string): { category: string; confidence: number } {
  const text = `${taskName} ${taskDescription || ''}`.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [category, config] of Object.entries(TASK_CATEGORIES)) {
    let score = 0;

    // Keyword matching
    for (const keyword of config.keywords) {
      if (text.includes(keyword)) {
        score += 1;
      }
    }

    // Pattern matching
    for (const pattern of config.patterns) {
      if (pattern.test(text)) {
        score += 2;
      }
    }

    scores[category] = score;
  }

  // Find best category
  let bestCategory = 'coding'; // Default
  let bestScore = 0;

  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  // Calculate confidence (normalize score)
  const confidence = Math.min(bestScore / 5, 1);

  return { category: bestCategory, confidence };
}

// ============================================================================
// Agent Router
// ============================================================================

export class AgentRouter {
  private agents: Map<string, AgentCapability> = new Map();
  private config: RouterConfig;

  constructor(config?: RouterConfig) {
    this.config = config || {
      defaultAgent: 'coder',
      fallbackAgent: 'leader',
      maxRetries: 3,
    };

    // Register default agents
    this.registerDefaultAgents();
  }

  /** Register default agent capabilities */
  private registerDefaultAgents(): void {
    this.registerAgent({
      id: 'coder',
      name: 'Coder Agent',
      keywords: ['implement', 'write', 'create', 'fix', 'code', 'bug', 'function', 'refactor'],
      patterns: [/write\s+(a|the)\s+(function|class)/i, /implement\s+\w+/i, /fix\s+\w+/i],
      priority: 60,
      maxConcurrent: 2,
    });

    this.registerAgent({
      id: 'leader',
      name: 'Leader Agent',
      keywords: ['coordinate', 'plan', 'organize', 'manage', 'distribute'],
      patterns: [/plan\s+(the|this)/i, /coordinate\s+\w+/i],
      priority: 50,
      maxConcurrent: 1,
    });

    this.registerAgent({
      id: 'reviewer',
      name: 'Review Agent',
      keywords: ['review', 'check', 'audit', 'analyze', 'inspect', 'quality'],
      patterns: [/review\s+(code|changes)/i, /check\s+\w+/i],
      priority: 55,
      maxConcurrent: 1,
    });

    this.registerAgent({
      id: 'tester',
      name: 'Test Agent',
      keywords: ['test', 'spec', 'coverage', 'unit', 'integration', 'verify'],
      patterns: [/write\s+(tests|specs)/i, /add\s+test/i],
      priority: 55,
      maxConcurrent: 1,
    });
  }

  /** Register agent capability */
  registerAgent(capability: AgentCapability): void {
    this.agents.set(capability.id, capability);
  }

  /** Route task to appropriate agent */
  route(task: Task): RouterResult {
    const classification = classifyTask(task.name, task.description);

    // Map category to agent
    const agentMap: Record<string, string> = {
      coding: 'coder',
      review: 'reviewer',
      testing: 'tester',
      research: 'leader',
      documentation: 'coder',
      security: 'reviewer',
    };

    const targetAgent = agentMap[classification.category] || this.config.defaultAgent || 'coder';

    return {
      agentId: targetAgent,
      confidence: classification.confidence,
      reason: `Task classified as ${classification.category} (confidence: ${classification.confidence.toFixed(2)})`,
    };
  }

  /** Get all registered agents */
  getAgents(): AgentCapability[] {
    return Array.from(this.agents.values());
  }

  /** Get agent by ID */
  getAgent(id: string): AgentCapability | undefined {
    return this.agents.get(id);
  }

  /** Check if agent exists */
  hasAgent(id: string): boolean {
    return this.agents.has(id);
  }

  /** Get available agents for category */
  getAgentsForCategory(category: string): AgentCapability[] {
    const categoryKeywords = (TASK_CATEGORIES as Record<string, { keywords: string[]; patterns: RegExp[] }>)[category]?.keywords || [];
    const matchingAgents: AgentCapability[] = [];

    for (const agent of this.agents.values()) {
      const overlap = agent.keywords.filter(k => categoryKeywords.includes(k));
      if (overlap.length > 0) {
        matchingAgents.push(agent);
      }
    }

    // Sort by priority
    matchingAgents.sort((a, b) => b.priority - a.priority);

    return matchingAgents;
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultRouter: AgentRouter | null = null;

export function getAgentRouter(config?: RouterConfig): AgentRouter {
  if (!defaultRouter) {
    defaultRouter = new AgentRouter(config);
  }
  return defaultRouter;
}

export function resetAgentRouter(): void {
  defaultRouter = null;
}