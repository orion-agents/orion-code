import {
  WORK_PANEL_DEFAULT_WIDTH,
  clampWorkPanelWidth,
  maximumWorkPanelWidth,
  parseWorkPanelPreference,
} from '../web/src/state/layout-preferences';

describe('Web Work Panel layout preferences', () => {
  it('clamps pointer widths while preserving the 560px conversation column', () => {
    expect(clampWorkPanelWidth(100, 1_440)).toBe(320);
    expect(clampWorkPanelWidth(600, 1_440)).toBe(600);
    expect(clampWorkPanelWidth(900, 1_440)).toBe(600);
    expect(maximumWorkPanelWidth(1_600)).toBe(720);
    expect(clampWorkPanelWidth(900, 1_600)).toBe(720);
    expect(maximumWorkPanelWidth(1_181)).toBe(341);
    expect(clampWorkPanelWidth(700, 1_000)).toBe(320);
  });

  it('uses a versioned safe default for corrupt or unknown storage', () => {
    expect(parseWorkPanelPreference('{bad', 1_440).widthPx).toBe(WORK_PANEL_DEFAULT_WIDTH);
    expect(parseWorkPanelPreference('{"schemaVersion":2}', 1_440).activePanel).toBe('agent');
  });

  it('preserves the desktop width while a narrow viewport uses drawer layout', () => {
    expect(
      parseWorkPanelPreference(
        JSON.stringify({
          schemaVersion: 1,
          expanded: true,
          widthPx: 700,
          activePanel: 'files',
          agentPanel: 'goal',
        }),
        390
      ).widthPx
    ).toBe(700);
  });

  it('restores the active panels without exposing keyboard resize state', () => {
    expect(
      parseWorkPanelPreference(
        JSON.stringify({
          schemaVersion: 1,
          expanded: false,
          widthPx: 612,
          activePanel: 'terminal',
          agentPanel: 'diagnostics',
        }),
        1_440
      )
    ).toEqual({
      schemaVersion: 1,
      expanded: false,
      widthPx: 612,
      activePanel: 'terminal',
      agentPanel: 'diagnostics',
    });
  });
});
