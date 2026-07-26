/**
 * orion code - YAML Config Loader
 *
 * 支持 YAML 和 JSON 配置文件加载
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { load as loadYaml } from 'js-yaml';
import { getConfigHome } from './config-dir';

// ============================================================================
// Types
// ============================================================================

export interface YAMLConfig {
  orion?: {
    version?: string;
    model?: {
      provider?: string;
      name?: string;
      fallback?: string;
    };
    memory?: {
      vector_enabled?: boolean;
      embedding_provider?: string;
      embedding_model?: string;
    };
    mcp?: {
      servers?: Record<string, MCPServerConfig>;
    };
    skills?: {
      auto_enable?: string[];
      custom_path?: string;
    };
    agents?: {
      max_workers?: number;
      timeout?: number;
    };
    cli?: {
      theme?: string;
      show_costs?: boolean;
    };
  };
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ============================================================================
// Config File Locations
// ============================================================================

const CONFIG_FILES = [
  '.orion-code.yaml',
  '.orion-code.yml',
  '.orion-code.json',
  'orion-code.yaml',
  'orion-code.yml',
  'orion.json',
];

const GLOBAL_CONFIG_FILE = 'orion-code.yaml';

// ============================================================================
// YAML Config Loader
// ============================================================================

export class YAMLConfigLoader {
  /** Load project config */
  loadProjectConfig(projectPath?: string): YAMLConfig | null {
    const cwd = projectPath || process.cwd();

    for (const filename of CONFIG_FILES) {
      const filePath = join(cwd, filename);
      if (existsSync(filePath)) {
        return this.loadFile(filePath);
      }
    }

    return null;
  }

  /** Load global config */
  loadGlobalConfig(): YAMLConfig | null {
    const configHome = getConfigHome();

    // Try YAML first
    const yamlPath = join(configHome, GLOBAL_CONFIG_FILE);
    if (existsSync(yamlPath)) {
      return this.loadFile(yamlPath);
    }

    // Try JSON as fallback
    const jsonPath = join(configHome, 'orion.json');
    if (existsSync(jsonPath)) {
      return this.loadFile(jsonPath);
    }

    return null;
  }

  /** Load config from file */
  private loadFile(filePath: string): YAMLConfig | null {
    try {
      const content = readFileSync(filePath, 'utf-8');

      if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        return loadYaml(content) as YAMLConfig;
      }

      // JSON format
      return JSON.parse(content) as YAMLConfig;
    } catch (err: any) {
      console.warn(`[YAMLConfig] Failed to load ${filePath}: ${err.message}`);
      return null;
    }
  }

  /** Merge configs with priority */
  mergeConfigs(project: YAMLConfig | null, global: YAMLConfig | null): YAMLConfig {
    const merged: YAMLConfig = {
      orion: {},
    };

    // Global config (lower priority)
    if (global?.orion) {
      merged.orion = { ...global.orion };
    }

    // Project config (higher priority, overrides global)
    if (project?.orion) {
      merged.orion = {
        ...merged.orion,
        ...project.orion,
        // Deep merge nested objects
        model: {
          ...merged.orion?.model,
          ...project.orion?.model,
        },
        memory: {
          ...merged.orion?.memory,
          ...project.orion?.memory,
        },
        mcp: {
          ...merged.orion?.mcp,
          servers: {
            ...merged.orion?.mcp?.servers,
            ...project.orion?.mcp?.servers,
          },
        },
        skills: {
          ...merged.orion?.skills,
          ...project.orion?.skills,
        },
        agents: {
          ...merged.orion?.agents,
          ...project.orion?.agents,
        },
        cli: {
          ...merged.orion?.cli,
          ...project.orion?.cli,
        },
      };
    }

    return merged;
  }

  /** Load all configs with priority */
  loadAll(): YAMLConfig {
    const global = this.loadGlobalConfig();
    const project = this.loadProjectConfig();
    return this.mergeConfigs(project, global);
  }

  /** Generate config template */
  generateTemplate(): string {
    const template = `# Orion Code Configuration
orion:
  version: "0.1.5"

  model:
    provider: openai
    name: gpt-4o
    fallback: gpt-3.5-turbo

  memory:
    vector_enabled: true
    embedding_provider: ollama  # or openai
    embedding_model: nomic-embed-text

  mcp:
    servers:
      filesystem:
        command: mcp-server-filesystem
        args: ["--root", "./"]

  skills:
    auto_enable:
      - code-review
      - security-check

  agents:
    max_workers: 3
    timeout: 60000

  cli:
    theme: dark
    show_costs: false
`;

    return template;
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultLoader: YAMLConfigLoader | null = null;

export function getYAMLConfigLoader(): YAMLConfigLoader {
  if (!defaultLoader) {
    defaultLoader = new YAMLConfigLoader();
  }
  return defaultLoader;
}

export function resetYAMLConfigLoader(): void {
  defaultLoader = null;
}