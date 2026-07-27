import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BUILD_SPEC_COMMIT_SHA,
  BUILD_IDENTITY_SOURCE,
  FileSystemAttemptCheckpointStore,
  FileSystemImmutableBlobStore,
  InMemoryArtifactCaptureJournal,
  InMemoryEgressAuthorizationAudit,
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  VOLCANO_EVALUATION_CASE,
  WpsAiPptProductAdapter,
  createArtifactVault,
  createRunSpecificationVault,
  parseAdapterExecutionConfiguration,
  registeredWpsAiPptBrowserDriverEvidence,
  resolveWpsAiPptProductAdapterExecutor,
  type EgressAuthorizationPort,
} from "../src/index.ts";
import { createAuthorizedSafeRasterManifest } from "../src/safe-raster.ts";

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const [pptxPath, slidesDirectory, durableRoot] = process.argv.slice(2);
if (
  pptxPath === undefined ||
  slidesDirectory === undefined ||
  durableRoot === undefined
) {
  throw new Error(
    "Usage: rehearse-wps-recovery <pptx> <slides-directory> <durable-root>",
  );
}

const tombstones = new InMemoryTombstoneLedger();
const inventory = new InMemoryPayloadInventory(tombstones);
const audit = new InMemoryEgressAuthorizationAudit();
const authorization: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `recovery-smoke-approved:${request.requestId}`,
      policyVersion: "local-durable-recovery-smoke-v1",
      request,
      legalSecurityBasis: "authorized local recovery rehearsal",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
};
const primary = new FileSystemImmutableBlobStore({
  storeId: "wps-smoke-artifact-primary-v1",
  rootPath: join(durableRoot, "artifact-primary"),
  tombstones,
});
const secondary = new FileSystemImmutableBlobStore({
  storeId: "wps-smoke-artifact-recovery-v1",
  rootPath: join(durableRoot, "artifact-recovery"),
  tombstones,
});
const runSpecificationStore = new FileSystemImmutableBlobStore({
  storeId: "wps-smoke-run-spec-recovery-v1",
  rootPath: join(durableRoot, "run-spec-recovery"),
  tombstones,
});
const artifactVault = createArtifactVault({
  primary,
  secondary,
  egressAuthorization: authorization,
  egressAudit: audit,
  captureJournal: new InMemoryArtifactCaptureJournal(
    "wps-smoke-capture-journal-v1",
  ),
  payloadInventory: inventory,
});
const runSpecificationVault = createRunSpecificationVault({
  store: runSpecificationStore,
  egressAuthorization: authorization,
  egressAudit: audit,
  payloadInventory: inventory,
});

const pptx = Uint8Array.from(await readFile(pptxPath));
const artifactHash = sha256(pptx);
const artifact = Object.freeze({
  artifactId: `production-wps-volcano-${artifactHash.slice(7, 23)}`,
  runId: "production-run-wps-volcano-recovery-v1",
  provenance: "PRODUCTION" as const,
  environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
  filename: "wps-volcano-16.pptx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  byteSize: pptx.byteLength,
  pageCount: 16,
  contentHash: artifactHash,
  capturedAt: "2026-07-27T06:02:01.000Z",
  content: pptx,
});
const slideBytes = await Promise.all(
  Array.from({ length: 16 }, async (_, index) =>
    Uint8Array.from(
      await readFile(
        join(
          slidesDirectory,
          `slide-${String(index + 1).padStart(2, "0")}.png`,
        ),
      ),
    ),
  ),
);
const renderManifest = await createAuthorizedSafeRasterManifest({
  artifact,
  renderManifestId: `${artifact.artifactId}-render`,
  rendererAuthorizationDecisionId:
    "recovery-smoke-retained-render-authorized",
  candidate: {
    renderer: "libreoffice-impress+pdftoppm@recovery-smoke",
    fontPack: "local-observed",
    resolution: "retained-native-size",
    colorProfile: "sRGB",
    renderOutcome: "degraded",
    fidelity: {
      status: "degraded",
      notes: ["retained local render substituted or omitted Chinese glyphs"],
    },
    slides: slideBytes.map((content, index) => ({
      pageNumber: index + 1,
      filename: `slide-${String(index + 1).padStart(2, "0")}.png`,
      mimeType: "image/png",
      content,
      extractedText: `retained WPS page ${index + 1}`,
    })),
    contactSheet: {
      filename: "contact-sheet-evidence.png",
      mimeType: "image/png",
      content: slideBytes[0]!,
    },
  },
});
const manifest = await artifactVault.capture({
  jobId: "production-job-volcano-wps-recovery-v1",
  dataClassification: "public_or_synthetic",
  sourceOwner: "ppt-evaluation",
  artifact,
  renderManifest,
});
const recovered = await artifactVault.readFromSecondary(manifest);
if (
  sha256(recovered.original) !== artifact.contentHash ||
  recovered.derivatives.length !== manifest.derivatives.length
) {
  throw new Error("Artifact recovery rehearsal did not reproduce the package");
}

