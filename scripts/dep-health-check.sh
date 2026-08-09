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

failUnless(
  manifest.engines?.node === '^20.0.0 || ^22.0.0 || ^24.0.0',
  'package engines must explicitly support only the tested Node 20/22/24 majors',
);
failUnless(major(production.openai) === 6, 'openai must stay on the Node-20-compatible 6.x line');
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
  failUnless(
    !installed.engines?.node || !/>=\s*22/.test(installed.engines.node),
    `installed openai excludes Node 20 via engines.node=${installed.engines?.node}`,
  );
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

if (errors.length > 0) {
  console.error('DEPENDENCY_POLICY_FAILED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('DEPENDENCY_POLICY_OK node=20|22|24 openai=6 cjs=ok chat-completions=ok');
console.log('DEPENDENCY_EXEMPTION ink=3 react=17 removal=src/tui-ui/INK-REMOVAL-MIGRATION.md');
NODE

if [[ "$mode" == "--policy-only" ]]; then
  exit 0
fi

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
