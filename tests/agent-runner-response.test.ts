import { parseAgentResponse } from '../src/services/agent-runner';

describe('AgentRunner response parsing', () => {
  test('extracts only the first balanced JSON object', () => {
    expect(
      parseAgentResponse('Result: {"success":true,"details":{"count":1}} trailing {"ignored":true}')
    ).toEqual({ success: true, details: { count: 1 } });
  });

  test('skips an invalid brace fragment before a valid object', () => {
    expect(parseAgentResponse('See {not json} then {"summary":"ok"}.')).toEqual({
      summary: 'ok',
    });
  });

  test('preserves invalid JSON as raw summary and records a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseAgentResponse('broken {"summary": }')).toEqual({
      summary: 'broken {"summary": }',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unable to parse JSON'));
  });
});
