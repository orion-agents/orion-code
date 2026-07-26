import { renderStyledFrameRow, type TuiFrame } from '../tui-core/frame';
import { encodeStyleToSgr, SGR_RESET, shouldSuppressColor } from '../tui-core/style';
import type { SurfaceOutput } from './inline-surface';

const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h';
const EXIT_ALTERNATE_SCREEN = '\x1b[?1049l';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/** Temporary alternate-screen surface used only while Ctrl+O Inspector is open. */
export class TranscriptInspectorSurface {
  private mounted = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly suppressColor = shouldSuppressColor();

  constructor(private readonly output: SurfaceOutput) {}

  mount(frame: TuiFrame): Promise<void> {
    return this.enqueue(async () => {
      if (!this.mounted) {
        await this.writeRaw(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}`);
        this.mounted = true;
      }
      await this.writeRaw(this.render(frame));
    });
  }

  paint(frame: TuiFrame): Promise<void> {
    if (!this.mounted) return this.mount(frame);
    return this.enqueue(() => this.writeRaw(this.render(frame)));
  }

  unmount(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.mounted) return;
      await this.writeRaw(`${SGR_RESET}${SHOW_CURSOR}${EXIT_ALTERNATE_SCREEN}`);
      this.mounted = false;
    });
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  private render(frame: TuiFrame): string {
    const chunks = [HOME, CLEAR];
    for (let rowIndex = 0; rowIndex < frame.height; rowIndex += 1) {
      const spans = renderStyledFrameRow(frame.rows[rowIndex]);
      for (const span of spans) {
        const sgr = encodeStyleToSgr(span.style, this.suppressColor);
        if (sgr) chunks.push(sgr);
        chunks.push(span.text, SGR_RESET);
      }
      if (rowIndex < frame.height - 1) chunks.push('\r\n');
    }
    return chunks.join('');
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation, operation);
    return this.chain;
  }

  private async writeRaw(chunk: string): Promise<void> {
    if (this.output.writable === false) throw new Error('terminal output is not writable');
    if (this.output.write(chunk) !== false) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.output.off('drain', onDrain);
        this.output.off('error', onError);
        this.output.off('close', onClose);
      };
      const onDrain = (): void => { cleanup(); resolve(); };
      const onError = (error?: unknown): void => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error ?? 'terminal output error')));
      };
      const onClose = (): void => onError(new Error('terminal output closed before drain'));
      this.output.on('drain', onDrain);
      this.output.on('error', onError);
      this.output.on('close', onClose);
    });
  }
}
