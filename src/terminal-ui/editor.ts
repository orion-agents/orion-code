import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'child_process';

export interface EditorResult {
  content?: string;
  cancelled?: boolean;
  error?: string;
}

export interface EditorOptions {
  initialContent?: string;
  env?: NodeJS.ProcessEnv;
  spawnSync?: (command: string, args: string[], options: { stdio: 'inherit'; shell: boolean }) => SpawnSyncReturns<Buffer>;
}

export function selectEditor(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL || env.EDITOR || 'vi';
}

export function openExternalEditor(options: EditorOptions = {}): EditorResult {
  const editor = selectEditor(options.env);
  const spawn = options.spawnSync ?? nodeSpawnSync;
  // v0.2.23: unique temp dir with random component to avoid collisions.
  const dir = mkdtempSync(join(tmpdir(), `orion-code-edit-${randomUUID().slice(0, 8)}-`));
  const file = join(dir, 'prompt.md');

  try {
    writeFileSync(file, options.initialContent ?? '', { encoding: 'utf8', mode: 0o600 });
    // Explicit chmod for platforms where writeFileSync mode may not apply.
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    const result = spawn(editor, [file], {
      stdio: 'inherit',
      shell: true,
    });

    if (result.error) {
      return { error: result.error.message };
    }
    if (result.status !== 0) {
      return { error: `Editor exited with status ${result.status ?? 'unknown'}.` };
    }

    const content = readFileSync(file, 'utf8').trimEnd();
    if (!content.trim()) {
      return { cancelled: true };
    }
    return { content };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    // v0.2.23: guaranteed cleanup of temp dir.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
