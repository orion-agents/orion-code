import type { WebSettingsDocumentV1 } from './types';

export interface SettingsMirrorSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
  readonly document: WebSettingsDocumentV1 | null;
  readonly lastGood: WebSettingsDocumentV1 | null;
  readonly stale: boolean;
  readonly error: string | null;
  readonly generation: number;
}

type SettingsReader = () => Promise<WebSettingsDocumentV1>;

/** One browser-side authority for Host settings reads and write-answer folding. */
export class SettingsMirror {
  private snapshot: SettingsMirrorSnapshot = Object.freeze({
    status: 'idle',
    document: null,
    lastGood: null,
    stale: false,
    error: null,
    generation: 0,
  });
  private readonly listeners = new Set<() => void>();
  private inFlight: Promise<SettingsMirrorSnapshot> | null = null;
  private rerun = false;
  private generation = 0;
  private disposed = false;

  constructor(private readonly read: SettingsReader) {}

  getSnapshot(): SettingsMirrorSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load once when empty; callers that need freshness use refresh(). */
  ensure(): Promise<SettingsMirrorSnapshot> {
    if (this.snapshot.document || this.inFlight) {
      return this.inFlight ?? Promise.resolve(this.snapshot);
    }
    return this.refresh();
  }

  /** Coalesce reads, rerunning once when invalidated while a read is in flight. */
  refresh(): Promise<SettingsMirrorSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = Promise.resolve().then(() => this.run());
    this.inFlight = run;
    return run;
  }

  /** Fold a bootstrap or successful mutation answer and invalidate any older GET. */
  accept(document: WebSettingsDocumentV1): SettingsMirrorSnapshot {
    if (this.disposed) return this.snapshot;
    this.generation += 1;
    if (this.inFlight) this.rerun = true;
    return this.publishDocument(document);
  }

  /** Mark the held view stale and refresh unless the accepted write already has this revision. */
  invalidate(revision: string, state: 'ready' | 'invalid'): Promise<SettingsMirrorSnapshot> {
    if (
      this.snapshot.document?.revision === revision &&
      (state === 'ready'
        ? this.snapshot.document.state === 'ready'
        : this.snapshot.document.state === 'invalid')
    ) {
      return Promise.resolve(this.snapshot);
    }
    this.setSnapshot({ ...this.snapshot, stale: true });
    return this.refresh();
  }

  /** Clear all workspace-specific state before a bootstrap or workspace transition. */
  reset(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.rerun = false;
    this.setSnapshot({
      status: 'idle',
      document: null,
      lastGood: null,
      stale: false,
      error: null,
      generation: this.generation,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  private async run(): Promise<SettingsMirrorSnapshot> {
    try {
      do {
        this.rerun = false;
        const startedAt = ++this.generation;
        this.setSnapshot({
          ...this.snapshot,
          status: this.snapshot.document ? 'ready' : 'loading',
          error: null,
          generation: startedAt,
        });
        try {
          const document = await this.read();
          if (this.disposed) return this.snapshot;
          if (startedAt !== this.generation) continue;
          this.publishDocument(document);
        } catch (error) {
          if (this.disposed) return this.snapshot;
          if (startedAt !== this.generation) continue;
          this.setSnapshot({
            ...this.snapshot,
            status: this.snapshot.document ? 'ready' : 'unavailable',
            stale: true,
            error: error instanceof Error ? error.message : '设置读取失败。',
            generation: startedAt,
          });
        }
      } while (this.rerun && !this.disposed);
      return this.snapshot;
    } finally {
      this.inFlight = null;
      if (this.rerun && !this.disposed) return this.refresh();
    }
  }

  private publishDocument(document: WebSettingsDocumentV1): SettingsMirrorSnapshot {
    const lastGood = document.state === 'ready' ? document : this.snapshot.lastGood;
    this.setSnapshot({
      status: 'ready',
      document,
      lastGood,
      stale: false,
      error: null,
      generation: this.generation,
    });
    return this.snapshot;
  }

  private setSnapshot(snapshot: SettingsMirrorSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
}
