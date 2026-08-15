/**
 * orion code - 消息摘要生成器
 *
 * 为压缩的历史消息生成简洁摘要，保留关键信息。
 */

import type { LLMService, Message } from '../llm';
import { redactTraceText } from '../redaction';
import { groupMessagesForCompact } from './planner';
import {
  emptyCompactSummary,
  extractCompactSummary,
  type CompactSummary,
} from './semantic-summary';

// ============================================================================
// 类型定义
// ============================================================================

export interface SummaryOptions {
  /** 摘要最大长度 */
  maxLength?: number;
  /** 是否包含工具调用摘要 */
  includeToolCalls?: boolean;
  /** 是否包含文件修改摘要 */
  includeFileChanges?: boolean;
  /** 摘要格式 */
  format?: 'bullet' | 'narrative' | 'structured';
  /**
   * Optional user focus for a manual compact. This is secondary guidance only:
   * atomic-group coverage and Harness invariants are validated separately.
   */
  focus?: string;
  /**
   * Bounded project guidance applied to manual and automatic compaction. It is
   * secondary to protocol, safety, criteria, evidence, and pending-work rules.
   */
  instructions?: string;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_OPTIONS: SummaryOptions = {
  maxLength: 2000,
  includeToolCalls: true,
  includeFileChanges: true,
  format: 'bullet',
};

const MAX_FOCUS_LENGTH = 300;
const MAX_INSTRUCTIONS_LENGTH = 600;

export function normalizeCompactFocus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = redactTraceText(value).replace(/\s+/g, ' ').trim();
  return normalized ? truncateSummary(normalized, MAX_FOCUS_LENGTH) : undefined;
}

export function normalizeCompactInstructions(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = redactTraceText(value).replace(/\s+/g, ' ').trim();
  return normalized ? truncateSummary(normalized, MAX_INSTRUCTIONS_LENGTH) : undefined;
}

function applyCompactGuidance(
  summary: string,
  focus: string | undefined,
  instructions: string | undefined,
  maxLength: number
): string {
  const normalizedFocus = normalizeCompactFocus(focus);
  const normalizedInstructions = normalizeCompactInstructions(instructions);
  const guidanceLines = [
    normalizedFocus ? `Requested focus: ${normalizedFocus}` : '',
    normalizedInstructions ? `Project compact instructions: ${normalizedInstructions}` : '',
  ].filter(Boolean);
  if (guidanceLines.length === 0) return truncateSummary(summary, maxLength);
  const guidance = guidanceLines.join('\n');
  if (!summary.trim()) return truncateSummary(guidance, maxLength);

  // Bound all caller guidance so it cannot crowd the semantic summary out of the
  // model-visible projection.
  const guidanceBudget = Math.min(Math.max(48, Math.floor(maxLength * 0.25)), 240);
  const boundedGuidance = truncateSummary(guidance, guidanceBudget);
  const summaryBudget = Math.max(0, maxLength - boundedGuidance.length - 1);
  return truncateSummary(
    `${boundedGuidance}\n${truncateSummary(summary, summaryBudget)}`,
    maxLength
  );
}

