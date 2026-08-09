jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import { execFile } from 'child_process';
import {
  assumeAwsRole,
  checkAwsCliAvailable,
  getStsToken,
  verifyAwsCredentials,
} from '../src/services/auth/aws';

const execFileMock = execFile as jest.MockedFunction<typeof execFile>;
const AWS_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
] as const;
const originalAwsEnv = Object.fromEntries(AWS_ENV_KEYS.map(key => [key, process.env[key]]));

function respond(stdout: unknown, stderr = '', error: Error | null = null): void {
  execFileMock.mockImplementationOnce(((
    _file: string,
    _args: string[],
    _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    callback(error, typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr);
    return {};
  }) as typeof execFile);
}

function validCredentials(expiration = '2099-01-01T00:00:00.000Z') {
  return {
    Credentials: {
      AccessKeyId: 'TEMP_ACCESS_KEY',
      SecretAccessKey: 'temporary-secret',
      SessionToken: 'temporary-session',
      Expiration: expiration,
    },
  };
}

describe('AWS auth command boundary', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    for (const key of AWS_ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const key of AWS_ENV_KEYS) {
      const value = originalAwsEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prefers complete environment credentials over a configured profile', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'ENV_ACCESS_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'environment-secret';
    process.env.AWS_SESSION_TOKEN = 'environment-session';
    respond({ Arn: 'arn:aws:iam::123456789012:user/test' });

    await expect(verifyAwsCredentials({ profile: 'ignored', region: 'eu-west-1' })).resolves
      .toMatchObject({ success: true });

    const [, args, options] = execFileMock.mock.calls[0];
    expect(args).not.toContain('--profile');
    expect(options).toMatchObject({
      env: expect.objectContaining({
        AWS_ACCESS_KEY_ID: 'ENV_ACCESS_KEY',
        AWS_SECRET_ACCESS_KEY: 'environment-secret',
        AWS_SESSION_TOKEN: 'environment-session',
      }),
    });
  });

  it('uses a profile when no direct credentials are present', async () => {
    respond({ Arn: 'arn:aws:iam::123456789012:user/test' });

    await verifyAwsCredentials({ profile: 'team', region: 'ap-southeast-1' });

    expect(execFileMock.mock.calls[0][1]).toEqual([
      'sts',
      'get-caller-identity',
      '--profile',
      'team',
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
    ]);
  });

  it('passes configured credentials through a child-only environment without a profile', async () => {
    respond({ Arn: 'arn:aws:iam::123456789012:user/test' });

    await verifyAwsCredentials({
      accessKeyId: 'CONFIG_ACCESS_KEY',
      secretAccessKey: 'configured-secret',
      sessionToken: 'configured-session',
      profile: 'ignored',
    });

    const [, args, options] = execFileMock.mock.calls[0];
    expect(args).not.toContain('--profile');
    expect(options).toMatchObject({
      env: expect.objectContaining({ AWS_ACCESS_KEY_ID: 'CONFIG_ACCESS_KEY' }),
    });
  });

  it('fails closed on incomplete or expired credentials without invoking AWS CLI', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'PARTIAL';
    await expect(verifyAwsCredentials({ profile: 'must-not-fallback' })).resolves.toEqual({
      success: false,
      error: 'AWS environment credentials are incomplete',
    });

    delete process.env.AWS_ACCESS_KEY_ID;
    await expect(verifyAwsCredentials({
      accessKeyId: 'EXPIRED',
      secretAccessKey: 'expired-secret',
      sessionToken: 'expired-token',
      expiration: '2000-01-01T00:00:00.000Z',
      profile: 'must-not-fallback',
    })).resolves.toEqual({
      success: false,
      error: 'Configured AWS credentials have expired',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns explicit verification errors for CLI and malformed identity failures', async () => {
    respond('', 'expired security token', new Error('exit 255'));
    await expect(verifyAwsCredentials({ profile: 'bad' })).resolves.toEqual({
      success: false,
      error: 'expired security token',
    });

    respond({ Account: '123456789012' });
    await expect(verifyAwsCredentials({ profile: 'bad-json-shape' })).resolves.toEqual({
      success: false,
      error: 'AWS identity response is missing Arn',
    });
  });

  it('returns validated session credentials and rejects expired STS output', async () => {
    respond(validCredentials());
    await expect(getStsToken({ profile: 'team' }, 1800)).resolves.toMatchObject({
      success: true,
      accessKeyId: 'TEMP_ACCESS_KEY',
      secretAccessKey: 'temporary-secret',
      sessionToken: 'temporary-session',
    });

    respond(validCredentials('2000-01-01T00:00:00.000Z'));
    await expect(getStsToken({ profile: 'team' })).resolves.toEqual({
      success: false,
      error: 'STS credentials have expired',
    });
  });

  it('assumes a role with the selected source credentials and returns temporary credentials', async () => {
    respond(validCredentials());

    await expect(assumeAwsRole({
      profile: 'source-profile',
      roleSessionName: 'orion-test',
      externalId: 'external-test',
    }, 'arn:aws:iam::123456789012:role/TestRole', 900)).resolves.toMatchObject({
      success: true,
      accessKeyId: 'TEMP_ACCESS_KEY',
    });

    expect(execFileMock.mock.calls[0][1]).toEqual([
      'sts',
      'assume-role',
      '--role-arn',
      'arn:aws:iam::123456789012:role/TestRole',
      '--role-session-name',
      'orion-test',
      '--external-id',
      'external-test',
      '--profile',
      'source-profile',
      '--region',
      'us-east-1',
      '--duration-seconds',
      '900',
      '--output',
      'json',
    ]);
  });

  it('routes role-backed getStsToken calls through assume-role', async () => {
    respond(validCredentials());

    await getStsToken({
      roleArn: 'arn:aws:iam::123456789012:role/TestRole',
      roleSessionName: 'via-token-api',
    });

    expect(execFileMock.mock.calls[0][1]).toContain('assume-role');
  });

  it('detects AWS CLI availability without throwing', async () => {
    respond('aws-cli/2.0');
    await expect(checkAwsCliAvailable()).resolves.toBe(true);
    respond('', '', new Error('ENOENT'));
    await expect(checkAwsCliAvailable()).resolves.toBe(false);
  });
});
