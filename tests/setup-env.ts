import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Every Jest test environment owns an isolated config root. Never inherit a caller's
// ORION_CODE_CONFIG_DIR: doing so can make concurrent matrices share or modify real data.
process.env.ORION_CODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'orion-jest-config-'));
