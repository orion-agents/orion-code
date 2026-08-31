import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const RELEASE_STATUS_NOT_RELEASABLE = 'NOT_RELEASABLE';
export const SIDECAR_ARCHIVE_ROOT = 'orion-code-sidecar';
export const SUPPORTED_SIDECAR_TARGETS = Object.freeze({
  'darwin-aarch64': Object.freeze({ platform: 'darwin', arch: 'arm64' }),
});

const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TARGET = /^[a-z0-9]+(?:-[a-z0-9_]+)*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  '.git',
  '.github',
  '.cache',
  'coverage',
  '__tests__',
  'test',
  'tests',
]);
const FORBIDDEN_SECRET_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^(?:credentials?|secrets?)(?:\.(?:json|txt|ya?ml))?$/i,
  /\.(?:key|pem|p12|pfx)$/i,
];
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const TOKEN_MARKERS = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opurs]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
];

export function parseCliArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }
    const equals = argument.indexOf('=');
    if (equals > 2) {
      const name = argument.slice(0, equals);
      if (values.has(name) || flags.has(name)) throw new Error(`Duplicate option: ${name}`);
      values.set(name, argument.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (values.has(argument) || flags.has(argument)) {
        throw new Error(`Duplicate option: ${argument}`);
      }
      values.set(argument, next);
      index += 1;
    } else {
      if (values.has(argument) || flags.has(argument)) {
        throw new Error(`Duplicate option: ${argument}`);
      }
      flags.add(argument);
    }
  }
  return { values, flags };
}

export function requireOption(parsed, name) {
  const value = parsed.values.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function optionalOption(parsed, name) {
  return parsed.values.get(name);
}

export function hasFlag(parsed, name) {
  return parsed.flags.has(name);
}

export function rejectUnknownOptions(parsed, allowedValues, allowedFlags) {
  for (const name of parsed.values.keys()) {
    if (!allowedValues.has(name)) throw new Error(`Unknown option: ${name}`);
  }
  for (const name of parsed.flags) {
    if (!allowedFlags.has(name)) throw new Error(`Unknown flag: ${name}`);
  }
}

export function assertExactSemver(version, label = 'version') {
  if (!EXACT_SEMVER.test(version)) throw new Error(`${label} must be an exact semver.`);
  return version;
}

export function assertGitSha(gitSha) {
  if (!GIT_SHA.test(gitSha)) throw new Error('git SHA must be exactly 40 lowercase hex bytes.');
  return gitSha;
}

export function assertSha256(value, label = 'SHA-256') {
  if (!SHA256.test(value)) throw new Error(`${label} must be 64 lowercase hex characters.`);
  return value;
}

export function assertSupportedTarget(target) {
  if (!SAFE_TARGET.test(target) || !SUPPORTED_SIDECAR_TARGETS[target]) {
    throw new Error(
      `Unsupported target ${target}; this release tooling currently enables only darwin-aarch64.`
    );
  }
  return target;
}

export function assertSafeRelativePath(path, label = 'path') {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    Buffer.byteLength(path, 'utf8') > 512 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes(':') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error(`${label} must be a safe portable relative path.`);
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  return path;
}

export function assertSafeBasename(name, label = 'filename') {
  assertSafeRelativePath(name, label);
  if (name.includes('/')) throw new Error(`${label} must not contain a directory.`);
  return name;
}

export function resolveContained(root, child, label = 'path') {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const relation = relative(resolvedRoot, resolvedChild);
  if (
    relation === '' ||
    relation.startsWith(`..${sep}`) ||
    relation === '..' ||
    isAbsolute(relation)
  ) {
    throw new Error(`${label} must resolve below its managed root.`);
  }
  return resolvedChild;
}

export function assertPathOutsideRoot(path, root, label) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const relation = relative(resolvedRoot, resolvedPath);
  if (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  ) {
    throw new Error(`${label} must be outside the source checkout.`);
  }
}

export function ensureRegularFile(path, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  return metadata;
}

export function ensurePrivateKeyFile(path) {
  const metadata = ensureRegularFile(path, 'test private key');
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('test private key must not be readable or writable by group/other users.');
  }
}

export function ensureEmptyOutputDirectory(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('output must be a real directory, not a symlink.');
  }
  const entries = readdirSync(path);
  if (entries.length > 0) throw new Error('output directory must be empty.');
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortJson(value), null, 2)}\n`, 'utf8');
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = sortJson(value[key]);
    return result;
  }
  return value;
}

export function writeFileExclusive(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { flag: 'wx', mode });
}

export function readJsonFile(path, label = 'JSON file') {
  ensureRegularFile(path, label);
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
  return value;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path) {
  ensureRegularFile(path, 'hashed file');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export function commandOutput(command, args, cwd, maxBuffer = 16 * 1024 * 1024) {
  return execFileSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function assertRfc3339(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp with milliseconds.`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new Error(`${label} is not a valid timestamp.`);
  }
  return value;
}

export function isoFromEpochSeconds(epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
    throw new Error('source date epoch must be a non-negative safe integer.');
  }
  return new Date(epochSeconds * 1000).toISOString();
}

export function isExcludedReleasePath(relativePath) {
  const segments = relativePath.split('/');
  if (segments.some(segment => FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase()))) return true;
  const basename = segments.at(-1) ?? '';
  if (/\.(?:map|d\.ts|d\.mts|tsbuildinfo)$/i.test(basename)) return true;
  if (/^(?:readme|changelog|history)(?:\.[^.]+)?$/i.test(basename)) return true;
  return false;
}

export function assertNoSecretPath(relativePath) {
  assertSafeRelativePath(relativePath, 'payload path');
  const basename = relativePath.split('/').at(-1) ?? '';
  if (FORBIDDEN_SECRET_NAMES.some(pattern => pattern.test(basename))) {
    throw new Error(`Refusing to package secret-like path ${relativePath}.`);
  }
}

export function sanitizeTextPayload(bytes, relativePath, forbiddenAbsolutePaths = []) {
  let text = bytes.toString('utf8');
  if (/\.(?:js|mjs|cjs)$/i.test(relativePath)) {
    text = text.replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*(?:\r?\n|$)/gm, '');
  }
  for (const absolutePath of forbiddenAbsolutePaths.filter(Boolean)) {
    if (text.includes(absolutePath)) {
      throw new Error(`Payload ${relativePath} contains an absolute build path.`);
    }
  }
  if (PRIVATE_KEY_MARKER.test(text) || TOKEN_MARKERS.some(pattern => pattern.test(text))) {
    throw new Error(`Payload ${relativePath} contains secret-like material.`);
  }
  return Buffer.from(text, 'utf8');
}

export function shouldTreatAsText(relativePath) {
  return /\.(?:cjs|css|html|js|json|md|mjs|plist|sh|txt|xml|yaml|yml)$/i.test(relativePath);
}

export function assertNoReceiptBinding(value, path = 'manifest') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoReceiptBinding(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes('receipt')) {
      throw new Error(
        `${path} must not contain receipt field ${key}; receipt binding is external.`
      );
    }
    assertNoReceiptBinding(child, `${path}.${key}`);
  }
}

export function assertExactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

export function realpathRegularFile(path, label) {
  ensureRegularFile(path, label);
  const canonical = realpathSync(path);
  ensureRegularFile(canonical, label);
  return canonical;
}

export function failClosedCli(kind, operation) {
  return Promise.resolve()
    .then(operation)
    .catch(error => {
      process.stderr.write(
        `${JSON.stringify({
          kind,
          fail_closed: true,
          error: error instanceof Error ? error.message : String(error),
        })}\n`
      );
      process.exitCode = 1;
    });
}
