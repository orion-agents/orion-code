/**
 * Security fix regression tests — batch 2 (issues #78, #79, #85).
 *
 * #78: MCP stdio servers must not inherit the parent process's full environment
 *      (which may carry AWS_, GCP_, and AZURE_ credentials). buildMcpChildEnv passes
 *      only a small allowlist plus explicitly-configured config.env.
 * #79: grep must reject patterns that trigger catastrophic backtracking (ReDoS)
 *      and other invalid/over-long patterns before constructing a RegExp.
 * #85: the atomic-write temp name must be unpredictable (random suffix) so a local
 *      attacker cannot pre-plant a symlink and divert the final rename (TOCTOU).
 */
import { buildFirstPartyMcpChildEnvironmentV1 } from '../src/runtime/mcp';
import { atomicWriteFileSync } from '../src/services/atomic-write';
import { validateRegexPattern } from '../src/tools/core/grep';
import { getRuntimeTools } from './support/legacy-tools';
import type { ToolContext } from '../src/framework/tool';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Capture the random bytes atomic-write uses for its temp name. fs/crypto
// namespace methods are non-configurable, so a jest.spyOn won't stick; instead
// we swap the whole `crypto` module for this test file.
const mockCapturedRandom: Buffer[] = [];
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: (size: number) => {
      const buf = actual.randomBytes(size);
      mockCapturedRandom.push(buf);
      return buf;
    },
  };
});

describe('MCP child env sanitization (Issue #78)', () => {
  const SECRET = 'MCP_LEAK_TEST_SECRET_12345';
  const original = process.env[SECRET];

  beforeAll(() => {
    process.env[SECRET] = 'super-secret-value';
  });

  afterAll(() => {
    if (original === undefined) delete process.env[SECRET];
    else process.env[SECRET] = original;
  });

  it('never leaks the parent process secret environment to the child', () => {
    const env = buildFirstPartyMcpChildEnvironmentV1();
    expect(env[SECRET]).toBeUndefined();
  });

  it('strips cloud-provider credential variables', () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.GCP_API_KEY = 'gcp-secret';
    process.env.AZURE_CLIENT_SECRET = 'azure-secret';
    const env = buildFirstPartyMcpChildEnvironmentV1();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GCP_API_KEY).toBeUndefined();
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.GCP_API_KEY;
    delete process.env.AZURE_CLIENT_SECRET;
  });

  it('passes through safe infrastructure variables that exist', () => {
    const env = buildFirstPartyMcpChildEnvironmentV1();
    if (process.env.PATH !== undefined) expect(env.PATH).toBe(process.env.PATH);
    if (process.env.HOME !== undefined) expect(env.HOME).toBe(process.env.HOME);
  });

  it('passes through LC_* locale variables', () => {
    process.env.LC_MESSAGES = 'en_US.UTF-8';
    const env = buildFirstPartyMcpChildEnvironmentV1();
    expect(env.LC_MESSAGES).toBe('en_US.UTF-8');
    delete process.env.LC_MESSAGES;
  });

  it('honors explicitly-configured config.env (and lets it override)', () => {
    const env = buildFirstPartyMcpChildEnvironmentV1({
      CUSTOM_TOKEN: 'from-config',
      PATH: '/custom/bin',
    });
    expect(env.CUSTOM_TOKEN).toBe('from-config');
    expect(env.PATH).toBe('/custom/bin');
  });
});

describe('grep pattern hardening (Issue #79)', () => {
  it('validateRegexPattern rejects an empty pattern', () => {
    expect(validateRegexPattern('')).toMatch(/empty/);
  });

  it('validateRegexPattern rejects an over-long pattern', () => {
    expect(validateRegexPattern('a'.repeat(2001))).toMatch(/too long/);
  });

  it('validateRegexPattern rejects a nested-quantifier ReDoS pattern', () => {
    const err = validateRegexPattern('(a+)+$');
    expect(err).toMatch(/ReDoS|catastrophic backtracking/);
  });

  it.each(['(a{1,})+$', '((a{1,})+)+$', '(a|aa)+$'])(
    'validateRegexPattern rejects brace and overlapping ReDoS pattern %s',
    pattern => {
      expect(validateRegexPattern(pattern)).toMatch(/ReDoS|catastrophic backtracking/);
    }
  );

  it('validateRegexPattern rejects an invalid regular expression', () => {
    expect(validateRegexPattern('(')).toMatch(/valid regular expression/);
  });

  it('validateRegexPattern accepts a safe pattern', () => {
    expect(validateRegexPattern('^foo\\d+$')).toBeNull();
  });

  let tmpDir: string;
  let ctx: ToolContext;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-grep-'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello world\nfoo bar\n');
    ctx = { cwd: tmpDir, config: { name: 'orion-code', mode: 'test' } } as ToolContext;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function grepTool() {
    return getRuntimeTools().find(t => (t as { name: string }).name === 'grep')!;
  }

  it('grep tool rejects a nested-quantifier ReDoS pattern', async () => {
    const result = await grepTool().execute({ pattern: '(a+)+$', path: tmpDir }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ReDoS|catastrophic backtracking|Invalid grep pattern/);
  });

  it.each(['(a{1,})+$', '(a|aa)+$'])('grep tool rejects ReDoS pattern %s', async pattern => {
    const result = await grepTool().execute({ pattern, path: tmpDir }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ReDoS|catastrophic backtracking|Invalid grep pattern/);
  });

  it('grep tool still matches a normal valid pattern', async () => {
    const result = await grepTool().execute({ pattern: 'world', path: tmpDir }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });
});

describe('atomic-write temp name unpredictability (Issue #85)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-atomic-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the content to the target and leaves no leftover temp file', () => {
    const target = path.join(tmpDir, 'out.txt');
    atomicWriteFileSync(target, 'data');
    expect(fs.readFileSync(target, 'utf8')).toBe('data');
    const leftovers = fs.readdirSync(tmpDir).filter(f => f.startsWith('.out.txt'));
    expect(leftovers).toHaveLength(0);
  });

  it('uses a fresh unpredictable random suffix on every call', () => {
    const target = path.join(tmpDir, 'rand.txt');
    mockCapturedRandom.length = 0;
    atomicWriteFileSync(target, 'x');
    atomicWriteFileSync(target, 'y');
    expect(mockCapturedRandom).toHaveLength(2);
    // 12 random bytes -> 24 hex chars in the temp name suffix.
    expect(mockCapturedRandom[0].length).toBe(12);
    expect(mockCapturedRandom[1].length).toBe(12);
    // Two independent calls must produce different suffixes, so a local attacker
    // cannot pre-plant a symlink at the predictable temp path (TOCTOU).
    expect(mockCapturedRandom[0]).not.toEqual(mockCapturedRandom[1]);
    // The final content reflects the latest write.
    expect(fs.readFileSync(target, 'utf8')).toBe('y');
  });
});
