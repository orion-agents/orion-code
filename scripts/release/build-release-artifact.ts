#!/usr/bin/env ts-node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import { createTarballArtifactReceiptV1 } from '../../src/runtime/release-receipts';

interface ArgumentsV1 {
  readonly outputDirectory: string;
  readonly receiptPath: string;
}

interface NpmPackEntryV1 {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly integrity: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly entryCount: number;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly mode?: number;
  }[];
}

export interface ReleaseArtifactSourceV1 {
  readonly gitSha: string;
  readonly dirty: boolean;
}

export function parseBuildArtifactArgumentsV1(argv: readonly string[]): ArgumentsV1 {
  const outputDirectory = optionValue(argv, '--out-dir');
  const receiptPath = optionValue(argv, '--receipt');
  if (!outputDirectory || !receiptPath) {
    throw new Error('Usage: build-release-artifact --out-dir PATH --receipt PATH');
  }
  return { outputDirectory: resolve(outputDirectory), receiptPath: resolve(receiptPath) };
}

function main(): void {
  const args = parseBuildArtifactArgumentsV1(process.argv.slice(2));
  const source = captureReleaseArtifactSourceV1();
  mkdirSync(args.outputDirectory, { recursive: true });
  const packed = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', args.outputDirectory],
      { cwd: resolve(__dirname, '../..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
  ) as NpmPackEntryV1[];
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error(`npm pack must produce exactly one artifact; observed ${packed.length}.`);
  }
  const entry = packed[0];
  const tarballPath = join(args.outputDirectory, basename(entry.filename));
  const manifest = [...entry.files]
    .map(file => ({ path: file.path, size: file.size, mode: file.mode ?? null }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const receipt = createTarballArtifactReceiptV1({
    version: 1,
    kind: 'orion.tarball-artifact',
    createdAt: new Date().toISOString(),
    source,
    package: { name: entry.name, version: entry.version },
    tarball: {
      filename: basename(entry.filename),
      sha256: createHash('sha256').update(readFileSync(tarballPath)).digest('hex'),
      npmIntegrity: entry.integrity,
      bytes: entry.size,
      unpackedBytes: entry.unpackedSize,
      entryCount: entry.entryCount,
      manifestDigest: digestRuntimeValue(manifest),
    },
  });
  mkdirSync(dirname(args.receiptPath), { recursive: true });
  writeFileSync(args.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

export function captureReleaseArtifactSourceV1(
  cwd = resolve(__dirname, '../..')
): ReleaseArtifactSourceV1 {
  return {
    gitSha: command('git', ['rev-parse', 'HEAD'], cwd).trim(),
    dirty: command('git', ['status', '--porcelain'], cwd).trim().length > 0,
  };
}

function command(
  executable: string,
  args: readonly string[],
  cwd = resolve(__dirname, '../..')
): string {
  return execFileSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ kind: 'orion.tarball-artifact-error', failClosed: true, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}
