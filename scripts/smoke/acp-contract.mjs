import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRootArgument = process.argv.find(argument => argument.startsWith('--package-root='));
const packageRoot = resolve(packageRootArgument?.slice('--package-root='.length) || process.cwd());
const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const goldenFixture =
  packageRoot === resolve(process.cwd())
    ? await loadGoldenFixture(
        join(packageRoot, 'tests', 'fixtures', 'acp-v1', 'golden-stdio.jsonl')
      )
    : undefined;
const packageRequire = createRequire(join(packageRoot, 'package.json'));
const acp = await import(pathToFileURL(packageRequire.resolve('@agentclientprotocol/sdk')).href);
const { createOrionAcpAgentApp } = await import(
  pathToFileURL(join(packageRoot, 'dist', 'acp', 'server.mjs')).href
);

await verifyTypedContract();
await verifyPermissionAbort();
const directFrames = await verifyStdioLauncher([join(packageRoot, 'bin', 'orion-code-acp')], false);
const aliasFrames = await verifyStdioLauncher([join(packageRoot, 'bin', 'orion'), 'acp'], false);
assert.deepEqual(aliasFrames, directFrames);
await verifyStdioLauncher([join(packageRoot, 'bin', 'orion-code-acp')], true);
await verifyStdioLauncher([join(packageRoot, 'bin', 'orion-code-acp'), '--help'], false);
await verifyStdioLauncher([join(packageRoot, 'bin', 'orion-code-acp'), '--version'], false);
await verifyStdioLauncher([join(packageRoot, 'bin', 'orion'), 'acp', '--help'], false);
await verifyStdioLauncher([join(packageRoot, 'bin', 'orion'), 'acp', '--version'], false);
process.stdout.write('ACP contract smoke passed.\n');

async function verifyTypedContract() {
  const updates = [];
  const permissions = [];
  const lifecycle = [];
  const mcpServers = [
    {
      name: 'studio-fixture',
      command: process.execPath,
      args: ['fixture.mjs', '--mode', 'smoke'],
      env: [{ name: 'ORION_ACP_SMOKE', value: 'enabled', _meta: { source: 'studio' } }],
      _meta: { owner: 'orion-studio' },
    },
  ];
  const fakeRuntime = {
    async createSession(input) {
      assert.deepEqual(input.mcpServers, mcpServers);
      lifecycle.push('new');
      return { sessionId: 'session-1' };
    },
    async loadSession(input) {
      assert.deepEqual(input.mcpServers, mcpServers);
      lifecycle.push('load-start');
      await input.observer.update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'history-1',
        content: { type: 'text', text: 'restored' },
      });
      lifecycle.push('load-finish');
    },
    async prompt(input) {
      await input.observer.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'invocation-1',
        title: 'write_file',
        status: 'pending',
        rawInput: { path: 'a.ts' },
      });
      const allowed = await input.observer.requestPermission({
        requestId: 'invocation-1',
        toolCallId: 'invocation-1',
        name: 'write_file',
        args: { path: 'a.ts' },
      });
      assert.equal(allowed, true);
      await input.observer.update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: { type: 'text', text: 'hello' },
      });
      return 'end_turn';
    },
    async cancel(sessionId) {
      lifecycle.push(`cancel:${sessionId}`);
    },
    async closeSession(sessionId) {
      lifecycle.push(`close:${sessionId}`);
    },
    async close() {
      lifecycle.push('connection-close');
    },
  };

  const agentApp = createOrionAcpAgentApp(fakeRuntime);
  const clientApp = acp
    .client({ name: 'orion-studio-smoke' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
      if (params.update.messageId === 'history-1') lifecycle.push('load-update');
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params);
      return {
        outcome: { outcome: 'selected', optionId: params.options[0].optionId },
      };
    });

  await clientApp.connectWith(agentApp, async context => {
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: 'orion-studio-smoke', version: '1' },
    });
    assert.equal(initialized.protocolVersion, 1);
    assert.deepEqual(initialized.agentCapabilities, {
      loadSession: true,
      promptCapabilities: {},
      sessionCapabilities: { close: {} },
    });
    assert.deepEqual(initialized.authMethods, []);
    assert.equal(initialized.agentInfo?.name, 'orion-code');
    assert.equal(initialized.agentInfo?.version, packageManifest.version);
    if (goldenFixture) {
      assert.deepEqual(
        { ...initialized, agentInfo: { ...initialized.agentInfo, version: '<version>' } },
        goldenFixture[1].result
      );
    }

    const created = await context.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers,
    });
    assert.equal(created.sessionId, 'session-1');
    const prompted = await context.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    assert.equal(prompted.stopReason, 'end_turn');
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].toolCall.toolCallId, 'invocation-1');
    assert.deepEqual(
      permissions[0].options.map(option => option.kind),
      ['allow_once', 'reject_once']
    );

    await context.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
    await context.request(acp.methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers,
    });
    lifecycle.push('load-response');
    await context.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
    await context.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
  });

  assert.deepEqual(
    updates.map(entry => entry.update.sessionUpdate),
    ['tool_call', 'agent_message_chunk', 'agent_message_chunk']
  );
  if (goldenFixture) {
    const promptMessage = updates.find(entry => entry.update.messageId === 'message-1');
    assert.ok(promptMessage);
    assert.deepEqual(
      {
        ...promptMessage,
        sessionId: '<session-id>',
        update: { ...promptMessage.update, messageId: '<message-id>' },
      },
      goldenFixture[5].params
    );
  }
  assert.ok(lifecycle.indexOf('load-update') < lifecycle.indexOf('load-response'));
  assert.equal(lifecycle.filter(entry => entry === 'close:session-1').length, 2);
}

