import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ensureConfigDir,
  getConfigHome,
  getDataHome,
  getGlobalConfigPath,
  getHistoryPath,
  getProjectsDir,
  getSessionCatalogPath,
  getSessionLeasesDir,
} from '../src/product/paths';

describe('Orion config and data roots', () => {
  const originalConfigDirectory = process.env.ORION_CODE_CONFIG_DIR;
  const originalDataDirectory = process.env.ORION_CODE_DATA_DIR;
  const roots: string[] = [];

  afterEach(() => {
    restore('ORION_CODE_CONFIG_DIR', originalConfigDirectory);
    restore('ORION_CODE_DATA_DIR', originalDataDirectory);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('keeps user configuration separate from mutable sidecar data', () => {
    const configDirectory = mkdtempSync(join(tmpdir(), 'orion-acp-config-'));
    const dataDirectory = mkdtempSync(join(tmpdir(), 'orion-acp-data-'));
    roots.push(configDirectory, dataDirectory);
    process.env.ORION_CODE_CONFIG_DIR = configDirectory;
    process.env.ORION_CODE_DATA_DIR = dataDirectory;

    ensureConfigDir();

    expect(getConfigHome()).toBe(configDirectory);
    expect(getDataHome()).toBe(dataDirectory);
    expect(getGlobalConfigPath()).toBe(join(configDirectory, 'orion.json'));
    expect(getHistoryPath()).toBe(join(dataDirectory, 'history.jsonl'));
    expect(getProjectsDir()).toBe(join(dataDirectory, 'projects'));
    expect(getSessionCatalogPath()).toBe(join(dataDirectory, 'session-catalog.json'));
    expect(existsSync(join(configDirectory, 'session-catalog.json'))).toBe(false);
    expect(existsSync(getSessionLeasesDir())).toBe(true);
  });

  test('uses the historical layout when no data override is provided', () => {
    const configDirectory = mkdtempSync(join(tmpdir(), 'orion-acp-compat-'));
    roots.push(configDirectory);
    process.env.ORION_CODE_CONFIG_DIR = configDirectory;
    delete process.env.ORION_CODE_DATA_DIR;
    expect(getDataHome()).toBe(configDirectory);
    expect(getProjectsDir()).toBe(join(configDirectory, 'projects'));
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
