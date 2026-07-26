import {
  ROLE_PRESETS,
  READ_ONLY_INVESTIGATION_TOOLS,
  SUBAGENT_FORBIDDEN_TOOLS,
  toolsForRole,
  systemPromptForRole,
  filterToolsForRole,
  assertNoForbiddenTools,
} from '../src/runtime/subagents/presets';
import type { SubagentRole } from '../src/runtime/subagents/types';

const ALL_UPSTREAM_TOOLS = [
  'read_file', 'write_file', 'list_files', 'exec_command', 'edit_file',
  'glob', 'grep', 'batch_read', 'memory_save', 'memory_recall',
  'memory_forget', 'history_search', 'mcp_call', 'mcp_list', 'openhorse',
];

describe('subagent presets', () => {
  describe('role tool allowlists', () => {
    const roles: SubagentRole[] = ['research', 'review', 'test-investigate'];
    for (const role of roles) {
      it(`${role} only receives read-only investigation tools`, () => {
        const tools = toolsForRole(role);
        for (const forbidden of SUBAGENT_FORBIDDEN_TOOLS) {
          expect(tools).not.toContain(forbidden);
        }
        expect(tools).toEqual(expect.arrayContaining([...READ_ONLY_INVESTIGATION_TOOLS]));
      });

      it(`${role} system prompt enforces JSON output contract`, () => {
        const prompt = systemPromptForRole(role);
        expect(prompt).toMatch(/JSON/);
        expect(prompt).toMatch(/summary/);
        expect(prompt).toMatch(/findings/);
        expect(prompt).toMatch(/commands/);
        // Must forbid the dangerous capabilities
        expect(prompt.toLowerCase()).toMatch(/cannot edit|cannot write|may not edit|may not write|cannot execute|may not execute/);
      });
    }
  });

  describe('filterToolsForRole', () => {
    it('keeps read-only tools and strips every forbidden tool', () => {
      const filtered = filterToolsForRole(ALL_UPSTREAM_TOOLS, 'research');
      expect(filtered).toContain('read_file');
      expect(filtered).toContain('batch_read');
      // R2: generic mcp_call/mcp_list are forbidden escape hatches - must be
      // excluded. First-class mcp__ tools are gated by isReadOnly() instead.
      expect(filtered).not.toContain('mcp_call');
      expect(filtered).not.toContain('mcp_list');
      // history_search removed in R3 (cross-project session leakage).
      expect(filtered).not.toContain('history_search');
      // Forbidden tools stripped
      for (const forbidden of SUBAGENT_FORBIDDEN_TOOLS) {
        expect(filtered).not.toContain(forbidden);
      }
    });

    it('strips exec_command, edit_file, write_file, memory_* and openhorse', () => {
      const filtered = filterToolsForRole(ALL_UPSTREAM_TOOLS, 'review');
      expect(filtered).not.toContain('exec_command');
      expect(filtered).not.toContain('edit_file');
      expect(filtered).not.toContain('write_file');
      expect(filtered).not.toContain('memory_save');
      expect(filtered).not.toContain('memory_recall');
      expect(filtered).not.toContain('memory_forget');
      expect(filtered).not.toContain('openhorse');
    });

    it('never includes the recursive subtask capability', () => {
      for (const role of ['research', 'review', 'test-investigate'] as SubagentRole[]) {
        const filtered = filterToolsForRole([...ALL_UPSTREAM_TOOLS, 'subtask'], role);
        expect(filtered).not.toContain('subtask');
      }
    });

    it('R2: first-class MCP tool admitted only when isReadOnly() === true', () => {
      // Fake tool definitions simulating MCP first-class tools.
      const readOnlyMcp = {
        name: 'mcp__server__get',
        isReadOnly: () => true,
      } as any;
      const mutatingMcp = {
        name: 'mcp__server__write',
        isReadOnly: () => false,
      } as any;
      const noAnnotationMcp = {
        name: 'mcp__server__unknown',
        // isReadOnly omitted -> conservative deny
      } as any;
      const runtimeTools = [readOnlyMcp, mutatingMcp, noAnnotationMcp];

      const filtered = filterToolsForRole(
        ['mcp__server__get', 'mcp__server__write', 'mcp__server__unknown'],
        'research',
        runtimeTools,
      );
      expect(filtered).toContain('mcp__server__get');
      expect(filtered).not.toContain('mcp__server__write');
      expect(filtered).not.toContain('mcp__server__unknown');
    });

    it('R2: denies all first-class MCP tools when no tool definitions provided', () => {
      // Without runtimeTools, we cannot verify isReadOnly() -> deny all.
      const filtered = filterToolsForRole(
        ['mcp__server__get', 'mcp__server__write'],
        'research',
      );
      expect(filtered).not.toContain('mcp__server__get');
      expect(filtered).not.toContain('mcp__server__write');
    });
  });

  describe('assertNoForbiddenTools', () => {
    it('passes for a clean read-only list', () => {
      expect(() => assertNoForbiddenTools(['read_file', 'grep'])).not.toThrow();
    });

    it('throws when a forbidden tool slips in', () => {
      expect(() => assertNoForbiddenTools(['read_file', 'exec_command'])).toThrow(/forbidden/);
      expect(() => assertNoForbiddenTools(['read_file', 'subtask'])).toThrow(/forbidden/);
    });

    it('R2: rejects mcp_call and mcp_list escape hatches', () => {
      expect(() => assertNoForbiddenTools(['read_file', 'mcp_call'])).toThrow(/forbidden/);
      expect(() => assertNoForbiddenTools(['read_file', 'mcp_list'])).toThrow(/forbidden/);
    });
  });

  it('every role preset is keyed and consistent', () => {
    for (const role of ['research', 'review', 'test-investigate'] as SubagentRole[]) {
      expect(ROLE_PRESETS[role]).toBeDefined();
      expect(ROLE_PRESETS[role].role).toBe(role);
      expect(ROLE_PRESETS[role].tools.length).toBeGreaterThan(0);
      expect(ROLE_PRESETS[role].systemPrompt.length).toBeGreaterThan(0);
    }
  });
});
