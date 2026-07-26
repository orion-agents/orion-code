/**
 * orion code - Session Memory 服务入口
 */

export {
  SessionMemory,
  getSessionMemory,
  resetSessionMemory,
  type SessionMemoryConfig,
  type SessionMemoryEntry,
} from './sessionMemory';

export {
  generateSessionSummaryPrompt,
  generateMemoryExtractionPrompt,
  generateContextCompressionPrompt,
} from './prompts';