/**
 * Orion Code - centralized product identity.
 *
 * ALL modules that need the product name, command, package, config paths, or
 * environment prefix MUST import from here (or from paths.ts / environment.ts).
 * Hard-coding "Orion Code", "orion-code", ".orion-code", or "ORION_CODE_" in
 * any other file is forbidden.
 */

export interface ProductIdentity {
  readonly productId: 'orion-code';
  readonly displayName: 'Orion Code';
  readonly cliName: 'orion';
  readonly npmPackage: 'orion-code';
  readonly repository: 'Linux2010/orion-code';
  readonly configDirName: '.orion-code';
  readonly configFileName: 'orion.json';
  readonly envFileName: '.orion-code.env';
  readonly envPrefix: 'ORION_CODE_';
  readonly userInstructionsFile: 'ORION.md';
  readonly localInstructionsFile: 'ORION.local.md';
  readonly projectConfigDirName: '.orion-code';
  readonly mcpClientName: 'orion-code';
}

const IDENTITY: ProductIdentity = {
  productId: 'orion-code',
  displayName: 'Orion Code',
  cliName: 'orion',
  npmPackage: 'orion-code',
  repository: 'Linux2010/orion-code',
  configDirName: '.orion-code',
  configFileName: 'orion.json',
  envFileName: '.orion-code.env',
  envPrefix: 'ORION_CODE_',
  userInstructionsFile: 'ORION.md',
  localInstructionsFile: 'ORION.local.md',
  projectConfigDirName: '.orion-code',
  mcpClientName: 'orion-code',
};

/** The frozen product identity singleton. */
export function getProductIdentity(): Readonly<ProductIdentity> {
  return IDENTITY;
}

// Convenience accessors — prefer these over getProductIdentity().xxx in most code.

export const PRODUCT_ID: ProductIdentity['productId'] = IDENTITY.productId;
export const DISPLAY_NAME: ProductIdentity['displayName'] = IDENTITY.displayName;
export const CLI_NAME: ProductIdentity['cliName'] = IDENTITY.cliName;
export const NPM_PACKAGE: ProductIdentity['npmPackage'] = IDENTITY.npmPackage;
export const REPOSITORY: ProductIdentity['repository'] = IDENTITY.repository;
export const CONFIG_DIR_NAME: ProductIdentity['configDirName'] = IDENTITY.configDirName;
export const CONFIG_FILE_NAME: ProductIdentity['configFileName'] = IDENTITY.configFileName;
export const ENV_FILE_NAME: ProductIdentity['envFileName'] = IDENTITY.envFileName;
export const ENV_PREFIX: ProductIdentity['envPrefix'] = IDENTITY.envPrefix;
export const USER_INSTRUCTIONS_FILE: ProductIdentity['userInstructionsFile'] = IDENTITY.userInstructionsFile;
export const LOCAL_INSTRUCTIONS_FILE: ProductIdentity['localInstructionsFile'] = IDENTITY.localInstructionsFile;
export const PROJECT_CONFIG_DIR_NAME: ProductIdentity['projectConfigDirName'] = IDENTITY.projectConfigDirName;
export const MCP_CLIENT_NAME: ProductIdentity['mcpClientName'] = IDENTITY.mcpClientName;