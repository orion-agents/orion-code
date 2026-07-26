import { getSkillsLoader, normalizeSkillSourcePath, parseSkillFile } from '../src/skills/loader';
import { getSkillsRegistry, resetSkillsRegistry } from '../src/skills/registry';
import {
  hasMatchingSkill,
  loadExplicitSkillReference,
  MAX_EXPLICIT_SKILL_BYTES,
  parseSkillCommandInput,
  resolveSkillResourcePath,
  resolveSkillsForTurn,
} from '../src/skills/runtime';
import { findCommand } from '../src/commands';
import type { SkillDefinition } from '../src/skills/types';
import { buildTool, type OpenHorseTool } from '../src/framework/tool';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const originalCwd = process.cwd();
const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;

function makeTool(name: string): OpenHorseTool {
  return buildTool({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, output: '' }),
  });
}

function writeSkill(root: string, name: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir !== undefined) {
    process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
  } else {
    delete process.env.ORION_CODE_CONFIG_DIR;
  }
  resetSkillsRegistry();
});

describe('SkillsLoader', () => {
  test('parseSkillFile parses valid skill', () => {
    const content = `---
name: test-skill
description: A test skill
trigger: /test
---
# Test Skill

This is a test skill prompt.`;

    const skill = parseSkillFile(content, '/path/to/SKILL.md');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('test-skill');
    expect(skill?.description).toBe('A test skill');
    expect(skill?.trigger).toBe('/test');
    expect(skill?.prompt).toContain('Test Skill');
  });

  test('parseSkillFile normalizes markdown link source locators', () => {
    const content = `---
name: chronicle
description: Screen history
---
# Chronicle`;

    const source = '[$chronicle](/Users/hope/.codex/skills/chronicle/SKILL.md)';
    const skill = parseSkillFile(content, source);

    expect(normalizeSkillSourcePath(source)).toBe('/Users/hope/.codex/skills/chronicle/SKILL.md');
    expect(skill?.name).toBe('chronicle');
    expect(skill?.source).toBe('/Users/hope/.codex/skills/chronicle/SKILL.md');
  });

  test('parseSkillFile accepts BOM and CRLF frontmatter', () => {
    const content = '\uFEFF---\r\nname: crlf-skill\r\ndescription: CRLF skill\r\n---\r\n# Body';

    const skill = parseSkillFile(content, '/path/to/crlf/SKILL.md');

    expect(skill?.name).toBe('crlf-skill');
    expect(skill?.description).toBe('CRLF skill');
    expect(skill?.prompt).toBe('# Body');
  });

  test('parseSkillFile parses activation aliases', () => {
    const content = `---
name: squad
description: Squad workflow
aliases:
  - 团队开发
  - coding team
---
# Body`;

    const skill = parseSkillFile(content, '/path/to/squad/SKILL.md');

    expect(skill?.aliases).toEqual(['团队开发', 'coding team']);
  });

  test('parseSkillFile accepts legacy markdown-only skills without warning', () => {
    const content = `# GitHub Contribution Skill

Automated GitHub contribution workflow.

## Usage
Run the workflow.`;

    const skill = parseSkillFile(content, '/Users/hope/.orion-code/skills/github-contribution/SKILL.md');

    expect(skill?.name).toBe('github-contribution');
    expect(skill?.description).toBe('Automated GitHub contribution workflow.');
    expect(skill?.prompt).toContain('GitHub Contribution Skill');
  });

  test('parseSkillFile returns null for invalid skill', () => {
    const content = 'No frontmatter here';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const skill = parseSkillFile(content, '/path/to/SKILL.md');
      expect(skill).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test('loader loads skills', () => {
    const loader = getSkillsLoader();
    const skills = loader.load();
    expect(skills.length).toBeGreaterThan(0);
  });

  test('loader finds builtin skills', () => {
    const loader = getSkillsLoader();
    loader.load();
    const skill = loader.getSkill('code-review');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('code-review');
  });

  test('shouldTrigger detects string trigger', () => {
    const loader = getSkillsLoader();
    const skill: SkillDefinition = {
      name: 'test',
      description: 'Test skill',
      trigger: '/test',
      prompt: 'test',
    };

    expect(loader.shouldTrigger(skill, '/test something')).toBe(true);
    expect(loader.shouldTrigger(skill, 'no match')).toBe(false);
  });

  test('shouldTrigger detects regex trigger', () => {
    const loader = getSkillsLoader();
    const skill: SkillDefinition = {
      name: 'test',
      description: 'Test skill',
      trigger: /review\s+\w+/i,
      prompt: 'test',
    };

    expect(loader.shouldTrigger(skill, 'review code')).toBe(true);
    expect(loader.shouldTrigger(skill, 'no match')).toBe(false);
  });

  test('findMatchingSkills returns matches', () => {
    const loader = getSkillsLoader();
    loader.load();
    const matches = loader.findMatchingSkills('/review code');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some(s => s.name === 'code-review')).toBe(true);
  });
});

describe('SkillsRegistry', () => {
  test('registry initializes', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const skills = registry.getAllSkills();
    expect(skills.length).toBeGreaterThan(0);
  });

  test('registry has skill', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    expect(registry.hasSkill('code-review')).toBe(true);
  });

  test('registry executes skill', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const result = registry.executeSkill('code-review', {
      cwd: process.cwd(),
      input: '/review',
      tools: [],
    });

    expect(result.skill).toBe('code-review');
    expect(result.triggered).toBe(true);
    expect(result.prompt).toBeDefined();
  });

  test('registry generates system prompt injection', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const injection = registry.generateSystemPromptInjection();
    expect(injection).toContain('Available Skills');
    expect(injection).toContain('code-review');
    expect(injection).toContain('Use the exact Skill file and Resource root');
    expect(injection).toContain('Source type: builtin');
    expect(injection).toContain('Skill file:');
    expect(injection).toContain('/code-review/SKILL.md');
    expect(injection).toContain('Resource root:');
  });

  test('registry returns summary', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const summary = registry.getSummary();
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.names).toContain('code-review');
  });
});