function truncateSummary(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

/**
 * Reserve space for newly evicted context even when the prior durable summary
 * already fills the entire summary budget.
 */
function mergeSummaries(
  priorSummary: string | undefined,
  freshSummary: string,
  maxLength: number
): string {
  const prior = priorSummary?.trim() ?? '';
  const fresh = freshSummary.trim();
  if (!prior) return truncateSummary(fresh, maxLength);
  if (!fresh) return truncateSummary(prior, maxLength);

  const contentBudget = Math.max(0, maxLength - 1);
  const freshBudget = Math.max(1, Math.ceil(contentBudget * 0.6));
  const priorBudget = Math.max(0, contentBudget - freshBudget);
  const parts = [truncateSummary(prior, priorBudget), truncateSummary(fresh, freshBudget)].filter(
    Boolean
  );
  return truncateSummary(parts.join('\n'), maxLength);
}

// ============================================================================
// 摘要生成
// ============================================================================

/**
 * 从消息列表生成摘要
 *
 * 注意：这是一个简化实现，不调用 LLM。
 * 实际生产版本应该调用 LLM 生成更准确的摘要。
 */
export async function summaryGenerator(
  messages: Message[],
  options?: SummaryOptions
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length === 0) {
    return '';
  }

  const prepared = prepareSummaryInput(messages);

  // 收集关键信息
  const userTopics: string[] = [];
  const toolsUsed: string[] = [];
  const filesModified: string[] = [];

  for (const msg of prepared.messages) {
    if (msg.role === 'user' && msg.content) {
      // 提取用户主题（截取前 50 字符）
      const topic = msg.content.slice(0, 50).trim();
      if (topic) {
        userTopics.push(topic);
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolsUsed.push(tc.function.name);

        // 提取文件修改
        if (tc.function.name === 'write_file' || tc.function.name === 'edit_file') {
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) {
              filesModified.push(redactTraceText(String(args.path)));
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  // 唯一化
  const uniqueTopics = [...new Set(userTopics)].slice(0, 5);
  const uniqueTools = [...new Set(toolsUsed)];
  const uniqueFiles = [...new Set(filesModified)];

  // 构建摘要
  const maxLen = opts.maxLength || 500;
  let freshSummary = '';
  switch (opts.format) {
    case 'bullet':
      freshSummary = buildBulletSummary(uniqueTopics, uniqueTools, uniqueFiles, maxLen);
      break;

    case 'narrative':
      freshSummary = buildNarrativeSummary(uniqueTopics, uniqueTools, uniqueFiles, maxLen);
      break;

    case 'structured':
      freshSummary = buildStructuredSummary(uniqueTopics, uniqueTools, uniqueFiles, maxLen);
      break;
  }

  return applyCompactGuidance(
    mergeSummaries(prepared.priorSummary, freshSummary, maxLen),
    opts.focus,
    opts.instructions,
    maxLen
  );
}

// ============================================================================
// 摘要格式化
// ============================================================================

function buildBulletSummary(
  topics: string[],
  tools: string[],
  files: string[],
  maxLength: number
): string {
  const lines: string[] = [];

  if (topics.length > 0) {
    lines.push('Discussion topics:');
    for (const t of topics) {
      lines.push(`- ${t}${t.length > 80 ? '...' : ''}`);
    }
  }

  if (tools.length > 0) {
    lines.push(`Tools used: ${tools.join(', ')}`);
  }

  if (files.length > 0) {
    lines.push('Files modified:');
    for (const f of files.slice(0, 10)) {
      lines.push(`- ${f}`);
    }
    if (files.length > 10) {
      lines.push(`- ... and ${files.length - 10} more`);
    }
  }

  const summary = lines.join('\n');
  return summary.length > maxLength ? summary.slice(0, maxLength - 3) + '...' : summary;
}

function buildNarrativeSummary(
  topics: string[],
  tools: string[],
  files: string[],
  maxLength: number
): string {
  const parts: string[] = [];

  if (topics.length > 0) {
    parts.push(`We discussed: ${topics.join('; ')}.`);
  }

  if (tools.length > 0) {
    parts.push(`I used these tools: ${tools.join(', ')}.`);
  }

  if (files.length > 0) {
    parts.push(`I modified files: ${files.slice(0, 5).join(', ')}.`);
  }

  const summary = parts.join(' ');
  return summary.length > maxLength ? summary.slice(0, maxLength - 3) + '...' : summary;
}

function buildStructuredSummary(
  topics: string[],
  tools: string[],
  files: string[],
  maxLength: number
): string {
  const summary = JSON.stringify({
    topics: topics.slice(0, 5),
    tools: tools.slice(0, 10),
    files: files.slice(0, 10),
  });

  return summary.length > maxLength ? summary.slice(0, maxLength - 3) + '...' : summary;
}

// ============================================================================
// 导出
// ============================================================================

export { summaryGenerator as generateSummary };

// ============================================================================
// LLM-driven Summary (生产级摘要)
// ============================================================================

export interface GeneratedSummary {
  text: string;
  source: 'llm' | 'heuristic';
  semanticSummary: CompactSummary;
  diagnostics: SummaryDiagnostic[];
}

export type SummaryDiagnosticCode =
  | 'llm_request_failed'
  | 'llm_empty_response'
  | 'llm_chunked_input'
  | 'heuristic_fallback'
  | 'deterministic_projection';

export interface SummaryDiagnostic {
  code: SummaryDiagnosticCode;
  message: string;
  fallbackUsed: boolean;
  chunkIndex?: number;
  chunkCount?: number;
}

const CONTEXT_SUMMARY_PREFIX = '[Context Summary]\n';
const SUMMARY_CHUNK_CHARS = 7000;

function prepareSummaryInput(messages: Message[]): {
  priorSummary?: string;
  messages: Message[];
} {
  let priorSummary: string | undefined;
  const prepared: Message[] = [];

  for (const message of messages) {
    if (message.content?.startsWith(CONTEXT_SUMMARY_PREFIX)) {
      priorSummary = redactTraceText(message.content.slice(CONTEXT_SUMMARY_PREFIX.length));
      continue;
    }
    if (
      message.role === 'assistant' &&
      message.content ===
        'I understand the context. I will continue the conversation with this background information.'
    ) {
      continue;
    }
    prepared.push({
      ...message,
      content: redactTraceText(message.content ?? ''),
    });
  }

  return { priorSummary, messages: prepared };
}

function compactBothEnds(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const headLength = Math.floor((maxLength - 5) / 2);
  const tailLength = maxLength - 5 - headLength;
  return `${value.slice(0, headLength)} ... ${value.slice(-tailLength)}`;
}

function summaryGroupLine(messages: Message[], groupId: string): string {
  const parts = messages.map(message => {
    const content = compactBothEnds(message.content ?? '', 600);
    const calls = message.tool_calls?.length
      ? ` calls=${message.tool_calls.map(call => `${call.function.name}#${call.id}`).join(',')}`
      : '';
    const resultId = message.tool_call_id ? ` resultFor=${message.tool_call_id}` : '';
    return `[${message.role}${calls}${resultId}] ${content}`;
  });
  return `<group id="${groupId}">\n${parts.join('\n')}\n</group>`;
}

function chunkSummaryLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > SUMMARY_CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    // A single very large group has already had each message compacted at both
    // ends. Keep it whole so the atomic group's tail is not silently dropped.
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function mergeChunkOutputs(outputs: string[], maxLength: number): string {
  if (outputs.length === 1) return truncateSummary(outputs[0], maxLength);
  const separatorBudget = Math.max(0, outputs.length - 1);
  const perChunk = Math.max(1, Math.floor((maxLength - separatorBudget) / outputs.length));
  return truncateSummary(
    outputs.map(output => truncateSummary(output.trim(), perChunk)).join('\n'),
    maxLength
  );
}

export async function generateSummaryWithSource(
  messages: Message[],
  llm: LLMService,
  options?: SummaryOptions
): Promise<GeneratedSummary> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (messages.length === 0) {
    return {
      text: '',
      source: 'heuristic',
      semanticSummary: emptyCompactSummary(),
      diagnostics: [],
    };
  }

  const prepared = prepareSummaryInput(messages);
  const groups = groupMessagesForCompact(prepared.messages);
  const normalizedFocus = normalizeCompactFocus(opts.focus);
  const normalizedInstructions = normalizeCompactInstructions(opts.instructions);
  const semanticSummary = {
    ...extractCompactSummary(groups),
    requestedFocus: normalizedFocus,
    projectInstructions: normalizedInstructions,
  };
  if (groups.length === 0 && prepared.priorSummary) {
    return {
      text: applyCompactGuidance(
        prepared.priorSummary,
        normalizedFocus,
        normalizedInstructions,
        opts.maxLength || 500
      ),
      source: 'heuristic',
      semanticSummary,
      diagnostics: [],
    };
  }

  const chunks = chunkSummaryLines(groups.map(group => summaryGroupLine(group.messages, group.id)));
  const diagnostics: SummaryDiagnostic[] = [];
  if (chunks.length > 1) {
    diagnostics.push({
      code: 'llm_chunked_input',
      message: `Semantic summary covered ${groups.length} groups in ${chunks.length} chunks.`,
      fallbackUsed: false,
      chunkCount: chunks.length,
    });
  }
  const outputs: string[] = [];

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const priorSummarySection =
      chunkIndex === 0 && prepared.priorSummary
        ? `Prior durable summary (merge it with only the new conversation below):\n${prepared.priorSummary}\n\n`
        : '';
    const focusSection = normalizedFocus
      ? `Additional user focus (secondary guidance; never omit constraints, evidence, failures, or pending work):\n${normalizedFocus}\n\n`
      : '';
    const instructionsSection = normalizedInstructions
      ? `Project compact instructions (secondary guidance; never override protocol, safety, criteria, evidence, failures, or pending work):\n${normalizedInstructions}\n\n`
      : '';
    const prompt = `Summarize this complete chunk of a coding-agent conversation. Every group is atomic. Focus on:
1. User's main goal/objective
2. Key actions taken (files modified, commands run)
3. Current state (what's done, what's pending)
4. Any important decisions or constraints mentioned

Keep the summary under ${opts.maxLength || 500} characters. Use bullet points. Do not omit the final group.

${instructionsSection}${focusSection}${priorSummarySection}Conversation chunk ${chunkIndex + 1}/${chunks.length}:
${chunk}

Summary:`;

    try {
      const response = await llm.chat([{ role: 'user', content: prompt }]);
      if (!response.content?.trim()) {
        diagnostics.push({
          code: 'llm_empty_response',
          message: `Summary model returned an empty response for chunk ${chunkIndex + 1}.`,
          fallbackUsed: true,
          chunkIndex,
          chunkCount: chunks.length,
        });
        break;
      }
      outputs.push(response.content.trim());
    } catch (error) {
      diagnostics.push({
        code: 'llm_request_failed',
        message: redactTraceText(error instanceof Error ? error.message : String(error)),
        fallbackUsed: true,
        chunkIndex,
        chunkCount: chunks.length,
      });
      break;
    }
  }

  if (outputs.length === chunks.length && outputs.length > 0) {
    return {
      text: applyCompactGuidance(
        mergeChunkOutputs(outputs, opts.maxLength || 500),
        normalizedFocus,
        normalizedInstructions,
        opts.maxLength || 500
      ),
      source: 'llm',
      semanticSummary,
      diagnostics,
    };
  }

  const freshSummary = await summaryGenerator(prepared.messages, {
    ...options,
    focus: undefined,
    instructions: undefined,
  });
  const maxLength = opts.maxLength || 500;
  diagnostics.push({
    code: 'heuristic_fallback',
    message: 'Used deterministic semantic summary fallback.',
    fallbackUsed: true,
  });
  return {
    text: applyCompactGuidance(
      mergeSummaries(prepared.priorSummary, freshSummary, maxLength),
      normalizedFocus,
      normalizedInstructions,
      maxLength
    ),
    source: 'heuristic',
    semanticSummary,
    diagnostics,
  };
}

/**
 * Generate a summary using the LLM for high-quality context compaction.
 * Falls back to heuristic summary if LLM call fails or times out.
 *
 * @param messages - Messages to summarize
 * @param llm - LLM service instance
 * @param options - Summary options
 * @returns Structured summary string
 */
export async function generateLLMSummary(
  messages: Message[],
  llm: LLMService,
  options?: SummaryOptions
): Promise<string> {
  return (await generateSummaryWithSource(messages, llm, options)).text;
}
