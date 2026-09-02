import { resolve } from 'path';

import type { OrionCodeCLIConfig } from '../services/config';
import {
  ProviderRequestGate,
  ProviderResilienceCoordinator,
} from '../services/provider-resilience';
import {
  SettingsCoordinatorError,
  SettingsCoordinatorV1,
  type SettingsInvalidationV1,
  type SettingsUpdateContextV1,
} from '../services/settings-coordinator';
import type { ProductionFirstPartyToolUniverseV1 } from './first-party-tool-universe';
import type { FirstPartyMcpAdapterV1 } from './mcp';
import type { FilesystemSkillProviderV1 } from './skills';

export interface WorkspaceSettingsRuntimeParticipantV1 {
  readonly runtimeIdle: () => boolean;
  readonly runtimePrepare: (
    context: Omit<SettingsUpdateContextV1, 'document'>
  ) => void | Promise<void>;
  /**
   * Apply one committed Settings document and return an exact in-memory
   * compensation. The kernel invokes compensations in reverse order when a
   * later participant rejects, before the coordinator restores durable bytes.
   */
  readonly runtimeApply: (
    context: SettingsUpdateContextV1
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface WorkspaceRuntimeKernelOptionsV1 {
  readonly cwd: string;
  readonly config: OrionCodeCLIConfig;
  readonly toolUniverse: ProductionFirstPartyToolUniverseV1;
  readonly skillProvider: FilesystemSkillProviderV1;
  readonly mcpAdapter: FirstPartyMcpAdapterV1;
  readonly onSettingsInvalidated?: (event: SettingsInvalidationV1) => void;
  readonly providerRequestGate?: ProviderRequestGate;
  readonly providerResilience?: ProviderResilienceCoordinator;
}

export interface WorkspaceRuntimeKernelDiagnosticsV1 {
  readonly participantCount: number;
  readonly ownerReleased: boolean;
  readonly closed: boolean;
  readonly providerGate: ReturnType<ProviderRequestGate['snapshot']>;
}

/**
 * Workspace-owned services shared by every Web Session actor.
 *
 * Session runtimes still own mutable Store/LLM/Thread/controller state. This
 * kernel owns only workspace-scoped, concurrency-safe resources: the parsed
 * model/client configuration, static Tool and MCP descriptors, the filesystem
 * Skill provider, one Settings coordinator/watcher, and one provider request
 * gate/cooldown domain.
 */
export class WorkspaceRuntimeKernelV1 {
  readonly version = 1 as const;
  readonly cwd: string;
  readonly toolUniverse: ProductionFirstPartyToolUniverseV1;
  readonly skillProvider: FilesystemSkillProviderV1;
  readonly mcpAdapter: FirstPartyMcpAdapterV1;
  readonly providerRequestGate: ProviderRequestGate;
  readonly providerResilience: ProviderResilienceCoordinator;
  readonly settingsCoordinator: SettingsCoordinatorV1;

  private readonly configSnapshot: OrionCodeCLIConfig;
  private readonly participants = new Set<WorkspaceSettingsRuntimeParticipantV1>();
  private ownerReleasedValue = false;
  private closedValue = false;

  constructor(options: WorkspaceRuntimeKernelOptionsV1) {
    // The composition root owns canonical workspace identity. Resolving
    // lexical segments here is safe; realpath re-keying (/var -> /private/var
    // on macOS) would diverge from the durable project Settings key.
    this.cwd = resolve(options.cwd);
    this.configSnapshot = cloneRuntimeConfig(options.config);
    this.toolUniverse = options.toolUniverse;
    this.skillProvider = options.skillProvider;
    this.mcpAdapter = options.mcpAdapter;
    this.providerRequestGate = options.providerRequestGate ?? new ProviderRequestGate();
    this.providerResilience =
      options.providerResilience ??
      new ProviderResilienceCoordinator(undefined, this.providerRequestGate);
    this.settingsCoordinator = SettingsCoordinatorV1.create({
      workspace: this.cwd,
      onInvalidated: options.onSettingsInvalidated,
      models: options.config.modelRegistry?.enabledProfiles.map(profile => ({
        id: profile.id,
        label: profile.displayName ?? profile.id,
        provider: profile.provider,
      })),
      internalDefaultModel: 'gpt-4o',
      modelDefaultEffort: 'auto',
      internalToolConfirmation: 'allow',
      runtimeIdle: () => this.runtimeIdle(),
      runtimePrepare: context => this.prepareParticipants(context),
      runtimeApply: context => this.applyParticipants(context),
    });
  }

  createRuntimeConfig(): OrionCodeCLIConfig {
    this.assertOpen();
    return cloneRuntimeConfig(this.configSnapshot);
  }

  registerSettingsRuntime(participant: WorkspaceSettingsRuntimeParticipantV1): () => void {
    this.assertOpen();
    if (this.ownerReleasedValue) {
      throw new Error('Workspace Runtime kernel owner has already been released.');
    }
    this.participants.add(participant);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.participants.delete(participant);
      this.closeWhenUnowned();
    };
  }

  runtimeIdle(): boolean {
    for (const participant of this.participants) {
      if (!participant.runtimeIdle()) return false;
    }
    return true;
  }

  diagnostics(): WorkspaceRuntimeKernelDiagnosticsV1 {
    return Object.freeze({
      participantCount: this.participants.size,
      ownerReleased: this.ownerReleasedValue,
      closed: this.closedValue,
      providerGate: Object.freeze({ ...this.providerRequestGate.snapshot() }),
    });
  }

  /** Release the sole workspace owner; final close waits for actor teardown. */
  releaseOwner(): void {
    if (this.ownerReleasedValue) return;
    this.ownerReleasedValue = true;
    this.closeWhenUnowned();
  }

  private async prepareParticipants(
    context: Omit<SettingsUpdateContextV1, 'document'>
  ): Promise<void> {
    for (const participant of [...this.participants]) {
      await participant.runtimePrepare(context);
    }
  }

  private async applyParticipants(context: SettingsUpdateContextV1): Promise<void> {
    const compensations: Array<() => void | Promise<void>> = [];
    try {
      for (const participant of [...this.participants]) {
        const compensate = await participant.runtimeApply(context);
        if (typeof compensate === 'function') compensations.push(compensate);
      }
    } catch (error) {
      let compensationFailed = false;
      for (const compensate of compensations.reverse()) {
        try {
          await compensate();
        } catch {
          compensationFailed = true;
        }
      }
      if (compensationFailed) {
        throw new SettingsCoordinatorError(
          503,
          'settings_recovery_required',
          'One or more Session runtimes could not restore their previous Settings state.'
        );
      }
      throw error;
    }
  }

  private closeWhenUnowned(): void {
    if (this.closedValue || !this.ownerReleasedValue || this.participants.size > 0) {
      return;
    }
    this.closedValue = true;
    this.settingsCoordinator.close();
  }

  private assertOpen(): void {
    if (this.closedValue) throw new Error('Workspace Runtime kernel is closed.');
  }
}

function cloneRuntimeConfig(config: OrionCodeCLIConfig): OrionCodeCLIConfig {
  return {
    ...config,
    ...(config.ui ? { ui: { ...config.ui } } : {}),
    ...(config.skills
      ? {
          skills: {
            ...config.skills,
            ...(config.skills.paths ? { paths: [...config.skills.paths] } : {}),
          },
        }
      : {}),
  };
}
