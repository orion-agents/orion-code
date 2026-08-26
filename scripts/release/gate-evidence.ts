#!/usr/bin/env ts-node

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

import { createGateEvidenceReceiptV1 } from '../../src/runtime/release-receipts';
import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';

interface GateEvidenceArgumentsV1 {
  readonly gateId: string;
  readonly output: string;
  readonly command: string;
  readonly commandArguments: readonly string[];
}

export function parseGateEvidenceArgumentsV1(argv: readonly string[]): GateEvidenceArgumentsV1 {
  const separator = argv.indexOf('--');
  const options = separator >= 0 ? argv.slice(0, separator) : argv;
  const commandLine = separator >= 0 ? argv.slice(separator + 1) : [];
  const gateId = optionValue(options, '--id');
  const output = optionValue(options, '--out');
  const [command, ...commandArguments] = commandLine;
  if (!gateId || !output || !command) {
    throw new Error('Usage: gate-evidence --id ID --out receipt.json -- command [args...]');
  }
  return { gateId, output: resolve(output), command, commandArguments };
}

function main(): void {
  const args = parseGateEvidenceArgumentsV1(process.argv.slice(2));
  const startedAt = performance.now();
  const outcome = spawnSync(args.command, [...args.commandArguments], {
    cwd: resolve(__dirname, '../..'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  const durationMs = Math.max(0, performance.now() - startedAt);
  const stdout = outcome.stdout ?? '';
  const stderr = outcome.error?.message ?? outcome.stderr ?? '';
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, '../../package.json'), 'utf8')
  ) as { version: string };
  const gitSha = commandOutput('git', ['rev-parse', 'HEAD']);
  const receipt = createGateEvidenceReceiptV1({
    version: 1,
    kind: 'orion.gate-evidence',
    createdAt: new Date().toISOString(),
    gateId: args.gateId,
    source: { gitSha, packageVersion: packageJson.version },
    commandDigest: digestRuntimeValue({ command: args.command, args: args.commandArguments }),
    outputDigest: createHash('sha256').update(stdout).update('\0').update(stderr).digest('hex'),
    durationMs,
    status: outcome.status === 0 ? 'pass' : 'fail',
  });
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (outcome.status !== 0) process.exitCode = outcome.status ?? 1;
}

function commandOutput(command: string, args: readonly string[]): string {
  const outcome = spawnSync(command, [...args], {
    cwd: resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  if (outcome.status !== 0 || !outcome.stdout.trim()) {
    throw new Error(`${command} ${args.join(' ')} failed.`);
  }
  return outcome.stdout.trim();
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
      `${JSON.stringify({ kind: 'orion.gate-evidence-error', failClosed: true, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}
