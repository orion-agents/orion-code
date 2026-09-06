/**
 * v0.3.12 S1 — pure geometry, registry and per-workspace preference contracts.
 */
import {
  computeRightWorkspaceGeometry,
  maxDockableDetailWidth,
  snapDetailWidth,
  DETAIL_MIN_WIDTH,
} from '../web/src/layout/right-workspace-geometry';
import { WORK_PANEL_REGISTRY, workPanelRegistration } from '../web/src/layout/work-panel-registry';
import {
  defaultWorkbenchLayoutPreferenceV3,
  migrateWorkPanelV2ToV3,
  parseRightWorkspaceV3,
  resolveWorkPanelPreference,
  withWorkPanelPreference,
  type WorkbenchLayoutPreferenceV3,
} from '../web/src/state/right-workspace-preferences';

describe('right-workspace geometry (v0.3.12 S1)', () => {
  test('wide desktop docks the detail and keeps the conversation >= 320px', () => {
    const geometry = computeRightWorkspaceGeometry({
      containerWidth: 1440,
      leftWidthPx: 280,
      expanded: true,
      storedDetailWidthPx: 560,
    });
    expect(geometry.mode).toBe('dock');
    expect(geometry.detailWidthPx).toBe(560);
    expect(geometry.conversationWidthPx).toBeGreaterThanOrEqual(320);
    expect(geometry.canResize).toBe(true);
  });

  test('a stored 1200px detail clamps to the max dockable width', () => {
    const available = 1440 - 280;
    const max = maxDockableDetailWidth(available);
    const geometry = computeRightWorkspaceGeometry({
      containerWidth: 1440,
      leftWidthPx: 280,
      expanded: true,
      storedDetailWidthPx: 1200,
    });
    expect(geometry.detailWidthPx).toBe(max);
    expect(geometry.conversationWidthPx).toBe(available - max - 48);
  });

  test('a 960px request at 1280 clamps to the max dockable width', () => {
    const geometry = computeRightWorkspaceGeometry({
      containerWidth: 1280,
      leftWidthPx: 48,
      expanded: true,
      storedDetailWidthPx: 960,
    });
    expect(geometry.mode).toBe('dock');
    expect(geometry.detailWidthPx).toBe(maxDockableDetailWidth(1280 - 48));
    expect(geometry.conversationWidthPx).toBeGreaterThanOrEqual(320);
  });

  test('a wide 1920 desktop docks at least 70% of the usable width', () => {
    const geometry = computeRightWorkspaceGeometry({
      containerWidth: 1920,
      leftWidthPx: 280,
      expanded: true,
      storedDetailWidthPx: 1200,
    });
    expect(geometry.mode).toBe('dock');
    expect(geometry.detailWidthPx).toBeGreaterThanOrEqual((1920 - 280) * 0.7 - 1);
  });

  test('compact width renders the detail as an overlay drawer', () => {
    const geometry = computeRightWorkspaceGeometry({
      containerWidth: 900,
      leftWidthPx: 48,
      expanded: true,
      storedDetailWidthPx: 960,
    });
    expect(geometry.mode).toBe('drawer');
    expect(geometry.detailWidthPx).toBe(0);
  });

  test('narrow width is a full-height drawer and conversation keeps the width', () => {
    const geometry = computeRightWorkspaceGeometry({
      containerWidth: 480,
      leftWidthPx: 0,
      expanded: true,
      storedDetailWidthPx: 960,
    });
    expect(geometry.mode).toBe('drawer');
    expect(geometry.conversationWidthPx).toBe(480);
  });

  test('snap points snap to 360/560/960/max and never below the minimum', () => {
    expect(snapDetailWidth(700, 1500)).toBe(560);
    expect(snapDetailWidth(1000, 1500)).toBe(960);
    expect(snapDetailWidth(200, 1500)).toBe(360);
    expect(snapDetailWidth(500, 900)).toBe(560);
    expect(snapDetailWidth(200, 300)).toBe(DETAIL_MIN_WIDTH);
  });

  test('rail-only when expanded but the dockable area is unusable', () => {
    const geometry = computeRightWorkspaceGeometry({
      containerWidth: 1060,
      leftWidthPx: 700,
      expanded: true,
      storedDetailWidthPx: 560,
    });
    // available = 360 → max dockable far below 360 → stay rail.
    expect(geometry.mode).toBe('rail');
  });
});

