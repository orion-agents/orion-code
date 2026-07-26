/**
 * orion code - Session Memory 提示模板
 *
 * 用于生成会话摘要和记忆的提示词。
 */

// ============================================================================
// 提示模板
// ============================================================================

/**
 * 生成会话摘要提示
 */
export function generateSessionSummaryPrompt(
  entries: Array<{
    topic: string;
    actions: string[];
    filesModified: string[];
  }>
): string {
  if (entries.length === 0) {
    return 'No significant activities in this session.';
  }

  const lines: string[] = [];

  lines.push('Please summarize the following session activities:');
  lines.push('');

  for (const entry of entries.slice(-10)) {
    lines.push(`Topic: ${entry.topic}`);
    if (entry.actions.length > 0) {
      lines.push(`Actions: ${entry.actions.join(', ')}`);
    }
    if (entry.filesModified.length > 0) {
      lines.push(`Files: ${entry.filesModified.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('Provide a brief summary (2-3 sentences) of what was accomplished.');

  return lines.join('\n');
}

/**
 * 生成记忆提取提示
 */
export function generateMemoryExtractionPrompt(content: string): string {
  return `Extract key information from the following content for session memory:

${content}

Extract:
1. Main topics discussed
2. Key decisions made
3. Files modified
4. Open questions or follow-ups

Format as JSON.`;
}

/**
 * 生成上下文压缩提示
 */
export function generateContextCompressionPrompt(
  oldMessages: string
): string {
  return `Summarize the following conversation history into a concise summary that preserves key context:

${oldMessages}

Requirements:
- Keep important decisions and their reasons
- Preserve key file modifications
- Note any open questions or pending tasks
- Be concise (under 300 words)`;
}

// ============================================================================
// 导出
// ============================================================================

export {
  generateSessionSummaryPrompt as summaryPrompt,
  generateMemoryExtractionPrompt as extractionPrompt,
  generateContextCompressionPrompt as compressionPrompt,
};