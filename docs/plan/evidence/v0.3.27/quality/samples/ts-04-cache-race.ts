// Sample ts-04 — race (defect)
// The memoised loader checks the cache, awaits the network, then writes the
// cache: two concurrent callers for the same key both miss, both fetch, and
// the second write silently replaces the first (and duplicates the request).
const cache = new Map<string, string>();

export async function loadConfig(key: string): Promise<string> {
  if (cache.has(key)) return cache.get(key) as string;
  const response = await fetch(`https://example.invalid/config/${key}`);
  const text = await response.text();
  cache.set(key, text);
  return text;
}
