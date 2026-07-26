/**
 * orion code - Auth 服务入口
 */

export {
  AuthService,
  getAuthService,
  resetAuthService,
  SecureStorage,
  getSecureStorage,
  type AuthConfig,
  type ApiKeyAuth,
  type OAuthAuth,
  type AwsAuth,
} from './auth';

export {
  verifyAwsCredentials,
  getStsToken,
  checkAwsCliAvailable,
  type StsResult,
} from './aws';