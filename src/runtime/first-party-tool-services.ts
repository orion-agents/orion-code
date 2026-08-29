import { isAbsolute, relative, resolve } from 'path';

import type { PermissionResult, ToolContext } from '../framework/tool';
import { resolveToolAllowlist } from '../services/tool-allowlist';
import { planSandboxedCommand, resolveSandboxSettings } from '../tools/sandbox';
import type { BuiltinToolCatalogV1 } from './builtin-tool-provider';
import { digestRuntimeValue } from './protocol/canonical';
import type {
  SandboxPreparationV1,
  SandboxServiceV1,
  ToolApprovalDecisionV1,
  ToolApprovalServiceV1,
  ToolPolicyDecisionV1,
  ToolPolicyServiceV1,
} from './tool-gateway';

export interface FirstPartyApprovalRequestV1 {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly abortSignal?: AbortSignal;
}

export type FirstPartyApprovalHandlerV1 = (
  request: FirstPartyApprovalRequestV1
) => boolean | Promise<boolean>;

export class FirstPartyToolServiceError extends Error {
  readonly code = 'ORION_FIRST_PARTY_TOOL_SERVICE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'FirstPartyToolServiceError';
  }
}

/**
 * Adapts existing first-party permission evaluators to the frozen v0.2.0
 * policy boundary. Agent display mode is deliberately absent from decisions.
 */
export class FirstPartyToolPolicyServiceV1 implements ToolPolicyServiceV1 {
  readonly serviceId = 'first-party-tool-policy';
  private readonly toolsByName: ReadonlyMap<string, BuiltinToolCatalogV1['entries'][number]>;

  constructor(
    catalog: BuiltinToolCatalogV1,
    private readonly context: ToolContext
  ) {
    this.toolsByName = new Map(
      catalog.entries.map(entry => [entry.candidate.descriptor.name, entry] as const)
    );
  }

  decide(input: Parameters<ToolPolicyServiceV1['decide']>[0]): ToolPolicyDecisionV1 {
    const entry = this.toolsByName.get(input.descriptor.name);
    if (entry) {
      const expected = entry.candidate.descriptor;
      if (
        expected.executorId !== input.descriptor.executorId ||
        expected.schemaDigest !== input.descriptor.schemaDigest ||
        digestRuntimeValue(expected.risk) !== digestRuntimeValue(input.descriptor.risk)
      ) {
        return decision('deny', 'snapshot', 'Tool descriptor drifted after capability capture.');
      }
      const inputError = entry.tool.validateInput?.({ ...input.args });
      if (inputError) return decision('deny', 'input', inputError);
    } else if (!input.descriptor.executorId.startsWith('mcp:')) {
      return decision('deny', 'catalog', 'Tool is not in an approved runtime catalog.');
    }
    const authorityFailure = checkAuthority(input);
    if (authorityFailure) return decision('deny', 'authority', authorityFailure);
    const configured = resolveToolAllowlist(input.snapshot.authority.projectRoot).evaluator?.(
      input.descriptor.name,
      { ...input.args }
    );
    if (configured?.effect === 'deny' || configured?.effect === 'ask') {
      return decision(
        configured.effect,
        `allowlist:${configured.scope ?? 'resolved'}`,
        `Matched ${configured.rule}.`
      );
    }

    if (!entry) {
      if (configured?.effect === 'allow') {
        return decision(
          'allow',
          `allowlist:${configured.scope ?? 'resolved'}`,
          `Matched durable grant ${configured.rule}.`
        );
      }
      return decision(
        'ask',
        'mcp-default',
        'Selected MCP tools require explicit approval unless durably granted.'
      );
    }

    let legacy: PermissionResult;
    try {
      legacy = entry.tool.checkPermissions?.({ ...input.args }, this.context) ?? {
        behavior: 'allow',
      };
    } catch (error) {
      return decision(
        'deny',
        'tool-policy',
        `Tool permission evaluator failed closed: ${errorMessage(error)}`
      );
    }
    if (!['allow', 'ask', 'deny'].includes(legacy.behavior)) {
      return decision('deny', 'tool-policy', 'Tool returned an invalid permission decision.');
    }
    if (legacy.behavior !== 'deny' && configured?.effect === 'allow') {
      return decision(
        'allow',
        `allowlist:${configured.scope ?? 'resolved'}`,
        `Matched durable grant ${configured.rule}.`
      );
    }
    return decision(legacy.behavior, 'tool-policy', legacy.reason);
  }
}

/** Confirmation is independent from containment and from BUILD/PLAN/AUTO. */
export class FirstPartyToolApprovalServiceV1 implements ToolApprovalServiceV1 {
  readonly serviceId = 'first-party-tool-approval';

  constructor(private readonly confirm?: FirstPartyApprovalHandlerV1) {}

