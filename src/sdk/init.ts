/**
 * orion code - SDK Init
 *
 * v0.1.11: SDK 初始化函数
 */

import type { SDKConfig } from './types';

let globalConfig: SDKConfig | null = null;

/**
 * 初始化 Orion Code SDK
 * @param config - SDK 配置
 */
export function init(config?: SDKConfig): void {
  globalConfig = {
    projectRoot: config?.projectRoot || process.cwd(),
    model: config?.model || 'default',
    mode: config?.mode || 'development',
    debug: config?.debug || false,
  };

  // Ensure memory directory exists
  if (globalConfig.projectRoot) {
    const { ensureMemoryDir } = require('../memory/storage');
    ensureMemoryDir(globalConfig.projectRoot);
  }
}

/**
 * 获取当前 SDK 配置
 */
export function getConfig(): SDKConfig | null {
  return globalConfig;
}

/**
 * 检查 SDK 是否已初始化
 */
export function isInitialized(): boolean {
  return globalConfig !== null;
}

/**
 * 重置 SDK 配置
 */
export function reset(): void {
  globalConfig = null;
}