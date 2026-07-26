import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

if (!process.env.ORION_CODE_CONFIG_DIR) {
  process.env.ORION_CODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openhorse-jest-config-'));
}
