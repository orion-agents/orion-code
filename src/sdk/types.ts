/**
 * orion code - SDK Types
 *
 * v0.1.11: SDK 类型定义
 */

// ============================================================================
// SDK Types
// ============================================================================

export interface SDKConfig {
  projectRoot?: string;
  model?: string;
  mode?: 'development' | 'production';
  debug?: boolean;
}

export interface SDKMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

export interface SDKSessionInfo {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  projectRoot?: string;
}

export interface SDKToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface SDKQueryOptions {
  messages: SDKMessage[];
  tools?: string[];
  maxTokens?: number;
  stream?: boolean;
}

export interface SDKQueryResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: SDKToolResult;
  }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}