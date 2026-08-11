import { readFileSync } from 'fs';
import { join } from 'path';
import type { Message } from '../src/services/llm';
import { appendAssistantNotice, errorLayerForChatError } from '../src/runtime/chat-trace';
import { checkpointTargetsFromToolCalls } from '../src/runtime/chat-checkpoint';
import { captureConsoleOutput } from '../src/runtime/chat-presentation';

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: string
): NonNullable<Message['tool_calls']>[number] {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe('chat controller helper contracts (#69)', () => {
  it('keeps extracted helper modules independent from commands and the controller', () => {
    for (const file of [
      'chat-trace.ts',
      'chat-checkpoint.ts',
      'chat-workspace.ts',
      'chat-presentation.ts',
      'chat-effort.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), 'src/runtime', file), 'utf8');
      expect(source).not.toMatch(/from ['"]\.\.\/commands/u);
      expect(source).not.toMatch(/from ['"]\.\/chat-controller/u);
    }

    const controller = readFileSync(join(process.cwd(), 'src/runtime/chat-controller.ts'), 'utf8');
    expect(controller.split(/\r?\n/u).length).toBeLessThan(2000);
  });

  it('derives unique in-project checkpoint targets and rejects previews/escapes', () => {
    const calls: NonNullable<Message['tool_calls']> = [
      toolCall('write_file', { path: 'src/a.ts' }, '1'),
      toolCall('edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'b' }, '2'),
      toolCall('edit_file', { path: 'src/preview.ts', preview: true }, '3'),
      toolCall('write_file', { path: '../outside.ts' }, '4'),
      toolCall('read_file', { path: 'src/read-only.ts' }, '5'),
    ];

    expect(checkpointTargetsFromToolCalls('/repo', calls)).toEqual(['/repo/src/a.ts']);
  });

  it('restores console sinks when a captured command throws', async () => {
    const original = { log: console.log, error: console.error, warn: console.warn };
    await expect(
      captureConsoleOutput(async () => {
        console.log('captured');
        throw new Error('injected command failure');
      })
    ).rejects.toThrow('injected command failure');
    expect(console.log).toBe(original.log);
    expect(console.error).toBe(original.error);
    expect(console.warn).toBe(original.warn);
  });

  it('keeps trace/error projections deterministic and non-destructive', () => {
    const messages: Array<{ role: 'assistant'; content: string; timestamp: number }> = [
      { role: 'assistant', content: 'answer', timestamp: 1 },
    ];
    appendAssistantNotice(messages, 'verification pending');
    expect(messages[0].content).toBe('answer\n\nverification pending');
    expect(errorLayerForChatError(new Error('web_search provider timeout'))).toBe('provider');
    expect(errorLayerForChatError(new Error('terminal renderer resize failed'))).toBe('renderer');
  });
});
