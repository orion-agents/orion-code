/**
 * orion code - 记忆相关性查找
 *
 * v0.1.11: 基于关键词匹配相关记忆，返回排序结果，最多 5 条
 *
 * 提供关键词提取、相似度计算、结果排序功能
 */

import { loadAllMemories, type MemoryEntry } from './storage';

// ============================================================================
// Types
// ============================================================================

export interface RelevantMemoryResult {
  memory: MemoryEntry;
  score: number;
  matchedKeywords: string[];
}

export interface KeywordMatchOptions {
  maxResults?: number; // 最大返回数量，默认 5
  minScore?: number; // 最小相似度阈值，默认 0.1
  caseSensitive?: boolean; // 是否大小写敏感，默认 false
}

// ============================================================================
// Keyword Extraction
// ============================================================================

/**
 * 从文本中提取关键词
 * @param text - 输入文本
 * @param preserveCase - 保留原始大小写（供 caseSensitive 匹配使用），默认 false
 * @returns 关键词列表
 */
export function extractKeywords(text: string, preserveCase: boolean = false): string[] {
  if (!text) return [];

  // 分词：按空格和标点分割。
  //
  // `-` 必须放在字符类末尾（或转义）。写成 `+-_` 会被正则引擎解析为 `+`(0x2B)
  // 到 `_`(0x5F) 的**区间**，于是 0-9、A-Z、`_` 全被当成分隔符，`API_KEY_V2`
  // / `port_8000` 这类标识符被切碎，关键词召回严重退化。
  //
  // 大小写：默认小写化。此前**无条件**小写化，导致 caseSensitive 选项失效
  // ——比较双方都来自本函数，两个分支恒等价。
  const words = (preserveCase ? text : text.toLowerCase())
    .split(/[\s,.;:!?'"(){}[\]<>=+_|\\/@#$%^&*-]+/)
    .filter(w => w.length >= 2);

  // 去除常见停用词
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'from',
    'as',
    'is',
    'was',
    'are',
    'were',
    'been',
    'be',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'must',
    'can',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'they',
    'them',
    'their',
    'we',
    'our',
    'you',
    'your',
    'he',
    'him',
    'his',
    'she',
    'her',
    'i',
    'me',
    'my',
    'not',
    'no',
    'yes',
    'all',
    'any',
    'some',
    'each',
    'every',
    'both',
    'few',
    'many',
    'more',
    'most',
    'other',
    'another',
    'such',
    'only',
    'own',
    'same',
    'so',
    'than',
    'too',
    'very',
    'just',
    'also',
    'now',
    'then',
    'here',
    'there',
    'when',
    'where',
    'why',
    'how',
    'what',
    'which',
    'who',
    'whom',
    'whose',
    'if',
    'else',
    'then',
    'because',
    'since',
    'although',
    'though',
    'while',
    'during',
    'before',
    'after',
    'until',
    'above',
    'below',
    'between',
    'under',
    'over',
    'out',
    'into',
    'onto',
    'about',
    'against',
    'through',
    'across',
    'along',
    'around',
    'again',
  ]);

  // 停用词过滤始终大小写不敏感，否则 preserveCase 模式下 "The"/"And" 会漏过。
  return words.filter(w => !stopWords.has(preserveCase ? w.toLowerCase() : w));
}

// ============================================================================
// Similarity Calculation
// ============================================================================

/**
 * 计算关键词匹配相似度
 * @param queryKeywords - 查询关键词
 * @param memoryEntry - 记忆条目
 * @param caseSensitive - 是否大小写敏感
 * @returns 相似度分数和匹配的关键词
 */
export function calculateKeywordMatch(
  queryKeywords: string[],
  memoryEntry: MemoryEntry,
  caseSensitive: boolean = false
): { score: number; matchedKeywords: string[] } {
  if (queryKeywords.length === 0) return { score: 0, matchedKeywords: [] };

  // 从记忆中提取内容关键词
  const memoryText = [
    memoryEntry.name,
    memoryEntry.description,
    memoryEntry.content,
    memoryEntry.type,
  ].join(' ');

  const memoryKeywords = extractKeywords(memoryText, caseSensitive);

  const matchedKeywords: string[] = [];
  let matchCount = 0;

  for (const qk of queryKeywords) {
    const compareQk = caseSensitive ? qk : qk.toLowerCase();

    for (const mk of memoryKeywords) {
      const compareMk = caseSensitive ? mk : mk.toLowerCase();

      // 精确匹配或部分匹配（包含关系）
      if (
        compareMk === compareQk ||
        compareMk.includes(compareQk) ||
        compareQk.includes(compareMk)
      ) {
        matchedKeywords.push(qk);
        matchCount++;
        break;
      }
    }
  }

  // 计算相似度分数：匹配数量 / 查询关键词数量
  const score = matchCount / queryKeywords.length;

  return { score, matchedKeywords };
}

// ============================================================================
// Relevant Memory Finder
// ============================================================================

/**
 * 查找相关记忆
 * @param query - 查询文本
 * @param projectPath - 项目路径
 * @param options - 匹配选项
 * @returns 相关记忆列表，按相似度排序
 */
export function findRelevantMemories(
  query: string,
  projectPath?: string,
  options?: KeywordMatchOptions
): RelevantMemoryResult[] {
  const maxResults = options?.maxResults ?? 5;
  const minScore = options?.minScore ?? 0.1;
  const caseSensitive = options?.caseSensitive ?? false;

  if (!query) return [];

  // 提取查询关键词（caseSensitive 时保留原始大小写，两侧一致才有意义）
  const queryKeywords = extractKeywords(query, caseSensitive);
  if (queryKeywords.length === 0) return [];

  // 加载所有记忆
  const memories = loadAllMemories(projectPath);
  if (memories.length === 0) return [];

  // 计算每个记忆的相似度
  const results: RelevantMemoryResult[] = [];

  for (const memory of memories) {
    const { score, matchedKeywords } = calculateKeywordMatch(queryKeywords, memory, caseSensitive);

    if (score >= minScore) {
      results.push({
        memory,
        score,
        matchedKeywords,
      });
    }
  }

  // 按相似度降序排序
  results.sort((a, b) => b.score - a.score);

  // 返回前 maxResults 条
  return results.slice(0, maxResults);
}

/**
 * 格式化相关记忆结果为字符串
 */
export function formatRelevantMemories(results: RelevantMemoryResult[]): string {
  if (results.length === 0) return 'No relevant memories found';

  const lines: string[] = [];
  lines.push(`Found ${results.length} relevant memories:`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.memory.name} (${r.memory.type}) - score: ${r.score.toFixed(2)}`);
    lines.push(`   Keywords matched: ${r.matchedKeywords.slice(0, 5).join(', ')}`);
    lines.push(`   Description: ${r.memory.description}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Export
// ============================================================================

export const RELEVANT_MEMORY_FINDER = {
  extractKeywords,
  calculateKeywordMatch,
  findRelevantMemories,
  formatRelevantMemories,
};
