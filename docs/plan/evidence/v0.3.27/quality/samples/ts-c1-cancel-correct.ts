// Sample ts-c1 — async/cancel (clean reference)
// The cancellation signal is wired into the request and the late-arrival
// guard makes a cancelled result inert.
import { EventEmitter } from 'node:events';

export class SearchService extends EventEmitter {
  private latest = '';

  async search(query: string, signal?: AbortSignal): Promise<string | null> {
    const response = await fetch(`https://example.invalid/search?q=${encodeURIComponent(query)}`, {
      signal,
    });
    const body = (await response.json()) as { result: string };
    if (signal?.aborted) return null;
    this.latest = body.result;
    this.emit('result', this.latest);
    return this.latest;
  }
}
