/** Session-effort restoration kept outside the main chat loop. */

import { resolveProfileEffort } from '../services/effort';
import { getProjectConfig, loadGlobalConfig } from '../services/global-config';
import type { SessionMeta } from '../services/session-storage';
import type { OrionCodeUiRuntime, UiEventSink } from './ui-events';

export function applySessionEffort(
  runtime: OrionCodeUiRuntime,
  events: Pick<UiEventSink, 'effortEvent'>,
  session: SessionMeta
): void {
  const registry = runtime.config.modelRegistry;
  const profile = registry
    ? (registry.profiles.get(session.model) ??
      [...registry.profiles.values()].find(candidate => candidate.model === session.model))
    : undefined;
  const provider = profile ? registry?.providers.get(profile.provider) : undefined;
  const project = getProjectConfig(runtime.cwd);
  const global = loadGlobalConfig();
  const preference = session.effortPreference ?? 'auto';
  const resolved = resolveProfileEffort(profile, {
    session: session.effortPreference,
    project: project.defaultEffort,
    global: global.defaultEffort ?? runtime.config.defaultEffort,
  });

  runtime.store.setEffort(preference, resolved);
  if (provider) {
    runtime.llm?.setEffortContext({
      preference,
      protocol: provider.protocol,
      capability: profile?.reasoningCapability,
    });
  }
  events.effortEvent?.(
    resolved.supported
      ? {
          type: 'effort_resolved',
          model: profile?.id ?? session.model,
          provider: provider?.id ?? 'legacy',
          requested: resolved.requested,
          effective: resolved.effective,
          supportedLevels: resolved.supportedLevels,
        }
      : {
          type: 'effort_unavailable',
          model: profile?.id ?? session.model,
          provider: provider?.id ?? 'legacy',
          requested: resolved.requested,
          reason: resolved.warning ?? 'capability not configured',
        }
  );
}
