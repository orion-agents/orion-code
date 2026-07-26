import * as fs from 'fs';

// Minimal terminal model (same logic as the PTY test's Python model).
class TerminalModel {
  rows: number;
  cols: number;
  row = 0;
  col = 0;
  screen: string[][];
  constructor(rows: number, cols: number) {
    this.rows = rows; this.cols = cols;
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(' '));
  }
  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') { i = this.esc(data, i); continue; }
      if (ch === '\r') this.col = 0;
      else if (ch === '\n') this.lf();
      else if (ch === '\b') this.col = Math.max(0, this.col - 1);
      else if (ch.charCodeAt(0) >= 32) this.put(ch);
      i += 1;
    }
  }
  private esc(text: string, index: number): number {
    if (index + 1 >= text.length) return index + 1;
    if (text[index + 1] !== '[') return Math.min(text.length, index + 2);
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
      const r = (parts[0] || 1) - 1, c = (parts[1] || 1) - 1;
      this.row = Math.min(this.rows - 1, Math.max(0, r));
      this.col = Math.min(this.cols - 1, Math.max(0, c));
    } else if (final === 'K') {
      const s = first === 2 ? 0 : this.col, e = first === 1 ? this.col + 1 : this.cols;
      for (let c = s; c < e; c++) this.screen[this.row][c] = ' ';
    } else if (final === 'J') {
      if (first === 2 || first === 3) { this.screen = Array.from({ length: this.rows }, () => Array(this.cols).fill(' ')); this.row = 0; this.col = 0; }
      else if (first === 0) { for (let c = this.col; c < this.cols; c++) this.screen[this.row][c] = ' '; for (let r = this.row + 1; r < this.rows; r++) this.screen[r] = Array(this.cols).fill(' '); }
    }
    return end + 1;
  }
  private lf(): void { this.row += 1; if (this.row >= this.rows) { this.screen.shift(); this.screen.push(Array(this.cols).fill(' ')); this.row = this.rows - 1; } }
  private put(ch: string): void {
    const w = (ord(ch) > 0x1100 && (ord(ch) <= 0x115f || (0x2e80 <= ord(ch) && ord(ch) <= 0xa4cf) || (0xac00 <= ord(ch) && ord(ch) <= 0xd7a3) || (0xf900 <= ord(ch) && ord(ch) <= 0xfaff) || (0xfe30 <= ord(ch) && ord(ch) <= 0xfe4f) || (0xff00 <= ord(ch) && ord(ch) <= 0xffe6))) ? 2 : 1;
    if (this.col >= this.cols) { this.col = 0; this.lf(); }
    this.screen[this.row][this.col] = ch;
    if (w === 2 && this.col + 1 < this.cols) this.screen[this.row][this.col + 1] = ' ';
    this.col += w;
    if (this.col >= this.cols) this.col = this.cols - 1;
  }
}
function ord(s: string): number { return s.codePointAt(0) ?? 0; }

function decodeVis(s: string): string {
  return s.replace(/ESC\[/g, '\x1b[').replace(/ESC\]/g, '\x1b]').replace(/ESC/g, '\x1b');
}

const file = process.argv[2];
const label = process.argv[3];
const text = fs.readFileSync(file, 'utf8');
const m = text.match(/=== RAW[^=]*===([\s\S]*?)(?:\n===|$)/);
if (!m) { console.error('no RAW section'); process.exit(1); }
const raw = decodeVis(m[1]);
const model = new TerminalModel(24, 100);
model.feed(raw);
console.log(`=== Model from ${label} (raw len=${raw.length}) ===`);
console.log(model.screen.map((r, i) => `${String(i).padStart(2)}|${r.join('')}`).join('\n'));
