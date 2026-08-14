import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';

function isUnderRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a path inside a workspace and verify the boundary after following
 * symlinks. Missing targets are allowed only when their nearest existing
 * ancestor is still inside the workspace, which keeps create operations safe.
 */
export function resolveWorkspacePath(workspace: string, candidate: string): string | null {
  const root = resolve(workspace);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (!isUnderRoot(target, root)) return null;

  try {
    const realRoot = realpathSync(root);
    let ancestor = existsSync(target) ? target : dirname(target);
    while (!existsSync(ancestor) && ancestor !== root) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
    if (!existsSync(ancestor) || !isUnderRoot(realpathSync(ancestor), realRoot)) return null;
    if (existsSync(target) && !isUnderRoot(realpathSync(target), realRoot)) return null;
    return target;
  } catch {
    // A boundary that cannot be proven is not safe to use.
    return null;
  }
}

export function isWorkspacePath(workspace: string, candidate: string): boolean {
  return resolveWorkspacePath(workspace, candidate) !== null;
}
