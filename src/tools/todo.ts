/**
 * orion code - TodoWrite Tool
 *
 * Manage task progress during coding sessions.
 *
 * State is held in the shared tool-state module so the CLI can mirror it
 * into the main Store and render it in the UI.
 */

import { buildTool, type OpenHorseTool } from '../framework/tool';
import { getToolState, setToolState, type TodoItem } from '../framework/tool-state';

// ============================================================================
// TodoWrite Tool
// ============================================================================

const TODO_PROMPT = `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

## When to Use This Tool

1. Complex multi-step tasks - When a task requires 3 or more distinct steps
2. Non-trivial tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list
4. User provides multiple tasks (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements
6. When you start working on a task - Mark it as in_progress BEFORE beginning
7. After completing a task - Mark it completed immediately

## When NOT to Use

1. Single, straightforward task
2. Trivial task with no organizational benefit
3. Purely conversational or informational

## Task States

- pending: Task not yet started
- in_progress: Currently working on (limit to ONE task at a time)
- completed: Task finished successfully

## Task Format

Each todo must have:
- content: Imperative form ("Run tests")
- activeForm: Present continuous form ("Running tests")
- status: pending | in_progress | completed

## Rules

- Exactly ONE task should be in_progress at any time
- Mark tasks complete IMMEDIATELY after finishing
- Remove tasks that are no longer relevant
- Only mark completed when FULLY accomplished`;

export const todoWriteTool: OpenHorseTool = buildTool({
  name: 'todo_write',
  description: `Update the todo list for the current session.

${TODO_PROMPT}`,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'string',
        description: 'JSON array or array of todos: [{"content":"Task","status":"pending|in_progress|completed","activeForm":"Doing task"}]',
      },
    },
    required: ['todos'],
  },
  execute: async (args) => {
    let todos: TodoItem[];
    const rawTodos = args.todos;
    if (Array.isArray(rawTodos)) {
      todos = rawTodos as TodoItem[];
    } else {
      try {
        todos = JSON.parse(rawTodos as string);
      } catch {
        return { success: false, output: '', error: 'todos must be a valid JSON array' };
      }
    }

    if (!Array.isArray(todos)) {
      return { success: false, output: '', error: 'todos must be an array' };
    }

    for (const todo of todos) {
      if (!todo.content || typeof todo.content !== 'string') {
        return { success: false, output: '', error: 'Each todo must have a content string' };
      }
      if (!todo.activeForm || typeof todo.activeForm !== 'string') {
        return { success: false, output: '', error: 'Each todo must have an activeForm string' };
      }
      if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
        return { success: false, output: '', error: `Invalid status: ${todo.status}` };
      }
    }

    const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      return {
        success: false,
        output: '',
        error: 'Only one task can be in_progress at a time',
      };
    }

    setToolState({ todos });

    const lines: string[] = [];
    lines.push('Todo list updated:');
    lines.push('');

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const icon = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '⏳' : '⬚';
      lines.push(`${i + 1}. [${icon}] ${todo.content}`);
      if (todo.status === 'in_progress') {
        lines.push(`   → ${todo.activeForm}`);
      }
    }

    lines.push('');
    lines.push(`Summary: ${todos.length} tasks, ${todos.filter(t => t.status === 'completed').length} completed, ${inProgressCount} in progress`);

    return {
      success: true,
      output: lines.join('\n'),
    };
  },
  isReadOnly: () => false,
  checkPermissions: () => {
    return { behavior: 'allow', reason: 'Todo operations are safe' };
  },
  userFacingName: (args) => {
    try {
      const todos = Array.isArray(args.todos)
        ? args.todos as TodoItem[]
        : JSON.parse(args.todos as string) as TodoItem[];
      return `Update ${todos.length} todos`;
    } catch {
      return 'Update todos';
    }
  },
});

/** Get current todos (for UI display) */
export function getCurrentTodos(): TodoItem[] {
  return getToolState().todos;
}

/** Format todos for display */
export function formatTodosForDisplay(todos: TodoItem[]): string {
  if (todos.length === 0) return 'No active tasks';

  const lines: string[] = [];
  lines.push('Tasks:');
  lines.push('');

  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    const icon = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '⏳' : '⬚';
    lines.push(`${i + 1}. [${icon}] ${todo.status === 'in_progress' ? todo.activeForm : todo.content}`);
  }

  return lines.join('\n');
}

export type { TodoItem };
export const TODO_TOOLS: OpenHorseTool[] = [todoWriteTool];
