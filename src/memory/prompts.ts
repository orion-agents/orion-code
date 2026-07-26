/**
 * orion code - Memory Prompts
 *
 * Build system prompt sections for memory system.
 */


import { loadAllMemories, loadMemoryIndex } from './storage';
import { MEMORY_TYPES_SECTION, MEMORY_EXCLUSIONS_SECTION, MEMORY_FRONTMATTER_EXAMPLE } from './types';

// ============================================================================
// Memory Prompt Building
// ============================================================================

/** Build full memory prompt for system message */
export function buildMemoryPrompt(): string {
  const memories = loadAllMemories();
  const index = loadMemoryIndex();

  const lines: string[] = [
    '# Memory System',
    '',
    `You have a persistent, file-based memory system at ~/.orion-code/memory/.`,
    'This directory already exists — write to it directly with the Write tool.',
    '',
    'You should build up this memory system over time so that future conversations',
    'can have a complete picture of who the user is, how they\'d like to collaborate,',
    'what behaviors to avoid or repeat, and the context behind the work.',
    '',
    'If the user explicitly asks you to remember something, save it immediately.',
    'If they ask you to forget something, find and remove the relevant entry.',
    '',
    MEMORY_TYPES_SECTION,
    '',
    '## How to save memories',
    '',
    'Write each memory to its own file using this frontmatter format:',
    '',
    '```markdown',
    MEMORY_FRONTMATTER_EXAMPLE,
    '```',
    '',
    '- Keep the name, description, and type fields up-to-date with the content',
    '- Organize memory semantically by topic, not chronologically',
    '- Update or remove memories that turn out to be wrong or outdated',
    '- Do not write duplicate memories. First check if there is an existing memory.',
    '',
    MEMORY_EXCLUSIONS_SECTION,
    '',
    '## When to access memories',
    '',
    '- When memories seem relevant, or the user references prior work',
    '- You MUST access memory when the user explicitly asks you to remember',
    '- Memory records can become stale. Verify against current state before acting',
    '',
  ];

  // Add loaded memories if any
  if (memories.length > 0) {
    lines.push('## Loaded Memories');
    lines.push('');
    for (const mem of memories) {
      lines.push(`### ${mem.name} (${mem.type})`);
      lines.push('');
      lines.push(mem.content);
      lines.push('');
    }
  } else if (index) {
    lines.push('## Memory Index');
    lines.push('');
    lines.push(index);
  }

  return lines.join('\n');
}

/** Build short memory summary for compact prompt */
export function buildMemorySummary(): string {
  const memories = loadAllMemories();

  if (memories.length === 0) {
    return 'No memories loaded. Use memory_save tool to save user preferences and feedback.';
  }

  const lines: string[] = ['Loaded memories:'];
  for (const mem of memories) {
    lines.push(`- ${mem.name} (${mem.type}): ${mem.description || mem.content.slice(0, 50)}`);
  }

  return lines.join('\n');
}

/** Get memory injection for user context */
export function getMemoryUserContext(): Record<string, string> {
  const memories = loadAllMemories();
  const context: Record<string, string> = {};

  // Group by type
  const byType: Record<string, string[]> = {
    user: [],
    feedback: [],
    project: [],
    reference: [],
  };

  for (const mem of memories) {
    const summary = `${mem.name}: ${mem.description || mem.content.slice(0, 80)}`;
    byType[mem.type]?.push(summary);
  }

  // Build context entries
  if (byType.user.length > 0) {
    context.user_memories = byType.user.join('\n');
  }
  if (byType.feedback.length > 0) {
    context.feedback_memories = byType.feedback.join('\n');
  }
  if (byType.project.length > 0) {
    context.project_memories = byType.project.join('\n');
  }
  if (byType.reference.length > 0) {
    context.reference_memories = byType.reference.join('\n');
  }

  return context;
}