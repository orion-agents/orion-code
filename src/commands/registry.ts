import type {
  CommandArgumentSchema,
  CommandAudience,
  CommandBusyPolicy,
  CommandDefaultAction,
  CommandLifecycle,
  CommandSideEffect,
  RegisteredSlashCommand,
  SlashCommand,
} from './types';

interface BuiltinCommandMetadata {
  id: string;
  audience: CommandAudience;
  sideEffects: CommandSideEffect[];
  busyPolicy: CommandBusyPolicy;
  defaultAction: CommandDefaultAction;
  lifecycle: CommandLifecycle;
  argumentSchema: CommandArgumentSchema;
}

const raw = (subcommands?: string[]): CommandArgumentSchema => ({
  kind: subcommands ? 'subcommands' : 'raw',
  opaqueTail: true,
  ...(subcommands ? { subcommands } : {}),
});
const none = (): CommandArgumentSchema => ({ kind: 'none', opaqueTail: false });
const stable = (since: string = 'v0.1.5'): CommandLifecycle => ({ status: 'stable', since });
const internal = (): CommandLifecycle => ({ status: 'internal', since: 'v0.1.5' });

/**
 * Explicit migration manifest for every built-in root. Adding a command without
 * metadata fails during module initialization instead of silently inheriting a
 * permissive default.
 */
