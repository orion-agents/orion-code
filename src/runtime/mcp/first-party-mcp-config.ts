import { existsSync, readFileSync, statSync } from 'fs';
import { getMcpConfigPath } from '../../product/paths';
import type {
  FirstPartyMcpConfigurationV1,
  FirstPartyMcpServerConfigV1,
} from './first-party-mcp-adapter';

const MAX_MCP_CONFIG_BYTES = 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

/** A sanitized, fail-closed error for an invalid local MCP configuration. */
export class FirstPartyMcpConfigurationError extends Error {
  readonly code: string;
  readonly configPath: string;

  constructor(code: string, message: string, configPath: string) {
    super(message);
    this.name = 'FirstPartyMcpConfigurationError';
    this.code = code;
    this.configPath = configPath;
  }
}

/**
 * Read the legacy-compatible MCP envelope without starting a server or exposing
 * command lines, headers, or environment values to diagnostics/model context.
 */
export function loadFirstPartyMcpConfigurationV1(
  configPath = getMcpConfigPath()
): FirstPartyMcpConfigurationV1 {
  if (!existsSync(configPath)) return Object.freeze({});
  let stat;
  try {
    stat = statSync(configPath);
  } catch {
    throw invalid('ORION_MCP_CONFIG_UNREADABLE', 'MCP configuration cannot be read.', configPath);
  }
  if (!stat.isFile() || stat.size > MAX_MCP_CONFIG_BYTES) {
    throw invalid(
      'ORION_MCP_CONFIG_INVALID_FILE',
      `MCP configuration must be a regular file no larger than ${MAX_MCP_CONFIG_BYTES} bytes.`,
      configPath
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch {
    throw invalid(
      'ORION_MCP_CONFIG_INVALID_JSON',
      'MCP configuration is not valid JSON.',
      configPath
    );
  }
  if (!isRecord(parsed)) {
    throw invalid(
      'ORION_MCP_CONFIG_INVALID_ROOT',
      'MCP configuration root must be an object.',
      configPath
    );
  }

  const direct = parseServerEnvelope(parsed.mcpServers, 'mcpServers', configPath);
  const compatible = parseServerEnvelope(parsed.servers, 'servers', configPath);
  const orion = parsed.orion;
  let nested: Readonly<Record<string, FirstPartyMcpServerConfigV1>> | undefined;
  if (orion !== undefined) {
    if (!isRecord(orion)) {
      throw invalid('ORION_MCP_CONFIG_INVALID_ROOT', 'MCP "orion" must be an object.', configPath);
    }
    if (orion.mcp !== undefined) {
      if (!isRecord(orion.mcp)) {
        throw invalid(
          'ORION_MCP_CONFIG_INVALID_ROOT',
          'MCP "orion.mcp" must be an object.',
          configPath
        );
      }
      nested = parseServerEnvelope(orion.mcp.servers, 'orion.mcp.servers', configPath);
    }
  }

  return Object.freeze({
    ...(direct ? { mcpServers: direct } : {}),
    ...(compatible ? { servers: compatible } : {}),
    ...(nested ? { orion: { mcp: { servers: nested } } } : {}),
  });
}

function parseServerEnvelope(
  value: unknown,
  label: string,
  configPath: string
): Readonly<Record<string, FirstPartyMcpServerConfigV1>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalid(
      'ORION_MCP_CONFIG_INVALID_SERVERS',
      `MCP "${label}" must be an object keyed by server id.`,
      configPath
    );
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([serverId, server]) => [serverId, parseServer(server, serverId, configPath)])
    )
  );
}

function parseServer(
  value: unknown,
  serverId: string,
  configPath: string
): FirstPartyMcpServerConfigV1 {
  if (!serverId.trim() || !isRecord(value)) {
    throw invalid(
      'ORION_MCP_CONFIG_INVALID_SERVER',
      `MCP server "${serverId || '<empty>'}" must be an object.`,
      configPath
    );
  }
  const server: FirstPartyMcpServerConfigV1 = {
    ...optionalText(value, 'type', serverId, configPath),
    ...optionalText(value, 'command', serverId, configPath),
    ...optionalText(value, 'cwd', serverId, configPath),
    ...optionalText(value, 'url', serverId, configPath),
    ...optionalText(value, 'name', serverId, configPath),
    ...optionalText(value, 'description', serverId, configPath),
    ...optionalBoolean(value, 'disabled', serverId, configPath),
    ...optionalBoolean(value, 'enabled', serverId, configPath),
    ...optionalStringArray(value, 'args', serverId, configPath),
    ...optionalStringArray(value, 'tags', serverId, configPath),
    ...optionalStringRecord(value, 'env', serverId, configPath),
    ...optionalStringRecord(value, 'headers', serverId, configPath),
  };
  return Object.freeze(server);
}

function optionalText(
  source: UnknownRecord,
  key: string,
  serverId: string,
  configPath: string
): Record<string, string> {
  const value = source[key];
  if (value === undefined) return {};
  if (typeof value !== 'string') throw invalidField(serverId, key, 'a string', configPath);
  return { [key]: value };
}

function optionalBoolean(
  source: UnknownRecord,
  key: string,
  serverId: string,
  configPath: string
): Record<string, boolean> {
  const value = source[key];
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw invalidField(serverId, key, 'a boolean', configPath);
  return { [key]: value };
}

function optionalStringArray(
  source: UnknownRecord,
  key: string,
  serverId: string,
  configPath: string
): Record<string, readonly string[]> {
  const value = source[key];
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw invalidField(serverId, key, 'an array of strings', configPath);
  }
  return { [key]: Object.freeze([...value]) };
}

function optionalStringRecord(
  source: UnknownRecord,
  key: string,
  serverId: string,
  configPath: string
): Record<string, Readonly<Record<string, string>>> {
  const value = source[key];
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every(item => typeof item === 'string')) {
    throw invalidField(serverId, key, 'an object with string values', configPath);
  }
  return { [key]: Object.freeze({ ...value }) as Readonly<Record<string, string>> };
}

function invalidField(
  serverId: string,
  field: string,
  expected: string,
  configPath: string
): FirstPartyMcpConfigurationError {
  return invalid(
    'ORION_MCP_CONFIG_INVALID_FIELD',
    `MCP server "${serverId}" field "${field}" must be ${expected}.`,
    configPath
  );
}

function invalid(
  code: string,
  message: string,
  configPath: string
): FirstPartyMcpConfigurationError {
  return new FirstPartyMcpConfigurationError(code, `${message} (${configPath})`, configPath);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
