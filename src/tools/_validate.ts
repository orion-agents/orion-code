/**
 * Issue #32 #4.4: 通用参数校验
 */

export class ToolArgError extends Error {
  constructor(tool: string, key: string, reason: string) {
    super(`${tool}: parameter "${key}" ${reason}`);
    this.name = 'ToolArgError';
  }
}

export function requireString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) {
    throw new ToolArgError(tool, key, 'must be a non-empty string');
  }
  return v;
}

export function requireNumber(
  args: Record<string, unknown>,
  key: string,
  tool: string,
  min?: number,
  max?: number,
): number {
  const v = args[key];
  if (typeof v !== 'number') {
    throw new ToolArgError(tool, key, 'must be a number');
  }
  if (min !== undefined && v < min) {
    throw new ToolArgError(tool, key, `must be >= ${min}`);
  }
  if (max !== undefined && v > max) {
    throw new ToolArgError(tool, key, `must be <= ${max}`);
  }
  return v;
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    return undefined;
  }
  return v;
}

export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') return undefined;
  return v;
}