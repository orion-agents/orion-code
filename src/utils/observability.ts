import { AsyncLocalStorage } from 'async_hooks';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CONFIG_DIR_NAME, ENV_PREFIX } from '../product/identity';
import { redactTraceText } from '../services/redaction';

export interface DiagnosticTraceContext {
  traceId: string;
  sessionId?: string;
  turnId?: string;
}

export interface StructuredDiagnosticEvent extends Partial<DiagnosticTraceContext> {
  timestamp: string;
  level: 'warn' | 'error';
  scope: string;
  message: string;
  detail?: string;
  pid: number;
}

const traceStorage = new AsyncLocalStorage<DiagnosticTraceContext>();
const diagnosticRing: StructuredDiagnosticEvent[] = [];
const metricCounters = new Map<string, number>();
const MAX_RING_EVENTS = 256;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function configHome(): string {
  return process.env[`${ENV_PREFIX}CONFIG_DIR`] ?? join(homedir(), CONFIG_DIR_NAME);
}

export function getDiagnosticLogPath(): string {
  return join(configHome(), 'logs', 'orion.jsonl');
}

export function setDiagnosticTraceContext(context: DiagnosticTraceContext): void {
  traceStorage.enterWith(context);
}

export function getDiagnosticTraceContext(): DiagnosticTraceContext | undefined {
  return traceStorage.getStore();
}

export function runWithDiagnosticTrace<T>(context: DiagnosticTraceContext, operation: () => T): T {
  return traceStorage.run(context, operation);
}

export function incrementDiagnosticMetric(name: string, delta: number = 1): void {
  metricCounters.set(name, (metricCounters.get(name) ?? 0) + delta);
}

export function getDiagnosticMetrics(): Record<string, number> {
  return Object.fromEntries(metricCounters);
}

export function getRecentDiagnosticEvents(): StructuredDiagnosticEvent[] {
  return diagnosticRing.map(event => ({ ...event }));
}

export function recordStructuredDiagnostic(
  level: StructuredDiagnosticEvent['level'],
  scope: string,
  message: string,
  detail?: string
): StructuredDiagnosticEvent {
  const trace = getDiagnosticTraceContext();
  const event: StructuredDiagnosticEvent = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message: redactTraceText(message),
    ...(detail ? { detail: redactTraceText(detail) } : {}),
    pid: process.pid,
    ...trace,
  };
  diagnosticRing.push(event);
  if (diagnosticRing.length > MAX_RING_EVENTS) {
    diagnosticRing.splice(0, diagnosticRing.length - MAX_RING_EVENTS);
  }
  incrementDiagnosticMetric(`diagnostic.${level}`);
  incrementDiagnosticMetric(`diagnostic.scope.${scope}`);

  try {
    const logPath = getDiagnosticLogPath();
    mkdirSync(join(configHome(), 'logs'), { recursive: true, mode: 0o700 });
    try {
      if (statSync(logPath).size >= MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`);
    } catch {
      // Missing/unreadable current log: append below creates a fresh file.
    }
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Diagnostics are never allowed to break the product path being diagnosed.
  }
  return event;
}
