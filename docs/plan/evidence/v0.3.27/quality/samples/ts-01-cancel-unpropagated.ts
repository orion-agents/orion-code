// Sample ts-01 — async/cancel (defect)
// A search service that ignores its own cancellation signal: the AbortSignal is
// accepted but never attached to the outgoing request, so a cancelled search
// keeps running and its late result overwrites newer state.
import { EventEmitter } from 'node:events';

export class SearchService extends EventEmitter {
  private latest = '';

  async search(query: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(`https://example.invalid/search?q=${query}`);
    const body = (await response.json()) as { result: string };
    this.latest = body.result;
    this.emit('result', this.latest);
    return this.latest;
  }
}
