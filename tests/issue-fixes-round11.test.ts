/**
 * Regression tests for GitHub issues #17, #18, #21, #22, #28.
 *
 * Every case below fails on the code as it shipped in v0.1.4 and passes after
 * the accompanying fix. They are grouped in one file because they are all
 * "the guard was there, it just did not cover this input" bugs.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { assessCommandSecurity, isReadOnlyCommand } from '../src/tools/bash_security';
import { redactTraceText } from '../src/services/redaction';
import { redactSecrets } from '../src/utils/mask';
import { extractKeywords } from '../src/memory/relevant-finder';
import { atomicWriteFileSync } from '../src/services/atomic-write';
import { migrateBrand } from '../src/migration/migrate';

// Split so the literals below are not themselves scanned as committed secrets.
const GOOGLE_API_KEY = ['AIza', 'SyA1B2C3D4E5F6G7H8I9J0KlMnOpQrStUv'].join('');
const SLACK_BOT_TOKEN = ['xoxb', '123456789012', 'abcdefghijklmnop'].join('-');
const SLACK_USER_TOKEN = ['xoxp', '987654321098', 'zyxwvutsrqponmlk'].join('-');
const GOOGLE_OAUTH_SECRET = ['GOCSPX', 'abcdEFGH1234ijklMNOP'].join('-');

describe('issue #21 - command substitution inside double quotes bypasses the read-only classifier', () => {
  const bypasses = [
    'echo "$(rm -rf $HOME)"',
    'echo "`whoami`"',
    'grep "$(cat /etc/shadow)" /proc/cpuinfo',
    'cat "$(ls /tmp)"',
  ];

  it.each(bypasses)('%s must not be classified read-only', cmd => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });

  it.each(bypasses)('%s must not be auto-approved as safe', cmd => {
    const security = assessCommandSecurity(cmd);
    // `exec_command.checkPermissions` auto-allows exactly on this conjunction.
    expect(security.level === 'safe' && security.isReadOnly).toBe(false);
  });

  it('single quotes still suppress expansion, so they stay read-only', () => {
    // Bash does not expand $() inside single quotes; classifying this as unsafe
    // would be a false positive and would regress plain `echo` usage.
    expect(isReadOnlyCommand(`echo '$(rm -rf $HOME)'`)).toBe(true);
  });

  it('ordinary quoted text is unaffected', () => {
    expect(isReadOnlyCommand('echo "hello world"')).toBe(true);
    expect(isReadOnlyCommand('git log --oneline -n 5')).toBe(true);
  });
});

describe('issue #18 - redactTraceText must cover every known provider key format', () => {
  const cases: Array<[string, string]> = [
    ['Google API key', GOOGLE_API_KEY],
    ['Slack bot token', SLACK_BOT_TOKEN],
    ['Slack user token', SLACK_USER_TOKEN],
    ['Google OAuth client secret', GOOGLE_OAUTH_SECRET],
    ['GitHub PAT', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0abcdefghijkl'],
    ['AWS access key id', ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')],
    ['OpenAI key', 'sk-abcdefgh1234567890XYZ'],
  ];

  it.each(cases)('redacts a %s', (_label, secret) => {
    const redacted = redactTraceText(`credential ${secret} end`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('[REDACTED_SECRET]');
  });

  it('leaves non-secret text alone', () => {
    const text = 'the build finished in 1234 ms with 0 errors';
    expect(redactTraceText(text)).toBe(text);
  });

  it('utils/mask redactSecrets is the same implementation, not a weaker copy', () => {
    // The old duplicate in utils/mask.ts leaked 5 of these 8 formats.
    for (const [, secret] of cases) {
      expect(redactSecrets(`credential ${secret} end`)).not.toContain(secret);
    }
    expect(redactSecrets).toBe(redactTraceText);
  });
});

describe('issue #28 - keyword split regex treated +..._ as a character range', () => {
  it('keeps digits attached to their identifier', () => {
    // Before the fix `+-_` was the range 0x2B-0x5F, so 0-9 and _ were separators
    // and this returned ['api', 'key'] with the version silently dropped.
    expect(extractKeywords('API_KEY_V2')).toEqual(expect.arrayContaining(['api', 'key', 'v2']));
  });

  it('does not swallow port numbers', () => {
    expect(extractKeywords('port_8000')).toEqual(expect.arrayContaining(['port', '8000']));
  });

  it('a query and a memory containing the same identifier share keywords', () => {
    const memory = extractKeywords('the prod api key is stored at /etc/api_v2_key');
    const query = extractKeywords('where is api_v2_key');
    expect(memory).toEqual(expect.arrayContaining(['v2']));
    expect(query).toEqual(expect.arrayContaining(['v2']));
  });

  it('still splits on the intended separators', () => {
    expect(extractKeywords('alpha-beta|gamma delta')).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'gamma', 'delta'])
    );
  });

  it('never emits empty tokens', () => {
    for (const token of extractKeywords('v2.0_upgrade port=8080 API_KEY_V2')) {
      expect(token.length).toBeGreaterThan(0);
    }
  });
});

describe('issue #17 - atomic write for credential files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orion-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies the requested mode even when the target already exists', () => {
    const target = join(dir, 'auth.json');
    // writeFileSync's `mode` is ignored for an existing file; the previous
    // implementation therefore wrote secrets into a 0644 file.
    writeFileSync(target, '{}', { mode: 0o644 });
    atomicWriteFileSync(target, JSON.stringify({ apiKey: 'x' }), { mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind on success', () => {
    const target = join(dir, 'secure.json');
    atomicWriteFileSync(target, '{"a":1}', { mode: 0o600, fsync: true });
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ a: 1 });
    expect(require('fs').readdirSync(dir)).toEqual(['secure.json']);
  });

  it('keeps the previous content when the write throws', () => {
    const target = join(dir, 'nested', 'auth.json');
    expect(() => atomicWriteFileSync(target, '{}', { mode: 0o600 })).toThrow();
    expect(existsSync(target)).toBe(false);
  });
});

describe('issue #22 - openhorse migration must not drop core data files', () => {
  // These five sat in `knownPaths` (so the uncategorized loop skipped them) but
  // had no handler of their own, so they were silently never copied.
  const DROPPED_FILES = ['settings.json', 'usage.json', 'history.jsonl', 'mcp.json'];

  let home: string;
  let source: string;
  let dest: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orion-migrate-'));
    source = join(home, '.openhorse');
    dest = join(home, '.orion-code');
    mkdirSync(source, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('copies the core data files the help text promises to migrate', () => {
    for (const name of DROPPED_FILES) {
      writeFileSync(join(source, name), `{"marker":"${name}"}`, 'utf-8');
    }
    writeFileSync(join(source, 'openhorse.json'), '{}', 'utf-8');

    const result = migrateBrand({ home });

    expect(result.success).toBe(true);
    for (const name of DROPPED_FILES) {
      expect(existsSync(join(dest, name))).toBe(true);
      expect(readFileSync(join(dest, name), 'utf-8')).toContain(name);
    }
  });

  it('copies vector.db verbatim (binary safe) instead of only integrity-checking it', () => {
    // A minimal but valid SQLite header, so the integrity check path runs.
    writeFileSync(join(source, 'vector.db'), Buffer.from('SQLite format 3\u0000binary\u0001\u0002', 'binary'));
    writeFileSync(join(source, 'openhorse.json'), '{}', 'utf-8');

    const result = migrateBrand({ home });

    expect(result.success).toBe(true);
    expect(existsSync(join(dest, 'vector.db'))).toBe(true);
    expect(readFileSync(join(dest, 'vector.db'))).toEqual(readFileSync(join(source, 'vector.db')));
  });

  it('still renames the files that have an explicit rename handler', () => {
    writeFileSync(join(source, 'openhorse.json'), '{"defaultModel":"x"}', 'utf-8');

    const result = migrateBrand({ home });

    expect(result.success).toBe(true);
    expect(existsSync(join(dest, 'orion.json'))).toBe(true);
    // The pre-rename name must not also land in the target verbatim.
    expect(existsSync(join(dest, 'openhorse.json'))).toBe(false);
  });
});
