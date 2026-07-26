/**
 * orion code - 快速压缩
 *
 * 不生成摘要，仅保留最近 N 条消息。
 * 用于紧急情况下的快速压缩。
 */

import type { Message } from '../llm';

// ============================================================================
// 快速压缩
// ============================================================================

/**
 * 微压缩：保留最近 10 条消息
 */
export function microCompact(messages: Message[]): Message[] {
  const KEEP_LAST = 10;

  const systemMessage = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const recent = nonSystem.slice(-KEEP_LAST);

  const result: Message[] = [];
  if (systemMessage) {
    result.push(systemMessage);
  }

  // 添加简洁提示
  if (nonSystem.length > KEEP_LAST) {
    result.push({
      role: 'user',
      content: `[Context trimmed] Earlier conversation has been compressed. Please continue.`,
    });
  }

  result.push(...recent);

  return result;
}

/**
 * 超快速压缩：保留最近 5 条 + 保留关键工具调用
 */
export function ultraCompact(messages: Message[]): Message[] {
  const KEEP_LAST = 5;

  const systemMessage = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  // 提取关键工具调用
  const criticalToolCalls: Message[] = [];
  const CRITICAL_TOOLS = ['write_file', 'edit_file', 'exec_command'];

  for (const msg of nonSystem) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      const criticalCalls = msg.tool_calls.filter(tc =>
        CRITICAL_TOOLS.includes(tc.function.name)
      );
      if (criticalCalls.length > 0) {
        criticalToolCalls.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: criticalCalls,
        });
      }
    }
  }

  // 保留最近消息
  const recent = nonSystem.slice(-KEEP_LAST);

  // 构建结果
  const result: Message[] = [];
  if (systemMessage) {
    result.push(systemMessage);
  }

  // 合并关键工具调用和最近消息（去重）
  const merged = [...criticalToolCalls, ...recent];
  const uniqueIds = new Set<string>();

  for (const msg of merged) {
    // 简单去重：基于内容
    const id = `${msg.role}:${msg.content?.slice(0, 50)}`;
    if (!uniqueIds.has(id)) {
      uniqueIds.add(id);
      result.push(msg);
    }
  }

  return result;
}

/**
 * 按角色压缩：保留 system + 最近 user/assistant
 */
export function roleCompact(messages: Message[]): Message[] {
  const systemMessage = messages.find(m => m.role === 'system');

  // 获取最近的 user 和 assistant 消息
  const recentUsers = messages.filter(m => m.role === 'user').slice(-2);
  const recentAssistants = messages.filter(m => m.role === 'assistant').slice(-2);
  const recentTools = messages.filter(m => m.role === 'tool').slice(-4);

  const result: Message[] = [];
  if (systemMessage) {
    result.push(systemMessage);
  }

  // 按时间顺序添加（简化：假设最近顺序）
  result.push(...recentUsers);
  result.push(...recentAssistants);
  result.push(...recentTools);

  return result;
}

// ============================================================================
// 导出
// ============================================================================

export { microCompact as quickCompact };