const BUILTIN_METADATA: Record<string, BuiltinCommandMetadata> = {
  goal: {
    id: 'builtin.workflow.goal',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'queue-next',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['status', 'pause', 'resume', 'clear']),
  },
  plan: {
    id: 'builtin.workflow.plan',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'queue-next',
    defaultAction: 'execute',
    lifecycle: stable('v0.1.7'),
    argumentSchema: raw(),
  },
  diff: {
    id: 'builtin.workflow.diff',
    audience: 'primary',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  'commit-plan': {
    id: 'builtin.workflow.commit-plan',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  review: {
    id: 'builtin.workflow.review',
    audience: 'primary',
    sideEffects: ['agent-request'],
    busyPolicy: 'queue-next',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  research: {
    id: 'builtin.workflow.research',
    audience: 'advanced',
    sideEffects: ['agent-request'],
    busyPolicy: 'queue-next',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(['local', 'web', 'mixed']),
  },
  security: {
    id: 'builtin.workflow.security',
    audience: 'advanced',
    sideEffects: ['agent-request'],
    busyPolicy: 'queue-next',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  'test-gen': {
    id: 'builtin.workflow.test-gen',
    audience: 'advanced',
    sideEffects: ['agent-request', 'workspace-write'],
    busyPolicy: 'queue-next',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  todos: {
    id: 'builtin.workflow.todos',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: none(),
  },
  resume: {
    id: 'builtin.session.resume',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'reject-busy',
    defaultAction: 'open-picker',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  session: {
    id: 'builtin.session.session',
    audience: 'advanced',
    sideEffects: ['session-state'],
    busyPolicy: 'reject-busy',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['list', 'info', 'rename']),
  },
  compact: {
    id: 'builtin.context.compact',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'reject-busy',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  context: {
    id: 'builtin.context.context',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'reject-busy',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['show', 'clear', 'harness', 'explain']),
  },
  rewind: {
    id: 'builtin.session.rewind',
    audience: 'advanced',
    sideEffects: ['session-state'],
    busyPolicy: 'reject-busy',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['list', 'restore']),
  },
  harness: {
    id: 'builtin.context.harness',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  skills: {
    id: 'builtin.extension.skills',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'queue-next',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  skill: {
    id: 'builtin.extension.skill',
    audience: 'advanced',
    sideEffects: ['agent-request'],
    busyPolicy: 'queue-next',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  memory: {
    id: 'builtin.context.memory',
    audience: 'advanced',
    sideEffects: ['session-state'],
    busyPolicy: 'reject-busy',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  tools: {
    id: 'builtin.extension.tools',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  mcp: {
    id: 'builtin.extension.mcp',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'queue-next',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  safety: {
    id: 'builtin.tool.safety',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  model: {
    id: 'builtin.model.model',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'queue-next',
    defaultAction: 'open-picker',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  effort: {
    id: 'builtin.model.effort',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'queue-next',
    defaultAction: 'open-picker',
    lifecycle: stable(),
    argumentSchema: raw([
      'status',
      'auto',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]),
  },
  config: {
    id: 'builtin.model.config',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: none(),
  },
  help: {
    id: 'builtin.system.help',
    audience: 'primary',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-help',
    lifecycle: stable(),
    argumentSchema: raw(['--all']),
  },
  status: {
    id: 'builtin.system.status',
    audience: 'primary',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: none(),
  },
  clear: {
    id: 'builtin.renderer.clear',
    audience: 'advanced',
    sideEffects: ['renderer-view'],
    busyPolicy: 'immediate',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: none(),
  },
  'tool-output': {
    id: 'builtin.renderer.tool-output',
    audience: 'advanced',
    sideEffects: ['renderer-view'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  theme: {
    id: 'builtin.renderer.theme',
    audience: 'primary',
    sideEffects: ['global-config'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['orion-pixel', 'classic', 'high-contrast', 'auto']),
  },
  keymap: {
    id: 'builtin.renderer.keymap',
    audience: 'primary',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  statusline: {
    id: 'builtin.renderer.statusline',
    audience: 'advanced',
    sideEffects: ['global-config'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  queue: {
    id: 'builtin.renderer.queue',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['clear']),
  },
  permissions: {
    id: 'builtin.tool.permissions',
    audience: 'primary',
    sideEffects: ['session-state'],
    busyPolicy: 'queue-next',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['show', 'ask', 'allow', 'deny', 'allow-edits', 'audit']),
  },
  redraw: {
    id: 'builtin.renderer.redraw',
    audience: 'internal',
    sideEffects: ['renderer-view'],
    busyPolicy: 'immediate',
    defaultAction: 'execute',
    lifecycle: internal(),
    argumentSchema: none(),
  },
  exit: {
    id: 'builtin.system.exit',
    audience: 'advanced',
    sideEffects: ['process-lifecycle'],
    busyPolicy: 'reject-busy',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: none(),
  },
  doctor: {
    id: 'builtin.diagnostics.doctor',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  storage: {
    id: 'builtin.diagnostics.storage',
    audience: 'advanced',
    sideEffects: ['workspace-write'],
    busyPolicy: 'reject-busy',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  usage: {
    id: 'builtin.diagnostics.usage',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(['session', 'lifetime', 'loop']),
  },
  trace: {
    id: 'builtin.diagnostics.trace',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  'last-tool': {
    id: 'builtin.diagnostics.last-tool',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  artifacts: {
    id: 'builtin.diagnostics.artifacts',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  subagents: {
    id: 'builtin.diagnostics.subagents',
    audience: 'advanced',
    sideEffects: ['none'],
    busyPolicy: 'immediate',
    defaultAction: 'show-status',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
  migrate: {
    id: 'builtin.diagnostics.migrate',
    audience: 'advanced',
    sideEffects: ['workspace-write'],
    busyPolicy: 'reject-busy',
    defaultAction: 'execute',
    lifecycle: stable(),
    argumentSchema: raw(),
  },
};

const COMMAND_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
let reservedBuiltinNames = new Set(Object.keys(BUILTIN_METADATA));

export function registerBuiltinCommands(definitions: SlashCommand[]): RegisteredSlashCommand[] {
  const definitionNames = new Set(definitions.map(command => command.name));
  const metadataNames = new Set(Object.keys(BUILTIN_METADATA));
  const missing = [...definitionNames].filter(name => !metadataNames.has(name));
  const stale = [...metadataNames].filter(name => !definitionNames.has(name));
  if (missing.length || stale.length) {
    throw new Error(
      `Command metadata mismatch (missing=${missing.join(',')}; stale=${stale.join(',')})`
    );
  }

  const registered = definitions.map(command => {
    if (!COMMAND_NAME.test(command.name)) throw new Error(`Invalid command name: ${command.name}`);
    for (const alias of command.aliases ?? []) {
      if (!COMMAND_NAME.test(alias)) throw new Error(`Invalid command alias: ${alias}`);
    }
    if (!Object.prototype.hasOwnProperty.call(command, 'risk')) {
      throw new Error(`Built-in command ${command.name} must declare explicit risk metadata`);
    }
    const metadata = BUILTIN_METADATA[command.name];
    return {
      ...command,
      ...metadata,
      source: { kind: 'builtin' as const, id: 'orion-code', trust: 'core' as const },
    };
  });

  const ids = new Set<string>();
  const names = new Map<string, string>();
  const nextReservedNames = new Set(Object.keys(BUILTIN_METADATA));
  for (const command of registered) {
    if (ids.has(command.id)) throw new Error(`Duplicate command id: ${command.id}`);
    ids.add(command.id);
    for (const value of [
      command.name,
      ...(command.aliases ?? []),
    ]) {
      const normalized = value.toLowerCase();
      const owner = names.get(normalized);
      if (owner) throw new Error(`Command name collision: ${value} (${owner}, ${command.id})`);
      names.set(normalized, command.id);
      nextReservedNames.add(normalized);
    }
  }
  // Publish the complete snapshot only after every descriptor validates. A
  // failed or repeated registration must not leak aliases into global state.
  reservedBuiltinNames = nextReservedNames;
  return registered;
}

export function isBuiltinCommandName(name: string): boolean {
  return reservedBuiltinNames.has(name.toLowerCase());
}
