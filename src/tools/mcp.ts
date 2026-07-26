/**
 * orion code - MCP (Model Context Protocol) Support
 *
 * MCP client with auto-startup, heartbeat, and reconnection.
 */

import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { buildTool, type OpenHorseTool, type OrionCodeTool, type ToolInputJSONSchema, type ToolResult } from '../framework/tool';
import { getConfigHome } from '../services/config-dir';

// ============================================================================
// MCP Types
// ============================================================================

interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

interface MCPServerConfig {
  type?: 'stdio' | 'sse' | 'http' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  url?: string;
  headers?: Record<string, string>;
}

interface MCPServersConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

interface MCPClientState {
  process: ChildProcess | null;
  tools: MCPToolDefinition[];
  connected: boolean;
  pendingRequests: Map<string, { resolve: (...args: unknown[]) => unknown; reject: (...args: unknown[]) => unknown; timer: NodeJS.Timeout }>;
  buffer: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_CLIENT_VERSION = process.env.npm_package_version || '0.1.23';

export function getMcpConfigPath(): string {
  return join(getConfigHome(), 'mcp.json');
}

function sanitizeMcpNamePart(name: string, fallback: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeMcpNamePart(serverName, 'server')}__${sanitizeMcpNamePart(toolName, 'tool')}`;
}

function expandEnvValue(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? '');
}

function expandServerConfig(config: MCPServerConfig): MCPServerConfig {
  const args = config.args?.map(arg => expandEnvValue(arg));
  const env = config.env
    ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expandEnvValue(value)]))
    : undefined;

  return {
    ...config,
    command: config.command ? expandEnvValue(config.command) : undefined,
    cwd: config.cwd ? resolve(expandEnvValue(config.cwd)) : undefined,
    args,
    env,
  };
}

function normalizeMcpInputSchema(schema: MCPToolDefinition['inputSchema']): ToolInputJSONSchema {
  const normalized: any = schema?.type === 'object'
    ? { ...schema, properties: { ...(schema.properties ?? {}) } }
    : { type: 'object', properties: {} };

  for (const [name, raw] of Object.entries(normalized.properties)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      normalized.properties[name] = { type: 'string', description: name };
      continue;
    }
    const prop: any = { ...(raw as Record<string, unknown>) };
    if (typeof prop.type !== 'string' && !prop.anyOf && !prop.oneOf && !prop.allOf) {
      prop.type = Array.isArray(prop.enum) ? 'string' : 'string';
    }
    if (typeof prop.description !== 'string') {
      prop.description = name;
    }
    normalized.properties[name] = prop;
  }

  normalized.required = Array.isArray(normalized.required)
    ? normalized.required.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  normalized.type = 'object';

  return normalized as ToolInputJSONSchema;
}

function formatMcpResult(result: any): ToolResult {
  const textContent = Array.isArray(result?.content)
    ? result.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n')
    : '';
  const output = textContent || JSON.stringify(result ?? {});

  if (result?.isError) {
    return { success: false, output, error: output || 'MCP tool returned an error' };
  }

  const metadata: Record<string, unknown> = {};
  if (result?.structuredContent !== undefined) metadata.structuredContent = result.structuredContent;
  return {
    success: true,
    output,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

// ============================================================================
// MCP Client
// ============================================================================

class SimpleMCPClient {
  private state: MCPClientState = {
    process: null,
    tools: [],
    connected: false,
    pendingRequests: new Map(),
    buffer: '',
  };

  private name = '';
  private serverConfig: MCPServerConfig | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private intentionallyDisconnected = false;
  private onDeadCallback: (() => void) | null = null;

  setOnDead(cb: () => void): void {
    this.onDeadCallback = cb;
  }

  async connect(name: string, config: MCPServerConfig): Promise<void> {
    this.name = name;
    this.serverConfig = config;
    this.intentionallyDisconnected = false;
    try {
      await this.spawnAndInit();
    } catch (err) {
      this.disconnect();
      throw err;
    }
    this.startHeartbeat();
  }

  private async spawnAndInit(): Promise<void> {
    const config = this.serverConfig;
    if (!config) throw new Error('No server config');
    if (config.type && config.type !== 'stdio') {
      throw new Error(`MCP transport "${config.type}" is not supported yet; only stdio is available`);
    }
    if (!config.command) {
      throw new Error('MCP stdio server requires a command');
    }

    const env = { ...process.env, ...config.env };

    this.state.process = spawn(config.command, config.args || [], {
      env,
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.state.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString());
    });

    this.state.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[MCP ${this.name} stderr]:`, data.toString().trim());
    });

    this.state.process.on('error', (err) => {
      console.error(`[MCP ${this.name} error]:`, err.message);
      this.state.connected = false;
    });

    this.state.process.on('close', () => {
      this.state.connected = false;
      this.failPendingRequests('MCP server disconnected');
      if (!this.intentionallyDisconnected) {
        this.scheduleReconnect();
      }
    });

    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orion-code', version: MCP_CLIENT_VERSION },
    });

    this.sendNotification('notifications/initialized', {});

    const toolsResult = await this.sendRequest('tools/list', {});
    this.state.tools = toolsResult.tools || [];

    this.state.connected = true;
    this.reconnectAttempts = 0;
  }

  private failPendingRequests(reason: string): void {
    for (const [, { reject, timer }] of this.state.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.state.pendingRequests.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.state.connected) return;
      // tools/list is cheap and supported by all MCP servers — use as ping
      this.sendRequest('tools/list', {}).catch(() => {
        // request failure → mark disconnected and let close handler reconnect
        this.state.connected = false;
        try { this.state.process?.kill(); } catch { /* noop */ }
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyDisconnected || this.reconnectTimer) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.error(`[MCP ${this.name}] giving up after ${RECONNECT_MAX_ATTEMPTS} failed reconnects`);
      this.stopHeartbeat();
      this.onDeadCallback?.();
      return;
    }
    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    console.error(`[MCP ${this.name}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionallyDisconnected) return;
      this.spawnAndInit().catch((err) => {
        console.error(`[MCP ${this.name}] reconnect failed:`, err.message);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private handleData(data: string): void {
    this.state.buffer += data;

    const lines = this.state.buffer.split('\n');
    this.state.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);

        if (msg.id && this.state.pendingRequests.has(msg.id)) {
          const { resolve, reject, timer } = this.state.pendingRequests.get(msg.id)!;
          this.state.pendingRequests.delete(msg.id);
          clearTimeout(timer);

          if (msg.error) {
            reject(new Error(msg.error.message || 'MCP error'));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // Each entry here was newline-terminated, so malformed or banner output is complete noise.
      }
    }
  }

  private async sendRequest(method: string, params: any): Promise<any> {
    if (!this.state.process) {
      throw new Error('MCP client not connected');
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.state.pendingRequests.has(id)) {
          this.state.pendingRequests.delete(id);
          reject(new Error('MCP request timeout'));
        }
      }, MCP_REQUEST_TIMEOUT_MS);

      this.state.pendingRequests.set(id, { resolve, reject, timer });
      this.state.process!.stdin?.write(request);
    });
  }

  private sendNotification(method: string, params: any): void {
    if (!this.state.process) return;

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }) + '\n';

    this.state.process.stdin?.write(notification);
  }

  async callTool(name: string, args: Record<string, any>): Promise<ToolResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });
    return formatMcpResult(result);
  }

  getTools(): MCPToolDefinition[] {
    return this.state.tools;
  }

  isConnected(): boolean {
    return this.state.connected;
  }

  disconnect(): void {
    this.intentionallyDisconnected = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPendingRequests('MCP client disconnected');
    if (this.state.process) {
      try { this.state.process.kill(); } catch { /* noop */ }
      this.state.process = null;
    }
    this.state.connected = false;
    this.state.tools = [];
  }
}

// ============================================================================
// MCP Server Manager
// ============================================================================

class MCPServerManager {
  private clients: Map<string, SimpleMCPClient> = new Map();
  private dead: Set<string> = new Set();
  private configured: Map<string, MCPServerConfig> = new Map();

  loadConfig(): MCPServersConfig | null {
    const configPath = getMcpConfigPath();

    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      const servers = parsed.mcpServers ?? parsed.servers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        console.error('[MCP] Invalid config: expected "mcpServers" object');
        return null;
      }
      return { mcpServers: servers } as MCPServersConfig;
    } catch (err: any) {
      console.error('[MCP] Failed to load config:', err.message);
      return null;
    }
  }

  async connectAll(): Promise<void> {
    const config = this.loadConfig();
    if (!config || !config.mcpServers) return;
    this.configured = new Map(Object.entries(config.mcpServers));

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig.disabled) {
        continue;
      }
      const existing = this.clients.get(name);
      if (existing?.isConnected()) {
        continue;
      }

      try {
        const expandedConfig = expandServerConfig(serverConfig);
        if (expandedConfig.type && expandedConfig.type !== 'stdio') {
          throw new Error(`transport "${expandedConfig.type}" is not supported yet; only stdio is available`);
        }
        const client = new SimpleMCPClient();
        client.setOnDead(() => {
          this.clients.delete(name);
          this.dead.add(name);
          console.error(`[MCP] server "${name}" removed from registry after repeated failures.`);
        });
        await client.connect(name, expandedConfig);
        this.clients.set(name, client);
        this.dead.delete(name);
        console.log(`[MCP] connected to ${name}, tools: ${client.getTools().length}`);
      } catch (err: any) {
        console.error(`[MCP] failed to connect to ${name}:`, err.message);
        this.dead.add(name);
      }
    }
  }

  getClient(name: string): SimpleMCPClient | undefined {
    return this.clients.get(name);
  }

  getAllTools(): Array<{ server: string; tool: MCPToolDefinition }> {
    const allTools: Array<{ server: string; tool: MCPToolDefinition }> = [];

    for (const [serverName, client] of this.clients) {
      if (!client.isConnected()) continue;
      for (const tool of client.getTools()) {
        allTools.push({ server: serverName, tool });
      }
    }

    return allTools;
  }

  getOrionCodeTools(): OrionCodeTool[] {
    const seen = new Set<string>();

    return this.getAllTools().map(({ server, tool }) => {
      const baseName = buildMcpToolName(server, tool.name);
      let orionCodeName = baseName;
      let suffix = 2;
      while (seen.has(orionCodeName)) {
        orionCodeName = `${baseName}_${suffix++}`;
      }
      seen.add(orionCodeName);

      return buildTool({
        name: orionCodeName,
        description: `[MCP:${server}/${tool.name}] ${tool.description || 'External MCP tool'}`,
        parameters: normalizeMcpInputSchema(tool.inputSchema),
        execute: async (args) => {
          const client = this.getClient(server);
          if (!client?.isConnected()) {
            return {
              success: false,
              output: '',
              error: `MCP server not connected: ${server}`,
            };
          }
          return client.callTool(tool.name, args);
        },
        checkPermissions: () => ({ behavior: 'ask', reason: `Calling external MCP tool ${server}/${tool.name}` }),
        isReadOnly: () => tool.annotations?.readOnlyHint === true,
        isDestructive: () => tool.annotations?.destructiveHint === true,
        userFacingName: () => `MCP ${server}/${tool.name}`,
        getSummary: (_args, result) => result.success ? `MCP ${server}/${tool.name}` : result.error || `MCP ${server}/${tool.name} failed`,
      });
    });
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
    this.dead.clear();
    this.configured.clear();
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.keys()).filter(name => this.clients.get(name)?.isConnected());
  }

  /** Snapshot for /mcp command */
  getStatus(): Array<{ name: string; connected: boolean; toolCount: number; dead: boolean }> {
    const all = new Set<string>([...this.configured.keys(), ...this.clients.keys(), ...this.dead]);
    return Array.from(all).map(name => {
      const client = this.clients.get(name);
      return {
        name,
        connected: !!client?.isConnected(),
        toolCount: client?.getTools().length ?? 0,
        dead: this.dead.has(name),
      };
    });
  }
}

export const mcpManager = new MCPServerManager();

// ============================================================================
// MCP Tools for Orion Code
// ============================================================================

export const mcpListTool: OpenHorseTool = buildTool({
  name: 'mcp_list',
  description: 'List available MCP tools from connected MCP servers.',
  parameters: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'Filter by server name (optional)',
      },
    },
    required: [],
  },
  execute: async (args) => {
    const serverFilter = args.server as string | undefined;
    const allTools = mcpManager.getAllTools();

    if (allTools.length === 0) {
      return {
        success: true,
        output: 'No MCP servers connected. Configure servers in ~/.orion-code/mcp.json',
      };
    }

    const filteredTools = serverFilter
      ? allTools.filter(t => t.server === serverFilter)
      : allTools;

    if (filteredTools.length === 0) {
      return {
        success: true,
        output: `No tools found for server: ${serverFilter}`,
      };
    }

    const lines: string[] = [];
    lines.push('MCP Tools Available:');
    lines.push('');

    for (const { server, tool } of filteredTools) {
      lines.push(`[${server}] ${tool.name}`);
      lines.push(`  ${tool.description || 'External MCP tool'}`);
      if (tool.inputSchema?.properties) {
        const props = Object.keys(tool.inputSchema.properties);
        lines.push(`  Parameters: ${props.join(', ')}`);
      }
      lines.push('');
    }

    return {
      success: true,
      output: lines.join('\n'),
    };
  },
  isReadOnly: () => true,
  userFacingName: () => 'List MCP tools',
});

export const mcpCallTool: OpenHorseTool = buildTool({
  name: 'mcp_call',
  description: 'Call an MCP tool from a connected MCP server.',
  parameters: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP server name',
      },
      tool: {
        type: 'string',
        description: 'Tool name to call',
      },
      args: {
        type: 'object',
        description: 'Tool arguments',
      },
    },
    required: ['server', 'tool'],
  },
  execute: async (args) => {
    const server = args.server as string;
    const tool = args.tool as string;
    const toolArgs = (args.args || {}) as Record<string, any>;

    if (!server) {
      return { success: false, output: '', error: 'mcp_call requires a server parameter' };
    }

    if (!tool) {
      return { success: false, output: '', error: 'mcp_call requires a tool parameter' };
    }

    const client = mcpManager.getClient(server);

    if (!client) {
      return {
        success: false,
        output: '',
        error: `MCP server not connected: ${server}. Available servers: ${mcpManager.getConnectedServers().join(', ') || 'none'}`,
      };
    }

    if (!client.isConnected()) {
      return {
        success: false,
        output: '',
        error: `MCP server ${server} is not connected`,
      };
    }

    try {
      const result = await client.callTool(tool, toolArgs);
      return result;
    } catch (err: any) {
      return {
        success: false,
        output: '',
        error: `MCP tool call failed: ${err.message}`,
      };
    }
  },
  checkPermissions: () => {
    return { behavior: 'ask', reason: 'Calling external MCP tool' };
  },
  userFacingName: (args) => `Call ${(args.server as string)}/${(args.tool as string)}`,
});

export const MCP_TOOLS: OpenHorseTool[] = [mcpListTool, mcpCallTool];
