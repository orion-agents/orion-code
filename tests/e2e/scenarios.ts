import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';

import {
  WEB_E2E_CRITICAL_SCENARIOS_V1,
  WEB_E2E_FULL_SCENARIOS_V1,
  WEB_E2E_SETTINGS_SCENARIOS_V1,
  WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1,
  WEB_E2E_WEB31_SCENARIOS_V1,
} from '../../src/runtime/release-receipts';

export const WEB_E2E_FULL_SCENARIOS = WEB_E2E_FULL_SCENARIOS_V1;
export const WEB_E2E_CRITICAL_SCENARIOS = WEB_E2E_CRITICAL_SCENARIOS_V1;
export const WEB_E2E_SETTINGS_SCENARIOS = WEB_E2E_SETTINGS_SCENARIOS_V1;
export const WEB_E2E_WEB31_SCENARIOS = WEB_E2E_WEB31_SCENARIOS_V1;
export const WEB_E2E_WEB31_CRITICAL_SCENARIOS = WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1;
export const WEB_E2E_SETTINGS_TAG = '@settings' as const;
export const WEB_E2E_CRITICAL_GREP = webE2EGrepPattern(WEB_E2E_CRITICAL_SCENARIOS);

export interface WebE2ERequiredFactV1 {
  readonly key: string;
  readonly equals?: string | number | boolean;
  readonly minimum?: number;
}

export const WEB31_REQUIRED_EVIDENCE_FACTS_V1: Readonly<
  Record<string, readonly WebE2ERequiredFactV1[]>
> = Object.freeze({
  'WEB31-P0-01': Object.freeze([
    { key: 'web31.projects_visible', minimum: 3 },
    { key: 'web31.lazy_session_page', equals: true },
    { key: 'web31.zero_session_project', equals: true },
    { key: 'web31.project_pin_search', equals: true },
    { key: 'web31.session_status_badges', equals: 'running,approval' },
    { key: 'web31.scale_projects', equals: 100 },
    { key: 'web31.scale_sessions_per_project', equals: 200 },
    { key: 'web31.project_dom_nodes', minimum: 1 },
    { key: 'web31.session_dom_nodes', equals: 100 },
    { key: 'web31.project_collection_p95_budget', equals: true },
    { key: 'web31.project_dom_bounded', equals: true },
  ]),
  'WEB31-P0-02': Object.freeze([
    { key: 'web31.context_target_verified', equals: true },
    { key: 'web31.context_conflict_side_effects', equals: 0 },
    { key: 'web31.context_stale_read_conflicts', equals: 8 },
  ]),
  'WEB31-P0-03': Object.freeze([
    { key: 'web31.resize_input', equals: 'mouse-pointer' },
    { key: 'web31.resize_min_px', equals: 320 },
    { key: 'web31.resize_max_px', equals: 720 },
    { key: 'web31.resize_default_px', equals: 420 },
    { key: 'web31.resize_reset_px', equals: 420 },
    { key: 'web31.resize_1440_clamp_px', equals: 600 },
    { key: 'web31.keyboard_fine_resize', equals: false },
    { key: 'web31.desktop_width_preserved', equals: true },
  ]),
  'WEB31-P0-04': Object.freeze([{ key: 'web31.agent_regression_verified', equals: true }]),
  'WEB31-P0-05': Object.freeze([
    { key: 'web31.file_security_verified', equals: true },
    { key: 'web31.file_binary_verified', equals: true },
    { key: 'web31.file_git_decoration', equals: '未跟踪' },
    { key: 'web31.file_scale_entries', equals: 100000 },
    { key: 'web31.file_read_operations', minimum: 1 },
    { key: 'web31.file_bytes_read', minimum: 1 },
    { key: 'web31.file_items_parsed', minimum: 1 },
    { key: 'web31.file_performance_budget', equals: true },
  ]),
  'WEB31-P0-06': Object.freeze([
    { key: 'web31.git_state_matrix_verified', equals: true },
    { key: 'web31.git_changed_files', equals: 2000 },
    { key: 'web31.git_raw_diff_bytes', minimum: 52428800 },
    { key: 'web31.git_process_count', minimum: 1 },
    { key: 'web31.git_bytes_read', minimum: 1 },
    { key: 'web31.git_items_parsed', minimum: 1 },
    { key: 'web31.git_performance_budget', equals: true },
  ]),
  'WEB31-P0-07': Object.freeze([{ key: 'web31.review_hunk_to_composer', equals: true }]),
  'WEB31-P0-08': Object.freeze([{ key: 'web31.real_pty_verified', equals: true }]),
  'WEB31-P0-09': Object.freeze([
    { key: 'web31.terminal_orphan_processes', equals: 0 },
    { key: 'web31.terminal_restart_state', equals: 'lost' },
  ]),
  'WEB31-P0-10': Object.freeze([
    { key: 'web31.sse_ws_isolated', equals: true },
    { key: 'web31.transport_dropped_events', equals: 0 },
    { key: 'web31.terminal_idle_frame_rate_fps', minimum: 55 },
    { key: 'web31.terminal_frame_rate_fps', minimum: 55 },
    { key: 'web31.terminal_burst_bytes', equals: 10485760 },
    { key: 'web31.terminal_performance_budget', equals: true },
  ]),
  'WEB31-P0-11': Object.freeze([
    { key: 'web31.responsive_focus_verified', equals: true },
    { key: 'web31.horizontal_overflow', equals: 0 },
    {
      key: 'web31.ide_shortcuts_verified',
      equals: 'Ctrl+B,Ctrl+Shift+B,Ctrl+Shift+1..5',
    },
    { key: 'web31.panel_switch_budget', equals: true },
  ]),
  'WEB31-P0-12': Object.freeze([
    { key: 'web31.axe_blocking_violations', equals: 0 },
    { key: 'web31.secret_findings', equals: 0 },
    { key: 'web31.reduced_motion_verified', equals: true },
    { key: 'web31.forced_colors_verified', equals: true },
  ]),
});

