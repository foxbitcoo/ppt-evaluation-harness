export type WpsRecoverySha256 = `sha256:${string}`;

export interface TrustedWpsRecoveryCheckpoint {
  readonly schemaVersion: "wps-recovery-checkpoint-v1";
  readonly checkpointId:
    "wps-real-provider-20260728-round5-resolution-final";
  readonly purpose: "real_provider_recovery";
  readonly registryId:
    "wps-real-provider-20260728-round5-resolution-final";
  readonly registryHash: WpsRecoverySha256;
  readonly rootReferences: {
    readonly artifactRecovery: "root:wps-replay-artifact-recovery";
    readonly runSpecification: "root:wps-replay-run-specification";
    readonly checkpoint: "root:wps-replay-checkpoint";
  };
  readonly storeIds: {
    readonly artifact: "wps-replay-artifact-recovery-v3";
    readonly runSpecification: "wps-replay-run-specification-v3";
    readonly checkpoint: "wps-replay-checkpoints-v3";
  };
  readonly keys: {
    readonly manifest: string;
    readonly original: string;
    readonly runSpecification: string;
  };
  readonly jobId: "production-job-volcano-wps-v1";
  readonly caseId: "volcano-query-v1";
  readonly runId: string;
  readonly attemptId: string;
  readonly artifactId: string;
  readonly providerArtifactReference:
    "artifact_wps_retained_real_capture";
  readonly artifactManifestCanonicalHash: WpsRecoverySha256;
  readonly artifactContentHash: WpsRecoverySha256;
  readonly renderManifestCanonicalHash: WpsRecoverySha256;
  readonly runSpecificationCanonicalHash: WpsRecoverySha256;
  readonly checkpointCanonicalHash: WpsRecoverySha256;
  readonly persistedCheckpointTraceHash: WpsRecoverySha256;
  readonly evaluatedSpecCommitSha: string;
  readonly evaluatedBuildIdentitySource:
    "EMBEDDED_VERIFIED_BUILD_MANIFEST";
  readonly runnerCodeDigest: WpsRecoverySha256;
  readonly packageId:
    "wps-aippt-real-provider-replay-v1";
  readonly adapterVersion: "wps-aippt-browser@1";
  readonly driverId: "wps-aippt-real-provider-replay";
  readonly driverVersion: "wps-aippt-harness-browser-bridge@2";
  readonly browserProfileDigest: WpsRecoverySha256;
  readonly driverImplementationDigest: WpsRecoverySha256;
  readonly driverConfigurationDigest: WpsRecoverySha256;
  readonly rendererId: "wps-retained-real-png-renderer-v3";
  readonly derivativePipelineVersion:
    "wps-retained-real-png-renderer-v3";
  readonly vendorTaskId:
    "task_wps_real_capture_20260727";
  readonly taskStateVersion: "artifact_ready@6";
  readonly captureReceipt: {
    readonly captureId:
      "wps-real-provider-20260728-round5-resolution-final";
    readonly artifactContentHash: WpsRecoverySha256;
    readonly traceDigest: WpsRecoverySha256;
    readonly retainedPageDigest: WpsRecoverySha256;
    readonly renderDigest: WpsRecoverySha256;
    readonly packageIdentityDigest: WpsRecoverySha256;
  };
}

const RUN_ID =
  "production-replay-run-wps-aippt-real-provider-replay-v-97e08cde980732ac5f86c80cdedfd618-volcano-v1";
const ATTEMPT_ID = `${RUN_ID}-attempt-1`;
const ARTIFACT_ID =
  `${ATTEMPT_ID}-artifact-c87cf5bd16ee81eb`;

/**
 * Executable verifier policy, not evidence accepted from a recovery bundle.
 * Any change requires source review and a newly frozen build identity.
 */
