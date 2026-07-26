/**
 * v0.2.24 — Goal model tools unit tests.
 * v0.2.26 — Updated for OpenHorseTool format with setGoalToolCoordinator binding.
 */

import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import {
  getGoalTool,
  createGoalTool,
  updateGoalTool,
  setGoalToolCoordinator,
} from '../src/runtime/goals/tools';

describe('Goal model tools', () => {
  let coordinator: GoalCoordinator;

  beforeEach(() => {
    coordinator = new GoalCoordinator('/test/project', 'test-session');
    setGoalToolCoordinator(coordinator);
  });

  describe('get_goal', () => {
    it('returns null when no goal exists', async () => {
      const result = await getGoalTool.execute({}, { cwd: '/test', config: { name: 'test', mode: 'test' } });
      expect(result.success).toBe(true);
      expect(result.output).toBe('No active goal.');
    });

    it('returns goal snapshot when goal exists', async () => {
      coordinator.create('test objective');
      const result = await getGoalTool.execute({}, { cwd: '/test', config: { name: 'test', mode: 'test' } });
      expect(result.success).toBe(true);
      expect(result.output).toContain('test objective');
    });

    it('has tool definition with correct name', () => {
      expect(getGoalTool.name).toBe('get_goal');
    });

    it('is read-only', () => {
      expect(getGoalTool.isReadOnly!({})).toBe(true);
    });
  });

  describe('create_goal', () => {
    it('creates a goal from explicit objective', async () => {
      const result = await createGoalTool.execute(
        { objective: 'Run CI' },
        { cwd: '/test', config: { name: 'test', mode: 'test' } },
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Run CI');
    });

    it('rejects empty objective', async () => {
      // Coordinator rejects empty objectives
      const result = await createGoalTool.execute(
        { objective: '' },
        { cwd: '/test', config: { name: 'test', mode: 'test' } },
      );
      expect(result.success).toBe(false);
    });

    it('rejects duplicate goal if active', async () => {
      coordinator.create('first goal');
      const result = await createGoalTool.execute(
        { objective: 'second goal' },
        { cwd: '/test', config: { name: 'test', mode: 'test' } },
      );
      expect(result.success).toBe(false);
    });

    it('has tool definition', () => {
      expect(createGoalTool.name).toBe('create_goal');
    });
  });

  describe('update_goal', () => {
    it('requests complete status on active goal', async () => {
      coordinator.create('test');
      const result = await updateGoalTool.execute(
        { status: 'complete' },
        { cwd: '/test', config: { name: 'test', mode: 'test' } },
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('complete');
    });

    it('requests blocked status', async () => {
      coordinator.create('test');
      const result = await updateGoalTool.execute(
        { status: 'blocked' },
        { cwd: '/test', config: { name: 'test', mode: 'test' } },
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('blocked');
    });

    it('rejects update when no goal exists', async () => {
      const result = await updateGoalTool.execute(
        { status: 'complete' },
        { cwd: '/test', config: { name: 'test', mode: 'test' } },
      );
      expect(result.success).toBe(false);
    });

    it('has tool definition', () => {
      expect(updateGoalTool.name).toBe('update_goal');
    });
  });
});