export interface WebE2ERunnerIdentityV1 {
  readonly name: string;
  readonly image: string;
  readonly digest: string;
  readonly chromeChannel: string;
}

export function expectedWebE2EScenarios(
  environment: NodeJS.ProcessEnv = process.env
): readonly string[] {
  const supplied = environment.ORION_WEB_E2E_EXPECTED_SCENARIOS;
  if (supplied) {
    const values = supplied
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (values.length === 0) throw new Error('Expected Web E2E scenario list is empty.');
    return Object.freeze([...new Set(values)]);
  }
  return environment.ORION_WEB_E2E_PROFILE === 'critical'
    ? WEB_E2E_CRITICAL_SCENARIOS
    : WEB_E2E_FULL_SCENARIOS;
}

export function webE2EScenarioIdFromTitle(title: string): string {
  const matches = title.match(/\b(?:E2E|SET|WEB31)-P0-\d{2}\b/gu) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      'Every Web E2E test title must include exactly one E2E-P0-XX, SET-P0-XX, or WEB31-P0-XX ID.'
    );
  }
  if (matches[0].startsWith('SET-P0-') && !title.includes(WEB_E2E_SETTINGS_TAG)) {
    throw new Error(
      `Settings scenario ${matches[0]} must include the ${WEB_E2E_SETTINGS_TAG} tag.`
    );
  }
  return matches[0];
}

export function webE2EGrepPattern(scenarioIds: readonly string[]): string {
  if (scenarioIds.length === 0) throw new Error('Web E2E grep scenario list is empty.');
  return `(?:${scenarioIds.map(escapeRegExp).join('|')})`;
}

export function webE2ERunnerIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot = resolve(__dirname, '../..')
): WebE2ERunnerIdentityV1 {
  const name = safeIdentity(
    environment.ORION_WEB_E2E_RUNNER_NAME ?? (environment.CI ? 'github-actions' : 'local'),
    'runner name'
  );
  const image = safeIdentity(
    environment.ORION_WEB_E2E_RUNNER_IMAGE ??
      ([environment.ImageOS, environment.ImageVersion].filter(Boolean).join('@') ||
        `${process.platform}-${process.arch}`),
    'runner image'
  );
  const chromeChannel = safeIdentity(
    environment.ORION_WEB_E2E_CHROME_CHANNEL ??
      (environment.CHROME_PATH ? 'system-google-chrome' : 'playwright-chrome'),
    'Chrome channel'
  );
  return Object.freeze({
    name,
    image,
    chromeChannel,
    digest: webE2ERunnerDigest(repositoryRoot),
  });
}

export function webE2ERunnerDigest(repositoryRoot = resolve(__dirname, '../..')): string {
  const roots = [resolve(repositoryRoot, 'scripts/e2e'), resolve(repositoryRoot, 'tests/e2e')];
  const paths = [resolve(repositoryRoot, 'playwright.config.ts')];
  for (const root of roots) collectTypeScriptFiles(root, paths);
  const excluded = new Set([
    resolve(repositoryRoot, 'scripts/e2e/assemble-web-e2e-receipt.ts'),
    resolve(repositoryRoot, 'scripts/e2e/capture-web-state-gallery.ts'),
  ]);
  const hash = createHash('sha256');
  for (const path of paths.filter(value => !excluded.has(value)).sort()) {
    const body = readFileSync(path);
    hash
      .update(relative(repositoryRoot, path).replace(/\\/gu, '/'))
      .update('\0')
      .update(String(body.length))
      .update('\0')
      .update(body);
  }
  return hash.digest('hex');
}

function collectTypeScriptFiles(root: string, paths: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) collectTypeScriptFiles(path, paths);
    else if (entry.isFile() && entry.name.endsWith('.ts')) paths.push(path);
  }
}

function safeIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9._+@:/ -]+$/u.test(normalized)) {
    throw new Error(`Invalid Web E2E ${label}.`);
  }
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
