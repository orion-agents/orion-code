export const MAX_WEB_SEARCH_RESPONSE_BYTES = 1024 * 1024;

export class ResponseBodyTooLargeError extends Error {
  constructor(
    readonly label: string,
    readonly maxBytes: number,
    readonly observedBytes?: number
  ) {
    super(
      `${label} response exceeds ${maxBytes} bytes${observedBytes ? ` (${observedBytes} bytes observed)` : ''}`
    );
    this.name = 'ResponseBodyTooLargeError';
  }
}

/** Read a Fetch response while enforcing a byte bound before and during streaming. */
export async function readBoundedResponseText(
  response: Pick<Response, 'headers' | 'body' | 'text'>,
  maxBytes = MAX_WEB_SEARCH_RESPONSE_BYTES,
  label = 'HTTP'
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel('response body exceeds maximum size').catch(() => undefined);
    throw new ResponseBodyTooLargeError(label, maxBytes, declaredLength);
  }

  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) throw new ResponseBodyTooLargeError(label, maxBytes, bytes);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('response body exceeds maximum size').catch(() => undefined);
        throw new ResponseBodyTooLargeError(label, maxBytes, bytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

export function validateWebSearchLimit(limit: unknown, defaultValue = 5): number {
  if (limit === undefined) return defaultValue;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('web_search limit must be a safe integer between 1 and 20');
  }
  return limit;
}

export function boundedErrorSnippet(text: string, maxChars = 512): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1)}…`;
}
