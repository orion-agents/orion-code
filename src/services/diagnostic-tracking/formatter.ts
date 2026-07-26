/**
 * orion code - Diagnostic 格式化
 */

import type { Diagnostic } from './types';
import { DiagnosticSeverity } from './types';
import chalk from 'chalk';

const ERROR = chalk.red;
const WARN = chalk.yellow;
const INFO = chalk.blue;
const HINT = chalk.dim;
const FILE = chalk.cyan;

/**
 * 格式化单个诊断
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const severityColor = {
    [DiagnosticSeverity.Error]: ERROR,
    [DiagnosticSeverity.Warning]: WARN,
    [DiagnosticSeverity.Information]: INFO,
    [DiagnosticSeverity.Hint]: HINT,
  };

  const color = severityColor[diagnostic.severity] || INFO;
  const severityLabel = {
    [DiagnosticSeverity.Error]: 'E',
    [DiagnosticSeverity.Warning]: 'W',
    [DiagnosticSeverity.Information]: 'I',
    [DiagnosticSeverity.Hint]: 'H',
  }[diagnostic.severity] || '?';

  const file = FILE(diagnostic.file);
  const line = diagnostic.line;
  const message = diagnostic.message;

  return `${color(severityLabel)} ${file}:${line}: ${message}`;
}

/**
 * 格式化诊断列表
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return 'No diagnostics found.';
  }

  const lines: string[] = [];

  // 按严重程度排序
  const sorted = [...diagnostics].sort((a, b) => a.severity - b.severity);

  for (const d of sorted.slice(0, 20)) {
    lines.push(formatDiagnostic(d));
  }

  if (sorted.length > 20) {
    lines.push(chalk.dim(`... and ${sorted.length - 20} more`));
  }

  return lines.join('\n');
}

/**
 * 格式化简短摘要
 */
export function formatDiagnosticSummary(diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error).length;
  const warnings = diagnostics.filter(d => d.severity === DiagnosticSeverity.Warning).length;
  const infos = diagnostics.filter(d => d.severity === DiagnosticSeverity.Information).length;

  const parts: string[] = [];

  if (errors > 0) parts.push(ERROR(`${errors} errors`));
  if (warnings > 0) parts.push(WARN(`${warnings} warnings`));
  if (infos > 0) parts.push(INFO(`${infos} infos`));

  if (parts.length === 0) {
    return chalk.green('No issues');
  }

  return parts.join(', ');
}