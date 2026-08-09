/**
 * Extract the first balanced JSON object from text that may contain prose.
 * Returns the parsed value, or null when no valid object is present.
 */
export function extractJsonObject(text: string): unknown {
  if (!text) return null;

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }

    if (end === -1) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        return null;
      }
    }

    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      searchFrom = end + 1;
    }
  }
  return null;
}
