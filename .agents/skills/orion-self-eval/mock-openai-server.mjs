#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible mock provider used by the orion-self-eval
 * skill to drive a real Orion Code conversation loop without a paid model key.
 *
 * Serves the two shapes src/services/llm.ts consumes:
 *   - non-streaming chat.completions.create() JSON
 *   - streaming (stream: true) SSE chunks with choices[].delta and a trailing
 *     usage chunk (stream_options.include_usage) then `data: [DONE]`
 *
 * Behaviour is driven by a JSON script file (ORION_EVAL_SCRIPT): an ordered
 * list of steps, each `{ content?, tool_calls?, thinking? }`. Step N is served
 * on the Nth request so a tool loop is reproducible; the final step is reused
 * if the agent keeps asking.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.ORION_EVAL_MOCK_PORT || 0);
const script = process.env.ORION_EVAL_SCRIPT
  ? JSON.parse(readFileSync(process.env.ORION_EVAL_SCRIPT, 'utf-8'))
  : [{ content: 'mock fallback answer' }];

let stepIndex = 0;
const calls = [];

function nextStep(payload) {
  const step = script[Math.min(stepIndex, script.length - 1)];
  stepIndex += 1;
  calls.push({
    model: payload.model,
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    stream: Boolean(payload.stream),
  });
  return step;
}

function usageFor(step, payload) {
  const promptTokens = step?.usage?.prompt_tokens ?? Math.max(1, JSON.stringify(payload).length >> 3);
  const completionTokens = step?.usage?.completion_tokens ?? (step?.content || '').length >> 2;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function messageFor(step) {
  const message = { role: 'assistant', content: step.content ?? '' };
  if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
    message.tool_calls = step.tool_calls.map((call, index) => ({
      id: call.id ?? `mock-call-${index}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
  }
  return message;
}

function finishReasonFor(step) {
  return Array.isArray(step.tool_calls) && step.tool_calls.length > 0 ? 'tool_calls' : 'stop';
}

function completeBody(step, payload) {
  return {
    id: `chatcmpl-mock-${stepIndex}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [{ index: 0, message: messageFor(step), finish_reason: finishReasonFor(step) }],
    usage: usageFor(step, payload),
  };
}

function sseBody(step, payload) {
  const lines = [];
  lines.push({
    id: `chatcmpl-mock-${stepIndex}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });
  if (step.content) {
    // Emit content in two deltas so the streaming reducer is actually exercised.
    const half = Math.ceil(step.content.length / 2);
    for (const piece of [step.content.slice(0, half), step.content.slice(half)]) {
      if (!piece) continue;
      lines.push({
        id: `chatcmpl-mock-${stepIndex}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
    }
  }
  if (Array.isArray(step.tool_calls)) {
    step.tool_calls.forEach((call, index) => {
      lines.push({
        id: `chatcmpl-mock-${stepIndex}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id ?? `mock-call-${index}`,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    });
  }
  lines.push({
    id: `chatcmpl-mock-${stepIndex}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReasonFor(step) }],
  });
  lines.push({
    id: `chatcmpl-mock-${stepIndex}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [],
    usage: usageFor(step, payload),
  });
  return lines.map(line => `data: ${JSON.stringify(line)}\n\n`).join('') + 'data: [DONE]\n\n';
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__mock_state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ calls, stepIndex }));
    return;
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock: unsupported ${req.url}` } }));
    return;
  }
  let raw = '';
  req.on('data', chunk => (raw += chunk));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock: invalid json body' } }));
      return;
    }
    const step = nextStep(payload);
    if (payload.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(sseBody(step, payload));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completeBody(step, payload)));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `${JSON.stringify({ ready: true, port: server.address().port, steps: script.length })}\n`
  );
});
