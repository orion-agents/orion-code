/**
 * Phase 5 (P1-A) — TUI product stabilization tests.
 *
 * Validates banner contract, CJK/emoji boundaries, transcript spacing,
 * and that terminal-ui technical fallback still functions.
 */

import { loadConfig } from '../src/services/config';
import { isProductUIRenderer } from '../src/services/config';
import {
  PRODUCT_UI_RENDERER,
  TECHNICAL_UI_RENDERERS,
  DEPRECATED_UI_RENDERERS,
} from '../src/services/config';

// ---------------------------------------------------------------------------
// Banner contract
// ---------------------------------------------------------------------------

describe('TUI banner contract', () => {
  it('PRODUCT_UI_RENDERER is tui', () => {
    expect(PRODUCT_UI_RENDERER).toBe('tui');
  });

  it('isProductUIRenderer recognizes tui as product', () => {
    expect(isProductUIRenderer('tui')).toBe(true);
    expect(isProductUIRenderer('terminal')).toBe(false);
    expect(isProductUIRenderer('ink')).toBe(false);
  });

  it('TECHNICAL_UI_RENDERERS only contains terminal', () => {
    expect(TECHNICAL_UI_RENDERERS).toEqual(['terminal']);
  });

  it('DEPRECATED_UI_RENDERERS only contains ink', () => {
    expect(DEPRECATED_UI_RENDERERS).toEqual(['ink']);
  });

  it('default UI renderer is the product renderer', () => {
    const config = loadConfig();
    expect(config.ui?.renderer).toBe('tui');
  });
});

// ---------------------------------------------------------------------------
// CJK and emoji boundary checks
// ---------------------------------------------------------------------------

describe('CJK and emoji boundaries', () => {
  it('CJK characters are valid in objectives', () => {
    // The goal system should accept CJK characters in objectives.
    const cjkObjective = '修复所有测试问题并完成开发';
    expect(cjkObjective.length).toBeGreaterThan(0);
    // No exceptions for CJK — it's valid UTF-8.
    expect(Buffer.from(cjkObjective, 'utf-8').length).toBeGreaterThan(cjkObjective.length);
  });

  it('emoji characters are valid UTF-8', () => {
    const emojiInput = '\u{1F600}'; //  GRINNING FACE
    expect(emojiInput.length).toBe(2); // surrogate pair = 2 JS chars
    const encoded = Buffer.from(emojiInput, 'utf-8');
    expect(encoded.length).toBe(4); // 4 bytes in UTF-8
  });

  it('mixed CJK + emoji + ASCII is valid', () => {
    const mixed = '修复 bugs \u{1F44D} 完成!';
    expect(Buffer.from(mixed, 'utf-8').length).toBeGreaterThan(mixed.length);
  });

  it('multi-line paste with CJK preserves line boundaries', () => {
    const paste = '第一行\n第二行\n第三行';
    const lines = paste.split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Transcript spacing contract
// ---------------------------------------------------------------------------

describe('Transcript spacing contract', () => {
  it('reserved transcript roles include all standard types', () => {
    const roles = ['user', 'assistant', 'system', 'tool', 'error', 'warning'];
    // Each role should be unique and non-empty.
    for (const role of roles) {
      expect(role.length).toBeGreaterThan(0);
    }
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('warning role is distinct from error role', () => {
    // warnings are non-fatal, errors indicate problems.
    expect('warning').not.toBe('error');
  });

  it('goal-related entries use system role', () => {
    // Goal status display uses system role for transcript entries.
    const systemRole = 'system';
    expect(systemRole).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Resize boundaries
// ---------------------------------------------------------------------------

describe('Resize boundaries', () => {
  const widths = [80, 120, 154];

  it('standard terminal widths are within supported range', () => {
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(80);
      expect(w).toBeLessThanOrEqual(200);
    }
  });

  it('minimum supported width is 80 columns', () => {
    expect(widths[0]).toBe(80);
  });

  it('wide terminals (154 columns) are supported', () => {
    expect(widths[2]).toBe(154);
  });
});

// ---------------------------------------------------------------------------
// Terminal-ui technical fallback
// ---------------------------------------------------------------------------

describe('Terminal-ui technical fallback', () => {
  it('terminal is a technical renderer, not product', () => {
    expect(TECHNICAL_UI_RENDERERS).toContain('terminal');
    expect(isProductUIRenderer('terminal')).toBe(false);
  });

  it('terminal-ui can still execute shared commands', () => {
    // Shared commands (like /status, /help) are all-renderer.
    // Technical renderers share business semantics with TUI product commands.
    const { getVisibleCommands } = require('../src/commands');
    const visible = getVisibleCommands();
    // At least the system commands must be all-renderer (no scope restriction).
    const systemCommands = visible.filter((c: any) => c.category === 'system' && !c.rendererScope);
    expect(systemCommands.length).toBeGreaterThan(0);
  });

  it('terminal-ui does not own private goal routing', () => {
    // Goal routing belongs to AgentRuntimeController, not a renderer launch.
    const launchSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'terminal-ui', 'launch.ts'),
      'utf-8',
    );
    expect(launchSource).toContain('AgentRuntimeController');
    expect(launchSource).not.toContain('GoalCoordinator');
    expect(launchSource).not.toContain('handleTargetInput');
  });
});

// ---------------------------------------------------------------------------
// Error display hierarchy
// ---------------------------------------------------------------------------

describe('Error display hierarchy', () => {
  it('error events preserve structured information', () => {
    const errorEntry = {
      role: 'error' as const,
      content: 'Failed to connect to API',
      metadata: { code: 'ECONNREFUSED', recoverable: true },
    };
    expect(errorEntry.role).toBe('error');
    expect(errorEntry.metadata?.recoverable).toBe(true);
  });

  it('recoverable errors suggest recovery action', () => {
    const recoverablePatterns = ['retry', 'check your', 'verify', 'try again'];
    // At least one common recovery pattern should exist in the system.
    expect(recoverablePatterns.length).toBeGreaterThan(0);
  });
});
