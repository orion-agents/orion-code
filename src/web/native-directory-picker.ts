/**
 * v0.3.16 — Host-side native directory picker.
 *
 * The browser cannot hand the local Node Host a real filesystem path (no such
 * API exists, by design), so opening a *new* local project has to start from
 * the Host. This adapter shells out to the OS picker and returns the chosen
 * directory — nothing else. It never writes to the workspace registry, never
 * activates a Context and never reads file contents.
 *
 * Safety contract:
 * - The AppleScript is a fixed constant. The prompt and the optional default
 *   location travel as `argv`, so a path can never be interpolated into a
 *   script (or a shell) string.
 * - We use `execFile`, not `exec`/`spawn(shell: true)`, so no shell parses the
 *   arguments.
 * - Cancellation is a normal outcome, not an error. Unexpected output is
 *   reported as `unavailable` with a fixed reason code — never echoed back,
 *   because picker output may contain a path the user has not confirmed.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type NativeDirectoryPickResult =
  | { readonly kind: 'selected'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface NativeDirectoryPickerInput {
  readonly title?: string;
  readonly initialPath?: string;
}

export interface NativeDirectoryPicker {
  pickDirectory(input: NativeDirectoryPickerInput): Promise<NativeDirectoryPickResult>;
}

export interface DirectoryPickerCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/** Injectable process runner so the picker can be unit-tested without a GUI. */
export type DirectoryPickerRunner = (
  command: DirectoryPickerCommand
) => Promise<{ readonly stdout: string }>;

export interface NativeDirectoryPickerOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: DirectoryPickerRunner;
  /** Reject absurd paths from a misbehaving picker. */
  readonly maxPathLength?: number;
  readonly timeoutMs?: number;
}

/** Fixed markers so we can tell outcomes apart without pattern-matching paths. */
const MARKER_SELECTED = '__ORION_PICK_SELECTED__';
const MARKER_CANCELLED = '__ORION_PICK_CANCELLED__';
const MARKER_ERROR = '__ORION_PICK_ERROR__';

const DEFAULT_TITLE = '选择要打开的本地项目文件夹';
const DEFAULT_MAX_PATH_LENGTH = 4096;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * `choose folder` blocks until the user acts. Cancelling raises AppleScript
 * error -128, which we translate into the CANCELLED marker so the process
 * exits 0 and the caller can treat it as a normal outcome.
 */
const MACOS_PICK_SCRIPT = [
  'on run argv',
  '  set promptText to item 1 of argv',
  '  set defaultPath to item 2 of argv',
  '  try',
  '    if defaultPath is "" then',
  '      set chosen to choose folder with prompt promptText',
  '    else',
  '      set chosen to choose folder with prompt promptText default location (POSIX file defaultPath)',
  '    end if',
  '  on error errMsg number errNum',
  '    if errNum is -128 then',
  `      return "${MARKER_CANCELLED}"`,
  '    end if',
  `    return "${MARKER_ERROR}"`,
  '  end try',
  `  return "${MARKER_SELECTED}" & (POSIX path of chosen)`,
  'end run',
].join('\n');

/** Why a picker invocation could not produce a directory. */
export type DirectoryPickerFailureReason = 'picker_unavailable' | 'picker_timeout';

/**
 * The default runner kills the child process when `timeoutMs` elapses, which is
 * a distinct outcome from "this platform has no picker". It is surfaced as a
 * fixed reason code so callers never have to parse an error message.
 */