const TRUSTED_WPS_RECOVERY_CHECKPOINT = Object.freeze({
  schemaVersion: "wps-recovery-checkpoint-v1",
  checkpointId:
    "wps-real-provider-20260728-round5-resolution-final",
  purpose: "real_provider_recovery",
  registryId:
    "wps-real-provider-20260728-round5-resolution-final",
  registryHash:
    "sha256:568a29b089eb2e42bd851b2a9809965a6e900507722c5005a75744156a782961",
  rootReferences: Object.freeze({
    artifactRecovery: "root:wps-replay-artifact-recovery",
    runSpecification: "root:wps-replay-run-specification",
    checkpoint: "root:wps-replay-checkpoint",
  }),
  storeIds: Object.freeze({
    artifact: "wps-replay-artifact-recovery-v3",
    runSpecification: "wps-replay-run-specification-v3",
    checkpoint: "wps-replay-checkpoints-v3",
  }),
  keys: Object.freeze({
    manifest: `artifacts/${ARTIFACT_ID}/manifest`,
    original: `artifacts/${ARTIFACT_ID}/original`,
    runSpecification:
      "run-specifications/9a3854edf425d138231c8720b3327ca774d509f40813c0bbe965203b9aa9a2b5",
  }),
  jobId: "production-job-volcano-wps-v1",
  caseId: "volcano-query-v1",
  runId: RUN_ID,
  attemptId: ATTEMPT_ID,
  artifactId: ARTIFACT_ID,
  providerArtifactReference:
    "artifact_wps_retained_real_capture",
  artifactManifestCanonicalHash:
    "sha256:efbff20e5ea103cdce12a52cab398d9b91672972f4254eec03a0d13842bae8ca",
  artifactContentHash:
    "sha256:c87cf5bd16ee81ebd72bd2e1df9705e4336576d5f6976323de3925d886b54e86",
  renderManifestCanonicalHash:
    "sha256:7585511f9d4f166a817e19c8d8b599888fef702a5b574b942a82d9b2cd6232e2",
  runSpecificationCanonicalHash:
    "sha256:9a3854edf425d138231c8720b3327ca774d509f40813c0bbe965203b9aa9a2b5",
  checkpointCanonicalHash:
    "sha256:5a1b1013a2e4075b75fdc0f54b8dfdb0d1b6bcee544b48f44dc10765e0b33f79",
  persistedCheckpointTraceHash:
    "sha256:4d28f5a44ed4ba86d559592a366c410943ca72f152b6b63fd2e0819ae5509341",
  evaluatedSpecCommitSha:
    "28c1ec3dfe04cb8b5355311d42e9f2307eb918b1",
  evaluatedBuildIdentitySource:
    "EMBEDDED_VERIFIED_BUILD_MANIFEST",
  runnerCodeDigest:
    "sha256:fa1f23f2b65b9ec6455e353ea6d5d45f11c16bcf752180a586454b0941a937be",
  packageId: "wps-aippt-real-provider-replay-v1",
  adapterVersion: "wps-aippt-browser@1",
  driverId: "wps-aippt-real-provider-replay",
  driverVersion: "wps-aippt-harness-browser-bridge@2",
  browserProfileDigest:
    "sha256:6727dc789ca0a86a76dfa9020b4dfaa703902acf8786b905a781314bafcf7065",
  driverImplementationDigest:
    "sha256:3f800e6a946de10b9e5664113c6ad107fe0820150f679e4d8b603138d7b99e96",
  driverConfigurationDigest:
    "sha256:6c864a83e2dadc4f4b9adb7a8bc5981f9a627417993f3eed88f7de552f21cd5f",
  rendererId: "wps-retained-real-png-renderer-v3",
  derivativePipelineVersion:
    "wps-retained-real-png-renderer-v3",
  vendorTaskId: "task_wps_real_capture_20260727",
  taskStateVersion: "artifact_ready@6",
  captureReceipt: Object.freeze({
    captureId:
      "wps-real-provider-20260728-round5-resolution-final",
    artifactContentHash:
      "sha256:c87cf5bd16ee81ebd72bd2e1df9705e4336576d5f6976323de3925d886b54e86",
    traceDigest:
      "sha256:4476b77bca87f6487296fc091c524a20de6f5b021c9541572b1512d074771df0",
    retainedPageDigest:
      "sha256:ef89bf6b7d58020fca3045b2a819781e8e5d42f3d3085a3bed00ea06e7568387",
    renderDigest:
      "sha256:846a0ab1b828ffff54ec4288e27e9d332c6e48046bdb0bf83870cd71e9143163",
    packageIdentityDigest:
      "sha256:3960d4ff788421be816b69925092236f659f8e3623190bab7772172ab65d5467",
  }),
}) satisfies TrustedWpsRecoveryCheckpoint;

export function trustedWpsRecoveryCheckpoint(
  checkpointId: string,
): TrustedWpsRecoveryCheckpoint {
  if (checkpointId !== TRUSTED_WPS_RECOVERY_CHECKPOINT.checkpointId) {
    throw new Error(
      `Untrusted WPS recovery checkpoint: ${checkpointId}`,
    );
  }
  return TRUSTED_WPS_RECOVERY_CHECKPOINT;
}
