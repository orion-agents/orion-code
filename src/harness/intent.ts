import { randomUUID } from 'crypto';
import type { HarnessState, IntentKind, IntentUpdate } from './types';

const MAX_SUMMARY = 220;

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function truncate(input: string, max = MAX_SUMMARY): string {
  const normalized = normalize(input);
  return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

function matches(input: string, pattern: RegExp): boolean {
  return pattern.test(input);
}

function extractPaths(input: string): string[] {
  const matches = input.match(/(?:\.{0,2}\/|~\/|\/)[A-Za-z0-9._~/-]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g);
  return [...new Set(matches ?? [])].slice(0, 12);
}

function extractTools(input: string): string[] {
  const known = [
    'bash',
    'exec_command',
    'web_search',
    'web_fetch',
    'mcp',
    'read_file',
    'write_file',
    'edit_file',
    'apply_patch',
    'npm',
    'jest',
    'tsc',
    'git',
  ];
  const lower = input.toLowerCase();
  return known.filter(tool => lower.includes(tool.toLowerCase()));
}

function extractConstraints(input: string): string[] {
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const constraintPattern = /(必须|要求|确保|保持|不要|不能|不准|避免|只|仅|must|should|required|ensure|keep|avoid|without|do not|don't|never|only)/i;
  return [...new Set(lines.filter(line => constraintPattern.test(line)).map(line => truncate(line, 180)))].slice(0, 10);
}

function extractNonGoals(input: string): string[] {
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const nonGoalPattern = /(不要|不能|不准|避免|不引入|不新增|禁止|do not|don't|never|avoid|without)/i;
  return [...new Set(lines.filter(line => nonGoalPattern.test(line)).map(line => truncate(line, 180)))].slice(0, 8);
}

function extractQuestions(input: string): string[] {
  return input
    .split(/(?<=[?？])\s*/)
    .map(line => line.trim())
    .filter(line => /[?？]/.test(line))
    .map(line => truncate(line, 180))
    .slice(0, 8);
}

function isGenericContinue(input: string): boolean {
  return /^(继续|继续吧|继续开发|继续做|接着|接着做|go on|continue|keep going)$/i.test(input.trim());
}

function isShortFeedback(input: string): boolean {
  const text = normalize(input);
  if (text.length > 18) return false;
  return /^(好的|可以|收到|嗯|对|是的|不错|挺好|挺好的|不对|不对吧|不是|错了|ok|yes|no|fine|great)$/i.test(text);
}

function isVersionScopedRefinement(input: string): boolean {
  return /(这个版本|本版本|当前版本|this version).*(主要|重点|聚焦|稳定|收敛|优化|完善|focus|stabilize|improve)/i.test(input);
}

function classifyKind(input: string, state?: HarnessState): { kind: IntentKind; confidence: number; reason: string } {
  const text = normalize(input);
  const lower = text.toLowerCase();
  const hasRoot = !!(state?.rootObjective || state?.contract?.objective);

  if (!text) {
    return { kind: 'casual_or_feedback', confidence: 0.5, reason: 'empty input' };
  }

  if (isGenericContinue(text)) {
    return { kind: 'continue_current_task', confidence: 0.78, reason: 'generic continuation request' };
  }

  if (isShortFeedback(text)) {
    return { kind: 'casual_or_feedback', confidence: 0.72, reason: 'short feedback should not replace the root objective' };
  }

  if (matches(lower, /\b(verify|test|run tests?|check|lint|typecheck|build)\b/) || matches(text, /(验证|测试|检查|跑一下|运行测试|构建|编译)/)) {
    return { kind: 'verify_or_test', confidence: 0.82, reason: 'verification-oriented wording' };
  }

  if (hasRoot && isVersionScopedRefinement(text)) {
    return { kind: 'refine_current_task', confidence: 0.78, reason: 'version-scoped refinement within the active task' };
  }

  if (matches(lower, /\b(harness|mcp|session|resume|compact|config|configuration|ui|npm|publish|push|pull request|pr)\b/) ||
      matches(text, /(配置|会话|恢复|压缩|版本|分支|发布|新ui|界面|工具|权限|确认|配置文件)/)) {
    if (matches(text, /(基于当前|切\s*v|切到|这个版本|新版本|开始按|完整开发|实现这个方案)/) ||
        matches(lower, /\b(please implement|implement this plan|start implementing|new version)\b/)) {
      return { kind: 'new_task', confidence: 0.88, reason: 'explicit versioned implementation task' };
    }
    return { kind: 'meta_configuration', confidence: 0.75, reason: 'configuration or CLI meta request' };
  }

  if (matches(text, /(不对|不是|错了|改成|改为|换成|重新|重做|不要.+而是|应该.+而不是)/) ||
      matches(lower, /\b(instead|replace|switch to|redo|wrong)\b/)) {
    return { kind: 'interrupt_and_replace_current_step', confidence: 0.8, reason: 'correction or replacement wording' };
  }

  if (matches(text, /(基于|切到|这个版本|新版本|开始|实现|开发|生成|创建|写文档|完成本次|按这个计划|完整支持|帮我完成)/) ||
      matches(lower, /\b(generate|create|implement|build|start|complete this|write a|please implement)\b/)) {
    return { kind: 'new_task', confidence: hasRoot ? 0.76 : 0.86, reason: 'explicit task creation wording' };
  }

  // Clarification: user is asking for explanation or asking about meaning
  // Must be checked BEFORE refinement since clarification phrases may contain "这个"
  if (matches(text, /(什么意思|解释一下|解释说明|clarify|explain to me|what does.*mean|what is.*for|can you explain|meaning of)/) ||
      matches(lower, /^(what|why|how|explain|clarify|could you explain|can you explain)\b/)) {
    return { kind: 'clarification', confidence: 0.7, reason: 'clarification or explanation request' };
  }

  if (matches(text, /(补充|另外|同时|还有|希望|可以|顺便|完善|优化|灰色|填充|这个|这里|如图|也|继续)/) ||
      matches(lower, /\b(also|additionally|please also|refine|improve|continue)\b/)) {
    return { kind: 'refine_current_task', confidence: hasRoot ? 0.76 : 0.58, reason: 'refinement or addition wording' };
  }

  return hasRoot
    ? { kind: 'refine_current_task', confidence: 0.55, reason: 'existing task makes ambiguous input a refinement' }
    : { kind: 'new_task', confidence: 0.62, reason: 'first meaningful user task' };
}

export function classifyIntent(input: string, state?: HarnessState): IntentUpdate {
  const now = Date.now();
  const baseEpoch = state?.taskEpoch ?? (state?.contract ? 1 : 0);
  const classified = classifyKind(input, state);
  const rootObjectiveChanged = classified.kind === 'new_task' || !state?.contract;
  const taskEpoch = rootObjectiveChanged ? Math.max(1, baseEpoch + (state?.contract ? 1 : 0)) : Math.max(1, baseEpoch || 1);
  const summary = truncate(input || 'Continue the current task');

  return {
    id: randomUUID(),
    kind: classified.kind,
    input,
    summary,
    confidence: classified.confidence,
    reason: classified.reason,
    taskEpoch,
    rootObjectiveChanged,
    activeInstruction: summary,
    constraints: extractConstraints(input),
    nonGoals: extractNonGoals(input),
    openQuestions: extractQuestions(input),
    filesMentioned: extractPaths(input),
    toolsMentioned: extractTools(input),
    createdAt: now,
  };
}

export function shouldReplaceActiveInstruction(intent: IntentUpdate): boolean {
  if (intent.kind === 'continue_current_task') return false;
  if (intent.kind === 'casual_or_feedback' && intent.input.trim().length <= 18) return false;
  if (intent.kind === 'clarification') return false;
  return true;
}
