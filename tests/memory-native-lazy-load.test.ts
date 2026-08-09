import { spawnSync } from 'child_process';
import { join } from 'path';

describe('optional semantic-memory native dependencies', () => {
  test('core tools load when better-sqlite3 is unavailable and semantic memory is disabled', () => {
    const repo = join(__dirname, '..');
    const script = `
      const Module = require('module');
      const originalLoad = Module._load;
      Module._load = function(request) {
        if (request === 'better-sqlite3' || request === 'sqlite-vec') {
          const error = new Error('simulated native binding unavailable');
          error.code = 'MODULE_NOT_FOUND';
          throw error;
        }
        return originalLoad.apply(this, arguments);
      };
      delete process.env.ORION_CODE_EMBEDDING_PROVIDER;
      require('ts-node/register');
      const tools = require('./src/tools/index.ts');
      if (!Array.isArray(tools.TOOLS) || tools.TOOLS.length === 0) process.exit(2);
      process.stdout.write('TOOLS_IMPORT_OK');
    `;

    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ORION_CODE_EMBEDDING_PROVIDER: '' },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('simulated native binding unavailable');
    expect(result.stdout).toBe('TOOLS_IMPORT_OK');
  });
});