  async decide(
    input: Parameters<ToolApprovalServiceV1['decide']>[0]
  ): Promise<ToolApprovalDecisionV1> {
    if (input.abortSignal?.aborted) {
      return approval(false, 'abort', 'Approval was aborted.');
    }
    switch (input.snapshot.authority.confirmation) {
      case 'allow':
        return approval(true, 'authority', 'Project authority pre-authorized this operation.');
      case 'deny':
        return approval(false, 'authority', 'Project authority denies confirmation.');
      case 'ask': {
        if (!this.confirm) {
          return approval(false, 'unavailable', 'No approval channel is attached.');
        }
        try {
          const approved = await this.confirm({
            id: input.invocationId,
            name: input.descriptor.name,
            args: { ...input.args },
            reason: input.policy.reason,
            abortSignal: input.abortSignal,
          });
          return approval(
            approved,
            'user',
            approved ? 'User approved the operation.' : 'User denied the operation.'
          );
        } catch (error) {
          return approval(
            false,
            'approval-error',
            `Approval failed closed: ${errorMessage(error)}`
          );
        }
      }
    }
  }
}

/**
 * Produces an auditable enforcement result before ExecutionService runs. Shell
 * tools use the existing OS sandbox planner; in-process file tools rely on the
 * same project-root path guards as their bound executor.
 */
export class FirstPartySandboxServiceV1 implements SandboxServiceV1 {
  readonly serviceId = 'first-party-sandbox';

  prepare(input: Parameters<SandboxServiceV1['prepare']>[0]): SandboxPreparationV1 {
    if (!input.snapshot.executionPolicy.sandboxRequired) {
      return sandbox('none', 'none', 'Sandbox is not required by the frozen policy.');
    }
    const descriptor = input.descriptor;
    if (descriptor.name === 'exec_command') return this.prepareCommand(input);
    if (
      descriptor.risk.network === 'none' &&
      (descriptor.risk.effect === 'none' ||
        descriptor.risk.effect === 'workspace_read' ||
        descriptor.risk.fileEdit)
    ) {
      return sandbox(
        'orion-path-containment',
        'full',
        'The bound in-process executor enforces the frozen project root.'
      );
    }
    return sandbox(
      'unsupported',
      'partial',
      `No full sandbox backend is bound for ${descriptor.name}.`
    );
  }

  private prepareCommand(input: Parameters<SandboxServiceV1['prepare']>[0]): SandboxPreparationV1 {
    const command = typeof input.args.command === 'string' ? input.args.command : '';
    if (!command.trim()) return sandbox('invalid-command', 'partial', 'Command is empty.');
    const projectRoot = resolve(input.snapshot.authority.projectRoot);
    const requestedCwd =
      typeof input.args.cwd === 'string' && input.args.cwd.trim()
        ? resolve(projectRoot, input.args.cwd)
        : resolve(input.snapshot.environment.cwd);
    if (!contains(projectRoot, requestedCwd)) {
      return sandbox('path-containment', 'partial', 'Command cwd is outside project authority.');
    }
    const plan = planSandboxedCommand(command, {
      cwd: requestedCwd,
      projectRoot,
      settings: resolveSandboxSettings(projectRoot),
    });
    if (!plan.ok) return sandbox('unavailable', 'partial', plan.reason);
    if (plan.backend === 'none') {
      return sandbox('none', 'none', 'Configured shell execution has no sandbox backend.');
    }
    return sandbox(
      plan.backend,
      'full',
      `${plan.profile}; network ${plan.network}; ${plan.writableRoots.length} writable roots.`
    );
  }
}

function checkAuthority(input: Parameters<ToolPolicyServiceV1['decide']>[0]): string | undefined {
  const { authority } = input.snapshot;
  const { risk } = input.descriptor;
  if (input.descriptor.name === 'exec_command' && typeof input.args.cwd === 'string') {
    const requestedCwd = resolve(authority.projectRoot, input.args.cwd);
    if (!contains(resolve(authority.projectRoot), requestedCwd)) {
      return 'Command cwd is outside project authority.';
    }
  }
  if (risk.network === 'write' && authority.network !== 'write') {
    return 'Tool requires network write authority.';
  }
  if (risk.network === 'read' && authority.network === 'deny') {
    return 'Tool requires network read authority.';
  }
  if (risk.effect === 'external_write' && authority.confirmation === 'deny') {
    return 'External writes are denied by the frozen authority.';
  }
  return undefined;
}

function decision(
  behavior: ToolPolicyDecisionV1['behavior'],
  source: string,
  reason?: string
): ToolPolicyDecisionV1 {
  const content = { behavior, source, ...(reason ? { reason } : {}) };
  return Object.freeze({ ...content, digest: digestRuntimeValue(content) });
}

function approval(approved: boolean, source: string, reason?: string): ToolApprovalDecisionV1 {
  const content = { approved, source, ...(reason ? { reason } : {}) };
  return Object.freeze({ ...content, digest: digestRuntimeValue(content) });
}

function sandbox(
  backend: string,
  enforcement: SandboxPreparationV1['enforcement'],
  reason?: string
): SandboxPreparationV1 {
  const content = { backend, enforcement, ...(reason ? { reason } : {}) };
  return Object.freeze({ ...content, digest: digestRuntimeValue(content) });
}

function contains(root: string, target: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(target)) return false;
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
