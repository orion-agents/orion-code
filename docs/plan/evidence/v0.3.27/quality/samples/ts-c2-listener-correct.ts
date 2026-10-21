// Sample ts-c2 — resource lifecycle (clean reference)
// The subscription handle is kept and dispose removes exactly the listener it
// added, so refresh cycles do not accumulate handlers.
import { EventEmitter } from 'node:events';

export class Dashboard {
  private readonly subscriptions: Array<{ off: () => void }> = [];

  constructor(private readonly container: HTMLElement) {}

  refresh(source: EventEmitter): void {
    const ondata = (payload: unknown): void => {
      this.container.textContent = JSON.stringify(payload);
    };
    source.on('data', ondata);
    this.subscriptions.push({ off: () => source.off('data', ondata) });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.off();
    this.subscriptions.length = 0;
  }
}
