// Sample ts-05 — boundary (defect)
// Page slicing uses (page - 1) * size + 1 as the start index, so page one
// skips the first row and every page shifts by one item.
export function pageItems<T>(items: readonly T[], page: number, size: number): T[] {
  const start = (page - 1) * size + 1;
  return items.slice(start, start + size);
}
