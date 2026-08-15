import { createHash } from 'crypto';
import type { CapabilityProfile, CapabilityProfileInput } from './types';

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function createCapabilityProfile(
  projectRoot: string,
  input: CapabilityProfileInput,
  previous?: CapabilityProfile
): CapabilityProfile {
  const tools = [...new Set(input.tools.map(name => name.trim()).filter(Boolean))].sort();
  const material = {
    projectRoot,
    model: {
      id: input.modelId,
      contextWindow: Math.max(1, Math.floor(input.contextWindow)),
      toolCalling: tools.length > 0,
      streaming: true,
    },
    permission: {
      mode: input.permissionMode,
      confirmation: input.toolConfirmation,
      scope: 'project' as const,
      source: 'runtime_policy' as const,
      hardDenyEnforced: true as const,
    },
    tools,
    features: {
      network: tools.some(name => /(?:web|http|fetch|search)/iu.test(name)),
      mcp: tools.some(name => /(?:^|__)mcp(?:__|$)/iu.test(name)),
      subagents: tools.some(name => /subtask|subagent/iu.test(name)),
      skills: tools.some(name => /skill/iu.test(name)),
    },
  };
  const nextFingerprint = fingerprint(material);
  if (previous?.fingerprint === nextFingerprint) return structuredClone(previous);
  return {
    schemaVersion: 1,
    revision: (previous?.revision ?? 0) + 1,
    fingerprint: nextFingerprint,
    createdAt: input.now ?? Date.now(),
    ...material,
  };
}
