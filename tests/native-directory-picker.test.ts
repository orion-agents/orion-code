/**
 * v0.3.16 — Host native directory picker contract.
 *
 * These tests never open a real dialog: the process runner is injected, so we
 * can assert exactly what would be executed and how each outcome is mapped.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  createFixtureDirectoryPicker,
  createNativeDirectoryPicker,
  fixturePickerFromEnvironment,
  parseNativePickerStdout,
  type DirectoryPickerCommand,
  type FixturePickerScript,
} from '../src/web/native-directory-picker';

function recordingPicker(stdout: string) {
  const calls: DirectoryPickerCommand[] = [];
  const picker = createNativeDirectoryPicker({
    platform: 'darwin',
    runner: async command => {
      calls.push(command);
      return { stdout };
    },
  });
  return { picker, calls };
}

describe('parseNativePickerStdout', () => {
  it('reads the selected path and strips the trailing separator AppleScript adds', () => {
    expect(parseNativePickerStdout('__ORION_PICK_SELECTED__/Users/hope/project/\n', 4096)).toEqual({
      kind: 'selected',
      path: '/Users/hope/project',
    });
  });

  it('keeps the filesystem root intact', () => {
    expect(parseNativePickerStdout('__ORION_PICK_SELECTED__/', 4096)).toEqual({
      kind: 'selected',
      path: '/',
    });
  });

  it('preserves spaces and unicode in the chosen path', () => {
    expect(parseNativePickerStdout('__ORION_PICK_SELECTED__/Users/hope/我的 项目/', 4096)).toEqual({
      kind: 'selected',
      path: '/Users/hope/我的 项目',
    });
  });

  it('maps the cancellation marker to cancelled', () => {
    expect(parseNativePickerStdout('__ORION_PICK_CANCELLED__\n', 4096)).toEqual({
      kind: 'cancelled',
    });
  });

  it('maps the error marker to unavailable without echoing the message', () => {
    const result = parseNativePickerStdout('__ORION_PICK_ERROR__boom: /secret/path', 4096);
    expect(result).toEqual({ kind: 'unavailable', reason: 'picker_failed' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('treats unexpected output as unavailable', () => {
    expect(parseNativePickerStdout('hello world', 4096)).toEqual({
      kind: 'unavailable',
      reason: 'picker_unexpected_output',
    });
  });

  it('rejects an over-long path', () => {
    expect(parseNativePickerStdout(`__ORION_PICK_SELECTED__/${'a'.repeat(20)}`, 10)).toEqual({
      kind: 'unavailable',
      reason: 'picker_returned_invalid_path',
    });
  });

  it('rejects a selected marker that carries no path', () => {
    expect(parseNativePickerStdout('__ORION_PICK_SELECTED__', 4096)).toEqual({
      kind: 'unavailable',
      reason: 'picker_returned_invalid_path',
    });
  });
});

describe('createFixtureDirectoryPicker', () => {
  it('walks a path list and repeats the last entry', async () => {
    const picker = createFixtureDirectoryPicker(() => ({ paths: ['/tmp/a', '/tmp/b'] }));
    await expect(picker.pickDirectory({})).resolves.toEqual({ kind: 'selected', path: '/tmp/a' });
    await expect(picker.pickDirectory({})).resolves.toEqual({ kind: 'selected', path: '/tmp/b' });
    await expect(picker.pickDirectory({})).resolves.toEqual({ kind: 'selected', path: '/tmp/b' });
  });

  it('honours cancelled and unavailable outcomes', async () => {
    const cancelled = createFixtureDirectoryPicker(() => ({ outcome: 'cancelled' }));
    await expect(cancelled.pickDirectory({})).resolves.toEqual({ kind: 'cancelled' });

    const unavailable = createFixtureDirectoryPicker(() => ({
      outcome: 'unavailable',
      reason: 'picker_timeout',
    }));
    await expect(unavailable.pickDirectory({})).resolves.toEqual({
      kind: 'unavailable',
      reason: 'picker_timeout',
    });
  });

  it('re-reads the script so a test can change the next answer', async () => {
    let answer: FixturePickerScript = { path: '/tmp/first' };
    const picker = createFixtureDirectoryPicker(() => answer);
    await expect(picker.pickDirectory({})).resolves.toEqual({ kind: 'selected', path: '/tmp/first' });
    answer = { outcome: 'cancelled' };
    await expect(picker.pickDirectory({})).resolves.toEqual({ kind: 'cancelled' });
  });

  it('is inert when the environment variable is absent', () => {
    expect(fixturePickerFromEnvironment({})).toBeUndefined();
    expect(fixturePickerFromEnvironment({ ORION_CODE_WEB_PICKER_FIXTURE: '  ' })).toBeUndefined();
  });

  it('reads the script file named by the environment variable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-picker-fixture-'));
    try {
      const scriptPath = join(root, 'picker.json');
      writeFileSync(scriptPath, JSON.stringify({ path: root }));
      const picker = fixturePickerFromEnvironment({ ORION_CODE_WEB_PICKER_FIXTURE: scriptPath });
      expect(picker).toBeDefined();
      await expect(picker?.pickDirectory({})).resolves.toEqual({ kind: 'selected', path: root });

      // A malformed script behaves like a cancelled dialog, never a crash.
      writeFileSync(scriptPath, '{ not json');
      await expect(picker?.pickDirectory({})).resolves.toEqual({ kind: 'cancelled' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createNativeDirectoryPicker', () => {
  it('invokes osascript with a fixed script and passes the title/path as argv', async () => {
    const { picker, calls } = recordingPicker('__ORION_PICK_SELECTED__/tmp/chosen/');
    const result = await picker.pickDirectory({
      title: 'Pick a folder',
      initialPath: '/tmp/a b',
    });

    expect(result).toEqual({ kind: 'selected', path: '/tmp/chosen' });
    expect(calls).toHaveLength(1);
    const [command] = calls;
    expect(command.file).toBe('osascript');
    expect(command.args[0]).toBe('-e');
    // The script is a constant; user-controlled values only appear as argv.
    expect(command.args[1]).not.toContain('Pick a folder');
    expect(command.args).toContain('Pick a folder');
    expect(command.args).toContain('/tmp/a b');
  });

  it('defaults the prompt when no title is supplied', async () => {
    const { picker, calls } = recordingPicker('__ORION_PICK_CANCELLED__');
    await picker.pickDirectory({});
    // args = ['-e', script, prompt, initialPath]
    expect(calls[0].args[2]).not.toBe('');
    expect(calls[0].args[3]).toBe('');
  });

  it('returns cancelled as a normal outcome', async () => {
    const { picker } = recordingPicker('__ORION_PICK_CANCELLED__');
    await expect(picker.pickDirectory({})).resolves.toEqual({ kind: 'cancelled' });
  });

  it('maps a runner failure to unavailable', async () => {
    const picker = createNativeDirectoryPicker({
      platform: 'darwin',
      runner: async () => {
        throw new Error('spawn osascript ENOENT');
      },
    });
    await expect(picker.pickDirectory({})).resolves.toEqual({
      kind: 'unavailable',
      reason: 'picker_unavailable',
    });
  });

  it('keeps a timeout distinct from an unavailable picker', async () => {
    const picker = createNativeDirectoryPicker({
      platform: 'darwin',
      runner: async () => {
        throw Object.assign(new Error('native directory picker failed'), {
          reason: 'picker_timeout',
        });
      },
    });
    await expect(picker.pickDirectory({})).resolves.toEqual({
      kind: 'unavailable',
      reason: 'picker_timeout',
    });
  });

  it('is explicitly unavailable on non-macOS platforms and never runs a process', async () => {
    let invoked = 0;
    const picker = createNativeDirectoryPicker({
      platform: 'linux',
      runner: async () => {
        invoked += 1;
        return { stdout: '' };
      },
    });
    await expect(picker.pickDirectory({})).resolves.toEqual({
      kind: 'unavailable',
      reason: 'picker_unavailable',
    });
    expect(invoked).toBe(0);
  });
});
