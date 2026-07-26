/**
 * orion code - Skills Loader
 *
 * 扫描并加载 Skills 目录中的技能定义
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { load as loadYaml } from 'js-yaml';
import { warnOnce } from '../core/warn-dedup';
import {
  type SkillDefinition,
  type SkillDuplicateDiagnostic,
  type SkillSource,
  SKILL_FILE_NAME,
  SKILLS_DIR_NAMES,
  DEFAULT_SKILL_PRIORITY,
} from './types';
import { getConfigHome } from '../services/config-dir';
import { loadConfig } from '../services/config';

// ============================================================================
// Skill Parser
// ============================================================================

/**
 * Parse SKILL.md file
 * Format: Markdown with YAML frontmatter
 */
export function parseSkillFile(content: string, sourcePath: string): SkillDefinition | null {
  const normalizedSourcePath = normalizeSkillSourcePath(sourcePath);

  try {
    const normalizedContent = content.replace(/^\uFEFF/, '');
    // Extract frontmatter (between --- lines). Accept CRLF and a leading BOM.
    const frontmatterMatch = normalizedContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

    if (!frontmatterMatch) {
      const legacySkill = parseLegacyMarkdownSkill(normalizedContent, normalizedSourcePath);
      if (legacySkill) {
        return legacySkill;
      }

      warnOnce(`skill-frontmatter:${normalizedSourcePath}`, `No frontmatter in ${normalizedSourcePath}`);
      return null;
    }

    const frontmatter = loadYaml(frontmatterMatch[1]) as Record<string, any>;

    // Extract prompt (content after frontmatter)
    const prompt = normalizedContent.slice(frontmatterMatch[0].length).trim();

    // Build skill definition
    const skill: SkillDefinition = {
      name: frontmatter.name || deriveSkillName(normalizedSourcePath),
      description: frontmatter.description || '',
      trigger: frontmatter.trigger,
      prompt,
      tools: frontmatter.tools,
      auto: frontmatter.auto ?? false,
      priority: frontmatter.priority ?? DEFAULT_SKILL_PRIORITY,
      source: normalizedSourcePath,
      tags: frontmatter.tags || [],
      aliases: normalizeStringList(frontmatter.aliases ?? frontmatter.alias),
    };

    return skill;
  } catch (err: any) {
    warnOnce(
      `skill-parse-fail:${normalizedSourcePath}`,
      `Failed to parse ${normalizedSourcePath}: ${err.message}`,
    );
    return null;
  }
}

export function normalizeSkillSourcePath(sourcePath: string): string {
  const trimmed = sourcePath.trim();
  const markdownLink = trimmed.match(/^\[[^\]]+\]\((.+)\)$/);
  const rawTarget = markdownLink ? markdownLink[1].trim() : trimmed;
  const unwrapped = rawTarget.startsWith('<') && rawTarget.endsWith('>')
    ? rawTarget.slice(1, -1)
    : rawTarget;

  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

