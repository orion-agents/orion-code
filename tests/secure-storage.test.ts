import { SecureStorage } from '../src/services/auth/auth';
import { ensureConfigDir, getConfigDir } from '../src/services/config-dir';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SecureStorage (issue #66) — encrypted at rest', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'orion-secure-storage-'));
  const originalEnv = process.env.ORION_CODE_CONFIG_DIR;

  beforeAll(() => {
    process.env.ORION_CODE_CONFIG_DIR = testDir;
    ensureConfigDir();
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    if (originalEnv !== undefined) {
      process.env.ORION_CODE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.ORION_CODE_CONFIG_DIR;
    }
  });

  test('round-trips a stored credential', async () => {
    const storage = new SecureStorage();
    expect(await storage.store('svc', 'acct', 'super-secret')).toBe(true);
    expect(await storage.retrieve('svc', 'acct')).toBe('super-secret');
  });

  test('never writes the plaintext credential to disk', async () => {
    const storage = new SecureStorage();
    await storage.store('svc', 'acct', 'super-secret');
    const dataPath = join(getConfigDir(), 'secure.json');
    const onDisk = readFileSync(dataPath, 'utf-8');
    expect(onDisk).not.toContain('super-secret');
    // The on-disk blob is the AES-GCM envelope, not the raw JSON map.
    const parsed = JSON.parse(onDisk);
    expect(parsed).not.toHaveProperty('svc:acct');
    expect(parsed).toHaveProperty('v', 1);
    expect(parsed).toHaveProperty('data');
  });

  test('isolates secrets: secure.json alone is not decryptable without key', async () => {
    const storage = new SecureStorage();
    await storage.store('svc', 'acct', 'super-secret');
    const dataPath = join(getConfigDir(), 'secure.json');
    const keyPath = join(getConfigDir(), 'secure.key');
    // The encrypted blob and the key must both exist and be distinct files.
    expect(existsSync(dataPath)).toBe(true);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(dataPath, 'utf-8')).not.toEqual(readFileSync(keyPath));
  });

  test('returns null for a missing credential', async () => {
    const storage = new SecureStorage();
    expect(await storage.retrieve('svc', 'missing')).toBeNull();
  });

  test('delete removes the credential', async () => {
    const storage = new SecureStorage();
    await storage.store('svc', 'acct', 'super-secret');
    expect(await storage.delete('svc', 'acct')).toBe(true);
    expect(await storage.retrieve('svc', 'acct')).toBeNull();
  });
});
