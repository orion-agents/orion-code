/**
 * v0.2.25 — Provider Error Classifier.
 *
 * Maps raw errors from OpenAI SDK / HTTP to structured ProviderFailureKind
 * and RetryDisposition. Typed signals take priority over string matching.
 */

import type { ProviderFailureKind, RetryDisposition } from './types';

export interface ClassificationResult {
  kind: ProviderFailureKind;
  disposition: RetryDisposition;
  retryAfterMs?: number;
  status?: number;
}

export function classifyProviderError(
  error: unknown,
  semanticDeltaSeen: boolean,
): ClassificationResult {
  // User abort
  if (isAbortError(error)) {
    return { kind: 'aborted', disposition: 'fail_fast' };
  }

  // Extract status and headers
  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterMs(error);

  // Non-retryable by status
  if (status === 401 || status === 403) {
    return { kind: 'auth_failed', disposition: 'fail_fast', status };
  }
  if (status === 402 || (status === 429 && isQuotaError(error))) {
    return { kind: 'quota_or_credit_exhausted', disposition: 'fail_fast', retryAfterMs, status };
  }
  if (status === 404) {
    return { kind: 'model_not_found', disposition: 'fail_fast', status };
  }
  if (status === 400) {
    if (isContextOverflow(error)) {
      return { kind: 'context_overflow', disposition: 'fail_fast', status };
    }
    return { kind: 'invalid_request', disposition: 'fail_fast', status };
  }
  if (status === 413) {
    return { kind: 'request_too_large', disposition: 'fail_fast', status };
  }

  // Content policy
  if (isContentPolicy(error)) {
    return { kind: 'content_policy', disposition: 'fail_fast', status };
  }

  // Retryable by status
  if (status === 408) {
    return { kind: 'conflict', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit', retryAfterMs, status };
  }
  if (status === 409) {
    return { kind: 'conflict', disposition: 'retry_precommit', retryAfterMs, status };
  }
  if (status === 429) {
    return { kind: 'rate_limit', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit', retryAfterMs, status };
  }
  if (status === 529) {
    return { kind: 'provider_overloaded', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit', retryAfterMs, status };
  }
  if (status && status >= 500) {
    return { kind: 'server_error', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit', retryAfterMs, status };
  }

  // Network errors
  if (isConnectionReset(error)) {
    return { kind: 'connection_reset', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit' };
  }
  if (isTimeout(error)) {
    return { kind: isConnectTimeout(error) ? 'connect_timeout' : 'read_timeout', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit' };
  }
  if (isNetworkError(error)) {
    return { kind: 'network_error', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit' };
  }

  // Malformed response
  if (isMalformedResponse(error)) {
    return { kind: 'malformed_response', disposition: semanticDeltaSeen ? 'recover_stream' : 'retry_precommit' };
  }

  // Stream interrupted
  if (semanticDeltaSeen) {
    return { kind: 'stream_interrupted', disposition: 'recover_stream' };
  }

  return { kind: 'unknown', disposition: 'retry_precommit' };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'CanceledError'
      || error.message?.includes('abort') || error.message?.includes('cancel');
  }
  return false;
}

function extractStatus(error: unknown): number | undefined {
  const e = error as Record<string, unknown> | undefined;
  if (!e) return undefined;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return undefined;
}

function isQuotaError(error: unknown): boolean {
  const e = error as Record<string, unknown> | undefined;
  if (!e) return false;
  const msg = String(e.message ?? '').toLowerCase();
  const code = String(e.code ?? '').toLowerCase();
  return msg.includes('quota') || msg.includes('credit') || msg.includes('insufficient')
    || code === 'insufficient_quota' || code === 'billing_not_active';
}

function isContextOverflow(error: unknown): boolean {
  const msg = String((error as any)?.message ?? '').toLowerCase();
  return msg.includes('context') && (msg.includes('overflow') || msg.includes('too long') || msg.includes('maximum context'));
}

function isContentPolicy(error: unknown): boolean {
  const msg = String((error as any)?.message ?? '').toLowerCase();
  return msg.includes('content') && (msg.includes('policy') || msg.includes('safety') || msg.includes('moderation'));
}

function isConnectionReset(error: unknown): boolean {
  const msg = String((error as any)?.message ?? '').toLowerCase();
  return msg.includes('reset') || msg.includes('econnreset') || msg.includes('epipe');
}

function isTimeout(error: unknown): boolean {
  const msg = String((error as any)?.message ?? '').toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out');
}

function isConnectTimeout(error: unknown): boolean {
  const msg = String((error as any)?.message ?? '').toLowerCase();
  return msg.includes('connect') && msg.includes('timeout');
}

function isNetworkError(error: unknown): boolean {
  const msg = String((error as any)?.message ?? '').toLowerCase();
  return msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('enonet')
    || msg.includes('network') || msg.includes('dns');
}

function isMalformedResponse(error: unknown): boolean {
  const msg = String((error as any)?.message ?? '').toLowerCase();
  return msg.includes('malformed') || msg.includes('unexpected token') || msg.includes('parse error');
}

function extractRetryAfterMs(error: unknown): number | undefined {
  const e = error as Record<string, unknown> | undefined;
  if (!e) return undefined;
  const headers = e.headers as Record<string, string> | undefined;
  if (headers) {
    const ms = headers['retry-after-ms'];
    if (ms) { const n = Number(ms); if (Number.isFinite(n) && n > 0) return n; }
    const sec = headers['retry-after'];
    if (sec) { const n = Number(sec); if (Number.isFinite(n) && n > 0) return n * 1000; }
    const date = headers['retry-after'];
    if (date && !Number(date)) {
      try { const ms = Date.parse(date) - Date.now(); if (ms > 0) return ms; } catch {}
    }
  }
  return undefined;
}