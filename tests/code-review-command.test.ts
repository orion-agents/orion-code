/**
 * v0.3.28 — `/review` command wiring (plan S4). The slash command must parse
 * typed selectors, refuse unrecognized input with usage text (never falling
 * back to ordinary chat), and require a configured model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WORKFLOW_COMMANDS } from '../src/commands/workflow-commands';
import type { CommandContext } from '../src/commands/types';

function minimalContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'orion-review-cmd-')),
    config: {} as CommandContext['config'],
    store: {} as CommandContext['store'],
    llm: null,
    ...overrides,
  };
}

const reviewCommand = WORKFLOW_COMMANDS.find(command => command.name === 'review');
expect(reviewCommand).toBeDefined();

const createdCwds: string[] = [];

function trackedContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const ctx = minimalContext(overrides);
  createdCwds.push(ctx.cwd);
  return ctx;
}

describe('v0.3.28 — /review command wiring', () => {
  afterEach(() => {
    while (createdCwds.length > 0) {
      rmSync(createdCwds.pop() as string, { recursive: true, force: true });
    }
  });

  test('unrecognized arguments return usage instead of continuing as chat', async () => {
    const result = await reviewCommand!.execute(trackedContext(), '--frobnicate');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Usage: /review');
    expect(result.continueAsChat).toBeUndefined();
  });

  test('a missing model is an explicit error, not a chat fallback', async () => {
    const result = await reviewCommand!.execute(trackedContext(), 'all');
    expect(result.success).toBe(false);
    expect(result.error).toContain('configured model');
    expect(result.continueAsChat).toBeUndefined();
  });

  test('the command is registered as a read-only builtin', () => {
    expect(reviewCommand?.risk).toBe('read-only');
    expect(reviewCommand?.execution).toBe('builtin');
    expect(reviewCommand?.category).toBe('workflow');
  });
});
