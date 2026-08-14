import {
  MAX_WEB_SEARCH_RESPONSE_BYTES,
  readBoundedResponseText,
  validateWebSearchLimit,
} from '../src/services/bounded-response';

describe('bounded web responses', () => {
  it('rejects an oversized declared content length before buffering', async () => {
    const response = new Response('small', {
      headers: { 'content-length': String(MAX_WEB_SEARCH_RESPONSE_BYTES + 1) },
    });
    await expect(readBoundedResponseText(response)).rejects.toThrow(/exceeds/);
  });

  it('cancels a chunked response as soon as its observed bytes exceed the limit', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_WEB_SEARCH_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream);

    await expect(readBoundedResponseText(response)).rejects.toThrow(/exceeds/);
    expect(cancelled).toBe(true);
  });

  it('counts UTF-8 bytes and accepts content within the limit', async () => {
    const text = '你好 Orion';
    await expect(readBoundedResponseText(new Response(text), 64)).resolves.toBe(text);
  });

  it.each([0, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5'])(
    'rejects invalid web_search limit %p',
    value => {
      expect(() => validateWebSearchLimit(value)).toThrow(/between 1 and 20/);
    }
  );

  it('defaults and accepts bounded integer limits', () => {
    expect(validateWebSearchLimit(undefined)).toBe(5);
    expect(validateWebSearchLimit(1)).toBe(1);
    expect(validateWebSearchLimit(20)).toBe(20);
  });
});
