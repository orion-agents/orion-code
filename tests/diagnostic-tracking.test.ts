import {
  DiagnosticSeverity,
  DiagnosticTracker,
  formatDiagnostic,
  formatDiagnostics,
  formatDiagnosticSummary,
  getDiagnosticTracker,
  resetDiagnosticTracker,
  type Diagnostic,
} from '../src/services/diagnostic-tracking';

const diagnostic = (
  file: string,
  line: number,
  severity: DiagnosticSeverity,
  message: string,
  code?: string
): Diagnostic => ({
  source: 'test',
  file,
  line,
  severity,
  message,
  code,
  timestamp: 1,
});

describe('diagnostic tracking', () => {
  afterEach(resetDiagnosticTracker);

  it('tracks new and resolved diagnostics against an immutable baseline', () => {
    const baselineError = diagnostic('src/a.ts', 1, DiagnosticSeverity.Error, 'baseline', 'E1');
    const baselineWarning = diagnostic('src/b.ts', 2, DiagnosticSeverity.Warning, 'warning', 'W1');
    const newError = diagnostic('src/c.ts', 3, DiagnosticSeverity.Error, 'new error', 'E2');
    const tracker = new DiagnosticTracker();
    tracker.setBaseline([baselineError, baselineWarning]);

    const result = tracker.update([baselineWarning, newError]);

    expect(result).toEqual({
      newDiagnostics: [newError],
      resolvedDiagnostics: [baselineError],
      hasNewErrors: true,
    });
    expect(tracker.detectNewErrors()).toEqual([newError]);
    expect(tracker.detectNewWarnings()).toEqual([]);
    expect(tracker.getStats()).toEqual({
      baselineCount: 2,
      currentCount: 2,
      newCount: 1,
      resolvedCount: 1,
      errorCount: 1,
      warningCount: 1,
    });
    expect(tracker.formatReport()).toContain('[ERROR] src/c.ts:3: new error');
    expect(tracker.formatReport()).toContain('✓ src/a.ts:1: baseline');
  });

  it('uses the first update as the baseline and resets singleton state', () => {
    const warning = diagnostic('src/a.ts', 4, DiagnosticSeverity.Warning, 'warning');
    const tracker = getDiagnosticTracker();
    expect(tracker.update([warning])).toMatchObject({ hasNewErrors: false });
    expect(tracker.getBaselineDiagnostics()).toEqual([warning]);

    resetDiagnosticTracker();
    expect(getDiagnosticTracker()).not.toBe(tracker);
    expect(getDiagnosticTracker().getStats().currentCount).toBe(0);
  });

  it('formats severity, sorting, truncation, empty states, and summaries', () => {
    const values = [
      diagnostic('hint.ts', 4, DiagnosticSeverity.Hint, 'hint'),
      diagnostic('error.ts', 1, DiagnosticSeverity.Error, 'error'),
      diagnostic('warning.ts', 2, DiagnosticSeverity.Warning, 'warning'),
      diagnostic('info.ts', 3, DiagnosticSeverity.Information, 'info'),
    ];

    expect(formatDiagnostic(values[1])).toContain('E');
    const formatted = formatDiagnostics(values);
    expect(formatted.indexOf('error.ts')).toBeLessThan(formatted.indexOf('warning.ts'));
    expect(formatDiagnostics([])).toBe('No diagnostics found.');
    expect(formatDiagnosticSummary(values)).toContain('1 errors');
    expect(formatDiagnosticSummary([])).toContain('No issues');

    const many = Array.from({ length: 22 }, (_, index) =>
      diagnostic(`src/${index}.ts`, index + 1, DiagnosticSeverity.Warning, `warning ${index}`)
    );
    expect(formatDiagnostics(many)).toContain('... and 2 more');
  });
});
