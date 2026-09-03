/**
 * Orion Code - Auth service
 *
 * Supports OAuth + API Key + AWS STS.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { join } from 'path';
import { getConfigDir, ensureConfigDir } from '../config-dir';
import { atomicWriteFileSync } from '../atomic-write';
import { debugError } from '../../utils/debug-log';

/**
 * Credential files are the least recoverable state Orion Code owns: a torn
 * write makes `JSON.parse` fail, and the loaders fall back to `{}`, which
 * silently logs the user out and drops every stored secret. Write them via
 * temp-file + rename with an fsync, so a crash leaves either the previous file
 * or the complete new one.
 */
const CREDENTIAL_WRITE_OPTS = { mode: 0o600, fsync: true } as const;

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
  /** Optional expiration for temporary credentials (ISO-8601). */
  expiration?: string;
  /** Region */
  region?: string;
  /** Profile */
  profile?: string;
  /** Optional role to assume when temporary role credentials are required. */
  roleArn?: string;
  /** STS role session name. */
  roleSessionName?: string;
  /** Optional external ID required by the target role trust policy. */
  externalId?: string;
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
    } catch (error) {
      // A corrupt auth.json must not brick startup, but resetting to an empty
      // config silently logs the user out — that needs to be diagnosable.
      debugError('auth.load', error, this.configPath);
      this.config = {};
    }
  }

  /**
   * 保存认证配置
   */
  private save(): void {
    atomicWriteFileSync(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      CREDENTIAL_WRITE_OPTS // 0600，仅用户可读写；原子写避免半截文件
    );
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
// Encrypted-at-rest credential storage
// ============================================================================

/**
 * Encrypted credential store (AES-256-GCM).
 *
 * The previous "SecureStorage" wrote credentials to `secure.json` in *plain
 * text*, which is a confidentiality hole: a backup, a stray `cat`, or a leaked
 * dotfile sync exposes every stored secret. Plaintext is never written to disk
 * now — the credential map is sealed with AES-256-GCM before it touches the
 * filesystem.
 *
 * Key management: a 256-bit key is generated once per config directory and kept
 * in `secure.key` (mode 0600, alongside `secure.json`). This makes `secure.json`
 * useless on its own (the realistic leak/backup scenario) — it cannot be
 * decrypted without `secure.key`. The key file itself is not secret against an
 * attacker who already owns the machine, so the strong option remains a real OS
 * keychain (macOS Keychain / libsecret); this implementation is the portable,
 * dependency-free improvement that closes the plaintext exposure (issue #66).
 */
const SECURE_KEY_FILE = 'secure.key';
const SECURE_DATA_FILE = 'secure.json';
const KEY_BYTES = 32;

interface EncryptedBlob {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function secureKeyPath(): string {
  return join(getConfigDir(), SECURE_KEY_FILE);
}

function loadOrCreateKey(): Buffer {
  const keyPath = secureKeyPath();
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }
  const key = randomBytes(KEY_BYTES);
  // Generated once; atomicity is not critical here. Keep it 0600 so it is not
  // world-readable like a stray file might be.
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function encryptMap(plain: Record<string, string>, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf-8'), cipher.final()]);
  const blob: EncryptedBlob = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
  return JSON.stringify(blob);
}

function decryptMap(blob: string, key: Buffer): Record<string, string> | null {
  try {
    const parsed = JSON.parse(blob) as EncryptedBlob;
    if (parsed.v !== 1) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
    return JSON.parse(plaintext) as Record<string, string>;
  } catch {
    // A corrupt or tampered blob is indistinguishable from "no credentials"
    // to the caller, which is the confusing case — log it upstream.
    return null;
  }
}

function readCredentialMap(): Record<string, string> {
  const storagePath = join(getConfigDir(), SECURE_DATA_FILE);
  if (!existsSync(storagePath)) {
    // No file yet: a fresh, empty map. Storing/deleting is safe to proceed.
    return {};
  }
  const key = loadOrCreateKey();
  const map = decryptMap(readFileSync(storagePath, 'utf-8'), key);
  if (map === null) {
    // The file exists but cannot be decrypted (corrupt/tampered/wrong key).
    // Distinguish this from "no credentials": if we returned {} here, store()
    // and delete() would silently overwrite the file with an empty map and
    // wipe every credential we couldn't read. Instead, surface the failure so
    // the caller's try/catch returns false (safe failure) rather than erasing
    // data. retrieve() still returns null, which is the correct "can't read".
    throw new Error('secure storage file exists but is corrupt or unreadable');
  }
  return map;
}

function writeCredentialMap(map: Record<string, string>): void {
  const storagePath = join(getConfigDir(), SECURE_DATA_FILE);
  const key = loadOrCreateKey();
  // Read-modify-write over the whole file: a torn write here loses *every*
  // stored secret, not just the one being added.
  atomicWriteFileSync(storagePath, encryptMap(map, key), CREDENTIAL_WRITE_OPTS);
}

export class SecureStorage {
  /**
   * Store a credential, encrypted at rest.
   */
  async store(service: string, account: string, password: string): Promise<boolean> {
    try {
      const map = readCredentialMap();
      map[`${service}:${account}`] = password;
      writeCredentialMap(map);
      return true;
    } catch (error) {
      // The caller only sees `false`; without this the reason a credential
      // failed to persist (permissions, disk full) is lost entirely.
      debugError('auth.store', error, `${service}:${account}`);
      return false;
    }
  }

  /**
   * Retrieve a credential (decrypted from disk).
   */
  async retrieve(service: string, account: string): Promise<string | null> {
    try {
      const map = readCredentialMap();
      return map[`${service}:${account}`] ?? null;
    } catch (error) {
      // A parse/decrypt failure here is indistinguishable from "no credential
      // stored" to the caller, which is exactly the confusing case.
      debugError('auth.retrieve', error, `${service}:${account}`);
      return null;
    }
  }

  /**
   * Delete a credential.
   */
  async delete(service: string, account: string): Promise<boolean> {
    try {
      const map = readCredentialMap();
      delete map[`${service}:${account}`];
      writeCredentialMap(map);
      return true;
    } catch (error) {
      // A failed delete leaves the secret on disk — the most security
      // relevant of the three, so it must never be silent.
      debugError('auth.delete', error, `${service}:${account}`);
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
