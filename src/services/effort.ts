import type { ProviderProtocol, ResolvedModelProfile } from './model-registry';

export const EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type EffortPreference = 'auto' | EffortLevel;
export type EffortScope = 'session' | 'project' | 'global';
export type EffortAdapterId =
  | 'openai-chat-reasoning-effort'
  | 'anthropic-output-config-effort';

export interface ReasoningCapability {
  kind: 'effort-level' | 'thinking-level' | 'thinking-budget';
  supportedLevels: EffortLevel[];
  defaultLevel?: EffortLevel;
  adapter: EffortAdapterId;
  source: 'config' | 'discovery' | 'builtin';
}

export interface ResolvedEffort {
  requested: EffortPreference;
  effective?: EffortLevel;
  source: 'request' | 'session' | 'project' | 'global' | 'model-default' | 'provider-default';
  capabilitySource?: ReasoningCapability['source'];
  supported: boolean;
  supportedLevels: EffortLevel[];
  warning?: string;
}

export interface EffortResolutionInput {
  request?: EffortPreference;
  session?: EffortPreference;
  project?: EffortPreference;
  global?: EffortPreference;
  capability?: ReasoningCapability;
}

export function isEffortPreference(value: unknown): value is EffortPreference {
  return value === 'auto' || EFFORT_LEVELS.includes(value as EffortLevel);
}

export function resolveEffort(input: EffortResolutionInput): ResolvedEffort {
  const candidates = [
    ['request', input.request],
    ['session', input.session],
    ['project', input.project],
    ['global', input.global],
  ] as const;
  const selected = candidates.find(([, value]) => value !== undefined && value !== 'auto');
  const requested = selected?.[1] ?? 'auto';
  const source = selected?.[0] ?? 'provider-default';
  const capability = input.capability;

  if (!capability) {
    return {
      requested,
      source,
      supported: false,
      supportedLevels: [],
      warning: 'capability levels and provider adapter are not configured',
    };
  }
  if (requested === 'auto') {
    return {
      requested,
      effective: capability.defaultLevel,
      source: capability.defaultLevel ? 'model-default' : 'provider-default',
      capabilitySource: capability.source,
      supported: true,
      supportedLevels: [...capability.supportedLevels],
    };
  }
  if (!capability.supportedLevels.includes(requested)) {
    return {
      requested,
      source,
      capabilitySource: capability.source,
      supported: false,
      supportedLevels: [...capability.supportedLevels],
      warning: `effort ${requested} is not supported; choose ${capability.supportedLevels.join(', ')}`,
    };
  }
  return {
    requested,
    effective: requested,
    source,
    capabilitySource: capability.source,
    supported: true,
    supportedLevels: [...capability.supportedLevels],
  };
}

export interface ProviderEffortSnapshot {
  protocol: ProviderProtocol;
  capability?: ReasoningCapability;
  resolved: ResolvedEffort;
}

/** Build an immutable provider fragment. `auto` intentionally sends no override. */
export function buildProviderEffortParams(snapshot: ProviderEffortSnapshot): Record<string, unknown> {
  if (
    !snapshot.resolved.supported ||
    snapshot.resolved.requested === 'auto' ||
    !snapshot.resolved.effective ||
    !snapshot.capability
  ) {
    return {};
  }
  if (
    snapshot.protocol === 'openai-completions' &&
    snapshot.capability.adapter === 'openai-chat-reasoning-effort'
  ) {
    return { reasoning_effort: snapshot.resolved.effective };
  }
  // Anthropic Messages is not sent through Orion's current OpenAI SDK seam.
  // Keep it unavailable until a native protocol adapter owns the full request.
  return {};
}

export function resolveProfileEffort(
  profile: ResolvedModelProfile | undefined,
  preferences: Omit<EffortResolutionInput, 'capability'>
): ResolvedEffort {
  return resolveEffort({ ...preferences, capability: profile?.reasoningCapability });
}
