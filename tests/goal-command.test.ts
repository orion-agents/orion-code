import {
  isTargetCommand,
  parseTargetCommand,
} from '../src/commands/target-command';

describe('/goal v0.2 command parsing', () => {
  it.each([' /goal ', '/goal status'])(`parses %s as status`, input => {
    expect(parseTargetCommand(input)).toEqual({
      ok: true,
      input: { type: 'goal_control', action: 'status' },
    });
  });

  it.each(['pause', 'resume', 'clear'] as const)('parses /goal %s', action => {
    expect(parseTargetCommand(`/goal ${action}`)).toEqual({
      ok: true,
      input: { type: 'goal_control', action },
    });
  });

  it('treats the remaining text as a create objective', () => {
    expect(parseTargetCommand('/goal fix all failing tests')).toEqual({
      ok: true,
      input: {
        type: 'goal_control',
        action: 'create',
        objective: 'fix all failing tests',
      },
    });
  });

  it('bounds objective size', () => {
    const result = parseTargetCommand(`/goal ${'x'.repeat(4_001)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('max 4000');
  });

  it.each([
    '/goal exit',
    '/goal confirm criterion-1',
    '/goal edit revised',
    '/goal replace revised',
    '/goal budget 5000',
    '/goal clear --yes',
  ])('rejects removed mutation %s', input => {
    const result = parseTargetCommand(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unsupported Goal command');
  });

  it('breaking-cut removes the /target alias', () => {
    expect(isTargetCommand('/target status')).toBe(false);
    expect(parseTargetCommand('/target status')).toEqual({
      ok: false,
      error: 'Usage: /goal [objective|status|pause|resume|clear]',
    });
    expect(isTargetCommand('/goal status')).toBe(true);
  });
});
