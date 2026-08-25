import { createHash } from 'crypto';

export function canonicalRuntimeJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function digestRuntimeValue(value: unknown): string {
  return createHash('sha256').update(canonicalRuntimeJson(value)).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)])
  );
}