describe('work panel registry (v0.3.12 S1)', () => {
  test('exposes exactly the five canonical panels in canonical order', () => {
    expect([...WORK_PANEL_REGISTRY.keys()]).toEqual([
      'agent',
      'review',
      'terminal',
      'files',
      'git',
    ]);
  });

  test('flags task vs resource panels for lifecycle decisions', () => {
    expect(workPanelRegistration('agent').kind).toBe('task');
    for (const id of ['review', 'terminal', 'files', 'git'] as const) {
      expect(workPanelRegistration(id).kind).toBe('resource');
    }
  });
});

describe('per-workspace preferences v3 (v0.3.12 S1)', () => {
  test('migrates a v2 work panel into the fallback entry and keeps detail width', () => {
    const migrated = migrateWorkPanelV2ToV3({
      expanded: true,
      widthPx: 420,
      activePanel: 'review',
    });
    expect(migrated.activePanel).toBe('review');
    expect(migrated.detailWidthPx).toBeGreaterThanOrEqual(320);
    expect(migrated.expanded).toBe(true);
  });

  test('resolves per-workspace state with fallback for unknown workspaces', () => {
    const base = defaultWorkbenchLayoutPreferenceV3();
    const scoped = withWorkPanelPreference(base, 'workspace-a', {
      expanded: true,
      activePanel: 'git',
      detailWidthPx: 960,
      taskSubview: 'overview',
    });
    expect(resolveWorkPanelPreference(scoped, 'workspace-a').activePanel).toBe('git');
    expect(resolveWorkPanelPreference(scoped, 'workspace-b').activePanel).toBe('agent');
  });

  test('round-trips a stored v3 value and rejects a v2 envelope', () => {
    const base = defaultWorkbenchLayoutPreferenceV3();
    const scoped = withWorkPanelPreference(base, 'ws-1', {
      expanded: true,
      activePanel: 'files',
      detailWidthPx: 720,
      taskSubview: 'diagnostics',
    });
    const raw = JSON.stringify(scoped);
    const parsed = parseRightWorkspaceV3(raw) as WorkbenchLayoutPreferenceV3;
    expect(parsed.schemaVersion).toBe(3);
    expect(resolveWorkPanelPreference(parsed, 'ws-1').detailWidthPx).toBe(720);
    expect(parseRightWorkspaceV3(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
    expect(parseRightWorkspaceV3('garbage')).toBeNull();
  });
});

import { computeWideDesktopColumns } from '../web/src/layout/right-workspace-geometry';

describe('wide desktop columns (v0.3.12 S1 component feed)', () => {
  test('1440px docks a 960px detail request and keeps conversation >= 320px', () => {
    const columns = computeWideDesktopColumns({
      containerWidth: 1440,
      navigationExpanded: true,
      navigationWidthPx: 280,
      workExpanded: true,
      workDetailWidthPx: 960,
    });
    expect(columns.navigation.mode).toBe('dock');
    expect(columns.workPanel.mode).toBe('dock');
    // 960 cannot fit at 1440 with a 280px nav (max dockable = 792): clamp to max.
    expect(columns.workPanel.widthPx).toBe(maxDockableDetailWidth(1440 - 280) + 48);
    expect(columns.conversationWidthPx).toBeGreaterThanOrEqual(320);
  });

  test('collapsed navigation frees room for an even wider detail surface', () => {
    const columns = computeWideDesktopColumns({
      containerWidth: 1440,
      navigationExpanded: false,
      navigationWidthPx: 280,
      workExpanded: true,
      workDetailWidthPx: 1200,
    });
    expect(columns.navigation.mode).toBe('rail');
    expect(columns.workPanel.mode).toBe('dock');
    expect(columns.conversationWidthPx).toBeGreaterThanOrEqual(320);
  });

  test('left navigation concedes to a rail when the conversation would drop below 320px', () => {
    // A narrow-ish wide screen: a 480px nav + a huge detail cannot coexist.
    const columns = computeWideDesktopColumns({
      containerWidth: 1080,
      navigationExpanded: true,
      navigationWidthPx: 480,
      workExpanded: true,
      workDetailWidthPx: 900,
    });
    expect(columns.navigation.mode).toBe('rail');
    expect(columns.workPanel.mode).toBe('dock');
    expect(columns.conversationWidthPx).toBeGreaterThanOrEqual(320);
  });

  test('collapsed work panel stays rail-only and hands width to the conversation', () => {
    const columns = computeWideDesktopColumns({
      containerWidth: 1440,
      navigationExpanded: true,
      navigationWidthPx: 280,
      workExpanded: false,
      workDetailWidthPx: 560,
    });
    expect(columns.workPanel.mode).toBe('rail');
    expect(columns.workPanel.widthPx).toBe(48);
    expect(columns.conversationWidthPx).toBeGreaterThan(1000);
  });
});
