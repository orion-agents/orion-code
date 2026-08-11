import { classifyProviderError } from '../src/services/provider-resilience/error-classifier';

describe('provider error classifier', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fails fast for local preflight and user abort signals', () => {
    const preflight = new Error('request rejected locally');
    preflight.name = 'ProviderRequestPreflightError';
    expect(classifyProviderError(preflight, false)).toEqual({
      kind: 'preflight_rejected',
      disposition: 'fail_fast',
    });

    for (const error of [
      Object.assign(new Error('stopped'), { name: 'AbortError' }),
      Object.assign(new Error('stopped'), { name: 'CanceledError' }),
      new Error('request abort requested'),
      new Error('request cancel requested'),
    ]) {
      expect(classifyProviderError(error, false)).toEqual({
        kind: 'aborted',
        disposition: 'fail_fast',
      });
    }
  });

  it.each([
    [{ status: 401 }, 'auth_failed'],
    [{ status: 403 }, 'auth_failed'],
    [{ status: 402 }, 'quota_or_credit_exhausted'],
    [{ status: 404 }, 'model_not_found'],
    [{ status: 400, message: 'reasoning_effort is unsupported' }, 'unsupported_effort'],
    [{ status: 400, message: 'bad input' }, 'invalid_request'],
    [{ status: 413 }, 'request_too_large'],
  ] as const)('classifies non-retryable status error %j', (error, kind) => {
    expect(classifyProviderError(error, false)).toMatchObject({
      kind,
      disposition: 'fail_fast',
      status: error.status,
    });
  });

  it.each([
    { status: 429, message: 'quota exceeded' },
    { status: 429, message: 'credit exhausted' },
    { status: 429, message: 'insufficient balance' },
    { status: 429, code: 'insufficient_quota' },
    { status: 429, code: 'billing_not_active' },
  ])('distinguishes quota exhaustion from an ordinary 429: %j', error => {
    expect(classifyProviderError(error, false)).toMatchObject({
      kind: 'quota_or_credit_exhausted',
      disposition: 'fail_fast',
      status: 429,
    });
  });

  it.each(['context overflow', 'context is too long', 'maximum context reached'])(
    'recognizes context overflow wording: %s',
    message => {
      expect(classifyProviderError({ status: 400, message }, false)).toEqual({
        kind: 'context_overflow',
        disposition: 'fail_fast',
        status: 400,
      });
    }
  );

  it.each(['content policy violation', 'content safety rejection', 'content moderation failure'])(
    'recognizes content-policy wording: %s',
    message => {
      expect(classifyProviderError({ message }, false)).toMatchObject({
        kind: 'content_policy',
        disposition: 'fail_fast',
      });
    }
  );

  it.each([
    [408, 'conflict'],
    [429, 'rate_limit'],
    [529, 'provider_overloaded'],
    [500, 'server_error'],
    [503, 'server_error'],
  ] as const)('uses stream-aware retry disposition for status %i', (status, kind) => {
    expect(classifyProviderError({ status }, false)).toMatchObject({
      kind,
      disposition: 'retry_precommit',
      status,
    });
    expect(classifyProviderError({ status }, true)).toMatchObject({
      kind,
      disposition: 'recover_stream',
      status,
    });
  });

  it('always retries a conflict status before commit', () => {
    expect(classifyProviderError({ status: 409 }, true)).toEqual({
      kind: 'conflict',
      disposition: 'retry_precommit',
      retryAfterMs: undefined,
      status: 409,
    });
  });

  it.each([
    ['connection reset', 'connection_reset'],
    ['socket ECONNRESET', 'connection_reset'],
    ['write EPIPE', 'connection_reset'],
    ['connect timeout', 'connect_timeout'],
    ['read timeout', 'read_timeout'],
    ['request timed out', 'read_timeout'],
    ['ECONNREFUSED', 'network_error'],
    ['ENOTFOUND', 'network_error'],
    ['ENONET', 'network_error'],
    ['network unavailable', 'network_error'],
    ['DNS lookup failed', 'network_error'],
    ['malformed response', 'malformed_response'],
    ['unexpected token in JSON', 'malformed_response'],
    ['parse error', 'malformed_response'],
  ] as const)('classifies transport failure %s', (message, kind) => {
    expect(classifyProviderError(new Error(message), false)).toEqual({
      kind,
      disposition: 'retry_precommit',
    });
    expect(classifyProviderError(new Error(message), true)).toEqual({
      kind,
      disposition: 'recover_stream',
    });
  });

  it('extracts numeric statusCode and supported Retry-After formats', () => {
    expect(
      classifyProviderError(
        {
          statusCode: 429,
          headers: { 'retry-after-ms': '250' },
        },
        false
      )
    ).toMatchObject({ status: 429, retryAfterMs: 250 });

    expect(
      classifyProviderError(
        {
          status: 429,
          headers: { 'retry-after-ms': 'invalid', 'retry-after': '3' },
        },
        false
      )
    ).toMatchObject({ retryAfterMs: 3_000 });

    expect(
      classifyProviderError(
        {
          status: 429,
          response: { headers: new Headers({ 'Retry-After': '1.5' }) },
        },
        false
      )
    ).toMatchObject({ retryAfterMs: 1_500 });

    expect(
      classifyProviderError(
        {
          status: 429,
          headers: { 'Retry-After-Ms': 750, 'Retry-After': '120' },
        },
        false
      )
    ).toMatchObject({ retryAfterMs: 750 });

    expect(
      classifyProviderError({ status: 429, headers: { 'retry-after': '120' } }, false)
    ).toMatchObject({ retryAfterMs: 120_000 });

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    expect(
      classifyProviderError(
        {
          status: 429,
          headers: { 'retry-after': 'Sat, 01 Aug 2026 00:00:10 GMT' },
        },
        false
      )
    ).toMatchObject({ retryAfterMs: 10_000 });
  });

  it('ignores invalid or expired Retry-After values', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));

    for (const value of ['0', '-1', 'invalid', 'Fri, 31 Jul 2026 23:59:00 GMT']) {
      expect(
        classifyProviderError(
          {
            status: 429,
            headers: { 'retry-after': value },
          },
          false
        ).retryAfterMs
      ).toBeUndefined();
    }
  });

  it('falls back to interrupted or unknown for unclassified errors', () => {
    expect(classifyProviderError(undefined, false)).toEqual({
      kind: 'unknown',
      disposition: 'retry_precommit',
    });
    expect(classifyProviderError(new Error('unclassified'), true)).toEqual({
      kind: 'stream_interrupted',
      disposition: 'recover_stream',
    });
  });
});
