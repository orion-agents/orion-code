// Sample ts-c3 — permission/path (clean reference)
// The user path is resolved and verified to stay inside the public root
// before any read; escapes are rejected with a typed error.
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const PUBLIC_ROOT = resolve('/srv/public');

export async function serveAsset(userPath: string): Promise<Buffer> {
  const resolved = resolve(join(PUBLIC_ROOT, userPath));
  if (resolved !== PUBLIC_ROOT && !resolved.startsWith(PUBLIC_ROOT + sep)) {
    throw new Error('asset escapes the public root');
  }
  return readFile(resolved);
}
