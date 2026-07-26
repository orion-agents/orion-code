/**
 * orion code - Memory System Types
 *
 * Typed memory system for user preferences, feedback, project context,
 * and external references. Based on OpenClaude's memory architecture.
 */

// ============================================================================
// Memory Types
// ============================================================================

/** Memory type taxonomy */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** Memory entry with frontmatter */
export interface MemoryEntry {
  /** Short kebab-case name */
  name: string;
  /** One-line description for index */
  description: string;
  /** Memory type */
  type: MemoryType;
  /** Memory content */
  content: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/** Memory index entry (MEMORY.md line) */
export interface MemoryIndexEntry {
  /** Memory name */
  name: string;
  /** Memory file path (relative) */
  path: string;
  /** One-line hook */
  hook: string;
}

// ============================================================================
// Type Descriptions
// ============================================================================

export const MEMORY_TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  user: 'User role, preferences, knowledge - helps tailor behavior to the user',
  feedback: 'Behavior guidance (avoid/keep) - corrections and confirmed approaches',
  project: 'Project state, goals, constraints - context behind current work',
  reference: 'External resource pointers - where to find info outside the project',
};

// ============================================================================
// Memory Prompts
// ============================================================================

/** Types section for system prompt */
export const MEMORY_TYPES_SECTION = `
## Types of memory

There are several discrete types of memory that you can store:

<types>
<type>
    <name>user</name>
    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective.</description>
    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>
</type>
<type>
    <name>feedback</name>
    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from validated approaches.</description>
    <when_to_save>Any time the user corrects your approach OR confirms a non-obvious approach worked</when_to_save>
    <body_structure>Lead with the rule, then **Why:** and **How to apply:** lines</body_structure>
</type>
<type>
    <name>project</name>
    <description>Information about ongoing work, goals, initiatives that is not derivable from code or git history. Helps understand the broader context.</description>
    <when_to_save>When you learn who is doing what, why, or by when. Convert relative dates to absolute dates.</when_to_save>
    <body_structure>Lead with the fact, then **Why:** and **How to apply:** lines</body_structure>
</type>
<type>
    <name>reference</name>
    <description>Stores pointers to where information can be found in external systems.</description>
    <when_to_save>When you learn about resources in external systems and their purpose</when_to_save>
</type>
</types>
`;

/** What NOT to save section */
export const MEMORY_EXCLUSIONS_SECTION = `
## What NOT to save in memory

- Code patterns, conventions, architecture, file paths, or project structure — read the current project state
- Git history, recent changes, or who-changed-what — \`git log\` / \`git blame\` are authoritative
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context
- Anything already documented in CLAUDE.md files
- Ephemeral task details: in-progress work, temporary state, current conversation context
`;

/** Frontmatter example */
export const MEMORY_FRONTMATTER_EXAMPLE = `---
name: {{short-kebab-case-slug}}
description: {{one-line summary}}
type: {{user|feedback|project|reference}}
---

{{memory content}}`;