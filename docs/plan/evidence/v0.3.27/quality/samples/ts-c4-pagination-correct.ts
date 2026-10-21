// Sample ts-c4 — boundary (clean reference)
// Page indexes are zero-based internally, validated, and the slice cannot
// read out of bounds; an empty page returns an empty array.
export function pageItems<T>(items: readonly T[], page: number, size: number): T[] {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('page must be >= 1');
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('size must be >= 1');
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