function parseLegacyMarkdownSkill(content: string, sourcePath: string): SkillDefinition | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('# ')) {
    return null;
  }

  const title = trimmed.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  const description = firstPlainParagraph(trimmed);

  return {
    name: deriveSkillName(sourcePath, title),
    description,
    prompt: trimmed,
    auto: false,
    priority: DEFAULT_SKILL_PRIORITY,
    source: sourcePath,
    tags: [],
    aliases: [],
  };
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function deriveSkillName(sourcePath: string, title?: string): string {
  const fromPath = basename(sourcePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase()
    ? basename(dirname(sourcePath))
    : basename(sourcePath).replace(/\.md$/i, '');
  return toKebabName(fromPath || title || 'skill');
}

function firstPlainParagraph(content: string): string {
  const lines = content.split(/\r?\n/);
  const paragraph: string[] = [];
  let skippedTitle = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (!skippedTitle && trimmed.startsWith('# ')) {
      skippedTitle = true;
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }

  return paragraph.join(' ').replace(/\s+/g, ' ').slice(0, 240);
}

function toKebabName(input: string): string {
  return input
    .trim()
    .replace(/\.md$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'skill';
}

function expandUserPath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function normalizeFilesystemPath(input: string): string {
  return resolve(expandUserPath(normalizeSkillSourcePath(input)));
}

// ============================================================================
// Directory Scanner
// ============================================================================

/**
 * Scan a directory for skills
 */
export function scanSkillsDirectory(dirPath: string, _type: SkillSource['type']): SkillDefinition[] {
  const normalizedDirPath = normalizeFilesystemPath(dirPath);
  if (!existsSync(normalizedDirPath)) {
    return [];
  }

  const skills: SkillDefinition[] = [];

  try {
    const rootStat = statSync(normalizedDirPath);
    if (!rootStat.isDirectory()) {
      return [];
    }

    const directSkillFile = join(normalizedDirPath, SKILL_FILE_NAME);
    if (existsSync(directSkillFile) && statSync(directSkillFile).isFile()) {
      const content = readFileSync(directSkillFile, 'utf-8');
      const skill = parseSkillFile(content, directSkillFile);
      if (skill) {
        skill.source = normalizedDirPath;
        skills.push(skill);
      }
      return skills;
    }

    const entries = readdirSync(normalizedDirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(normalizedDirPath, entry.name);
      const skillFile = join(skillDir, SKILL_FILE_NAME);

      if (!existsSync(skillFile)) {
        // No SKILL.md, skip
        continue;
      }

      const content = readFileSync(skillFile, 'utf-8');
      const skill = parseSkillFile(content, skillFile);

      if (skill) {
        skill.source = skillDir;
        skills.push(skill);
      }
    }
  } catch (err: any) {
    warnOnce(`skill-scan-fail:${normalizedDirPath}`, `Failed to scan ${normalizedDirPath}: ${err.message}`);
  }

  return skills;
}

function getConfiguredSkillsDirs(): string[] {
  try {
    return loadConfig().skills?.paths ?? [];
  } catch {
    return [];
  }
}

// ============================================================================
// Skills Loader
// ============================================================================

export class SkillsLoader {
  /** Loaded skills */
  private skills: Map<string, SkillDefinition> = new Map();

  /** Skill sources */
  private sources: Map<string, SkillSource> = new Map();

  /** Auto-trigger skills */
  private autoSkills: SkillDefinition[] = [];

  /** Duplicate skill resolution diagnostics */
  private duplicateDiagnostics: SkillDuplicateDiagnostic[] = [];

  /** Last scan time */
  private lastScan: number = 0;

  /** Load all skills from configured directories */
  load(): SkillDefinition[] {
    this.clear();

    // 1. Load builtin skills (src/skills/builtin/)
    try {
      // Builtin skills are packaged with the application
      const builtinSkillsDir = join(__dirname, SKILLS_DIR_NAMES.BUILTIN);
      const builtinSkills = scanSkillsDirectory(builtinSkillsDir, 'builtin');
      for (const skill of builtinSkills) {
        this.registerSkill(skill, { path: builtinSkillsDir, type: 'builtin' });
      }
    } catch {
      // Builtin directory may not exist in some environments
    }

    // 2. Load user skills (~/.orion-code/skills/)
    const userSkillsDir = join(getConfigHome(), SKILLS_DIR_NAMES.USER);
    const userSkills = scanSkillsDirectory(userSkillsDir, 'user');
    for (const skill of userSkills) {
      this.registerSkill(skill, { path: userSkillsDir, type: 'user' });
    }

    // 3. Load configured skills roots. They override regular user skills but
    // project-local skills remain the highest-priority source.
    const configuredSkillsDirs = getConfiguredSkillsDirs();
    for (const configuredSkillsDir of configuredSkillsDirs) {
      const configuredSkills = scanSkillsDirectory(configuredSkillsDir, 'configured');
      for (const skill of configuredSkills) {
        this.registerSkill(skill, { path: normalizeFilesystemPath(configuredSkillsDir), type: 'configured' });
      }
    }

    // 4. Load project skills (.orion-code/skills/)
    const projectSkillsDir = join(process.cwd(), SKILLS_DIR_NAMES.PROJECT);
    const projectSkills = scanSkillsDirectory(projectSkillsDir, 'project');
    for (const skill of projectSkills) {
      // Project skills override user/builtin skills with same name
      this.registerSkill(skill, { path: projectSkillsDir, type: 'project' });
    }

    this.autoSkills = Array.from(this.skills.values()).filter(skill => !!skill.auto);
    this.lastScan = Date.now();
    return this.getSkills();
  }

  /** Register a skill */
  private registerSkill(skill: SkillDefinition, source: SkillSource): void {
    const preparedSkill: SkillDefinition = {
      ...skill,
      sourceType: source.type,
      resourceRoot: skill.source,
    };

    // Check for conflicts
    const existing = this.skills.get(preparedSkill.name);
    if (existing) {
      const existingSource = this.sources.get(preparedSkill.name);
      const existingRank = sourceRank(existingSource?.type);
      const incomingRank = sourceRank(source.type);
      const shouldOverride = incomingRank > existingRank
        || (incomingRank === existingRank && (preparedSkill.priority || DEFAULT_SKILL_PRIORITY) > (existing.priority || DEFAULT_SKILL_PRIORITY));
      const reason = incomingRank === existingRank
        ? `same source rank; priority ${preparedSkill.priority || DEFAULT_SKILL_PRIORITY} ${shouldOverride ? '>' : '<='} ${existing.priority || DEFAULT_SKILL_PRIORITY}`
        : `source rank ${incomingRank} ${shouldOverride ? '>' : '<='} ${existingRank}`;

      this.duplicateDiagnostics.push({
        name: preparedSkill.name,
        existingSource,
        incomingSource: source,
        selectedSourceType: shouldOverride ? source.type : existingSource?.type,
        incomingSelected: shouldOverride,
        reason,
      });

      if (shouldOverride) {
        this.skills.set(preparedSkill.name, preparedSkill);
        this.sources.set(preparedSkill.name, source);
      }
    } else {
      this.skills.set(preparedSkill.name, preparedSkill);
      this.sources.set(preparedSkill.name, source);
    }

    // Track auto-trigger skills
    if (preparedSkill.auto && this.skills.get(preparedSkill.name) === preparedSkill) {
      this.autoSkills.push(preparedSkill);
    }
  }

  /** Get all loaded skills */
  getSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /** Get skill by name */
  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** Get auto-trigger skills */
  getAutoSkills(): SkillDefinition[] {
    return this.autoSkills;
  }

  /** Get duplicate skill diagnostics */
  getDuplicateDiagnostics(): SkillDuplicateDiagnostic[] {
    return [...this.duplicateDiagnostics];
  }

  /** Get skill source */
  getSource(name: string): SkillSource | undefined {
    return this.sources.get(name);
  }

  /** Check if skill should trigger */
  shouldTrigger(skill: SkillDefinition, input: string): boolean {
    if (!skill.trigger) return false;

    if (typeof skill.trigger === 'string') {
      return input.includes(skill.trigger) || input.startsWith(skill.trigger);
    }

    if (skill.trigger instanceof RegExp) {
      return skill.trigger.test(input);
    }

    // Trigger function
    return skill.trigger(input, { cwd: process.cwd(), input, tools: [] });
  }

  /** Find skills that match input */
  findMatchingSkills(input: string): SkillDefinition[] {
    const matches: SkillDefinition[] = [];

    for (const skill of this.skills.values()) {
      if (this.shouldTrigger(skill, input)) {
        matches.push(skill);
      }
    }

    // Sort by priority (higher first)
    matches.sort((a, b) => (b.priority || 50) - (a.priority || 50));

    return matches;
  }

  /** Clear loaded skills */
  clear(): void {
    this.skills.clear();
    this.sources.clear();
    this.autoSkills = [];
    this.duplicateDiagnostics = [];
    this.lastScan = 0;
  }

  /** Get last scan time */
  getLastScan(): number {
    return this.lastScan;
  }
}

function sourceRank(type?: SkillSource['type']): number {
  switch (type) {
    case 'project':
      return 3;
    case 'configured':
      return 2.5;
    case 'user':
      return 2;
    case 'builtin':
      return 1;
    default:
      return 0;
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultLoader: SkillsLoader | null = null;

export function getSkillsLoader(): SkillsLoader {
  if (!defaultLoader) {
    defaultLoader = new SkillsLoader();
    defaultLoader.load();
  }
  return defaultLoader;
}

export function resetSkillsLoader(): void {
  if (defaultLoader) {
    defaultLoader.clear();
  }
  defaultLoader = null;
}
