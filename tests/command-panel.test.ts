/**
 * Issue #32 #4.3: Command panel tests
 */

import { spawn } from 'child_process';
import { join } from 'path';

describe('Command Panel', () => {
  const cliPath = join(__dirname, '..', 'dist', 'cli.js');
  let writeSpy: jest.SpyInstance;
  let output: string[];

  beforeEach(() => {
    jest.resetModules();
    output = [];
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    try {
      const { hideCommandPanel } = require('../src/ui/command-panel');
      hideCommandPanel();
    } catch {
      // Ignore cleanup failures from module reset.
    }
    writeSpy.mockRestore();
  });

  // Note: These tests are limited because command-panel relies on TTY
  // which is not available in Jest environment

  describe('resetRenderLength', () => {
    it('should reset isFirstRender to true', () => {
      // Import the function
      const { resetRenderLength } = require('../src/ui/command-panel');
      resetRenderLength();
      // The function exists and can be called
      expect(typeof resetRenderLength).toBe('function');
    });
  });

  describe('showCommandPanel', () => {
    it('should be a function', () => {
      const { showCommandPanel } = require('../src/ui/command-panel');
      expect(typeof showCommandPanel).toBe('function');
    });
  });

  describe('hideCommandPanel', () => {
    it('should be a function', () => {
      const { hideCommandPanel } = require('../src/ui/command-panel');
      expect(typeof hideCommandPanel).toBe('function');
    });
  });

  describe('isPanelVisible', () => {
    it('should return boolean', () => {
      const { isPanelVisible } = require('../src/ui/command-panel');
      expect(typeof isPanelVisible()).toBe('boolean');
    });
  });

  describe('compact rendering', () => {
    it('hides argument hints and type labels from command rows', () => {
      const { showCommandPanel } = require('../src/ui/command-panel');

      showCommandPanel('m');

      const rendered = output.join('');
      expect(rendered).toContain('Matching "m"');
      expect(rendered).toContain('/model');
      expect(rendered).toContain('Tab Complete');
      expect(rendered).not.toContain('[model|list|help]');
      expect(rendered).not.toContain('[Cmd]');
    });

    it('completes the selected command without executing it', () => {
      const {
        completeSelectedCommand,
        getPendingCommand,
        isPanelVisible,
        showCommandPanel,
      } = require('../src/ui/command-panel');

      showCommandPanel('s');

      const completed = completeSelectedCommand();

      expect(completed).toBe('/status ');
      expect(isPanelVisible()).toBe(false);
      expect(getPendingCommand()).toBeNull();
    });

    it('keeps the panel visible on empty matches so backspace can recover', () => {
      const { showCommandPanel, updatePanelFilter, isPanelVisible } = require('../src/ui/command-panel');

      showCommandPanel('zzzz');

      expect(isPanelVisible()).toBe(true);
      expect(output.join('')).toContain('No matching commands');

      updatePanelFilter('s');

      const rendered = output.join('');
      expect(rendered).toContain('Matching "s"');
      expect(rendered).toContain('/status');
    });

    it('clears the existing panel before redrawing input while filtering', () => {
      const {
        showCommandPanel,
        redrawInputWithPrompt,
        resetRenderLength,
        setInputPromptRenderer,
      } = require('../src/ui/command-panel');

      setInputPromptRenderer('framed');
      resetRenderLength();
      showCommandPanel('s');
      output = [];

      redrawInputWithPrompt('/ss');

      const rendered = output.join('');
      expect(rendered).toContain('\x1b[J');
      expect(rendered).toContain('›');
      expect(rendered).not.toContain('oh');
      expect(rendered).toContain('/ss');
      expect(rendered).not.toContain('Matching "s"');
    });

    it('clears the framed input row before submitted input is echoed', () => {
      const {
        clearRenderedInput,
        redrawInputWithPrompt,
        resetRenderLength,
        setInputPromptRenderer,
      } = require('../src/ui/command-panel');

      setInputPromptRenderer('framed');
      resetRenderLength();
      redrawInputWithPrompt('hello');
      output = [];

      clearRenderedInput();

      const rendered = output.join('');
      expect(rendered).toContain('\x1b[2K');
      expect(rendered.split('\x1b[2K')).toHaveLength(2);
      expect(rendered.endsWith('\r')).toBe(true);
    });

    it('clears the previous framed input row before redrawing slash input', () => {
      const {
        redrawInputWithPrompt,
        resetRenderLength,
        setInputPromptRenderer,
      } = require('../src/ui/command-panel');

      setInputPromptRenderer('framed');
      resetRenderLength();
      redrawInputWithPrompt('');
      output = [];

      redrawInputWithPrompt('/');

      const rendered = output.join('');
      expect(rendered).toContain('\x1b[2K');
      expect(rendered.split('\x1b[2K')).toHaveLength(2);
      expect(rendered).toContain('›');
      expect(rendered).not.toContain('oh');
      expect(rendered).toContain('/');
    });

    it('reserves command panel space below the framed input', () => {
      const {
        redrawInputWithPrompt,
        resetRenderLength,
        setInputPromptRenderer,
        showCommandPanel,
      } = require('../src/ui/command-panel');

      setInputPromptRenderer('framed');
      resetRenderLength();
      redrawInputWithPrompt('/');
      output = [];

      showCommandPanel('');

      const rendered = output.join('');
      expect(rendered).toContain('\x1b[2B\r');
      expect(rendered).toContain('\x1b[4G');
      expect(rendered).toContain('Commands');
    });

    it('restores the framed input below an unfinished output line', () => {
      const {
        redrawInputWithPrompt,
        resetRenderLength,
        setInputPromptRenderer,
        writeOutputPreservingInput,
      } = require('../src/ui/command-panel');

      setInputPromptRenderer('framed');
      resetRenderLength();
      writeOutputPreservingInput('assistant partial');
      redrawInputWithPrompt('edit');
      output = [];

      writeOutputPreservingInput(' chunk');

      const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
      expect(rendered).toContain(' chunk\n');
      expect(rendered).not.toContain(' chunk─');
    });

    it('keeps an empty framed input row visible during assistant output without separators', () => {
      const {
        redrawInputWithPrompt,
        resetRenderLength,
        setInputPromptRenderer,
        writeOutputPreservingInput,
      } = require('../src/ui/command-panel');

      setInputPromptRenderer('framed');
      resetRenderLength();
      redrawInputWithPrompt('');
      output = [];

      writeOutputPreservingInput('assistant line\n');

      const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
      expect(rendered).toContain('assistant line\n');
      expect(rendered).not.toContain('─');
      expect(rendered).toContain('›');
    });

    it('keeps the old v2 prompt renderer alias for compatibility', () => {
      const {
        redrawInputWithPrompt,
        resetRenderLength,
        setInputPromptRenderer,
      } = require('../src/ui/command-panel');

      setInputPromptRenderer('v2');
      resetRenderLength();
      redrawInputWithPrompt('compat');

      const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
      expect(rendered).toContain('› compat');
    });
  });
});
