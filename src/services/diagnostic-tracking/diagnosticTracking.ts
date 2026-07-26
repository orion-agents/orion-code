/**
 * orion code - Diagnostic Tracking 服务
 *
 * 追踪 IDE/LSP 诊断，检测新引入错误。
 */

import type { Diagnostic, DiagnosticBaseline, NewDiagnosticsResult } from './types';
import { DiagnosticSeverity, diagnosticKey } from './types';

// ============================================================================
// Diagnostic Tracking 实现
// ============================================================================

export class DiagnosticTracker {
  private baseline: DiagnosticBaseline | null = null;
  private currentDiagnostics: Diagnostic[] = [];
  private newDiagnostics: Diagnostic[] = [];
  private resolvedDiagnostics: Diagnostic[] = [];

  /**
   * 设置基线
   */
  setBaseline(diagnostics: Diagnostic[]): void {
    this.baseline = {
      timestamp: Date.now(),
      diagnostics: [...diagnostics],
    };
    this.currentDiagnostics = [...diagnostics];
    this.newDiagnostics = [];
    this.resolvedDiagnostics = [];
  }

  /**
   * 更新诊断列表
   */
  update(diagnostics: Diagnostic[]): NewDiagnosticsResult {
    if (!this.baseline) {
      // 无基线：设置基线
      this.setBaseline(diagnostics);
      return {
        newDiagnostics: [],
        resolvedDiagnostics: [],
        hasNewErrors: false,
      };
    }

    const baselineKeys = new Set(this.baseline.diagnostics.map(d => diagnosticKey(d)));
    const currentKeys = new Set(diagnostics.map(d => diagnosticKey(d)));

    // 计算新增诊断
    const newDiagnostics: Diagnostic[] = [];
    for (const d of diagnostics) {
      if (!baselineKeys.has(diagnosticKey(d))) {
        newDiagnostics.push(d);
      }
    }

    // 计算已解决诊断
    const resolvedDiagnostics: Diagnostic[] = [];
    for (const d of this.baseline.diagnostics) {
      if (!currentKeys.has(diagnosticKey(d))) {
        resolvedDiagnostics.push(d);
      }
    }

    // 更新状态
    this.currentDiagnostics = [...diagnostics];
    this.newDiagnostics = newDiagnostics;
    this.resolvedDiagnostics = resolvedDiagnostics;

    // 检查是否有新错误
    const hasNewErrors = newDiagnostics.some(d => d.severity === DiagnosticSeverity.Error);

    return {
      newDiagnostics,
      resolvedDiagnostics,
      hasNewErrors,
    };
  }

  /**
   * 检测新错误
   */
  detectNewErrors(): Diagnostic[] {
    return this.newDiagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
  }

  /**
   * 检测新警告
   */
  detectNewWarnings(): Diagnostic[] {
    return this.newDiagnostics.filter(d => d.severity === DiagnosticSeverity.Warning);
  }

  /**
   * 获取当前诊断
   */
  getCurrentDiagnostics(): Diagnostic[] {
    return [...this.currentDiagnostics];
  }

  /**
   * 获取基线诊断
   */
  getBaselineDiagnostics(): Diagnostic[] {
    return this.baseline?.diagnostics || [];
  }

  /**
   * 获取统计
   */
  getStats(): {
    baselineCount: number;
    currentCount: number;
    newCount: number;
    resolvedCount: number;
    errorCount: number;
    warningCount: number;
  } {
    return {
      baselineCount: this.baseline?.diagnostics.length || 0,
      currentCount: this.currentDiagnostics.length,
      newCount: this.newDiagnostics.length,
      resolvedCount: this.resolvedDiagnostics.length,
      errorCount: this.currentDiagnostics.filter(d => d.severity === DiagnosticSeverity.Error).length,
      warningCount: this.currentDiagnostics.filter(d => d.severity === DiagnosticSeverity.Warning).length,
    };
  }

  /**
   * 清除基线
   */
  clearBaseline(): void {
    this.baseline = null;
    this.currentDiagnostics = [];
    this.newDiagnostics = [];
    this.resolvedDiagnostics = [];
  }

  /**
   * 格式化诊断报告
   */
  formatReport(): string {
    const stats = this.getStats();
    const lines: string[] = [];

    lines.push('## Diagnostic Report');
    lines.push('');
    lines.push(`Baseline: ${stats.baselineCount} issues`);
    lines.push(`Current: ${stats.currentCount} issues`);
    lines.push(`New: ${stats.newCount} issues`);
    lines.push(`Resolved: ${stats.resolvedCount} issues`);
    lines.push('');

    if (this.newDiagnostics.length > 0) {
      lines.push('### New Issues');
      lines.push('');
      for (const d of this.newDiagnostics.slice(0, 10)) {
        const severityLabel = d.severity === DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
        lines.push(`- [${severityLabel}] ${d.file}:${d.line}: ${d.message}`);
      }
      lines.push('');
    }

    if (this.resolvedDiagnostics.length > 0) {
      lines.push('### Resolved Issues');
      lines.push('');
      for (const d of this.resolvedDiagnostics.slice(0, 10)) {
        lines.push(`- ✓ ${d.file}:${d.line}: ${d.message}`);
      }
    }

    return lines.join('\n');
  }
}

// ============================================================================
// 单例
// ============================================================================

let diagnosticTracker: DiagnosticTracker | null = null;

export function getDiagnosticTracker(): DiagnosticTracker {
  if (!diagnosticTracker) {
    diagnosticTracker = new DiagnosticTracker();
  }
  return diagnosticTracker;
}

export function resetDiagnosticTracker(): void {
  diagnosticTracker = null;
}