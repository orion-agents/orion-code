/**
 * Bug-hunt round 7 evidence: normalizeToolPath URL-decodes plain file paths.
 *
 * normalizeToolPath applies decodeURIComponent to EVERY path (line ~875), not
 * just file:// URLs. A literal filename containing `%XX` (where XX is valid
 * hex) is silently rewritten: `lit%41.txt` becomes `litA.txt`. The agent then
 * operates on a different file than the one named, or reports "File not found"
 * for a file that exists. Filesystem paths are not URLs and must not be
 * percent-decoded.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

const TOOLS = require('../src/tools').TOOLS;
const readFileTool = TOOLS.find((t: any) => t.name === 'read_file');

const ctx = { cwd: process.cwd(), config: { name: 'orion-code', mode: 'development' } };

describe('read_file literal percent in filename (bug-hunt round 7)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'openhorse-pct-bug-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file whose name contains a literal %41 (not decoded to A)', async () => {
    const file = path.join(dir, 'lit%41.txt'); // %41 is the hex code for 'A'
    fs.writeFileSync(file, 'percent-body', 'utf-8');

    const result = await readFileTool.execute({ path: file }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('percent-body');
  });

  it('reads a file whose name contains a literal %20 (not decoded to space)', async () => {
    const file = path.join(dir, 'lit%20file.txt');
    fs.writeFileSync(file, 'twenty-body', 'utf-8');

    const result = await readFileTool.execute({ path: file }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('twenty-body');
  });
});
