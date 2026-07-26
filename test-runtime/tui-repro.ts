import { TuiRunner } from '../src/tui-ui/runner';
import { InlineTerminalSurface } from '../src/tui-ui/inline-surface';

// ---- JS port of the PTY test's TerminalModel ----
class TerminalModel {
  rows: number;
  cols: number;
  row: number;
  col: number;
  screen: string[][];

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.row = 0;
    this.col = 0;
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(' '));
  }

  feed(data: string): void {
    let index = 0;
    const text = data;
    while (index < text.length) {
      const char = text[index];
      if (char === '\x1b') {
        index = this.consumeEscape(text, index);
        continue;
      }
      if (char === '\r') this.col = 0;
      else if (char === '\n') this.lineFeed();
      else if (char === '\b') this.col = Math.max(0, this.col - 1);
      else if (char.charCodeAt(0) >= 32) this.put(char);
      index += 1;
    }
  }

  lines(): string[] {
    return this.screen.map(r => r.join(''));
  }

  private consumeEscape(text: string, index: number): number {
    if (index + 1 >= text.length) return index + 1;
    const marker = text[index + 1];
    if (marker !== '[') return Math.min(text.length, index + 2);
    let end = index + 2;
    while (end < text.length && !(text[end] >= '@' && text[end] <= '~')) end += 1;
    if (end >= text.length) return text.length;
    const paramStr = text.slice(index + 2, end).replace(/^\?/, '');
    const parts = paramStr.split(';').map(p => (p === '' ? 0 : parseInt(p, 10) || 0));
    const first = parts[0] || 0;
    const count = first || 1;
    const final = text[end];
    if (final === 'A') this.row = Math.max(0, this.row - count);
    else if (final === 'B') this.row = Math.min(this.rows - 1, this.row + count);
    else if (final === 'C') this.col = Math.min(this.cols - 1, this.col + count);
    else if (final === 'D') this.col = Math.max(0, this.col - count);
    else if (final === 'G') this.col = Math.min(this.cols - 1, Math.max(0, count - 1));
    else if (final === 'H' || final === 'f') {
      const r = (parts[0] || 1) - 1;
      const c = (parts[1] || 1) - 1;
      this.row = Math.min(this.rows - 1, Math.max(0, r));
      this.col = Math.min(this.cols - 1, Math.max(0, c));
    } else if (final === 'K') {
      const start = first === 2 ? 0 : this.col;
      const endCol = first === 1 ? this.col + 1 : this.cols;
      for (let c = start; c < endCol; c++) this.screen[this.row][c] = ' ';
    } else if (final === 'J') {
      if (first === 2 || first === 3) {
        this.screen = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
        this.row = 0;
        this.col = 0;
      } else if (first === 0) {
        for (let c = this.col; c < this.cols; c++) this.screen[this.row][c] = ' ';
        for (let r = this.row + 1; r < this.rows; r++) this.screen[r] = Array(this.cols).fill(' ');
      }
    }
    return end + 1;
  }

  private lineFeed(): void {
    this.row += 1;
    if (this.row >= this.rows) {
      this.screen.shift();
      this.screen.push(Array(this.cols).fill(' '));
      this.row = this.rows - 1;
    }
  }

  private put(char: string): void {
    const width = this.charWidth(char);
    if (width <= 0) return;
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.screen[this.row][this.col] = char;
    for (let o = 1; o < width; o++) {
      if (this.col + o < this.cols) this.screen[this.row][this.col + o] = ' ';
    }
    this.col += width;
    if (this.col >= this.cols) this.col = this.cols - 1;
  }

  private charWidth(char: string): number {
    // Approximate: treat common CJK ranges as width 2.
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff) ||
        (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xa000 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6))) {
      return 2;
    }
    return 1;
  }
}

function flushRunner(runner: TuiRunner): Promise<void> {
  return new Promise(resolve => setTimeout(() => {
    runner.getScheduler().flush();
    setTimeout(resolve, 0);
  }, 0));
}

async function main(): Promise<void> {
  const ROWS = 24;
  const COLS = 100;
  const chunks: string[] = [];
  const sink = {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  } as any;

  const surface = new InlineTerminalSurface({ output: sink });

  const model = new TerminalModel(ROWS, COLS);
  // Simulate the npm/ts-node/deprecation banner that prints BEFORE the TUI
  // mounts in the real `npm run start` process (leaves the real cursor at row 5,
  // while the surface still assumes it starts at 0 — reproducing the desync).
  model.feed('> orion-code@0.2.27 start\n> ts-node src/cli.ts --ui tui\n\n(node) deprecation warning\n(Use node)\n');
  chunks.length = 0;
  await surface.mount(COLS, ROWS);

  const runner = new TuiRunner({
    output: sink,
    width: COLS,
    height: ROWS,
    surface,
  });

  await flushRunner(runner);

  // Append system message (live, like launch.ts)
  runner.events.append({
    role: 'system',
    content: 'ORION CODE v0.2.27\nProject /tmp\n/ commands   @ files   ? shortcuts   Ctrl+C twice exits',
    live: true,
  });
  await flushRunner(runner);

  const renderNow = () => {
    const raw = chunks.join('');
    chunks.length = 0;
    model.feed(raw);
    return raw;
  };

  const dumpRaw = (label: string, raw: string) => {
    const visible = raw
      .replace(/\x1b\[/g, '␛[')
      .replace(/\x1b\]/g, '␛]')
      .replace(/\x1b/g, '␛');
    console.log(`\n--- RAW ${label} (len=${raw.length}) ---`);
    console.log(visible);
  };

  const r1 = renderNow();
  dumpRaw('SYSTEM MSG', r1);
  console.log('\n=== AFTER SYSTEM MSG (model) ===');
  console.log(model.lines().map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n'));

  // Type CJK
  const cjk = '开源小？事收到';
  for (const ch of cjk) {
    runner.feedInput(ch);
    await flushRunner(runner);
  }
  const r2 = renderNow();
  dumpRaw('AFTER TYPING', r2);
  console.log('\n=== AFTER TYPING 开源小？事收到 (model) ===');
  console.log(model.lines().map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n'));

  // Backspace
  runner.feedInput('\x7f');
  await flushRunner(runner);
  const r3 = renderNow();
  dumpRaw('AFTER BACKSPACE', r3);
  console.log('\n=== AFTER BACKSPACE ===');
  console.log(model.lines().map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n'));

  const visible = model.lines().join('\n').replace(/ /g, '');
  console.log('\ncompact has 开源小？事收:', visible.includes('开源小？事收'));
  console.log('compact still has 到:', visible.includes('事收到'));
}

main().catch(e => { console.error(e); process.exit(1); });
