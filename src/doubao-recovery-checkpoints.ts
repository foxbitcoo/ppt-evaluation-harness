export type DoubaoRecoverySha256 = `sha256:${string}`;

export interface TrustedDoubaoRecoveryReceipt {
  readonly captureId: string;
  readonly artifactContentHash: DoubaoRecoverySha256;
  readonly traceDigest: DoubaoRecoverySha256;
  readonly retainedPageDigest: DoubaoRecoverySha256;
  readonly renderDigest: DoubaoRecoverySha256;
}

export interface TrustedDoubaoRecoveryCheckpoint {
  readonly schemaVersion: "doubao-recovery-checkpoint-v1";
  readonly checkpointId: string;
  readonly purpose:
    | "real_provider_recovery"
    | "offline_validation_fixture";
  readonly artifactContentHash: DoubaoRecoverySha256;
  readonly pageCount: 16;
  readonly packageId: string;
  readonly adapterVersion: "doubao-web-ppt@1";
  readonly adapterImplementationDigest: DoubaoRecoverySha256;
  readonly executionEntrypointDigest: DoubaoRecoverySha256;
  readonly executionConfigurationDigest: DoubaoRecoverySha256;
  readonly driverId: "doubao-real-provider-replay";
  readonly driverVersion: "doubao-harness-browser-bridge@2";
  readonly browserProfileDigest: DoubaoRecoverySha256;
  readonly driverImplementationDigest: DoubaoRecoverySha256;
  readonly driverConfigurationDigest: DoubaoRecoverySha256;
  readonly vendorTaskId: `task_${string}`;
  readonly taskStateVersion: "artifact_exported@4";
  readonly captureReceipt: TrustedDoubaoRecoveryReceipt;
  readonly rendererId: string;
  readonly derivativePipelineVersion: string;
  readonly slideDimensions: {
    readonly width: number;
    readonly height: number;
  };
  readonly contactSheetDimensions: {
    readonly width: number;
    readonly height: number;
  };
}

export const DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID =
  "doubao-volcano-20260727-real-provider-v1";

/**
 * This allowlist is executable harness policy, not evidence supplied by the
 * bundle being recovered. Adding or changing an entry therefore requires a
 * reviewed source revision and a newly frozen build identity.
 */
const TRUSTED_CHECKPOINTS = Object.freeze<
  readonly TrustedDoubaoRecoveryCheckpoint[]
>([
  Object.freeze({
    schemaVersion: "doubao-recovery-checkpoint-v1",
    checkpointId: DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
    purpose: "real_provider_recovery",
    artifactContentHash:
      "sha256:ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4",
    pageCount: 16,
    packageId: "doubao-web-ppt-real-provider-replay-v1",
    adapterVersion: "doubao-web-ppt@1",
    adapterImplementationDigest:
      "sha256:2955c7083ebfb19e9cd17600eb8e4c1c1feafc0c6f1ae238d849fdc9d078f9a4",
    executionEntrypointDigest:
      "sha256:6535ea0103cec7f348239cf567107d1ff6effdac238b2ff3a47b8cd7fd774957",
    executionConfigurationDigest:
      "sha256:e8c192eb9e1213aba734425bd93f8f04526d8b3495b07b26cd2febac0a50f43e",
    driverId: "doubao-real-provider-replay",
    driverVersion: "doubao-harness-browser-bridge@2",
    browserProfileDigest:
      "sha256:c6e451e70a930e80e799843cd8b1576d2bcaf47eb59c33ea1767e009fd599222",
    driverImplementationDigest:
      "sha256:2955c7083ebfb19e9cd17600eb8e4c1c1feafc0c6f1ae238d849fdc9d078f9a4",
    driverConfigurationDigest:
      "sha256:b79c9b95ad7e8180ee67ff1cc5554f604ec748871e71cc8da2b3334cd5310f7b",
    vendorTaskId: "task_38435879568317954",
    taskStateVersion: "artifact_exported@4",
    captureReceipt: Object.freeze({
      captureId: "doubao-volcano-20260727-1845",
      artifactContentHash:
        "sha256:ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4",
      traceDigest:
        "sha256:594d9b94d81d98e4b8a1986db7353f6852ac17201076d85e5d6f64df505d40ad",
      retainedPageDigest:
        "sha256:8f9453b0cf3b88525d2ad69d7f0d854efd24cc7e86108fcafb82727912b46c3f",
      renderDigest:
        "sha256:047f33568528b87be6abc3ce17898fdb98d36ed5f38742eed3d4b05db7e26826",
    }),
    rendererId: "doubao-retained-real-png-renderer-v1",
    derivativePipelineVersion:
      "doubao-retained-real-png-renderer-v1",
    slideDimensions: Object.freeze({ width: 1600, height: 900 }),
    contactSheetDimensions: Object.freeze({
      width: 1280,
      height: 720,
    }),
  }),
]);

export function trustedDoubaoRecoveryCheckpoint(
  checkpointId: string,
): TrustedDoubaoRecoveryCheckpoint {
  const checkpoint = TRUSTED_CHECKPOINTS.find(
    (candidate) => candidate.checkpointId === checkpointId,
  );
  if (checkpoint === undefined) {
    throw new Error(
      "Doubao recovery checkpoint is not present in the harness-owned allowlist",
    );
  }
  return checkpoint;
}
