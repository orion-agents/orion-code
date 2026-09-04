/**
 * Orion Code - CLI entry point
 */

import chalk from 'chalk';
import {
  DEFAULT_UI_RENDERER,
  resolveUIRenderer,
  SUPPORTED_UI_RENDERERS,
  type UIRenderer,
} from './services/config';
import { launchTuiUI } from './tui-ui/launch';
import { launchTerminalUI } from './terminal-ui/launch';
import {
  launchPrintMode,
  readPromptFromStdinIfAvailable,
  type PrintOutputFormat,
} from './print-ui/launch';
import { collectDoctorReport, formatDoctorReport, hasDoctorFailures } from './services/doctor';
import { collectWorkspaceDiff, formatWorkspaceDiff } from './services/workspace-diff';
import { createCommitPlan, formatCommitPlan } from './services/commit-plan';
import type { OrionCodeUiRuntime } from './runtime/ui-events';
import { createProductUiRuntime } from './runtime/product-bootstrap';
import { handleMigrateCommand } from './migration/command';
import type { CommandContext } from './commands/types';
import { PACKAGE_VERSION } from './product/version';
import { runOrionWeb } from './web';
import { hostDaemonStatus, stopBackgroundHost } from './web/host-daemon';
import { parseWebCliOptions } from './web/cli-options';

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const ERROR = chalk.red;
const WARN = chalk.yellow;

const VERSION = PACKAGE_VERSION;

function showCliHelp(): void {
  console.log();
  console.log(BRAND('orion') + DIM(` v${VERSION}`));
  console.log(DIM('  Orion Code - goal-driven coding agent for the terminal.'));
  console.log();
  console.log(ACCENT('Usage:'));
  console.log('  orion             Start the default TUI renderer');
  console.log('  orion doctor      Run local diagnostics and exit');
  console.log('  orion diff        Summarize current git workspace changes');
  console.log('  orion commit      Create a read-only commit plan and suggested message');
  console.log('  orion migrate openhorse  Preview OpenHorse migration; add --yes to execute');
  console.log('  orion web         Start the local Web Workbench');
  console.log('  orion -p "task"   Run an experimental non-interactive task');
  console.log('  orion --help      Show this help message');
  console.log('  orion --version   Show version');
  console.log('  orion --ui tui    Start the default TUI renderer explicitly');
  console.log('  orion --ui terminal  Start the technical terminal UI for diagnostics');
  console.log();
  console.log(ACCENT('Options:'));
  console.log('  -h, --help     Show help');
  console.log('  -v, --version  Show version');
  console.log('  -p, --print    Experimental non-interactive print mode');
  console.log(`  --ui <mode>    UI renderer: ${SUPPORTED_UI_RENDERERS.join(', ')}`);
  console.log('  --output-format <text|json>  Print-mode output format');
  console.log();
  console.log(
    DIM('tui is the default product UI. terminal is the technical fallback; print is experimental.')
  );
  console.log();
}

function showWebHelp(): void {
  console.log('Usage: orion web [--port <number>] [--no-open] [--cwd <directory>] [--background]');
  console.log('Starts the local-only Web Workbench on 127.0.0.1.');
  console.log(
    '  --background      run detached in the background (pidfile + logs under ~/.orion-code)'
  );
  console.log('orion web status [--port <number>]');
  console.log('orion web stop [--port <number>]');
  console.log('orion web restart [--port <number>]');
  console.log('  Manage a background host started with --background.');
}

async function manageBackgroundHost(command: 'status' | 'stop', args: string[]): Promise<void> {
  const options = parseWebCliOptions(args);
  const status = hostDaemonStatus(options.port);
  if (command === 'status') {
    if (status.state === 'running') {
      console.log(`orion web is running: ${status.pidfile.url} (pid ${status.pidfile.pid})`);
      console.log(
        `workspace ${status.pidfile.workspace} · started ${new Date(status.pidfile.startedAt).toISOString()}`
      );
    } else if (status.state === 'stale') {
      console.log(
        `orion web is not running (stale pidfile for pid ${status.pid} on port ${status.port}).`
      );
    } else {
      console.log(`orion web is not running on port ${options.port}.`);
    }
    return;
  }
  const result = await stopBackgroundHost(options.port);
  if (result === 'stopped') console.log(`orion web on port ${options.port} stopped.`);
  else console.log(`orion web was not running on port ${options.port}.`);
}

interface CliOptions {
  uiRenderer: UIRenderer;
  printMode: boolean;
  outputFormat: PrintOutputFormat;
  promptArgs: string[];
}

function parseCliOptions(args: string[]): CliOptions {
  let uiRenderer: UIRenderer = DEFAULT_UI_RENDERER;
  let printMode = false;
  let outputFormat: PrintOutputFormat = 'text';
  const promptArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      promptArgs.push(...args.slice(i + 1));
      break;
    }

    if (arg === '-p' || arg === '--print') {
      printMode = true;
      continue;
    }

    const uiValue =
      arg === '--ui'
        ? args[i + 1]
        : arg.startsWith('--ui=')
          ? arg.slice('--ui='.length)
          : undefined;

    if (uiValue !== undefined) {
      if (arg === '--ui') i++;
      const resolvedRenderer = resolveUIRenderer(uiValue);
      if (resolvedRenderer) {
        uiRenderer = resolvedRenderer;
        continue;
      }

      if (uiValue === 'legacy' || uiValue === 'v2') {
        console.log(
          WARN(
            `Renderer "${uiValue}" is no longer supported; starting the TUI product renderer instead.`
          )
        );
        uiRenderer = 'tui';
        continue;
      }

      console.error(ERROR(`Invalid --ui value: ${uiValue}`));
      console.error(DIM(`Expected: ${SUPPORTED_UI_RENDERERS.join(', ')}`));
      process.exit(1);
    }

    const outputFormatValue =
      arg === '--output-format'
        ? args[i + 1]
        : arg.startsWith('--output-format=')
          ? arg.slice('--output-format='.length)
          : undefined;

    if (outputFormatValue !== undefined) {
      if (arg === '--output-format') i++;
      if (outputFormatValue === 'text' || outputFormatValue === 'json') {
        outputFormat = outputFormatValue;
        continue;
      }

      console.error(ERROR(`Invalid --output-format value: ${outputFormatValue}`));
      console.error(DIM('Expected: text, json'));
      process.exit(1);
    }

    promptArgs.push(arg);
  }

  return { uiRenderer, printMode, outputFormat, promptArgs };
}

