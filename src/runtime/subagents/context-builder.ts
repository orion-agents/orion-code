/**
 * SubagentContextBuilder: assembles the independent child message context.
 *
 * A child does NOT inherit the parent's full transcript. It receives a role
 * system prompt, a read-only summary of the root objective, and the specific
 * task packet with canonical scope. Optional capsule/evidence are injected only
 * when available, kept compact to avoid polluting the child context.
 */

import type { Message } from '../../services/llm';
import type { ContextCapsule } from '../../harness/types';
import { systemPromptForRole } from './presets';
import type { SubtaskPacket } from './types';

export interface ChildContextInputs {
  /** Canonical project root the child operates in. */
  cwd: string;
  /** The task packet (objective, scope, expectedOutput, hints). */
  packet: SubtaskPacket;
  /** Canonical scope paths already validated by policy. */
  canonicalScopePaths?: string[];
  /** Read-only summary of the root objective; never the full parent transcript. */
  rootObjectiveSummary?: string;
  /** Parent harness capsule, compacted to its salient fields. */
  capsule?: ContextCapsule;
  /** Model/provider info shown to the child so it understands its limits. */
  modelLabel?: string;
  /** Active project instructions / skill guidance (read-only). */
  projectInstructions?: string;
}

/**
 * Build the child message list. The first message is always the role system
 * prompt; a single user message frames the task. The child loop appends its
 * own assistant/tool messages on top of this.
 */
export function buildChildMessages(inputs: ChildContextInputs): Message[] {
  const { packet, cwd } = inputs;
  const systemPrompt = assembleSystemPrompt(inputs);
  const userPrompt = assembleUserPrompt(inputs);

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  function assembleSystemPrompt(i: ChildContextInputs): string {
    const rolePrompt = systemPromptForRole(packet.role);
    const lines: string[] = [rolePrompt, ''];
    lines.push(`# Operating context`);
    lines.push(`- Project root: ${cwd}`);
    if (i.modelLabel) lines.push(`- Model: ${i.modelLabel}`);
    lines.push('- You are a child agent at delegation depth 1. You may NOT create further subagents.');
    lines.push('- You may NOT edit, write, delete, commit, push, publish, install, or run shell commands.');
    if (i.rootObjectiveSummary) {
      lines.push('');
      lines.push(`# Root objective (read-only summary)`);
      lines.push(truncate(i.rootObjectiveSummary, 800));
    }
    if (i.projectInstructions) {
      lines.push('');
      lines.push(`# Project instructions (read-only)`);
      lines.push(truncate(i.projectInstructions, 1200));
    }
    if (i.capsule) {
      lines.push('');
      lines.push(`# Parent context capsule (read-only)`);
      lines.push(compactCapsule(i.capsule));
    }
    return lines.join('\n');
  }

  function assembleUserPrompt(i: ChildContextInputs): string {
    const lines: string[] = [];
    lines.push(`## Task`);
    lines.push(`role: ${packet.role}`);
    lines.push(`objective: ${packet.objective}`);
    if (packet.reason) lines.push(`reason: ${packet.reason}`);
    if (i.canonicalScopePaths && i.canonicalScopePaths.length > 0) {
      lines.push(`scope: ${i.canonicalScopePaths.join(', ')}`);
    }
    if (packet.contextHints && packet.contextHints.length > 0) {
      lines.push(`hints:`);
      for (const hint of packet.contextHints) lines.push(`  - ${hint}`);
    }
    if (packet.expectedOutput) {
      lines.push(`expected output: ${packet.expectedOutput}`);
    }
    lines.push('');
    lines.push('Investigate now using only the read-only tools available to you, then emit the JSON result object as specified in your system prompt.');
    return lines.join('\n');
  }
}

function compactCapsule(capsule: ContextCapsule): string {
  const lines: string[] = [];
  if (capsule.contract?.objective) lines.push(`- contract objective: ${truncate(capsule.contract.objective, 200)}`);
  if (capsule.completed.length > 0) lines.push(`- completed: ${truncate(capsule.completed.join('; '), 300)}`);
  if (capsule.openTodos.length > 0) lines.push(`- open todos: ${truncate(capsule.openTodos.join('; '), 300)}`);
  if (capsule.changedFiles.length > 0) lines.push(`- changed files: ${truncate(capsule.changedFiles.join(', '), 300)}`);
  if (capsule.keyFacts.length > 0) {
    lines.push(`- key facts:`);
    for (const fact of capsule.keyFacts.slice(0, 5)) lines.push(`  - ${truncate(fact.content, 160)}`);
  }
  if (capsule.nextAction) lines.push(`- next action: ${truncate(capsule.nextAction, 200)}`);
  return lines.length > 0 ? lines.join('\n') : '(no capsule fields)';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
