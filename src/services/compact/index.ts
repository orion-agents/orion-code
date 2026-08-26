/**
 * orion code - Compact 服务入口
 *
 * 导出所有压缩相关功能。
 */

export {
  compactMessages,
  needsCompact,
  prepareCompactCandidate,
  validateCompactCandidate,
  commitCompactCandidate,
  CompactCandidateValidationError,
  type CompactOptions,
  type CompactResult,
  type CompactCandidate,
  type CompactCandidateValidation,
  type CompactValidationError,
  type CompactValidationErrorCode,
} from './compact';

export {
  summaryGenerator,
  normalizeCompactFocus,
  normalizeCompactInstructions,
  type SummaryOptions,
  type SummaryDiagnostic,
  type SummaryDiagnosticCode,
} from './summary-generator';

export {
  AutoCompact,
  getAutoCompact,
  resetAutoCompact,
  type AutoCompactConfig,
  type AutoCompactAttempt,
  type CompactPauseCode,
  type CompactPauseFailure,
  type CompactPostValidation,
  type CompactPostValidator,
} from './auto-compact';

export { CompactCoordinator, type CompactCoordinatorConfig } from './coordinator';

export {
  canonicalMessagesFingerprint,
  canonicalCompactCandidateFingerprint,
  COMPACT_CANDIDATE_STRATEGY_VERSION,
  type CompactCandidateFingerprintInput,
} from './fingerprint';

export {
  DEFAULT_COMPACT_TARGET_RATIO,
  groupMessagesForCompact,
  planCompactMessages,
  flattenCompactGroups,
  type CompactMessageGroup,
  type CompactPlan,
  type CompactPlanOptions,
} from './planner';

export {
  extractCompactSummary,
  emptyCompactSummary,
  type CompactSummary,
  type ContextItem,
  type ContextItemKind,
  type ContextItemPriority,
} from './semantic-summary';
