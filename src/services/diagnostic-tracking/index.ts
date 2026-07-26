/**
 * orion code - Diagnostic Tracking 入口
 */

export {
  DiagnosticTracker,
  getDiagnosticTracker,
  resetDiagnosticTracker,
} from './diagnosticTracking';

export {
  Diagnostic,
  DiagnosticBaseline,
  DiagnosticSeverity,
  NewDiagnosticsResult,
  diagnosticKey,
  isDiagnosticEqual,
} from './types';

export {
  formatDiagnostic,
  formatDiagnostics,
  formatDiagnosticSummary,
} from './formatter';