/**
 * orion code - AWS STS 验证
 *
 * 验证 AWS 凭证并获取临时 Token。
 */

import { execFile } from 'child_process';
import type { AwsAuth } from './auth';

// ============================================================================
// AWS STS 验证
// ============================================================================

export interface StsResult {
  success: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  expiration?: string;
  error?: string;
}

interface AwsCredentialContext {
  profileArgs: string[];
  env: NodeJS.ProcessEnv;
  error?: string;
}

function validateExpiration(value: string | undefined, source: string): string | undefined {
  if (!value) return undefined;
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) return `${source} credential expiration is invalid`;
  if (expiresAt <= Date.now()) return `${source} credentials have expired`;
  return undefined;
}

/** Resolve credentials without silently falling through a partial/expired source. */
function resolveCredentialContext(auth: AwsAuth): AwsCredentialContext {
  const env = { ...process.env };
  const envAccessKey = process.env.AWS_ACCESS_KEY_ID;
  const envSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const envToken = process.env.AWS_SESSION_TOKEN;
  const hasAnyEnvCredential = Boolean(envAccessKey || envSecret || envToken);

  if (hasAnyEnvCredential) {
    if (!envAccessKey || !envSecret) {
      return {
        profileArgs: [],
        env,
        error: 'AWS environment credentials are incomplete',
      };
    }
    const expirationError = validateExpiration(
      process.env.AWS_CREDENTIAL_EXPIRATION,
      'AWS environment'
    );
    return { profileArgs: [], env, error: expirationError };
  }

  const hasAnyAuthCredential = Boolean(
    auth.accessKeyId || auth.secretAccessKey || auth.sessionToken
  );
  if (hasAnyAuthCredential) {
    if (!auth.accessKeyId || !auth.secretAccessKey) {
      return { profileArgs: [], env, error: 'Configured AWS credentials are incomplete' };
    }
    const expirationError = validateExpiration(auth.expiration, 'Configured AWS');
    if (expirationError) return { profileArgs: [], env, error: expirationError };
    env.AWS_ACCESS_KEY_ID = auth.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = auth.secretAccessKey;
    if (auth.sessionToken) env.AWS_SESSION_TOKEN = auth.sessionToken;
    return { profileArgs: [], env };
  }

  return {
    profileArgs: auth.profile ? ['--profile', auth.profile] : [],
    env,
  };
}

function credentialsFromResponse(value: unknown): StsResult {
  if (!value || typeof value !== 'object') {
    return { success: false, error: 'STS response is missing Credentials' };
  }
  const credentials = value as Record<string, unknown>;
  if (
    typeof credentials.AccessKeyId !== 'string' ||
    typeof credentials.SecretAccessKey !== 'string' ||
    typeof credentials.SessionToken !== 'string' ||
    typeof credentials.Expiration !== 'string'
  ) {
    return { success: false, error: 'STS response contains invalid temporary credentials' };
  }
  const expirationError = validateExpiration(credentials.Expiration, 'STS');
  if (expirationError) return { success: false, error: expirationError };
  return {
    success: true,
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
}

/**
 * 验证 AWS 凭证
 */
export async function verifyAwsCredentials(auth: AwsAuth): Promise<StsResult> {
  const credentialContext = resolveCredentialContext(auth);
  if (credentialContext.error) return { success: false, error: credentialContext.error };
  // 尝试调用 AWS CLI
  return new Promise((resolve) => {
    const region = auth.region || 'us-east-1';

    execFile('aws', [
      'sts',
      'get-caller-identity',
      ...credentialContext.profileArgs,
      '--region', region,
      '--output', 'json',
    ], {
      timeout: 10000,
      env: credentialContext.env,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          error: stderr.toString() || error.message,
        });
        return;
      }

      try {
        const result = JSON.parse(stdout.toString());
        if (!result || typeof result.Arn !== 'string') {
          resolve({ success: false, error: 'AWS identity response is missing Arn' });
          return;
        }
        resolve({
          success: true,
          // get-caller-identity 不返回凭证，仅验证身份
          accessKeyId: result.Arn?.split(':')[4]?.split('/')[1],
        });
      } catch {
        resolve({
          success: false,
          error: 'Failed to parse AWS response',
        });
      }
    });
  });
}

/**
 * 获取临时 STS Token
 */
export async function getStsToken(
  auth: AwsAuth,
  durationSeconds: number = 3600
): Promise<StsResult> {
  if (auth.roleArn) return assumeAwsRole(auth, auth.roleArn, durationSeconds);
  const credentialContext = resolveCredentialContext(auth);
  if (credentialContext.error) return { success: false, error: credentialContext.error };
  return new Promise((resolve) => {
    const region = auth.region || 'us-east-1';

    execFile('aws', [
      'sts',
      'get-session-token',
      ...credentialContext.profileArgs,
      '--region', region,
      '--duration-seconds', String(durationSeconds),
      '--output', 'json',
    ], {
      timeout: 15000,
      env: credentialContext.env,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          error: stderr.toString() || error.message,
        });
        return;
      }

      try {
        const result = JSON.parse(stdout.toString());
        resolve(credentialsFromResponse(result.Credentials));
      } catch {
        resolve({
          success: false,
          error: 'Failed to parse STS response',
        });
      }
    });
  });
}

/** Assume an IAM role and return its validated temporary credentials. */
export async function assumeAwsRole(
  auth: AwsAuth,
  roleArn: string,
  durationSeconds: number = 3600
): Promise<StsResult> {
  if (!roleArn.trim()) return { success: false, error: 'AWS role ARN is required' };
  const credentialContext = resolveCredentialContext(auth);
  if (credentialContext.error) return { success: false, error: credentialContext.error };
  const region = auth.region || 'us-east-1';
  const sessionName = auth.roleSessionName || `orion-code-${process.pid}`;
  const externalIdArgs = auth.externalId ? ['--external-id', auth.externalId] : [];

  return new Promise(resolve => {
    execFile('aws', [
      'sts',
      'assume-role',
      '--role-arn', roleArn,
      '--role-session-name', sessionName,
      ...externalIdArgs,
      ...credentialContext.profileArgs,
      '--region', region,
      '--duration-seconds', String(durationSeconds),
      '--output', 'json',
    ], {
      timeout: 15000,
      env: credentialContext.env,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr.toString() || error.message });
        return;
      }
      try {
        const result = JSON.parse(stdout.toString());
        resolve(credentialsFromResponse(result.Credentials));
      } catch {
        resolve({ success: false, error: 'Failed to parse STS response' });
      }
    });
  });
}

/**
 * 检测 AWS CLI 是否可用
 */
export async function checkAwsCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('aws', ['--version'], {
      timeout: 5000,
    }, (error) => {
      resolve(!error);
    });
  });
}
