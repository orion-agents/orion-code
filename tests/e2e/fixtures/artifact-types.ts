import type { TarballArtifactReceiptV1 } from '../../../src/runtime/release-receipts';

export const WEB_E2E_ARTIFACT_STATE_VERSION = 1 as const;
export const WEB_E2E_STATE_ENV = 'ORION_WEB_E2E_STATE' as const;
export const WEB_E2E_RUN_ROOT_ENV = 'ORION_WEB_E2E_RUN_ROOT' as const;
export const WEB_E2E_TARBALL_ENV = 'ORION_WEB_E2E_TARBALL' as const;
export const WEB_E2E_RECEIPT_ENV = 'ORION_WEB_E2E_RECEIPT' as const;

export type WebE2EArtifactSourceV1 = 'provided' | 'built';

export interface WebE2EArtifactStateV1 {
  readonly version: typeof WEB_E2E_ARTIFACT_STATE_VERSION;
  readonly kind: 'orion.web-e2e-artifact-state';
  readonly createdAt: string;
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly rawRoot: string;
  readonly statePath: string;
  readonly source: WebE2EArtifactSourceV1;
  readonly artifact: {
    readonly tarballPath: string;
    readonly receiptPath: string;
    readonly receipt: TarballArtifactReceiptV1;
  };
  readonly installation: {
    readonly prefix: string;
    readonly packageRoot: string;
    readonly packageJsonPath: string;
    readonly binaryPath: string;
    readonly targetDigest: string;
  };
  readonly environment: {
    readonly node: string;
    readonly nodeMajor: number;
    readonly npm: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly stateDigest: string;
}
