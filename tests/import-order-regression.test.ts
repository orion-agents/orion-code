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
 * failures. It runs each order in a fresh Node process (no module cache) using
 * the compiled dist/ output.
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';

const rootDir = resolve(__dirname, '..');

/**
 * Run a snippet in a fresh Node process (no module cache) and assert it exits
 * cleanly with code 0.
 */
function assertImportOrder(modules: string[], _label: string): void {
  const code = modules
    .map(m => `require(${JSON.stringify(m)});`)
    .join('\n');
  // execFileSync throws on non-zero exit, which fails the test.
  execFileSync(
    process.execPath,
    ['-e', code],
    { cwd: rootDir, encoding: 'utf8', timeout: 30000 },
  );
}

describe('import-order regression (R1 circular dep)', () => {
  it('tools/web → services/config → runtime/subagents', () => {
    assertImportOrder(
      [
        resolve(rootDir, 'dist/tools/web'),
        resolve(rootDir, 'dist/services/config'),
        resolve(rootDir, 'dist/runtime/subagents'),
      ],
      'web-first',
    );
  });

  it('services/config → tools/web → runtime/subagents', () => {
    assertImportOrder(
      [
        resolve(rootDir, 'dist/services/config'),
        resolve(rootDir, 'dist/tools/web'),
        resolve(rootDir, 'dist/runtime/subagents'),
      ],
      'config-first',
    );
  });

  it('runtime/subagents → services/config → tools/web', () => {
    assertImportOrder(
      [
        resolve(rootDir, 'dist/runtime/subagents'),
        resolve(rootDir, 'dist/services/config'),
        resolve(rootDir, 'dist/tools/web'),
      ],
      'subagents-first',
    );
  });
});
