#!/usr/bin/env bash
# Dependency contract gate for the supported runtime matrix.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

mode="${1:-offline}"
if [[ "$mode" != "offline" && "$mode" != "--policy-only" && "$mode" != "--full-network" ]]; then
  echo "Usage: $0 [--policy-only|--full-network]" >&2
  exit 2
fi

node <<'NODE'
const { readFileSync } = require('fs');
const { join } = require('path');

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'));
const production = manifest.dependencies ?? {};
const development = manifest.devDependencies ?? {};
const lockRoot = lock.packages?.[''] ?? {};
const errors = [];

const failUnless = (condition, message) => {
  if (!condition) errors.push(message);
};
const major = value => Number(String(value ?? '').match(/\d+/)?.[0] ?? NaN);
const supportedNodeFloors = new Map([
  [22, [22, 12, 0]],
  [24, [24, 0, 0]],
  [26, [26, 0, 0]],
]);
const runtimeNodeVersion = process.versions.node.split('.').map(Number);
const runtimeNodeMajor = runtimeNodeVersion[0];
const compareNodeVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

failUnless(
  manifest.engines?.node === '^22.12.0 || ^24.0.0 || ^26.0.0',
  'package engines must match the tested Node 22.12+/24/26 build and runtime floor',
);
failUnless(
  lockRoot.engines?.node === manifest.engines?.node,
  `npm-shrinkwrap root engines must match package engines (package=${manifest.engines?.node ?? 'missing'}, shrinkwrap=${lockRoot.engines?.node ?? 'missing'})`,
);
failUnless(
  supportedNodeFloors.has(runtimeNodeMajor),
  `current Node ${process.versions.node} is unsupported; use Node 22, 24, or 26`,
);
const runtimeNodeFloor = supportedNodeFloors.get(runtimeNodeMajor);
failUnless(
  runtimeNodeFloor && compareNodeVersions(runtimeNodeVersion, runtimeNodeFloor) >= 0,
  `current Node ${process.versions.node} is below the supported floor ${runtimeNodeFloor?.join('.') ?? 'unknown'}`,
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
  'npm-shrinkwrap root metadata must preserve @types/better-sqlite3 as development-only',
);
failUnless(
  !('shell-quote' in production) && !lock.packages?.['node_modules/shell-quote'],
  'unused shell-quote dependency must not return with the retired renderer',
);

failUnless(
  !('ink' in production) && !('react' in production) && !('react-dom' in production),
  'Ink and runtime React dependencies must not return',
);
failUnless(
  major(development.react) === 18 &&
    major(development['react-dom']) === 18 &&
    major(development['@types/react']) === 18 &&
    major(development['@types/react-dom']) === 18,
  'the bundled Web client must keep React 18 and its types in devDependencies',
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
      'Run `npm rebuild better-sqlite3` and reinstall dependencies with the active Node.js version if the sqlite-vec platform extension is missing',
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
  `DEPENDENCY_POLICY_OK node=22|24|26 openai=6 cjs=ok chat-completions=ok sqlite-vec=${semanticProbe}`,
);
console.log('DEPENDENCY_REMOVAL ink=absent runtime-react=absent web-react=18');
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

if [[ "$mode" == "--full-network" ]]; then
  echo
  echo "== npm audit (high severity network gate) =="
  npm audit --audit-level=high --fetch-retries=1 --fetch-timeout=10000

  echo
  echo "== npm outdated (network report only; majors require contract review) =="
  npm outdated --fetch-retries=1 --fetch-timeout=10000 || true
else
  echo
  echo "== registry reports skipped (offline default; use --full-network) =="
fi

echo
echo "Dependency health check complete."
