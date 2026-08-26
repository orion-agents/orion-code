import type { OrionCodeTool } from '../../framework/tool';
import { coreTool as editFileTool } from './edit-file';
import { coreTool as execCommandTool } from './exec-command';
import { coreTool as globTool } from './glob';
import { coreTool as grepTool } from './grep';
import { coreTool as listFilesTool } from './list-files';
import { coreTool as readFileTool } from './read-file';
import { coreTool as writeFileTool } from './write-file';

/**
 * Legacy eager assembly reuses the exact same tool shards as the v0.2 runtime.
 * Production lazy callers import an individual shard directly instead.
 */
export const CORE_TOOLS: readonly OrionCodeTool[] = Object.freeze([
  readFileTool,
  writeFileTool,
  listFilesTool,
  execCommandTool,
  editFileTool,
  globTool,
  grepTool,
]);

export {
  editFileTool,
  execCommandTool,
  globTool,
  grepTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
};
