/**
 * orion code - Skills Types
 *
 * Skills 系统类型定义
 */

// ============================================================================
// Types
// ============================================================================

/** Skill trigger type */
export type SkillTrigger = string | RegExp | SkillTriggerFunction;

/** Skill trigger function */
export interface SkillTriggerFunction {
  (input: string, context: SkillContext): boolean;
}

/** Skill definition */
export interface SkillDefinition {
  /** Unique skill name (kebab-case) */
  name: string;
  /** Short description */
  description: string;
  /** Trigger condition */
  trigger?: SkillTrigger;
  /** Skill prompt injected to system */
  prompt: string;
  /** Available tools for this skill */
  tools?: string[];
  /** Auto-trigger on matching input */
  auto?: boolean;
  /** Priority (higher = more important) */
  priority?: number;
  /** Skill source path */
  source?: string;
  /** Source type after discovery. */
  sourceType?: 'builtin' | 'user' | 'configured' | 'project';
  /** Root directory for resolving relative skill resources. */
  resourceRoot?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Additional explicit activation names or phrases. */
  aliases?: string[];
}

/** Skill execution context */
export interface SkillContext {
  /** Current working directory */
  cwd: string;
  /** User input */
  input: string;
  /** Available tools */
  tools: string[];
  /** Project path */
  projectPath?: string;
  /** Session ID */
  sessionId?: string;
}

/** Skill execution result */
export interface SkillResult {
  /** Skill name */
  skill: string;
  /** Whether skill was triggered */
  triggered: boolean;
  /** Generated prompt */
  prompt?: string;
  /** Execution metadata */
  metadata?: Record<string, any>;
}

/** Skill source location */
export interface SkillSource {
  /** Skill directory path */
  path: string;
  /** Source type */
  type: 'builtin' | 'user' | 'configured' | 'project';
  /** SKILL.md file path */
  skillFile?: string;
}

/** Duplicate skill resolution diagnostic. */
export interface SkillDuplicateDiagnostic {
  /** Skill name that appeared more than once. */
  name: string;
  /** Previously registered source. */
  existingSource?: SkillSource;
  /** Incoming source that collided with an existing skill. */
  incomingSource: SkillSource;
  /** Source type that wins after priority resolution. */
  selectedSourceType?: SkillSource['type'];
  /** Whether the incoming skill replaced the existing one. */
  incomingSelected: boolean;
  /** Human-readable reason for the resolution. */
  reason: string;
}

/** Skills registry state */
export interface SkillsRegistryState {
  /** Registered skills */
  skills: Map<string, SkillDefinition>;
  /** Skill sources */
  sources: Map<string, SkillSource>;
  /** Auto-trigger skills */
  autoSkills: SkillDefinition[];
  /** Last scan time */
  lastScan: number;
  /** Duplicate skill resolution diagnostics. */
  duplicateDiagnostics?: SkillDuplicateDiagnostic[];
}

// ============================================================================
// Constants
// ============================================================================

/** Skill file name */
export const SKILL_FILE_NAME = 'SKILL.md';

/** Skills directory names */
export const SKILLS_DIR_NAMES = {
  USER: 'skills',
  PROJECT: '.orion-code/skills',
  BUILTIN: 'builtin',
};

/** Default skill priority */
export const DEFAULT_SKILL_PRIORITY = 50;

/** Maximum skills to auto-trigger */
export const MAX_AUTO_SKILLS = 3;
