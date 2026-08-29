import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const eventsPath = process.env.ORION_ACP_MCP_FIXTURE_EVENTS;

function record(event) {
  if (eventsPath) appendFileSync(eventsPath, `${event}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function close() {
  record('close');
  process.exit(0);
}

process.once('SIGTERM', close);
process.once('SIGINT', close);

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'notifications/initialized') {
    record('initialized');
    return;
  }
  if (message.id === undefined) return;

  record(message.method);
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'orion-acp-stdio-fixture', version: '1' },
    });
    return;
  }
  if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo a deterministic fixture value',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
    });
    return;
  }
  if (message.method === 'tools/call') {
    respond(message.id, {
      content: [
        {
          type: 'text',
          text: `${message.params.arguments.text}:${process.env.FIXTURE_VALUE ?? 'missing'}`,
        },
      ],
    });
  }
});
