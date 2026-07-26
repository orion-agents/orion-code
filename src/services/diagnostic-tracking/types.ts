/**
 * orion code - Diagnostic 类型定义
 *
 * IDE/LSP 诊断信息的标准格式。
 */

// ============================================================================
// 类型定义
// ============================================================================

export interface Diagnostic {
  /** 来源（如 'typescript', 'eslint'） */
  source: string;
  /** 严重程度 */
  severity: DiagnosticSeverity;
  /** 消息 */
  message: string;
  /** 文件路径 */
  file: string;
  /** 行号 */
  line: number;
  /** 列号 */
  column?: number;
  /** 结束行 */
  endLine?: number;
  /** 结束列 */
  endColumn?: number;
  /** 诊断代码 */
  code?: string;
  /** 是否已修复 */
  fixed?: boolean;
  /** 时间戳 */
  timestamp: number;
}

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface DiagnosticBaseline {
  /** 基线时间戳 */
  timestamp: number;
  /** 基线诊断列表 */
  diagnostics: Diagnostic[];
}

export interface NewDiagnosticsResult {
  /** 新引入的诊断 */
  newDiagnostics: Diagnostic[];
  /** 已解决的诊断 */
  resolvedDiagnostics: Diagnostic[];
  /** 是否有新错误 */
  hasNewErrors: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

export function diagnosticKey(diagnostic: Diagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.code || diagnostic.message}`;
}

export function isDiagnosticEqual(a: Diagnostic, b: Diagnostic): boolean {
  return diagnosticKey(a) === diagnosticKey(b);
}