const adapter = new WpsAiPptProductAdapter();
const executionConfiguration = parseAdapterExecutionConfiguration(
  adapter.executionConfigurationPackage,
);
const execution = resolveWpsAiPptProductAdapterExecutor(
  adapter.implementationPackage,
  executionConfiguration,
  undefined,
);
const runSpecificationReference = await runSpecificationVault.capture({
  jobId: "production-job-volcano-wps-recovery-v1",
  runId: artifact.runId,
  specCommitSha: BUILD_SPEC_COMMIT_SHA,
  evaluationCase: VOLCANO_EVALUATION_CASE,
  productPackage: adapter.productPackage,
  protocolSnapshot: {
    protocolId: "production-query-default-cost-v1",
    referencePackMode: "automatic",
    timeoutMs: 30 * 60 * 1_000,
    retryPolicy: "one_if_provably_not_submitted",
    resultSelectionPolicy: "first_policy_compliant_artifact",
    cancellationPolicy: "independent_vendor_runs_continue",
  },
  adapterImplementationPackage: adapter.implementationPackage,
  adapterExecutionEntrypointDigest: sha256(
    new TextEncoder().encode(execution.toString()),
  ),
  adapterExecutionConfigurationPackage:
    adapter.executionConfigurationPackage,
  browserDriverEvidence:
    registeredWpsAiPptBrowserDriverEvidence(undefined),
});
const recoveredRunSpecification =
  await runSpecificationVault.read(runSpecificationReference);
if (
  recoveredRunSpecification.specCommitSha !== BUILD_SPEC_COMMIT_SHA ||
  recoveredRunSpecification.runId !== artifact.runId
) {
  throw new Error("Run Specification recovery rehearsal failed");
}
const checkpointStore = new FileSystemAttemptCheckpointStore({
  checkpointStoreId: "wps-smoke-checkpoints-v1",
  rootPath: join(durableRoot, "attempt-checkpoints"),
});
const checkpointAttemptId = "production-attempt-wps-recovery-v1";
await checkpointStore.append({
  eventId: `${checkpointAttemptId}-recovery-marker-1`,
  jobId: "production-job-volcano-wps-recovery-v1",
  caseId: VOLCANO_EVALUATION_CASE.caseId,
  runId: artifact.runId,
  attemptId: checkpointAttemptId,
  attemptSeq: 1,
  eventType: "historical_capture_recovery_marker",
  sourceAt: "2026-07-27T06:02:01.000Z",
  observedAt: "2026-07-27T06:02:01.000Z",
  writerId: "recovery-rehearsal@1",
  evidenceRef: "ev_00000000000000a3",
  sourceUrl: null,
  submissionEvidenceAtCheckpoint: "unknown",
  vendorTaskId: null,
  taskStateVersion: null,
  adapterVersion: "wps-aippt-browser@1",
  artifactId: artifact.artifactId,
});
const recoveredCheckpoints =
  await checkpointStore.readAttempt(checkpointAttemptId);
if (recoveredCheckpoints.length !== 1) {
  throw new Error("Checkpoint recovery rehearsal failed");
}

const recoveryPayloadLocations = manifest.payloadLocations.filter(
  ({ copyRole, key }) =>
    copyRole === "secondary" &&
    (key.endsWith("/original") || key.endsWith("/manifest")),
);

process.stdout.write(
  `${JSON.stringify(
    {
      artifactContentHash: artifact.contentHash,
      artifactManifestHash: manifest.manifestHash,
      artifactIdentityHash: manifest.artifactIdentityHash,
      renderManifestHash: renderManifest.contentHash,
      derivativeCount: manifest.derivatives.length,
      recoveredOriginalHash: sha256(recovered.original),
      recoveredDerivativeCount: recovered.derivatives.length,
      artifactStorageProfile: artifactVault.storageProfile,
      artifactRecoveryPayloadLocations: recoveryPayloadLocations,
      runSpecificationHash: runSpecificationReference.contentHash,
      runSpecificationStorageProfile:
        runSpecificationVault.storageProfile,
      runSpecificationRecoveryLocation:
        runSpecificationVault.retentionLocation(
          runSpecificationReference,
        ),
      checkpointStorageProfile: {
        durability: checkpointStore.durability,
        checkpointStoreId: checkpointStore.checkpointStoreId,
        recoveryReferencePrefix:
          checkpointStore.recoveryReferencePrefix,
        attemptReference: `${checkpointStore.recoveryReferencePrefix}:${checkpointAttemptId}`,
        recoveredCheckpointCount: recoveredCheckpoints.length,
        evidenceKind: "historical_capture_recovery_marker",
      },
      buildSpecCommitSha: BUILD_SPEC_COMMIT_SHA,
      buildIdentitySource: BUILD_IDENTITY_SOURCE,
    },
    null,
    2,
  )}\n`,
);
