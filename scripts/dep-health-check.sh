#!/usr/bin/env bash
# Dependency contract gate for the supported v0.1.4 runtime matrix.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${1:-full}"
if [[ "$mode" != "full" && "$mode" != "--policy-only" ]]; then
  echo "Usage: $0 [--policy-only]" >&2
  exit 2
fi

node <<'NODE'
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const production = manifest.dependencies ?? {};
const development = manifest.devDependencies ?? {};
const lockRoot = lock.packages?.[''] ?? {};
const errors = [];

const failUnless = (condition, message) => {
  if (!condition) errors.push(message);
};
const major = value => Number(String(value ?? '').match(/\d+/)?.[0] ?? NaN);
const supportedNodeMajors = new Set([20, 22, 24]);
const runtimeNodeMajor = Number(process.versions.node.split('.')[0]);

failUnless(
  manifest.engines?.node === '^20.0.0 || ^22.0.0 || ^24.0.0',
  'package engines must explicitly support only the tested Node 20/22/24 majors',
);
failUnless(
  supportedNodeMajors.has(runtimeNodeMajor),
  `current Node ${process.versions.node} is unsupported; use Node 20, 22, or 24`,
);
failUnless(major(production.openai) === 6, 'openai must stay on the validated 6.x line');
failUnless(!('lodash-es' in production), 'zero-reference lodash-es must not be a direct dependency');
failUnless(!('type-fest' in production), 'zero-reference type-fest must not be a direct dependency');
failUnless(
  !Object.keys(production).some(name => name.startsWith('@types/')),
  '@types/* packages belong in devDependencies, not production dependencies',
);
failUnless(
  '@types/better-sqlite3' in development,
  '@types/better-sqlite3 must remain a devDependency',
);
failUnless(
  major(development['@types/jest']) === major(development.jest),
  `@types/jest major must match jest major (types=${development['@types/jest']}, jest=${development.jest})`,
);
failUnless(
  !('@types/better-sqlite3' in (lockRoot.dependencies ?? {})) &&
    '@types/better-sqlite3' in (lockRoot.devDependencies ?? {}),
  'package-lock root metadata must preserve @types/better-sqlite3 as development-only',
);

// Ink is a deprecated compatibility renderer. Upgrading it in-place would
// force ESM + React 19 and, for Ink 7, Node >=22. Remove the renderer according
// to the checked-in migration plan instead of silently breaking Node 20/CJS.
failUnless(major(production.ink) === 3, 'Ink compatibility exemption is pinned to major 3');
failUnless(major(production.react) === 17, 'Ink compatibility exemption requires React 17');
failUnless(
  existsSync(join(root, 'src/tui-ui/INK-REMOVAL-MIGRATION.md')),
  'Ink/React exemption requires the executable removal roadmap',
);

let OpenAI;
try {
  const loaded = require('openai');
  OpenAI = loaded.default ?? loaded;
} catch (error) {
  errors.push(`openai must expose a CommonJS require entry: ${error.message}`);
}
if (OpenAI) {
  const installed = JSON.parse(
    readFileSync(join(root, 'node_modules/openai/package.json'), 'utf8'),
  );
  failUnless(major(installed.version) === 6, `installed openai must be 6.x, found ${installed.version}`);
  try {
    const client = new OpenAI({ apiKey: 'dependency-contract-probe' });
    failUnless(
      typeof client.chat?.completions?.create === 'function',
      'openai Chat Completions API is unavailable',
    );
  } catch (error) {
    errors.push(`openai CommonJS Chat Completions probe failed: ${error.message}`);
  }
}

let semanticProbe = 'unavailable';
let semanticDb;
try {
  const loadedDatabase = require('better-sqlite3');
  const Database = loadedDatabase.default ?? loadedDatabase;
  semanticDb = new Database(':memory:', { allowExtension: true });
  const loadedSqliteVec = require('sqlite-vec');
  const sqliteVec = loadedSqliteVec.default ?? loadedSqliteVec;
  failUnless(typeof sqliteVec.load === 'function', 'sqlite-vec must export load(database)');
  if (typeof sqliteVec.load === 'function') {
    sqliteVec.load(semanticDb);
    const version = semanticDb.prepare('SELECT vec_version() AS version').get()?.version;
    semanticDb.exec('CREATE VIRTUAL TABLE vec_health USING vec0(embedding FLOAT[4])');
    failUnless(typeof version === 'string' && version.length > 0, 'sqlite-vec version probe failed');
    failUnless(
      semanticDb.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_health'").get()?.name ===
        'vec_health',
      'sqlite-vec vec0 virtual-table probe failed',
    );
    semanticProbe = String(version);
  }
} catch (error) {
  errors.push(
    `semantic native dependencies failed to load: ${error.message}. ` +
      'Run `npm rebuild better-sqlite3 && npm rebuild sqlite-vec` with the active Node.js version',
  );
} finally {
  try {
    semanticDb?.close();
  } catch (error) {
    errors.push(`semantic dependency probe cleanup failed: ${error.message}`);
  }
}

if (errors.length > 0) {
  console.error('DEPENDENCY_POLICY_FAILED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(
  `DEPENDENCY_POLICY_OK node=20|22|24 openai=6 cjs=ok chat-completions=ok sqlite-vec=${semanticProbe}`,
);
console.log('DEPENDENCY_EXEMPTION ink=3 react=17 removal=src/tui-ui/INK-REMOVAL-MIGRATION.md');
NODE

if [[ "$mode" == "--policy-only" ]]; then
  exit 0
fi

echo
echo "== native dependency ABI =="
node <<'NODE'
try {
  const loaded = require('better-sqlite3');
  const Database = loaded.default ?? loaded;
  const db = new Database(':memory:');
  db.prepare('SELECT 1 AS ok').get();
  db.close();
  console.log(
    `better-sqlite3: ok node=${process.versions.node} abi=${process.versions.modules}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('NATIVE_DEPENDENCY_FAILED better-sqlite3');
  console.error(`- ${message}`);
  console.error('- Run: npm rebuild better-sqlite3');
  process.exit(1);
}
NODE

echo
echo "== dependency tree consistency =="
npm ls --all >/dev/null
echo "npm ls: ok"

echo
echo "== npm audit (high severity gate) =="
npm audit --audit-level=high

echo
echo "== npm outdated (report only; majors require contract review) =="
npm outdated || true

echo
echo "Dependency health check complete."
