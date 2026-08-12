/**
 * Import-order regression test for R1 (circular dependency).
 *
 * The dependency chain was:
 *   config.ts → subagents barrel → runtime-integration.ts → tools/index.ts → web.ts → config.ts
 *
 * When `tools/web` loaded before `services/config`, `WEB_TOOLS` was still
 * undefined and `...WEB_TOOLS` threw "WEB_TOOLS is not iterable".
 *
 * This test verifies that importing in any order does not cause module-load
 * failures. It runs each order in a fresh Node process (no module cache) and
 * loads TypeScript sources through ts-node, so a clean checkout does not need
 * a pre-existing dist/ build.
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';

const rootDir = resolve(__dirname, '..');
const tsNodeRegister = require.resolve('ts-node/register/transpile-only');

/**
 * Run a snippet in a fresh Node process (no module cache) and assert it exits
 * cleanly with code 0.
 */
function assertImportOrder(modules: string[], _label: string): void {
  const code = modules.map(m => `require(${JSON.stringify(m)});`).join('\n');
  // execFileSync throws on non-zero exit, which fails the test.
  execFileSync(process.execPath, ['-r', tsNodeRegister, '-e', code], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      TS_NODE_PROJECT: resolve(rootDir, 'tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: 'true',
    },
  });
}

describe('import-order regression (R1 circular dep)', () => {
  it('tools/web → services/config → runtime/subagents', () => {
    assertImportOrder(
      [
        resolve(rootDir, 'src/tools/web'),
        resolve(rootDir, 'src/services/config'),
        resolve(rootDir, 'src/runtime/subagents'),
      ],
      'web-first'
    );
  });

  it('services/config → tools/web → runtime/subagents', () => {
    assertImportOrder(
      [
        resolve(rootDir, 'src/services/config'),
        resolve(rootDir, 'src/tools/web'),
        resolve(rootDir, 'src/runtime/subagents'),
      ],
      'config-first'
    );
  });

  it('runtime/subagents → services/config → tools/web', () => {
    assertImportOrder(
      [
        resolve(rootDir, 'src/runtime/subagents'),
        resolve(rootDir, 'src/services/config'),
        resolve(rootDir, 'src/tools/web'),
      ],
      'subagents-first'
    );
  });
});
