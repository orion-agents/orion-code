'use strict';

let buffer = '';

function respond(message) {
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') {
    result = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'orion-harness-benchmark', version: '1' },
    };
  } else if (message.method === 'tools/list') {
    result = { tools: [] };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      respond(JSON.parse(line));
    } catch {
      // A malformed benchmark frame is ignored; the client timeout exposes it.
    }
  }
});
