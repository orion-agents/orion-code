import {
  addMultilineLine,
  cancelMultiline,
  enterMultiline,
  getMultilineInput,
  getMultilineLineCount,
  isMultilineActive,
  renderContinuationPrompt,
  resetMultiline,
} from '../src/ui/multiline-input';
import { clearStatusBar, updateStatusBarDisplay } from '../src/ui/status-bar';
import {
  getProductIdentity,
  CLI_NAME,
  DISPLAY_NAME,
  NPM_PACKAGE,
  PRODUCT_ID,
  REPOSITORY,
} from '../src/product/identity';
import { ORION_USER_AGENT, PACKAGE_VERSION, resolvePackageVersion } from '../src/product/version';
import packageMetadata from '../package.json';
import { isTechnicalUIRenderer } from '../src/services/config';
import { YAMLConfigLoader } from '../src/services/yaml-config';
import {
  BUILTIN_MODELS,
  calculateCtxPercent,
  getAllKnownModels,
  getModelInfo,
} from '../src/services/model-context';
import { quickTokenEstimate } from '../src/utils/token-estimate';

describe('public utility contracts', () => {
  it('keeps the product identity singleton aligned with its public constants', () => {
    const identity = getProductIdentity();

    expect(identity).toMatchObject({
      productId: PRODUCT_ID,
      displayName: DISPLAY_NAME,
      cliName: CLI_NAME,
      npmPackage: NPM_PACKAGE,
      repository: REPOSITORY,
    });
    expect(NPM_PACKAGE).toBe(packageMetadata.name);
    expect(REPOSITORY).toBe('orion-agents/orion-code');
    expect(packageMetadata.repository.url).toContain(REPOSITORY);
    expect(getProductIdentity()).toBe(identity);
  });

  it('uses package metadata as the single runtime version source', () => {
    const previous = process.env.npm_package_version;
    process.env.npm_package_version = '9.9.9-caller';

    try {
      expect(resolvePackageVersion()).toBe(packageMetadata.version);
      expect(PACKAGE_VERSION).toBe(packageMetadata.version);
      expect(ORION_USER_AGENT).toBe(`Orion-Code/${packageMetadata.version}`);
    } finally {
      if (previous === undefined) delete process.env.npm_package_version;
      else process.env.npm_package_version = previous;
    }
  });

  it('uses the package version in generated YAML configuration templates', () => {
    const template = new YAMLConfigLoader().generateTemplate();

    expect(template).toContain(`version: "${packageMetadata.version}"`);
    expect(template).not.toContain('version: "0.1.5"');
  });

  it('classifies only terminal-ui as the technical renderer', () => {
    expect(isTechnicalUIRenderer('terminal')).toBe(true);
    expect(isTechnicalUIRenderer('tui')).toBe(false);
    expect(isTechnicalUIRenderer('ink')).toBe(false);
    expect(isTechnicalUIRenderer(null)).toBe(false);
  });

  it('provides conservative quick estimates for ASCII and CJK character counts', () => {
    expect(quickTokenEstimate(0)).toBe(0);
    expect(quickTokenEstimate(9)).toBe(3);
    expect(quickTokenEstimate(3, true)).toBe(5);
  });

  it('reports multiline state and cancels the buffered input', () => {
    resetMultiline();
    enterMultiline('first\\');
    addMultilineLine('second\\');

    expect(isMultilineActive()).toBe(true);
    expect(getMultilineLineCount()).toBe(2);
    expect(getMultilineInput()).toBe('first\nsecond');
    expect(renderContinuationPrompt()).toContain('... (3)');

    cancelMultiline();
    expect(isMultilineActive()).toBe(false);
    expect(getMultilineLineCount()).toBe(0);
    expect(getMultilineInput()).toBe('');
  });

  it('writes the status bar using save, redraw, and restore cursor sequences', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      updateStatusBarDisplay({
        model: 'test-model',
        tokens: 1200,
        promptTokens: 1000,
        completionTokens: 200,
        cost: 0,
        ctxPercent: 42,
        mcpConnected: 1,
        mcpTotal: 2,
      });
      clearStatusBar();

      expect(write.mock.calls.map(call => call[0])).toEqual([
        '\x1b[s',
        '\x1b[A',
        '\x1b[2K',
        expect.stringContaining('test-model'),
        '\x1b[u',
        '\x1b[s',
        '\x1b[A',
        '\x1b[2K',
        '\x1b[u',
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('exposes built-in model information and clamps context utilization', () => {
    const model = getModelInfo('gpt-4o');

    expect(model).toMatchObject({ id: 'gpt-4o', contextWindow: expect.any(Number) });
    expect(getModelInfo('definitely-unknown-model')).toBeNull();
    expect(calculateCtxPercent(model!.contextWindow / 2, 'gpt-4o')).toBe(50);
    expect(calculateCtxPercent(model!.contextWindow * 2, 'gpt-4o')).toBe(100);

    const knownModels = getAllKnownModels();
    expect(knownModels).toHaveLength(Object.keys(BUILTIN_MODELS).length);
    expect(knownModels).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gpt-4o' })])
    );
  });
});
