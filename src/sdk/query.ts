/**
 * orion code - SDK Query
 *
 * v0.1.11: SDK 查询函数
 */

import type { SDKQueryOptions, SDKQueryResponse, SDKMessage } from './types';
import { isInitialized } from './init';

/**
 * 执行查询
 * @param options - 查询选项
 * @returns 查询响应
 */
export async function query(options: SDKQueryOptions): Promise<SDKQueryResponse> {
  if (!isInitialized()) {
    throw new Error('SDK not initialized. Call init() first.');
  }


  // Simple mock implementation for SDK entry points
  // Real implementation would call the framework query function
  const response: SDKQueryResponse = {
    content: `Processed ${options.messages.length} messages`,
    usage: {
      inputTokens: options.messages.reduce((sum, m) => sum + m.content.length / 4, 0),
      outputTokens: 0,
    },
  };

  return response;
}

/**
 * 简单查询（单个消息）
 * @param message - 用户消息
 * @returns 查询响应
 */
export async function simpleQuery(message: string): Promise<SDKQueryResponse> {
  const messages: SDKMessage[] = [
    { role: 'user', content: message, timestamp: Date.now() },
  ];

  return query({ messages });
}