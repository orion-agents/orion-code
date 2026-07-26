import { resolveModelContext } from './model-context';
import { ENV } from '../product/environment';

export type ProviderErrorType =
  | 'model_not_found'
  | 'invalid_endpoint'
  | 'auth_failed'
  | 'quota_or_credit_exhausted'
  | 'rate_limit'
  | 'provider_busy'
  | 'unknown_provider_error';

export interface ProviderErrorDiagnostic {
  type: ProviderErrorType;
  retryable: boolean;
  status?: number;
  code?: string;
  providerMessage: string;
  hint: string;
}

export interface ProviderConfigDiagnostic {
  status: 'ok' | 'warn' | 'fail';
  summary: string;
  detail: string[];
}

export interface ProviderConfigInput {
  apiKey?: string;
  baseUrl?: string;
  fallbackModel?: string;
  model: string;
}

export class LLMProviderError extends Error {
  readonly diagnostic: ProviderErrorDiagnostic;

  constructor(diagnostic: ProviderErrorDiagnostic) {
    super(formatProviderErrorMessage(diagnostic));
    this.name = 'LLMProviderError';
    this.diagnostic = diagnostic;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function codeValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function redactProviderSecrets(input: string): string {
  return input
    .replace(/\b(https?:\/\/)([^/\s@]+)@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|key|token|secret|authorization)=)[^&\s#]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_-]?key|token|secret|authorization)\s*[:=]\s*["']?[^"'\s,;]+/gi,
      '$1=[REDACTED]'
    );
}

function compactProviderMessage(input: string): string {
  const compact = redactProviderSecrets(input).replace(/\s+/g, ' ').trim();
  return compact.length > 600 ? `${compact.slice(0, 597)}...` : compact;
}

function extractErrorParts(error: unknown): {
  status?: number;
  code?: string;
  type?: string;
  message: string;
} {
  const messages: string[] = [];
  let status: number | undefined;
  let code: string | undefined;
  let type: string | undefined;

  if (error instanceof Error) {
    messages.push(error.message);
  } else if (typeof error === 'string') {
    messages.push(error);
  }

  if (isRecord(error)) {
    status = numberValue(error.status) ?? numberValue(error.statusCode);
    code = codeValue(error.code);
    type = stringValue(error.type);

    const topLevelMessage = stringValue(error.message);
    if (topLevelMessage) messages.push(topLevelMessage);

    const response = isRecord(error.response) ? error.response : undefined;
    status = status ?? numberValue(response?.status);

    const body = isRecord(error.error)
      ? error.error
      : isRecord(error.body)
        ? error.body
        : undefined;
    const nestedError = isRecord(body?.error) ? body.error : undefined;

    code = code ?? codeValue(body?.code) ?? codeValue(nestedError?.code);
    type = type ?? stringValue(body?.type) ?? stringValue(nestedError?.type);

    const bodyMessage = stringValue(body?.message) ?? stringValue(nestedError?.message);
    if (bodyMessage) messages.push(bodyMessage);
  }

  if (messages.length === 0) {
    messages.push(String(error));
  }

  return {
    status,
    code,
    type,
    message: compactProviderMessage([...new Set(messages)].join(' | ')),
  };
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function hintFor(type: ProviderErrorType): string {
  switch (type) {
    case 'model_not_found':
      return `Model was not found by the provider. Check ${ENV.MODEL} and the provider model ID.`;
    case 'invalid_endpoint':
      return `Endpoint appears invalid or unreachable. Check ${ENV.API_BASE_URL} and use the provider OpenAI-compatible base URL.`;
    case 'auth_failed':
      return `Provider authentication failed. Check ${ENV.API_KEY} and make sure it matches the configured endpoint.`;
    case 'quota_or_credit_exhausted':
      return 'Provider quota or credit appears insufficient. Recharge the provider account or switch model/provider.';
    case 'rate_limit':
      return 'Provider rate limit was reached. Wait before retrying, reduce request rate, or switch model/provider.';
    case 'provider_busy':
      return `Provider is busy or overloaded. Retry later or configure ${ENV.FALLBACK_MODEL}.`;
    case 'unknown_provider_error':
      return 'Provider request failed. Check provider status and model/endpoint configuration.';
  }
}

function retryableFor(type: ProviderErrorType, status?: number, message?: string): boolean {
  if (type === 'rate_limit' || type === 'provider_busy') return true;
  if (type === 'auth_failed' || type === 'quota_or_credit_exhausted' || type === 'model_not_found') return false;
  // invalid_endpoint: network-level errors (DNS, connection refused) are retryable;
  // configuration errors (invalid URL, unsupported protocol) are not.
  if (type === 'invalid_endpoint') {
    if (message && /\b(econnrefused|etimedout|enotfound|econnreset|epipe|network|connection)\b/i.test(message)) return true;
    return false;
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (!message) return false;
  return matchesAny(message.toLowerCase(), [
    /\btimeout\b/,
    /\beconnreset\b/,
    /\bconnection\b/,
    /\bepipe\b/,
    /\bnetwork\b/,
    /\btemporarily unavailable\b/,
  ]);
}

export function diagnoseProviderError(error: unknown): ProviderErrorDiagnostic {
  const parts = extractErrorParts(error);
  const text = [parts.message, parts.code, parts.type].filter(Boolean).join(' ').toLowerCase();
  const code = parts.code?.toLowerCase();

  let type: ProviderErrorType = 'unknown_provider_error';

  if (
    code === 'model_not_found'
    || matchesAny(text, [
      /\bmodel_not_found\b/,
      /\bmodel not found\b/,
      /\bmodel .*not found\b/,
      /\bmodel .*does not exist\b/,
      /\bunknown model\b/,
    ])
  ) {
    type = 'model_not_found';
  } else if (
    code === '11210'
    || matchesAny(text, [
      /\bnotenoughcverror\b/,
      /\bnot enough cverror\b/,
      /\bcode:\s*11210\b/,
      /\binsufficient_quota\b/,
      /\binsufficient quota\b/,
      /\bquota exceeded\b/,
      /\bcredit exhausted\b/,
      /\binsufficient credit\b/,
      /\bbilling hard limit\b/,
    ])
  ) {
    type = 'quota_or_credit_exhausted';
  } else if (
    code === 'invalid_api_key'
    || parts.status === 401
    || parts.status === 403
    || matchesAny(text, [
      /\binvalid api key\b/,
      /\binvalid_api_key\b/,
      /\bauthentication\b/,
      /\bauthorization failed\b/,
      /\bunauthorized\b/,
      /\bforbidden\b/,
      /\baccess denied\b/,
      /\btoken expired\b/,
    ])
  ) {
    type = 'auth_failed';
  } else if (
    parts.status === 429
    || matchesAny(text, [
      /\brate limit\b/,
      /\btoo many requests\b/,
      /\bapi-limit\b/,
      /\bapi_limit\b/,
      /\bapi limit\b/,
      /\brequest limit\b/,
      /\brequests per minute\b/,
      /\btokens per minute\b/,
      /\btemporarily throttled\b/,
      /\b429\b/,
    ])
  ) {
    type = 'rate_limit';
  } else if (
    parts.status === 529
    || matchesAny(text, [
      /\bcode:\s*10012\b/,
      /\bengineinternalerror\b/,
      /\bsystem is busy\b/,
      /\bservice is busy\b/,
      /\bserver is busy\b/,
      /\boverloaded\b/,
      /\btry again later\b/,
    ])
  ) {
    type = 'provider_busy';
  } else if (
    parts.status === 404
    || matchesAny(text, [
      /\binvalid url\b/,
      /\berr_invalid_url\b/,
      /\bunsupported protocol\b/,
      /\bgetaddrinfo enotfound\b/,
      /\benotfound\b/,
      /\beconnrefused\b/,
      /\bfetch failed\b/,
    ])
  ) {
    type = 'invalid_endpoint';
  }

  return {
    type,
    retryable: retryableFor(type, parts.status, text),
    status: parts.status,
    code: parts.code,
    providerMessage: parts.message,
    hint: hintFor(type),
  };
}

export function toLLMProviderError(error: unknown): Error {
  if (error instanceof LLMProviderError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  return new LLMProviderError(diagnoseProviderError(error));
}

export function formatProviderErrorMessage(diagnostic: ProviderErrorDiagnostic): string {
  const status = diagnostic.status ? ` status=${diagnostic.status}` : '';
  const code = diagnostic.code ? ` code=${diagnostic.code}` : '';
  return `LLM provider error [${diagnostic.type}${status}${code}]: ${diagnostic.hint}`;
}

function endpointDiagnostics(baseUrl?: string): {
  status: ProviderConfigDiagnostic['status'];
  endpoint: string;
  detail: string[];
} {
  if (!baseUrl) {
    return {
      status: 'ok',
      endpoint: '(default OpenAI-compatible endpoint)',
      detail: ['endpoint=(default OpenAI-compatible endpoint)'],
    };
  }

  const endpoint = compactProviderMessage(baseUrl);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return {
      status: 'fail',
      endpoint,
      detail: [`endpoint=${endpoint}`, 'endpointStatus=invalid URL'],
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      status: 'fail',
      endpoint,
      detail: [`endpoint=${endpoint}`, `endpointStatus=unsupported protocol ${url.protocol}`],
    };
  }

  if (/\/(?:chat\/completions|responses|messages)\/?$/i.test(url.pathname)) {
    return {
      status: 'warn',
      endpoint,
      detail: [
        `endpoint=${endpoint}`,
        'endpointStatus=looks like a request path; configure the provider base URL instead',
      ],
    };
  }

  return {
    status: 'ok',
    endpoint,
    detail: [`endpoint=${endpoint}`, 'endpointStatus=valid URL syntax'],
  };
}

function worseStatus(
  left: ProviderConfigDiagnostic['status'],
  right: ProviderConfigDiagnostic['status']
): ProviderConfigDiagnostic['status'] {
  if (left === 'fail' || right === 'fail') return 'fail';
  if (left === 'warn' || right === 'warn') return 'warn';
  return 'ok';
}

export function diagnoseProviderConfig(input: ProviderConfigInput): ProviderConfigDiagnostic {
  const model = input.model.trim() || '(not set)';
  const modelContext = resolveModelContext(model);
  const endpoint = endpointDiagnostics(input.baseUrl);
  const modelStatus: ProviderConfigDiagnostic['status'] =
    model === '(not set)' || modelContext.source === 'default' ? 'warn' : 'ok';
  const keyStatus: ProviderConfigDiagnostic['status'] = input.apiKey ? 'ok' : 'fail';
  const status = worseStatus(worseStatus(endpoint.status, modelStatus), keyStatus);
  const provider = modelContext.provider ?? 'unknown';

  return {
    status,
    summary: `${model} via ${provider}, endpoint ${endpoint.endpoint}`,
    detail: [
      `model=${model}`,
      `provider=${provider}`,
      `modelSource=${modelContext.source}`,
      `matchedModel=${modelContext.matchedId}`,
      `contextWindow=${modelContext.contextWindow}`,
      `maxOutputTokens=${modelContext.maxOutputTokens ?? '(unknown)'}`,
      ...endpoint.detail,
      `apiKey=${input.apiKey ? 'configured' : 'missing'}`,
      `fallbackModel=${input.fallbackModel || '(none)'}`,
      'networkCheck=skipped',
    ],
  };
}
