/**
 * orion code - Skills Registry
 *
 * Skills 注册和查询系统
 */

import { getSkillsLoader, type SkillsLoader } from './loader';
import { join } from 'path';
import {
  SKILL_FILE_NAME,
  type SkillDefinition,
  type SkillContext,
  type SkillDuplicateDiagnostic,
  type SkillResult,
} from './types';

// ============================================================================
// Skills Registry
// ============================================================================

export class SkillsRegistry {
  private loader: SkillsLoader;

  constructor() {
    this.loader = getSkillsLoader();
  }

  /** Initialize registry */
  initialize(): void {
    this.loader.load();
  }

  /** Get all skills */
  getAllSkills(): SkillDefinition[] {
    return this.loader.getSkills();
  }

  /** Get skill by name */
  getSkill(name: string): SkillDefinition | undefined {
    return this.loader.getSkill(name);
  }

  /** Get source metadata for a skill. */
  getSource(name: string) {
    return this.loader.getSource(name);
  }

  /** Check if skill exists */
  hasSkill(name: string): boolean {
    return this.loader.getSkill(name) !== undefined;
  }

  /** Find skills matching input */
  findMatchingSkills(input: string): SkillDefinition[] {
    return this.loader.findMatchingSkills(input);
  }

  /** Get auto-trigger skills */
  getAutoSkills(): SkillDefinition[] {
    return this.loader.getAutoSkills();
  }

  /** Execute skill (generate prompt) */
  executeSkill(name: string, _context: SkillContext): SkillResult {
    const skill = this.loader.getSkill(name);

    if (!skill) {
      return {
        skill: name,
        triggered: false,
        prompt: undefined,
        metadata: { error: 'Skill not found' },
      };
    }

    return {
      skill: name,
      triggered: true,
      prompt: skill.prompt,
      metadata: {
        tools: skill.tools,
        priority: skill.priority,
        source: skill.source,
      },
    };
  }

  /** Check input for auto-trigger skills */
  checkAutoTriggers(input: string, context: SkillContext): SkillResult[] {
    const autoSkills = this.loader.getAutoSkills();
    const results: SkillResult[] = [];

    for (const skill of autoSkills) {
      if (this.loader.shouldTrigger(skill, input)) {
        results.push(this.executeSkill(skill.name, context));
      }
    }

    return results;
  }

  /** Generate system prompt injection for skills */
  generateSystemPromptInjection(): string {
    const skills = this.getAllSkills();

    if (skills.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('## Available Skills');
    lines.push('');
    lines.push('The following skills are available for specialized tasks:');
    lines.push('Use the exact Skill file and Resource root shown below when asked to inspect, load, or use a skill.');
    lines.push('Do not guess a skill path from another agent such as ~/.codex/skills unless it is explicitly listed here.');
    lines.push('');

    for (const skill of skills) {
      lines.push(`### ${skill.name}`);
      lines.push(`Description: ${skill.description}`);
      if (skill.sourceType) lines.push(`Source type: ${skill.sourceType}`);
      const resourceRoot = skill.resourceRoot || skill.source;
      if (resourceRoot) {
        lines.push(`Skill file: ${skillFilePath(resourceRoot)}`);
        lines.push(`Resource root: ${resourceRoot}`);
      }
      if (skill.trigger) {
        const triggerStr = typeof skill.trigger === 'string'
          ? skill.trigger
          : skill.trigger instanceof RegExp
            ? skill.trigger.source
            : 'custom function';
        lines.push(`Trigger: ${triggerStr}`);
      }
      if (skill.tools && skill.tools.length > 0) {
        lines.push(`Tools: ${skill.tools.join(', ')}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Get skills summary */
  getSummary(): {
    count: number;
    names: string[];
    autoCount: number;
    duplicateCount: number;
    duplicates: SkillDuplicateDiagnostic[];
  } {
    const skills = this.getAllSkills();
    const autoSkills = this.getAutoSkills();
    const duplicates = this.loader.getDuplicateDiagnostics();

    return {
      count: skills.length,
      names: skills.map(s => s.name),
      autoCount: autoSkills.length,
      duplicateCount: duplicates.length,
      duplicates,
    };
  }
}

function skillFilePath(resourceRoot: string): string {
  return resourceRoot.toLowerCase().endsWith(`/${SKILL_FILE_NAME.toLowerCase()}`)
    ? resourceRoot
    : join(resourceRoot, SKILL_FILE_NAME);
}

// ============================================================================
// Factory
// ============================================================================

let defaultRegistry: SkillsRegistry | null = null;

export function getSkillsRegistry(): SkillsRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SkillsRegistry();
    defaultRegistry.initialize();
  }
  return defaultRegistry;
}

export function resetSkillsRegistry(): void {
  defaultRegistry = null;
  // Also reset loader
  const { resetSkillsLoader } = require('./loader');
  resetSkillsLoader();
}
