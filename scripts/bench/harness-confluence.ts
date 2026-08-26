#!/usr/bin/env ts-node

import { resolve } from 'path';

import {
  ArchitectureConfluenceError,
  runArchitectureConfluenceAuditV1,
  type ArchitectureConfluenceReceiptV1,
  type RunArchitectureConfluenceAuditOptionsV1,
} from '../../src/runtime/harness-confluence';

export interface HarnessConfluenceGateDependenciesV1 {
  readonly audit?: (
    options: RunArchitectureConfluenceAuditOptionsV1
  ) => Promise<ArchitectureConfluenceReceiptV1>;
  readonly writeStdout?: (output: string) => void;
  readonly writeStderr?: (output: string) => void;
}

interface HarnessConfluenceArgumentsV1 {
  readonly repositoryRoot: string;
  readonly pretty: boolean;
}

/**
 * Fail-closed command implementation for the future `npm run test:harness-confluence` gate.
 * GO returns 0, an audited NO_GO returns 1, and invalid arguments/audit failures return 2.
 */
export async function runHarnessConfluenceGateV1(
  argv: readonly string[],
  dependencies: HarnessConfluenceGateDependenciesV1 = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? (output => process.stdout.write(output));
  const writeStderr = dependencies.writeStderr ?? (output => process.stderr.write(output));

  try {
    const args = parseArguments(argv);
    const receipt = await (dependencies.audit ?? runArchitectureConfluenceAuditV1)({
      repositoryRoot: args.repositoryRoot,
    });
    writeStdout(`${JSON.stringify(receipt, null, args.pretty ? 2 : 0)}\n`);
    return receipt.decision === 'GO' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(
      `${JSON.stringify({
        version: 1,
        type: 'architecture_confluence_gate_error',
        failClosed: true,
        error: message,
      })}\n`
    );
    return 2;
  }
}

function parseArguments(argv: readonly string[]): HarnessConfluenceArgumentsV1 {
  let repositoryRoot = process.cwd();
  let pretty = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--pretty') {
      pretty = true;
      continue;
    }
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new ArchitectureConfluenceError('--root requires a repository path.');
      }
      repositoryRoot = resolve(value);
      index++;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      throw new ArchitectureConfluenceError(
        'Usage: ts-node scripts/bench/harness-confluence.ts [--root PATH] [--pretty]'
      );
    }
    throw new ArchitectureConfluenceError(`Unknown argument: ${argument}`);
  }
  return { repositoryRoot: resolve(repositoryRoot), pretty };
}

if (require.main === module) {
  void runHarnessConfluenceGateV1(process.argv.slice(2)).then(exitCode => {
    process.exitCode = exitCode;
  });
}
