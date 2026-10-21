// Sample ts-02 — resource lifecycle (defect)
// Every refresh() call registers another listener on the shared bus and none
// is ever removed, so a long-lived tab accumulates handlers and re-renders
// once per refresh.
import { EventEmitter } from 'node:events';

export class Dashboard {
  private readonly bus = new EventEmitter();

  constructor(private readonly container: HTMLElement) {}

  refresh(source: EventEmitter): void {
    source.on('data', payload => {
      this.bus.emit('render', payload);
      this.container.textContent = JSON.stringify(payload);
    });
  }
}
