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

  test('memory and diagnostics barrels load without resolving native modules', () => {
    const repo = join(__dirname, '..');
    const script = `
      const Module = require('module');
      const originalLoad = Module._load;
      Module._load = function(request) {
        if (request === 'better-sqlite3' || request === 'sqlite-vec') {
          const error = new Error('simulated optional native module missing');
          error.code = 'MODULE_NOT_FOUND';
          throw error;
        }
        return originalLoad.apply(this, arguments);
      };
      require('ts-node/register');
      const memory = require('./src/memory/index.ts');
      const maintenance = require('./src/services/storage-maintenance.ts');
      if (typeof memory.searchMemories !== 'function') process.exit(2);
      if (typeof maintenance.collectStorageReport !== 'function') process.exit(3);
      process.stdout.write('NON_NATIVE_IMPORTS_OK');
    `;

    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: repo,
      encoding: 'utf8',
    });

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toBe('NON_NATIVE_IMPORTS_OK');
  });

  test('explicit semantic and vector-maintenance calls fail closed with ABI repair guidance', () => {
    const repo = join(__dirname, '..');
    const script = `
      const { mkdtempSync, mkdirSync, writeFileSync } = require('fs');
      const { tmpdir } = require('os');
      const { join } = require('path');
      const configHome = mkdtempSync(join(tmpdir(), 'orion-native-failure-'));
      mkdirSync(join(configHome, 'projects'));
      writeFileSync(join(configHome, 'vector.db'), 'existing-vector-database');
      process.env.ORION_CODE_CONFIG_DIR = configHome;

      const Module = require('module');
      const originalLoad = Module._load;
      let nativeFailureMode = 'abi';
      Module._load = function(request) {
        if (request === 'better-sqlite3') {
          if (nativeFailureMode === 'missing') {
            const error = new Error('simulated better-sqlite3 MODULE_NOT_FOUND');
            error.code = 'MODULE_NOT_FOUND';
            throw error;
          }
          return class IncompatibleDatabase {
            constructor() {
              const error = new Error(
                'was compiled against a different Node.js version using NODE_MODULE_VERSION 115'
              );
              error.code = 'ERR_DLOPEN_FAILED';
              throw error;
            }
          };
        }
        return originalLoad.apply(this, arguments);
      };

      require('ts-node/register');
      const { VectorStore } = require('./src/memory/vector-store.ts');
      const { searchMemoriesAsync } = require('./src/memory/storage.ts');
      const { collectStorageReport } = require('./src/services/storage-maintenance.ts');

      const assertDiagnostic = (error, expectedCause) => {
        if (error?.code !== 'ORION_BETTER_SQLITE3_UNAVAILABLE') process.exit(4);
        if (!error.message.includes(expectedCause)) process.exit(5);
        if (!error.message.includes('npm rebuild better-sqlite3')) process.exit(6);
      };

      (async () => {
        try {
          new VectorStore({ dbPath: join(configHome, 'direct.db') });
          process.exit(7);
        } catch (error) {
          assertDiagnostic(error, 'NODE_MODULE_VERSION 115');
        }

        nativeFailureMode = 'missing';
        try {
          await searchMemoriesAsync('explicit semantic request');
          process.exit(8);
        } catch (error) {
          assertDiagnostic(error, 'MODULE_NOT_FOUND');
        }

        nativeFailureMode = 'abi';
        try {
          collectStorageReport();
          process.exit(9);
        } catch (error) {
          assertDiagnostic(error, 'NODE_MODULE_VERSION 115');
        }

        process.stdout.write('NATIVE_FAILURE_DIAGNOSTIC_OK');
      })().catch(error => {
        console.error(error);
        process.exit(10);
      });
    `;

    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: repo,
      encoding: 'utf8',
    });

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toBe('NATIVE_FAILURE_DIAGNOSTIC_OK');
  });
});