async function verifyPermissionAbort() {
  let permissionRejected = false;
  const fakeRuntime = {
    async createSession() {
      return { sessionId: 'session-abort' };
    },
    async loadSession() {},
    async prompt(input) {
      const controller = new AbortController();
      const permission = input.observer.requestPermission({
        requestId: 'invocation-abort',
        toolCallId: 'invocation-abort',
        name: 'write_file',
        args: { path: 'blocked.ts' },
        signal: controller.signal,
      });
      controller.abort('smoke cancellation');
      permissionRejected = !(await settleWithin(
        permission,
        500,
        'ACP permission cancellation did not settle immediately.'
      ));
      return 'cancelled';
    },
    async cancel() {},
    async closeSession() {},
    async close() {},
  };
  const agentApp = createOrionAcpAgentApp(fakeRuntime);
  const clientApp = acp
    .client({ name: 'orion-studio-permission-abort' })
    .onRequest(acp.methods.client.session.requestPermission, () => new Promise(() => {}));

  await clientApp.connectWith(agentApp, async context => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: 'orion-studio-permission-abort', version: '1' },
    });
    const created = await context.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const prompted = await context.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'abort permission' }],
    });
    assert.equal(prompted.stopReason, 'cancelled');
  });

  assert.equal(permissionRejected, true);
}

async function verifyStdioLauncher(arguments_, createSession) {
  const configDirectory = await mkdtemp(join(tmpdir(), 'orion-acp-smoke-config-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orion-acp-smoke-data-'));
  const child = spawn(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORION_CODE_CONFIG_DIR: configDirectory,
      ORION_CODE_DATA_DIR: dataDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const parsedStdout = [];
  let stdoutBuffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString('utf8');
    while (true) {
      const lineEnd = stdoutBuffer.indexOf('\n');
      if (lineEnd < 0) break;
      const line = stdoutBuffer.slice(0, lineEnd);
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      parsedStdout.push(message);
      responses.get(message.id)?.(message);
      responses.delete(message.id);
    }
  });

  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
      }, 10_000);
      responses.set(id, message => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const initialized = await request(1, 'initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'stdio-smoke', version: '1' },
    });
    assert.equal(initialized.result?.protocolVersion, 1);
    assert.equal(initialized.result?.agentInfo?.name, 'orion-code');
    assert.equal(initialized.result?.agentInfo?.version, packageManifest.version);

    if (createSession) {
      const created = await request(2, 'session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      });
      assert.ok(created.result?.sessionId);
      const closed = await request(3, 'session/close', {
        sessionId: created.result.sessionId,
      });
      assert.deepEqual(closed.result, {});
    }

    child.stdin.end();
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdoutBuffer, '');
    assert.ok(parsedStdout.length >= 1);
    const leaseEntries = await readDirectoryIfPresent(join(dataDirectory, 'session-leases'));
    assert.deepEqual(leaseEntries, []);
    return parsedStdout;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(configDirectory, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function loadGoldenFixture(path) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
}

async function readDirectoryIfPresent(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ACP sidecar did not exit after EOF.'));
    }, 10_000);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function settleWithin(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