describe('Skills runtime', () => {
  test('injects full matched skill prompt and scopes tools for the turn', () => {
    resetSkillsRegistry();
    const tools = ['read_file', 'glob', 'grep', 'write_file'].map(makeTool);

    const resolution = resolveSkillsForTurn({
      cwd: process.cwd(),
      input: '/review src',
      tools,
    });

    expect(resolution.skills.map(s => s.name)).toContain('code-review');
    expect(resolution.promptInjection).toContain('# Code Review Skill');
    expect(resolution.promptInjection).toContain('Resource root:');
    expect(resolution.toolScopeActive).toBe(true);
    expect(resolution.tools.map(t => t.name).sort()).toEqual(['glob', 'grep', 'read_file']);
  });

  test('explicit /skill command activates a loaded skill without a trigger', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-explicit-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: { paths: [externalRoot] },
    }), 'utf-8');

    writeSkill(externalRoot, 'no-trigger-skill', `---
name: no-trigger-skill
description: No trigger skill
---
No trigger prompt`);

    resetSkillsRegistry();
    const resolution = resolveSkillsForTurn({
      cwd: projectDir,
      input: '/skill no-trigger-skill do the task',
      tools: ['read_file', 'write_file'].map(makeTool),
    });

    expect(parseSkillCommandInput('/skill no-trigger-skill do the task')).toEqual({
      skillName: 'no-trigger-skill',
      task: 'do the task',
    });
    expect(resolution.skills.map(skill => skill.name)).toEqual(['no-trigger-skill']);
    expect(resolution.promptInjection).toContain('No trigger prompt');
    expect(hasMatchingSkill('/no-trigger-skill do the task')).toBe(true);

    const markdownReference = `[$no-trigger-skill](${externalRoot}/no-trigger-skill/SKILL.md) inspect it`;
    expect(parseSkillCommandInput(markdownReference)).toEqual({
      skillName: 'no-trigger-skill',
      skillPath: `${externalRoot}/no-trigger-skill/SKILL.md`,
      task: 'inspect it',
    });
    expect(resolveSkillsForTurn({
      cwd: projectDir,
      input: markdownReference,
      tools: ['read_file', 'write_file'].map(makeTool),
    }).skills.map(skill => skill.name)).toEqual(['no-trigger-skill']);

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('loads an unconfigured skill from an explicit SKILL.md reference', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-linked-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external root)');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);
    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
    }), 'utf-8');
    writeSkill(externalRoot, 'chronicle', `---
name: chronicle
description: Screen history
---
Chronicle prompt`);

    resetSkillsRegistry();
    const skillFile = join(externalRoot, 'chronicle', 'SKILL.md');
    const input = `[$chronicle](<${skillFile}>) inspect recent work (today)`;
    const resolution = resolveSkillsForTurn({
      cwd: projectDir,
      input,
      tools: ['read_file', 'write_file'].map(makeTool),
    });

    expect(getSkillsRegistry().getSkill('chronicle')).toBeUndefined();
    expect(parseSkillCommandInput(input)).toEqual({
      skillName: 'chronicle',
      skillPath: skillFile,
      task: 'inspect recent work (today)',
    });
    expect(resolution.skills.map(skill => skill.name)).toEqual(['chronicle']);
    expect(resolution.promptInjection).toContain('Chronicle prompt');
    expect(resolution.skills[0].resourceRoot).toBe(join(externalRoot, 'chronicle'));
    expect(resolveSkillsForTurn({
      cwd: projectDir,
      input: `/${input}`,
      tools: ['read_file', 'write_file'].map(makeTool),
    }).skills.map(skill => skill.name)).toEqual(['chronicle']);

    const command = findCommand('skill');
    expect(command!.execute({ cwd: projectDir } as any, input)).toEqual(expect.objectContaining({
      success: true,
      continueAsChat: true,
      chatInput: `/skill [$chronicle](<${skillFile}>) inspect recent work (today)`,
    }));
    const noTask = command!.execute(
      { cwd: projectDir } as any,
      `[$chronicle](<${skillFile}>)`,
    );
    expect(noTask).toEqual(expect.objectContaining({
      output: expect.stringContaining('Skill reference chronicle is valid for one turn.'),
    }));
    expect(noTask).not.toEqual(expect.objectContaining({
      output: expect.stringContaining('Skill chronicle is loaded.'),
    }));

    const relativeInput = '[$chronicle](<../external root)/chronicle/SKILL.md>) inspect';
    process.chdir(originalCwd);
    expect(hasMatchingSkill(relativeInput, projectDir)).toBe(true);

    const oversizedRoot = join(tempRoot, 'oversized');
    writeSkill(oversizedRoot, 'oversized', `---
name: oversized
description: Oversized skill
---
${'x'.repeat(MAX_EXPLICIT_SKILL_BYTES)}`);
    const oversizedInput = `[$oversized](${join(oversizedRoot, 'oversized', 'SKILL.md')}) inspect`;
    expect(loadExplicitSkillReference(oversizedInput, projectDir)).toBeUndefined();
    const invalidBuiltinReference = `[$code-review](${join(oversizedRoot, 'missing', 'SKILL.md')}) inspect`;
    expect(hasMatchingSkill(invalidBuiltinReference, projectDir)).toBe(false);
    expect(resolveSkillsForTurn({
      cwd: projectDir,
      input: invalidBuiltinReference,
      tools: ['read_file', 'write_file'].map(makeTool),
    }).skills).toEqual([]);

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('keeps closing parentheses in a markdown skill task', () => {
    expect(parseSkillCommandInput(
      '/skill [$code-review](/tmp/code-review/SKILL.md) inspect (src)',
    )).toEqual({
      skillName: 'code-review',
      skillPath: '/tmp/code-review/SKILL.md',
      task: 'inspect (src)',
    });
  });

  test('explicit natural-language skill request activates a loaded skill by name', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-natural-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: { paths: [externalRoot] },
    }), 'utf-8');

    writeSkill(externalRoot, 'coding-squad', `---
name: coding-squad
description: Squad workflow
tags:
  - agent-workflow
  - coding
---
Squad prompt`);

    resetSkillsRegistry();
    const resolution = resolveSkillsForTurn({
      cwd: projectDir,
      input: '使用团队开发',
      tools: ['read_file', 'write_file'].map(makeTool),
    });

    expect(resolution.skills.map(skill => skill.name)).toEqual(['coding-squad']);
    expect(resolution.promptInjection).toContain('Squad prompt');

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('/skill slash command continues through chat with explicit activation syntax', () => {
    resetSkillsRegistry();
    const command = findCommand('skill');
    expect(command).toBeDefined();

    const result = command!.execute({} as any, 'code-review inspect src');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      continueAsChat: true,
      chatInput: '/skill code-review inspect src',
    }));

    const codeReview = getSkillsRegistry().getSkill('code-review');
    const markdownResult = command!.execute({ cwd: process.cwd() } as any,
      `[$code-review](${codeReview!.resourceRoot}/SKILL.md) inspect src`);
    expect(markdownResult).toEqual(expect.objectContaining({
      success: true,
      continueAsChat: true,
      chatInput: expect.stringMatching(/^\/skill \[\$code-review\]\(.+\/SKILL\.md\) inspect src$/),
    }));
  });

  test('/skill slash command accepts activation aliases', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-command-alias-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: { paths: [externalRoot] },
    }), 'utf-8');

    writeSkill(externalRoot, 'coding-squad', `---
name: coding-squad
description: Squad workflow
aliases:
  - 团队开发
---
Squad prompt`);

    resetSkillsRegistry();
    const command = findCommand('skill');
    const result = command!.execute({} as any, '团队开发 修复问题');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      continueAsChat: true,
      chatInput: '/skill coding-squad 修复问题',
    }));

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('project skills override user and builtin skills with the same name', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeSkill(join(configDir, 'skills'), 'code-review', `---
name: code-review
description: User review
trigger: /review
priority: 100
---
User skill prompt`);

    writeSkill(join(projectDir, '.orion-code', 'skills'), 'code-review', `---
name: code-review
description: Project review
trigger: /review
priority: 1
---
Project skill prompt`);

    resetSkillsRegistry();
    const skill = getSkillsRegistry().getSkill('code-review');

    expect(skill?.description).toBe('Project review');
    expect(skill?.prompt).toContain('Project skill prompt');
    expect(skill?.sourceType).toBe('project');

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('configured skills paths load external roots and direct skill directories', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-extra-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    const directSkillDir = join(tempRoot, 'direct-skill');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: {
        paths: [externalRoot, directSkillDir],
      },
    }), 'utf-8');

    writeSkill(externalRoot, 'coding-squad', `---
name: coding-squad
description: External squad workflow
trigger: coding-squad
---
External squad prompt`);

    mkdirSync(directSkillDir, { recursive: true });
    writeFileSync(join(directSkillDir, 'SKILL.md'), `---
name: direct-skill
description: Direct skill path
trigger: direct-skill
---
Direct prompt`, 'utf-8');

    resetSkillsRegistry();
    const registry = getSkillsRegistry();

    expect(registry.getSkill('coding-squad')?.description).toBe('External squad workflow');
    expect(registry.getSkill('coding-squad')?.sourceType).toBe('configured');
    expect(registry.getSkill('direct-skill')?.description).toBe('Direct skill path');
    expect(registry.getSkill('direct-skill')?.sourceType).toBe('configured');

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('project skills override configured skills with the same name', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-priority-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: {
        paths: [externalRoot],
      },
    }), 'utf-8');

    writeSkill(externalRoot, 'code-review', `---
name: code-review
description: Configured review
trigger: /review
priority: 100
---
Configured skill prompt`);

    writeSkill(join(projectDir, '.orion-code', 'skills'), 'code-review', `---
name: code-review
description: Project review
trigger: /review
priority: 1
---
Project skill prompt`);

    resetSkillsRegistry();
    const skill = getSkillsRegistry().getSkill('code-review');

    expect(skill?.description).toBe('Project review');
    expect(skill?.sourceType).toBe('project');

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('records duplicate skill diagnostics with selected source', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-duplicates-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: {
        paths: [externalRoot],
      },
    }), 'utf-8');

    writeSkill(externalRoot, 'code-review', `---
name: code-review
description: Configured review
trigger: /review
priority: 100
---
Configured skill prompt`);

    writeSkill(join(projectDir, '.orion-code', 'skills'), 'code-review', `---
name: code-review
description: Project review
trigger: /review
priority: 1
---
Project skill prompt`);

    resetSkillsRegistry();
    const summary = getSkillsRegistry().getSummary();

    expect(summary.duplicateCount).toBeGreaterThan(0);
    expect(summary.duplicates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'code-review',
        incomingSelected: true,
        selectedSourceType: 'project',
      }),
    ]));

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('resolves skill resources from the skill root and blocks escapes', () => {
    resetSkillsRegistry();
    const resolution = resolveSkillsForTurn({
      cwd: process.cwd(),
      input: '/review src',
      tools: ['read_file', 'glob', 'grep'].map(makeTool),
    });

    const skill = resolution.skills.find(s => s.name === 'code-review');
    expect(skill).toBeDefined();

    const resolved = resolveSkillResourcePath(skill!, 'assets/example.txt');
    expect(resolved).toContain('/code-review/assets/example.txt');
    expect(() => resolveSkillResourcePath(skill!, '../outside.txt')).toThrow('escapes root');
  });
});
