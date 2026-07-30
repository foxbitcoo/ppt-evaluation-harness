import type {
  ApprovedEgressAuthorization,
} from "./egress-authorization.ts";

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
  readonly artifactManifestAttestedPayloadHash?: DoubaoRecoverySha256;
  readonly renderManifestAttestedPayloadHash?: DoubaoRecoverySha256;
  readonly runSpecificationCanonicalHash?: DoubaoRecoverySha256;
  readonly runnerCodeDigest?: DoubaoRecoverySha256;
  readonly evaluatedSpecCommitSha: string;
  readonly evaluatedBuildIdentitySource:
    "EMBEDDED_VERIFIED_BUILD_MANIFEST";
  readonly rendererAuthorizationDecision:
    ApprovedEgressAuthorization;
  readonly rendererAuthorizationAuditDigest: DoubaoRecoverySha256;
  readonly checkpointTraceHash: DoubaoRecoverySha256;
  readonly caseId: "volcano-query-v1";
  readonly caseVersion: 1;
  readonly caseContentHash: DoubaoRecoverySha256;
  readonly vendorPromptHash: DoubaoRecoverySha256;
  readonly track: "query_generation";
  readonly protocolId: "production-query-default-cost-v1";
  readonly referencePackMode: "off";
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
    artifactManifestAttestedPayloadHash:
      "sha256:1697e0128db2880c3bf7de7dc7fc03d376582d0bc16b3e293fbe68229c12a53a",
    renderManifestAttestedPayloadHash:
      "sha256:6daf8702f7007148336931dca858f1b01dc288832545f9ae5bf534a3be2c32f0",
    runSpecificationCanonicalHash:
      "sha256:4ede5e5c3f8b3ce1e17163658d742004fd7436136b715f6046689bef2c872b3b",
    runnerCodeDigest:
      "sha256:ba691d59c346eb96f2cd68ba5d54bde341ffe0f2f4486aa3f765056d60732b18",
    evaluatedSpecCommitSha:
      "fb08a1096bad8e63f33c27bd6add40e0ee6c792c",
    evaluatedBuildIdentitySource:
      "EMBEDDED_VERIFIED_BUILD_MANIFEST",
    rendererAuthorizationDecision: Object.freeze({
      status: "approved",
      decisionId: "doubao-replay:b7b30a5f6730e1de522c6164",
      policyVersion: "doubao-real-provider-replay-ingest-v1",
      request: Object.freeze({
        requestId:
          "artifact-rendering:artifact-doubao-ca1235d230e2b61ce083bebadaeaa5e4",
        jobId: "production-job-volcano-wps-v1",
        runId:
          "production-replay-run-doubao-web-ppt-real-provider-rep-d77ffcfc6c17d7cf2ad9e9a7972fce90-volcano-v1",
        attemptId:
          "production-replay-run-doubao-web-ppt-real-provider-rep-d77ffcfc6c17d7cf2ad9e9a7972fce90-volcano-v1-attempt-1",
        dataClassification: "public_or_synthetic",
        sourceOwner: "ppt-evaluation-harness",
        processingPurpose: "artifact_rendering",
        targetKind: "renderer",
        targetService: "isolated-offline-png-rasterizer",
        targetAccount: "local-sandbox",
        targetRegion: "local",
        subprocessors: Object.freeze([]),
        contentFields: Object.freeze(["artifact_binary"]),
        payloadHash:
          "sha256:ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4",
        requiredRedactions: Object.freeze([]),
        requestedAt: "2026-07-30T15:40:45.090Z",
      }),
      legalSecurityBasis:
        "authorized retained real-provider capture ingest",
      approvedAt: "2026-07-30T15:40:45.090Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    rendererAuthorizationAuditDigest:
      "sha256:1ed43314b7d5a8c0c99a05cd300fc388b56de95a36347563839e77d470317315",
    checkpointTraceHash:
      "sha256:f2b51f7de6b15d9676ee3d345ba406be0f7aeb42a10443e2c0d562fe2508ca0d",
    caseId: "volcano-query-v1",
    caseVersion: 1,
    caseContentHash:
      "sha256:9c2f70e0ef3d5413a0d527475dfd03f29c5feabe17cf719013e2d83af193be18",
    vendorPromptHash:
      "sha256:39fec395e6904ca10346a86b85ecae57a35a9196e9897ccab7fe2ab30ccb6ba4",
    track: "query_generation",
    protocolId: "production-query-default-cost-v1",
    referencePackMode: "off",
    pageCount: 16,
    packageId: "doubao-web-ppt-real-provider-replay-v1",
    adapterVersion: "doubao-web-ppt@1",
    adapterImplementationDigest:
      "sha256:2317479ba1044dba3f3989b33445924bb5f6456b11d11dc56c0525403e1b7c6a",
    executionEntrypointDigest:
      "sha256:981d718e15bfa3edfdc636672d96f70f3b169e302625d8b790283c1d13072429",
    executionConfigurationDigest:
      "sha256:e8c192eb9e1213aba734425bd93f8f04526d8b3495b07b26cd2febac0a50f43e",
    driverId: "doubao-real-provider-replay",
    driverVersion: "doubao-harness-browser-bridge@2",
    browserProfileDigest:
      "sha256:c6e451e70a930e80e799843cd8b1576d2bcaf47eb59c33ea1767e009fd599222",
    driverImplementationDigest:
      "sha256:2317479ba1044dba3f3989b33445924bb5f6456b11d11dc56c0525403e1b7c6a",
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