const createDefaultRunner =
  (timeoutMs: number): DirectoryPickerRunner =>
  command =>
    new Promise((resolve, reject) => {
      execFile(
        command.file,
        [...command.args],
        { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) {
            const failure = new Error('native directory picker failed');
            (failure as { reason?: DirectoryPickerFailureReason }).reason = (
              error as { killed?: boolean }
            ).killed
              ? 'picker_timeout'
              : 'picker_unavailable';
            reject(failure);
            return;
          }
          resolve({ stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') });
        }
      );
    });

/**
 * `POSIX path of` always appends a trailing slash; the registry compares
 * canonical paths exactly, so normalize here rather than downstream.
 */
function stripTrailingSeparator(path: string): string {
  if (path.length <= 1) return path;
  return path.replace(/\/+$/u, '') || '/';
}

export function parseNativePickerStdout(
  stdout: string,
  maxPathLength: number
): NativeDirectoryPickResult {
  const text = stdout.trim();
  if (text === MARKER_CANCELLED) return { kind: 'cancelled' };
  if (text.startsWith(MARKER_SELECTED)) {
    const path = stripTrailingSeparator(text.slice(MARKER_SELECTED.length).trim());
    if (!path || path.length > maxPathLength) {
      return { kind: 'unavailable', reason: 'picker_returned_invalid_path' };
    }
    return { kind: 'selected', path };
  }
  if (text.startsWith(MARKER_ERROR)) {
    return { kind: 'unavailable', reason: 'picker_failed' };
  }
  return { kind: 'unavailable', reason: 'picker_unexpected_output' };
}

export function createNativeDirectoryPicker(
  options: NativeDirectoryPickerOptions = {}
): NativeDirectoryPicker {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? createDefaultRunner(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxPathLength = options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;

  return {
    async pickDirectory(input: NativeDirectoryPickerInput): Promise<NativeDirectoryPickResult> {
      // Only macOS has an implemented adapter. Other platforms answer
      // explicitly instead of pretending a directory was chosen, so the UI can
      // fall back to the advanced manual path entry.
      if (platform !== 'darwin') {
        return { kind: 'unavailable', reason: 'picker_unavailable' };
      }
      const title = input.title?.trim() || DEFAULT_TITLE;
      const initialPath = input.initialPath?.trim() ?? '';
      let stdout: string;
      try {
        ({ stdout } = await runner({
          file: 'osascript',
          args: ['-e', MACOS_PICK_SCRIPT, title, initialPath],
        }));
      } catch (error) {
        const reason = (error as { reason?: DirectoryPickerFailureReason } | null)?.reason;
        return {
          kind: 'unavailable',
          reason: reason === 'picker_timeout' ? 'picker_timeout' : 'picker_unavailable',
        };
      }
      return parseNativePickerStdout(stdout, maxPathLength);
    },
  };
}

/**
 * v0.3.17 — scripted picker for end-to-end tests.
 *
 * CI must never pop a real Finder dialog, so E2E points the Host at a JSON
 * script file instead. The script is re-read on every invocation, which lets a
 * test change the next answer between clicks:
 *
 * ```json
 * { "path": "/abs/dir" }                        // selected
 * { "paths": ["/a", "/b"] }                     // sequential, last one repeats
 * { "outcome": "cancelled" }                    // user cancelled
 * { "outcome": "unavailable", "reason": "..." } // no picker on this platform
 * ```
 *
 * This is a browse-only seam: the returned path still has to be confirmed on
 * the card and passes through the same guarded activation flow, so it can never
 * cause an unattended workspace switch.
 */
export interface FixturePickerScript {
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly outcome?: 'cancelled' | 'unavailable';
  readonly reason?: string;
}

export function createFixtureDirectoryPicker(
  readScript: () => FixturePickerScript
): NativeDirectoryPicker {
  let cursor = 0;
  return {
    async pickDirectory(): Promise<NativeDirectoryPickResult> {
      const script = readScript();
      const paths = script.paths ?? (script.path ? [script.path] : []);
      if (paths.length > 0) {
        const next = paths[Math.min(cursor, paths.length - 1)];
        cursor += 1;
        return next ? { kind: 'selected', path: next } : { kind: 'cancelled' };
      }
      if (script.outcome === 'unavailable') {
        return { kind: 'unavailable', reason: script.reason ?? 'picker_unavailable' };
      }
      return { kind: 'cancelled' };
    },
  };
}

/** Reads the script from `ORION_CODE_WEB_PICKER_FIXTURE`; absent means real. */
export function fixturePickerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NativeDirectoryPicker | undefined {
  const scriptPath = env.ORION_CODE_WEB_PICKER_FIXTURE?.trim();
  if (!scriptPath) return undefined;
  return createFixtureDirectoryPicker(() => {
    try {
      const parsed = JSON.parse(readFileSync(scriptPath, 'utf8')) as FixturePickerScript;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // A missing or malformed script behaves like a cancelled dialog rather
      // than failing the request.
      return {};
    }
  });
}
