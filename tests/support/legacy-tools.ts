import type { ToolContext } from '../../src/framework/tool';
import { CORE_TOOLS } from '../../src/tools/core';

/** Test-only core-tool fixture. Product code injects BuiltinToolCatalogV1. */
export const TOOLS = [...CORE_TOOLS];

export function getRuntimeTools() {
  return [...TOOLS];
}

export function getToolNames(): string {
  return getRuntimeTools()
    .map(tool => tool.name)
    .join(', ');
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  context?: ToolContext
): Promise<string> {
  const tool = TOOLS.find(candidate => candidate.name === name);
  if (!tool) {
    return Promise.resolve(
      JSON.stringify({
        success: false,
        output: '',
        error: `Unknown tool: ${name}. Available tools: ${getToolNames()}`,
      })
    );
  }
  const effectiveContext: ToolContext = {
    cwd: context?.cwd ?? process.cwd(),
    config: context?.config ?? { name: 'orion-code-test', mode: 'test' },
    ...(abortSignal ? { abortSignal } : {}),
    ...(context ?? {}),
  };
  return tool.execute({ ...args }, effectiveContext).then(result =>
    JSON.stringify({
      ...result,
      output: result.output ?? '',
      outputBytes: Buffer.byteLength(result.output ?? '', 'utf8'),
      summary: tool.getSummary?.(args, result),
    })
  );
}

/** Removed v0.1.x global runtime; retained only to make stale test imports fail loudly. */
export const legacyToolRuntime = undefined;
