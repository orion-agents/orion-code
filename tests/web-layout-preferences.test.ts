import {
  PROJECT_NAVIGATION_DEFAULT_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
  clampProjectNavigationWidth,
  clampStoredWorkPanelWidth,
  computeWorkbenchColumns,
  defaultWorkbenchLayoutPreference,
  parseWorkbenchLayoutPreference,
  type WorkbenchLayoutPreferenceV2,
} from '../web/src/state/layout-preferences';

describe('Web Workbench layout preferences v2', () => {
  it('clamps stored desktop preferences without shrinking them for the current viewport', () => {
    expect(clampProjectNavigationWidth(100)).toBe(240);
    expect(clampProjectNavigationWidth(900)).toBe(480);
    expect(clampProjectNavigationWidth(Number.NaN)).toBe(PROJECT_NAVIGATION_DEFAULT_WIDTH);
    expect(clampStoredWorkPanelWidth(100)).toBe(320);
    expect(clampStoredWorkPanelWidth(900)).toBe(720);
    expect(clampStoredWorkPanelWidth(Number.NaN)).toBe(WORK_PANEL_DEFAULT_WIDTH);
  });

  it('migrates the v1 work-panel preference and supplies a safe project-navigation default', () => {
    expect(
      parseWorkbenchLayoutPreference(
        null,
        JSON.stringify({
          schemaVersion: 1,
          expanded: false,
          widthPx: 612,
          activePanel: 'terminal',
          agentPanel: 'diagnostics',
        })
      )
    ).toEqual({
      schemaVersion: 2,
      projectNavigation: { expanded: true, widthPx: 280 },
      workPanel: {
        expanded: false,
        widthPx: 612,
        activePanel: 'terminal',
        agentPanel: 'diagnostics',
      },
    });
  });

  it('uses a versioned safe default for corrupt or unknown storage', () => {
    expect(parseWorkbenchLayoutPreference('{bad')).toBe(defaultWorkbenchLayoutPreference);
    expect(parseWorkbenchLayoutPreference('{"schemaVersion":3}')).toBe(
      defaultWorkbenchLayoutPreference
    );
  });

  it('preserves both maximum preferences while conceding the right panel first', () => {
    const preference = makePreference({ navigationWidth: 480, workPanelWidth: 720 });
    expect(computeWorkbenchColumns(1_760, preference)).toEqual({
      projectNavigation: { mode: 'dock', widthPx: 480 },
      conversationWidthPx: 560,
      workPanel: { mode: 'dock', widthPx: 720 },
    });
    expect(computeWorkbenchColumns(1_440, preference)).toEqual({
      projectNavigation: { mode: 'dock', widthPx: 480 },
      conversationWidthPx: 560,
      workPanel: { mode: 'dock', widthPx: 400 },
    });
    expect(preference.workPanel.widthPx).toBe(720);
  });

  it('derives rail and drawer states without overwriting desktop preferences', () => {
    const preference = makePreference({ navigationWidth: 480, workPanelWidth: 720 });
    expect(computeWorkbenchColumns(1_181, preference)).toEqual({
      projectNavigation: { mode: 'dock', widthPx: 480 },
      conversationWidthPx: 653,
      workPanel: { mode: 'rail', widthPx: 48 },
    });
    expect(computeWorkbenchColumns(1_180, preference)).toEqual({
      projectNavigation: { mode: 'dock', widthPx: 480 },
      conversationWidthPx: 700,
      workPanel: { mode: 'drawer', widthPx: 0 },
    });
    expect(computeWorkbenchColumns(800, preference)).toEqual({
      projectNavigation: { mode: 'dock', widthPx: 240 },
      conversationWidthPx: 560,
      workPanel: { mode: 'drawer', widthPx: 0 },
    });
    expect(computeWorkbenchColumns(799, preference)).toEqual({
      projectNavigation: { mode: 'drawer', widthPx: 0 },
      conversationWidthPx: 799,
      workPanel: { mode: 'drawer', widthPx: 0 },
    });
    expect(computeWorkbenchColumns(390, preference)).toEqual({
      projectNavigation: { mode: 'drawer', widthPx: 0 },
      conversationWidthPx: 390,
      workPanel: { mode: 'drawer', widthPx: 0 },
    });
    expect(preference.projectNavigation.widthPx).toBe(480);
    expect(preference.workPanel.widthPx).toBe(720);
  });

  it('keeps explicit collapsed preferences as 48px rails on desktop', () => {
    const preference = makePreference({ navigationExpanded: false, workPanelExpanded: false });
    expect(computeWorkbenchColumns(1_440, preference)).toEqual({
      projectNavigation: { mode: 'rail', widthPx: 48 },
      conversationWidthPx: 1_344,
      workPanel: { mode: 'rail', widthPx: 48 },
    });
    expect(computeWorkbenchColumns(1_024, preference)).toEqual({
      projectNavigation: { mode: 'rail', widthPx: 48 },
      conversationWidthPx: 976,
      workPanel: { mode: 'drawer', widthPx: 0 },
    });
  });
});

function makePreference(input: {
  readonly navigationExpanded?: boolean;
  readonly navigationWidth?: number;
  readonly workPanelExpanded?: boolean;
  readonly workPanelWidth?: number;
}): WorkbenchLayoutPreferenceV2 {
  return {
    schemaVersion: 2,
    projectNavigation: {
      expanded: input.navigationExpanded ?? true,
      widthPx: input.navigationWidth ?? 280,
    },
    workPanel: {
      expanded: input.workPanelExpanded ?? true,
      widthPx: input.workPanelWidth ?? 420,
      activePanel: 'agent',
      agentPanel: 'goal',
    },
  };
}
