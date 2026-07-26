/**
 * Orion Code - Auth service
 *
 * Supports OAuth + API Key + AWS STS.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfigDir, ensureConfigDir } from '../config-dir';

// ============================================================================
// 类型定义
// ============================================================================

export interface AuthConfig {
  /** API Key 认证 */
  apiKey?: ApiKeyAuth;
  /** OAuth 认证 */
  oauth?: OAuthAuth;
  /** AWS 认证 */
  aws?: AwsAuth;
}

export interface ApiKeyAuth {
  /** API Key */
  key: string;
  /** 来源（'env' | 'file' | 'user'） */
  source: 'env' | 'file' | 'user';
  /** 创建时间 */
  createdAt?: number;
}

export interface OAuthAuth {
  /** Access Token */
  accessToken: string;
  /** Refresh Token */
  refreshToken?: string;
  /** 过期时间 */
  expiresAt?: number;
  /** Provider（'anthropic' | 'openai' | 'google'） */
  provider: string;
}

export interface AwsAuth {
  /** Access Key ID */
  accessKeyId?: string;
  /** Secret Access Key */
  secretAccessKey?: string;
  /** Session Token */
  sessionToken?: string;
  /** Region */
  region?: string;
  /** Profile */
  profile?: string;
}

// ============================================================================
// Auth Service
// ============================================================================

export class AuthService {
  private config: AuthConfig | null = null;
  private configPath: string;

  constructor() {
    ensureConfigDir();
    this.configPath = join(getConfigDir(), 'auth.json');
    this.load();
  }

  /**
   * 加载认证配置
   */
  private load(): void {
    if (!existsSync(this.configPath)) {
      this.config = {};
      return;
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(content);
    } catch {
      this.config = {};
    }
  }

  /**
   * 保存认证配置
   */
  private save(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), {
      mode: 0o600,  // 仅用户可读写
    });
  }

  /**
   * 设置 API Key
   */
  setApiKey(key: string, source: 'env' | 'file' | 'user' = 'user'): void {
    if (!this.config) this.config = {};

    this.config.apiKey = {
      key,
      source,
      createdAt: Date.now(),
    };

    this.save();
  }

  /**
   * 获取 API Key
   */
  getApiKey(): string | null {
    // 1. 从环境变量获取
    const envKey = process.env.ORION_CODE_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      return envKey;
    }

    // 2. 从配置文件获取
    if (this.config?.apiKey?.key) {
      return this.config.apiKey.key;
    }

    return null;
  }

  /**
   * 设置 OAuth Token
   */
  setOAuthToken(
    provider: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number
  ): void {
    if (!this.config) this.config = {};

    this.config.oauth = {
      provider,
      accessToken,
      refreshToken,
      expiresAt,
    };

    this.save();
  }

  /**
   * 获取 OAuth Token
   */
  getOAuthToken(): OAuthAuth | null {
    if (!this.config?.oauth) {
      return null;
    }

    // 检查是否过期
    if (this.config.oauth.expiresAt && Date.now() > this.config.oauth.expiresAt) {
      return null;
    }

    return this.config.oauth;
  }

  /**
   * 设置 AWS 认证
   */
  setAwsAuth(profile: string, region?: string): void {
    if (!this.config) this.config = {};

    this.config.aws = {
      profile,
      region: region || 'us-east-1',
    };

    this.save();
  }

  /**
   * 获取 AWS 认证
   */
  getAwsAuth(): AwsAuth | null {
    return this.config?.aws || null;
  }

  /**
   * 清除所有认证
   */
  clear(): void {
    this.config = {};
    this.save();
  }

  /**
   * 检查是否已认证
   */
  isAuthenticated(): boolean {
    return !!this.getApiKey() || !!this.getOAuthToken() || !!this.getAwsAuth();
  }

  /**
   * 获取认证状态
   */
  getStatus(): {
    hasApiKey: boolean;
    hasOAuth: boolean;
    hasAws: boolean;
    apiKeySource?: string;
    oauthProvider?: string;
    awsProfile?: string;
  } {
    return {
      hasApiKey: !!this.getApiKey(),
      hasOAuth: !!this.getOAuthToken(),
      hasAws: !!this.getAwsAuth(),
      apiKeySource: this.config?.apiKey?.source,
      oauthProvider: this.config?.oauth?.provider,
      awsProfile: this.config?.aws?.profile,
    };
  }
}

// ============================================================================
// Secure Storage (macOS Keychain)
// ============================================================================

/**
 * macOS Keychain 安全存储
 * 注意：这是简化实现，实际需要调用 security 命令
 */
export class SecureStorage {
  /**
   * 存储到 Keychain
   */
  async store(service: string, account: string, password: string): Promise<boolean> {
    // macOS: security add-generic-password
    try {
      // 简化实现：存储到加密文件
      const storagePath = join(getConfigDir(), 'secure.json');
      const content = existsSync(storagePath)
        ? JSON.parse(readFileSync(storagePath, 'utf-8'))
        : {};

      content[`${service}:${account}`] = password;
      writeFileSync(storagePath, JSON.stringify(content), { mode: 0o600 });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从 Keychain 获取
   */
  async retrieve(service: string, account: string): Promise<string | null> {
    try {
      const storagePath = join(getConfigDir(), 'secure.json');
      if (!existsSync(storagePath)) {
        return null;
      }

      const content = JSON.parse(readFileSync(storagePath, 'utf-8'));
      return content[`${service}:${account}`] || null;
    } catch {
      return null;
    }
  }

  /**
   * 从 Keychain 删除
   */
  async delete(service: string, account: string): Promise<boolean> {
    try {
      const storagePath = join(getConfigDir(), 'secure.json');
      if (!existsSync(storagePath)) {
        return true;
      }

      const content = JSON.parse(readFileSync(storagePath, 'utf-8'));
      delete content[`${service}:${account}`];
      writeFileSync(storagePath, JSON.stringify(content), { mode: 0o600 });

      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// 单例
// ============================================================================

let authService: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!authService) {
    authService = new AuthService();
  }
  return authService;
}

export function resetAuthService(): void {
  authService = null;
}

let secureStorage: SecureStorage | null = null;

export function getSecureStorage(): SecureStorage {
  if (!secureStorage) {
    secureStorage = new SecureStorage();
  }
  return secureStorage;
}