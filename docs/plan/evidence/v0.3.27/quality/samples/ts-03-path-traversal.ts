// Sample ts-03 — permission/path (defect)
// A static file helper that joins the raw user path onto the public root and
// reads it back: "..%2f..%2fetc%2fpasswd" escapes the root because the
// containment check is missing.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PUBLIC_ROOT = '/srv/public';

export async function serveAsset(userPath: string): Promise<Buffer> {
  const resolved = join(PUBLIC_ROOT, userPath);
  return readFile(resolved);
}
