/**
 * Orion Code - CLI entry point
 */

import chalk from 'chalk';
import { LLMService } from './services/llm';
import { ProviderResilienceCoordinator } from './services/provider-resilience';
import { ModelCoordinator } from './runtime/model-coordinator';
import {
  DEFAULT_UI_RENDERER,
  loadConfig,
  isConfigured,
  resolveUIRenderer,
  SUPPORTED_UI_RENDERERS,
  type UIRenderer,
} from './services/config';
import { ensureConfigDir } from './services/config-dir';
import {
  getProjectConfig,
  recordFirstStartTime,
  incrementSessionCount,
} from './services/global-config';
import { appendUsageRecord } from './services/usage-state';
import {
  createSession,
  endSession,
  readSessionMessages,
  updateSessionSummary,
  type SessionMeta,
} from './services/session-storage';
import { buildMemoryPromptContext } from './memory/prompt-context';
import { loadProjectInstructions } from './services/project-instructions';
import { Store } from './framework/store';
import { discoverModelContexts } from './services/model-context';
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
import { createProductionFirstPartyToolUniverseV1 } from './runtime/first-party-tool-universe';
import { createProductOrionRuntimeV1 } from './runtime/product-orion-runtime';
import { createFirstPartyMcpAdapterV1, loadFirstPartyMcpConfigurationV1 } from './runtime/mcp';
import { createProductionFilesystemSkillProviderV1 } from './runtime/skills';
import { OrionSessionRunnerV1 } from './runtime/orion-session-runner';
import { CompactCoordinator } from './services/compact';
import { handleMigrateCommand } from './migration/command';
import type { CommandContext } from './commands/types';
import { PACKAGE_VERSION } from './product/version';

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
  ensureConfigDir();
  recordFirstStartTime();

  const cwd = process.cwd();
  const config = loadConfig({ ui: { renderer: uiRenderer } });
  const memoryContent = buildMemoryPromptContext('', cwd).content;
  const projectInstructionsContent = loadProjectInstructions(cwd);
  const firstPartyTools = createProductionFirstPartyToolUniverseV1({
    context: { cwd, config: { name: config.name, mode: config.mode } },
  });
  const toolCatalog = firstPartyTools.catalog;
  const skillProvider = createProductionFilesystemSkillProviderV1({
    cwd,
    configuredPaths: config.skills?.paths,
  });
  const mcpAdapter = createFirstPartyMcpAdapterV1({
    config: loadFirstPartyMcpConfigurationV1(),
    baseDirectory: cwd,
  });

  const store = new Store({
    config,
    tools: toolCatalog.entries.map(entry => entry.tool),
    currentModel: config.model,
    memoryContent,
    // Skill descriptors/definitions are selected by the lazy v0.2.0 runtime.
    // The presentation Store must never eagerly retain Skill bodies.
    skillsContent: '',
    projectInstructionsContent,
  });

  let llm: LLMService | null = null;
  let modelCoordinator: ModelCoordinator | undefined;
    // Resolve credentials from the configured model registry or legacy config.
  const configured = config.modelRegistry
    ? config.modelRegistry.defaultProfile !== null
    : isConfigured(config);
  if (configured) {
    const defaultProvider = config.modelRegistry?.defaultProfile
      ? config.modelRegistry.providers.get(config.modelRegistry.defaultProfile.provider)
      : null;
    llm = new LLMService({
      apiKey: defaultProvider
        ? defaultProvider.apiKey.startsWith('$')
          ? (process.env[defaultProvider.apiKey.slice(1)] ?? '')
          : defaultProvider.apiKey
        : config.apiKey,
      baseUrl: defaultProvider?.baseUrl ?? config.apiBaseUrl,
      model: config.modelRegistry?.defaultProfile?.model ?? config.model,
      fallbackModel: config.modelRegistry?.fallbackProfile?.model ?? config.fallbackModel,
      providerProtocol: defaultProvider?.protocol,
      reasoningCapability: config.modelRegistry?.defaultProfile?.reasoningCapability,
      fallbackReasoningCapability: config.modelRegistry?.fallbackProfile?.reasoningCapability,
      effortPreference: config.defaultEffort,
    });
    // Keep chat() and chatStream() on the shared provider-resilience layer.
    llm.resilience = new ProviderResilienceCoordinator();

    // Initialize ModelCoordinator for /model switching.
    modelCoordinator = new ModelCoordinator();
    if (config.modelRegistry && config.modelClientPool) {
      modelCoordinator.bind(config.modelRegistry, config.modelClientPool);
      modelCoordinator.initModel(config.model);
    }

    if (config.apiBaseUrl) {
      discoverModelContexts(config.apiBaseUrl, config.apiKey).catch(() => undefined);
    }
  }

  const compactCoordinator = new CompactCoordinator({
    modelId: llm?.getModel() ?? config.model,
    llm,
    outputReserveTokens: llm?.getMaxTokens?.(),
    compactInstructions: getProjectConfig(cwd).compactInstructions,
    getContextCapsule: () => store.getSnapshot().harnessState?.capsule,
    getHarnessState: () => store.getSnapshot().harnessState,
  });

  let currentSession: SessionMeta | null = null;
  let sessionRunner: OrionSessionRunnerV1 | undefined;
  let shuttingDown = false;

  const ensureSession = (): SessionMeta => {
    if (!currentSession) {
      currentSession = createSession(
        cwd,
        store.getSnapshot().currentModel || store.getSnapshot().config.model
      );
      incrementSessionCount();
    }
    return currentSession;
  };

  const setSession = (session: SessionMeta | null): void => {
    currentSession = session;
  };

  const getSession = (): SessionMeta | null => currentSession;

  const costTracker = store.getSnapshot().costTracker;
  costTracker.setRecordSink(record => {
    appendUsageRecord(record, {
      sessionId: currentSession?.id,
      projectPath: cwd,
    });
  });
  const unsubscribeLlmUsage = llm?.subscribeUsage(event => {
    costTracker.record(event.usage, {
      model: event.model,
      requestKind: event.operation,
    });
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    await sessionRunner?.close('Orion CLI shutdown');

    if (currentSession) {
      const messages = readSessionMessages(currentSession.id);
      if (messages.length > 0) {
        updateSessionSummary(currentSession.id, messages);
      }
      endSession(currentSession.id);
    }

    unsubscribeLlmUsage?.();
  };

  const createAgentRunner: OrionCodeUiRuntime['createAgentRunner'] = llm
    ? (events, runnerOptions) => {
        if (sessionRunner) return sessionRunner;
        sessionRunner = new OrionSessionRunnerV1({
          eventSink: events,
          getSessionId: () => ensureSession().id,
          createRuntime: sessionId =>
            createProductOrionRuntimeV1(
              {
                cwd,
                config,
                store,
                llm: llm as LLMService,
                compactCoordinator,
                toolCatalog,
                skillProviders: [skillProvider],
                mcpDescriptors: mcpAdapter.descriptors,
                mcpConnector: mcpAdapter.connector,
                approvalHandler: runnerOptions.approvalHandler,
              },
              sessionId
            ),
          mode: () => {
            const mode = store.getSnapshot().agentMode;
            return mode === 'plan' ? 'plan' : mode === 'auto' ? 'auto' : 'build';
          },
        });
        return sessionRunner;
      }
    : undefined;

  return {
    cwd,
    version: VERSION,
    config,
    store,
    llm,
    compactCoordinator,
    modelCoordinator,
    createAgentRunner,
    getHarnessDiagnostics: async () => sessionRunner?.diagnostics(),
    isConfigured: isConfigured(config),
    ensureSession,
    setSession,
    getSession,
    shutdown,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
