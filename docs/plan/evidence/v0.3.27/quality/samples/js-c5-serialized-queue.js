// Sample js-c5 — race (clean reference)
// Loaders for the same key are serialised through a per-key promise chain, so
// concurrent callers share one fetch and one cache write.
const cache = new Map();
const inflight = new Map();

async function loadConfig(key) {
  if (cache.has(key)) return cache.get(key);
  const pending = inflight.get(key) ?? doLoad(key);
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(key);
  }
}

async function doLoad(key) {
  const response = await fetch(`https://example.invalid/config/${key}`);
  const text = await response.text();
  cache.set(key, text);
  return text;
}

module.exports = { loadConfig };