async function bootstrapRuntime(uiRenderer: UIRenderer): Promise<OrionCodeUiRuntime> {
  return createProductUiRuntime({
    cwd: process.cwd(),
    uiRenderer,
    shutdownReason: 'Orion CLI shutdown',
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'web') {
    if (args.includes('--help') || args.includes('-h')) {
      showWebHelp();
      return;
    }
    const rest = args.slice(1);
    if (rest[0] === 'status' || rest[0] === 'stop') {
      await manageBackgroundHost(rest[0], rest.slice(1));
      return;
    }
    if (rest[0] === 'restart') {
      await manageBackgroundHost('stop', rest.slice(1));
      const restartOptions = parseWebCliOptions(rest.slice(1));
      await runOrionWeb({
        ...restartOptions,
        background: true,
        backgroundArgs: [
          ...(restartOptions.open ? [] : ['--no-open']),
          '--port',
          String(restartOptions.port),
          '--cwd',
          restartOptions.cwd,
        ],
      });
      return;
    }
    const options = parseWebCliOptions(rest);
    const backgroundArgs = [
      ...(options.open ? [] : ['--no-open']),
      '--port',
      String(options.port),
      '--cwd',
      options.cwd,
    ];
    await runOrionWeb({ ...options, backgroundArgs });
    return;
  }
  if (args[0] === 'migrate') {
    const result = handleMigrateCommand(
      { cwd: process.cwd() } as CommandContext,
      args.slice(1).join(' ')
    );
    process.exit(result.success ? 0 : 1);
  }
  if (args.includes('--help') || args.includes('-h')) {
    showCliHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`orion v${VERSION}`);
    process.exit(0);
  }

  const options = parseCliOptions(args);
  const runtime = await bootstrapRuntime(options.uiRenderer);
  if (!options.printMode && options.promptArgs[0] === 'doctor') {
    const report = collectDoctorReport({
      cwd: runtime.cwd,
      config: runtime.config,
      store: runtime.store,
      llm: runtime.llm,
      compactCoordinator: runtime.compactCoordinator,
      getSession: runtime.getSession,
    });
    if (options.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatDoctorReport(report)}\n`);
    }
    await runtime.shutdown();
    process.exit(hasDoctorFailures(report) ? 1 : 0);
  }

  if (!options.printMode && options.promptArgs[0] === 'diff') {
    const maxFilesIndex = options.promptArgs.findIndex(arg => arg === '--max-files');
    const maxFiles =
      maxFilesIndex >= 0
        ? Number(options.promptArgs[maxFilesIndex + 1] ?? 40)
        : Number(
            options.promptArgs
              .find(arg => arg.startsWith('--max-files='))
              ?.slice('--max-files='.length) ?? 40
          );
    const report = collectWorkspaceDiff({
      cwd: runtime.cwd,
      maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 40,
    });
    if (options.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${formatWorkspaceDiff(report, { maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 40 })}\n`
      );
    }
    await runtime.shutdown();
    process.exit(report.isGitRepo ? 0 : 1);
  }

  if (!options.printMode && options.promptArgs[0] === 'commit') {
    const maxFilesIndex = options.promptArgs.findIndex(arg => arg === '--max-files');
    const maxFiles =
      maxFilesIndex >= 0
        ? Number(options.promptArgs[maxFilesIndex + 1] ?? 20)
        : Number(
            options.promptArgs
              .find(arg => arg.startsWith('--max-files='))
              ?.slice('--max-files='.length) ?? 20
          );
    const plan = createCommitPlan({
      cwd: runtime.cwd,
      maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 20,
    });
    if (options.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatCommitPlan(plan)}\n`);
    }
    await runtime.shutdown();
    process.exit(plan.diff.isGitRepo ? 0 : 1);
  }

  if (options.printMode) {
    const prompt = options.promptArgs.join(' ').trim() || (await readPromptFromStdinIfAvailable());
    if (!prompt) {
      console.error(ERROR('Print mode requires a prompt argument or piped stdin.'));
      await runtime.shutdown();
      process.exit(1);
    }

    const exitCode = await launchPrintMode(runtime, prompt, { outputFormat: options.outputFormat });
    process.exit(exitCode);
  }

  if (options.promptArgs.length > 0) {
    console.error(ERROR(`Unexpected argument: ${options.promptArgs[0]}`));
    console.error(DIM('Use -p/--print to run a non-interactive prompt.'));
    await runtime.shutdown();
    process.exit(1);
  }

  const uiRenderer = options.uiRenderer;
  if (uiRenderer === 'tui') {
    await launchTuiUI(runtime);
  } else {
    await launchTerminalUI(runtime);
  }
}

main().catch(async error => {
  console.error(ERROR('[Orion Code] Fatal error:'), error);
  process.exit(1);
});
