/**
 * Bug-hunt round 6 evidence: read_file byte limit uses code-unit slice, not bytes.
 *
 * readFileSync_ enforces a 50KB *byte* limit, but implements it with
 * `content.slice(0, maxBytes)`. String.slice counts UTF-16 code units, not
 * bytes, so for multi-byte UTF-8 content (CJK, emoji) the returned output is
 * far larger than maxBytes in actual bytes - defeating the size guard that is
 * meant to keep tool output bounded for the model context.
 *
 * It can also split a surrogate pair (emoji) or a multi-byte sequence,
 * producing a lone surrogate / mojibake in the output.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

const TOOLS = require('../src/tools').TOOLS;
const readFileTool = TOOLS.find((t: any) => t.name === 'read_file');

const ctx = { cwd: process.cwd(), config: { name: 'orion-code', mode: 'development' } };
const MAX_BYTES = 51200; // 50KB, the limit baked into readFileSync_

describe('read_file byte limit (bug-hunt round 6)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'openhorse-readfile-bug-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps CJK output within the byte limit (not the code-unit limit)', async () => {
    // 100 lines (<= default maxLines=500, so the line-truncation path is NOT
    // taken), each line 200 CJK chars. Each CJK char is 3 bytes in UTF-8, so
    // total ~= 100 * 200 * 3 = 60000 bytes > 50KB, triggering the byte guard.
    const cjk = '漢'.repeat(200);
    const file = path.join(dir, 'cjk.txt');
    fs.writeFileSync(file, (cjk + '\n').repeat(100), 'utf-8');

    const result = await readFileTool.execute({ path: file }, ctx);
    const output = (result as { output: string }).output;

    // The whole-point of the guard is to bound output bytes. Before the fix,
    // slice(0, 51200) returned 51200 CJK chars (~153KB) - 3x over the limit.
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(MAX_BYTES + 200); // +slack for the truncation notice
  });

  it('does not emit a lone surrogate when truncating emoji content', async () => {
    // Each emoji is a surrogate pair (2 code units, 4 UTF-8 bytes). 26000 emoji
    // = 52000 code units = 104000 bytes on a single line (<=500 lines), so the
    // byte guard fires AND slice(0,51200) actually truncates. With one leading
    // ASCII char, the 51200 cut lands mid-surrogate-pair.
    const file = path.join(dir, 'emoji.txt');
    // Prefix with one ASCII char so the 51200 cut lands mid-surrogate-pair.
    fs.writeFileSync(file, 'X' + '😀'.repeat(26000), 'utf-8');

    const result = await readFileTool.execute({ path: file }, ctx);
    const output = (result as { output: string }).output;

    // A lone surrogate means JSON.stringify (used to ship tool results) would
    // produce malformed output, and the string is not valid for transport.
    // Assert the output is well-formed: no lone surrogates.
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
