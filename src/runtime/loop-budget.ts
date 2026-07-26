import { DEFAULT_LOOP_BUDGET, type LoopBudget, type LoopBudgetBaseProfile } from '../framework';
import type { OpenHorseCLIConfig } from '../services/config';
import type { HarnessState } from '../harness/types';

const COMPLEX_TASK_LLM_BUDGET = 48;
const RELEASE_TASK_LLM_BUDGET = 64;
const COMPLEX_TASK_TOOL_BUDGET = 180;
const RELEASE_TASK_TOOL_BUDGET = 240;
const COMPLEX_TASK_MODEL_VISIBLE_BYTES = 96 * 1024;
const RELEASE_TASK_MODEL_VISIBLE_BYTES = 128 * 1024;

function toBaseProfile(value: LoopBudget['profile'] | undefined): LoopBudgetBaseProfile {
  return value === 'complex' || value === 'release' ? value : 'default';
}

function applyConfigOverrides(
  budget: LoopBudget,
  overrides: OpenHorseCLIConfig['agentLoop'] | undefined,
): LoopBudget {
  const configured = overrides?.budget;
  if (!configured) return budget;
  const numericOverrides = Object.fromEntries(
    Object.entries(configured).filter(([, value]) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
    )
  );
  if (Object.keys(numericOverrides).length === 0) return budget;

  return {
    ...budget,
    ...numericOverrides,
    profile: 'config',
    baseProfile: budget.baseProfile ?? toBaseProfile(budget.profile),
    configOverride: true,
  };
}

function looksLikeReleaseTask(input: string): boolean {
  return /\b(push|pull request|pr|publish|release|npm publish|prepublish)\b/i.test(input)
    || /(发布|发版|提交|推送)/.test(input);
}

function looksLikeComplexTask(input: string): boolean {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length >= 120 || input.includes('\n')) return true;
  return /\b(implement|refactor|migrate|optimi[sz]e|debug|fix|complete|review|plan|large|complex|multi[- ]?step|continue)\b/i.test(normalized)
    || /(开发|实现|重构|迁移|优化|修复|完成|完整|复杂|大任务|大的任务|大型任务|大规模|长任务|长期任务|多步骤|检查|审查|按计划|执行计划|继续)/.test(normalized);
}

export function resolveRuntimeLoopBudget(
  input: string,
  config: Pick<OpenHorseCLIConfig, 'agentLoop'>,
  harnessState?: Pick<HarnessState, 'rootObjective' | 'activeInstruction' | 'contract' | 'capsule'>,
): LoopBudget {
  let budget: LoopBudget = {
    ...DEFAULT_LOOP_BUDGET,
    profile: 'default',
    baseProfile: 'default',
    configOverride: false,
  };
  const taskSegments = [
    input,
    harnessState?.rootObjective,
    harnessState?.activeInstruction,
    harnessState?.contract?.objective,
    harnessState?.capsule?.contract?.objective,
    harnessState?.capsule?.nextAction,
  ].filter((segment): segment is string => typeof segment === 'string' && segment.trim().length > 0);

  if (taskSegments.some(looksLikeReleaseTask)) {
    budget = {
      ...budget,
      maxLlmRequestsPerUserTurn: RELEASE_TASK_LLM_BUDGET,
      maxToolCallsPerUserTurn: RELEASE_TASK_TOOL_BUDGET,
      maxModelVisibleToolBytes: RELEASE_TASK_MODEL_VISIBLE_BYTES,
      profile: 'release',
      baseProfile: 'release',
    };
  } else if (taskSegments.some(looksLikeComplexTask)) {
    budget = {
      ...budget,
      maxLlmRequestsPerUserTurn: COMPLEX_TASK_LLM_BUDGET,
      maxToolCallsPerUserTurn: COMPLEX_TASK_TOOL_BUDGET,
      maxModelVisibleToolBytes: COMPLEX_TASK_MODEL_VISIBLE_BYTES,
      profile: 'complex',
      baseProfile: 'complex',
    };
  }

  return applyConfigOverrides(budget, config.agentLoop);
}
