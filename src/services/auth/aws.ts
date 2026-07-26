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

/**
 * 验证 AWS 凭证
 */
export async function verifyAwsCredentials(auth: AwsAuth): Promise<StsResult> {
  // 尝试调用 AWS CLI
  return new Promise((resolve) => {
    const profile = auth.profile || 'default';
    const region = auth.region || 'us-east-1';

    execFile('aws', [
      'sts',
      'get-caller-identity',
      '--profile', profile,
      '--region', region,
      '--output', 'json',
    ], {
      timeout: 10000,
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
  return new Promise((resolve) => {
    const profile = auth.profile || 'default';
    const region = auth.region || 'us-east-1';

    execFile('aws', [
      'sts',
      'get-session-token',
      '--profile', profile,
      '--region', region,
      '--duration-seconds', String(durationSeconds),
      '--output', 'json',
    ], {
      timeout: 15000,
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
        const credentials = result.Credentials;

        resolve({
          success: true,
          accessKeyId: credentials.AccessKeyId,
          secretAccessKey: credentials.SecretAccessKey,
          sessionToken: credentials.SessionToken,
          expiration: credentials.Expiration,
        });
      } catch {
        resolve({
          success: false,
          error: 'Failed to parse STS response',
        });
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