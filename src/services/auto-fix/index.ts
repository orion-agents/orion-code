/**
 * orion code - AutoFix 服务入口
 */

export {
  AutoFixRunner,
  getAutoFixRunner,
  resetAutoFixRunner,
  type AutoFixResult,
  type AutoFixError,
  type AutoFixContext,
} from './autoFixRunner';

export {
  DEFAULT_AUTOFIX_CONFIG,
  detectAutoFixConfig,
  type AutoFixConfig,
  type AutoFixTrigger,
} from './autoFixConfig';

export {
  autoFixHook,
  shouldTriggerAutoFix,
} from './autoFixHook';