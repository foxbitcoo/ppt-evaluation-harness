import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
  FileSystemAttemptCheckpointStore,
  FileSystemImmutableBlobStore,
  BUILD_SPEC_COMMIT_SHA,
  calculateArtifactDerivativeSetHash,
  canonicalJsonBytes,
  loadDurableRootRegistry,
  resolveDurableRoot,
  trustedDoubaoRecoveryCheckpoint,
  type TrustedDoubaoRecoveryCheckpoint,
} from "../src/index.ts";
import { validatedSafePngDimensions } from "../src/safe-raster.ts";
import {
  validatedOpenXmlPresentationSlideNames,
} from "../src/wps-aippt.ts";

type JsonRecord = Record<string, unknown>;
type Sha256 = `sha256:${string}`;

export interface DoubaoProductionRecoveryCommand {
  readonly registryId: string;
  readonly artifactRecoveryRootReference: string;
  readonly runSpecificationRootReference: string;
  readonly checkpointRootReference: string;
  readonly artifactStoreId: string;
  readonly manifestKey: string;
  readonly originalKey: string;
  readonly runSpecificationStoreId: string;
  readonly runSpecificationKey: string;
  readonly checkpointStoreId: string;
  readonly attemptId: string;
}

interface ValidatedDerivative {
  readonly derivativeId: string;
  readonly sourceArtifactId: string;
  readonly derivativeType:
    | "static_slide"
    | "extracted_text"
    | "contact_sheet";
  readonly pageNumber: number | null;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHash: Sha256;
  readonly pipelineVersion: string;
}

interface ValidatedReceipt {
  readonly captureId: string;
  readonly artifactContentHash: Sha256;
  readonly traceDigest: Sha256;
  readonly retainedPageDigest: Sha256;
  readonly renderDigest: Sha256;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const hash = (content: Uint8Array): Sha256 =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;
const RECEIPT_KEYS = Object.freeze([
  "captureId",
  "artifactContentHash",
  "traceDigest",
  "retainedPageDigest",
  "renderDigest",
]);
const ARTIFACT_KEYS = Object.freeze([
  "artifactId",
  "runId",
  "contentHash",
  "mimeType",
  "byteSize",
  "pageCount",
  "capturedAt",
  "filename",
]);
const DERIVATIVE_KEYS = Object.freeze([
  "derivativeId",
  "sourceArtifactId",
  "derivativeType",
  "pageNumber",
  "filename",
  "mimeType",
  "byteSize",
  "contentHash",
  "pipelineVersion",
]);
const EXECUTION_EVIDENCE_KEYS = Object.freeze([
  "executionMode",
  "captureSource",
  "driverSessionId",
  "driverVersion",
  "adapterVersion",
  "outcome",
  "vendorTaskId",
  "taskStateVersion",
  "artifactContentHash",
  "rasterManifestHash",
  "traceHash",
  "captureReceipt",
]);
const EVALUATION_CASE_KEYS = Object.freeze([
  "audience",
  "caseId",
  "caseVersion",
  "dataClassification",
  "environmentOrigin",
  "provenance",
  "readingMode",
  "recordId",
  "sourceOwner",
  "targetPageCount",
  "title",
  "track",
  "vendorPrompt",
]);
const PROTOCOL_KEYS = Object.freeze([
  "cancellationPolicy",
  "protocolId",
  "referencePackMode",
  "resultSelectionPolicy",
  "retryPolicy",
  "timeoutMs",
]);
const BROWSER_EVIDENCE_KEYS = Object.freeze([
  "browserProfileDigest",
  "captureReceipt",
  "captureSource",
  "configurationDigest",
  "driverId",
  "driverVersion",
  "implementationDigest",
  "provenance",
]);
const ENVIRONMENT_ORIGIN_KEYS = Object.freeze([
  "environment",
  "originId",
]);
const EGRESS_DESTINATION_KEYS = Object.freeze([
  "subprocessors",
  "targetAccount",
  "targetRegion",
  "targetService",
]);
const RENDER_SLIDE_KEYS = Object.freeze([
  "pageNumber",
  "contentHash",
  "filename",
  "mimeType",
  "extractedTextHash",
]);
const CONTACT_SHEET_KEYS = Object.freeze([
  "contentHash",
  "filename",
  "mimeType",
]);

function record(value: unknown, label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`Durable Doubao recovery ${label} schema is invalid`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  allowedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `Durable Doubao recovery ${label} schema contains an unexpected field`,
    );
  }
}

function json(bytes: Uint8Array, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`Durable Doubao recovery ${label} JSON is invalid`);
  }
  return record(parsed, label);
}

function text(
  value: unknown,
  label: string,
  expected?: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (expected !== undefined && value !== expected)
  ) {
    throw new Error(`Durable Doubao recovery ${label} schema is invalid`);
  }
  return value;
}

function sha(value: unknown, label: string): Sha256 {
  const result = text(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) {
    throw new Error(`Durable Doubao recovery ${label} schema is invalid`);
  }
  return result as Sha256;
}

function integer(value: unknown, label: string, expected?: number): number {
  if (
    !Number.isInteger(value) ||
    (expected !== undefined && value !== expected)
  ) {
    throw new Error(`Durable Doubao recovery ${label} schema is invalid`);
  }
  return value as number;
}

function iso(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  ) {
    throw new Error(`Durable Doubao recovery ${label} schema is invalid`);
  }
  return result;
}

function receipt(value: unknown, label: string): ValidatedReceipt {
  const candidate = record(value, label);
  exactKeys(candidate, RECEIPT_KEYS, label);
  return Object.freeze({
    captureId: text(candidate.captureId, `${label}.captureId`),
    artifactContentHash: sha(
      candidate.artifactContentHash,
      `${label}.artifactContentHash`,
    ),
    traceDigest: sha(candidate.traceDigest, `${label}.traceDigest`),
    retainedPageDigest: sha(
      candidate.retainedPageDigest,
      `${label}.retainedPageDigest`,
    ),
    renderDigest: sha(candidate.renderDigest, `${label}.renderDigest`),
  });
}

function sameReceipt(
  left: ValidatedReceipt,
  right: ValidatedReceipt,
): boolean {
  return (
    left.captureId === right.captureId &&
    left.artifactContentHash === right.artifactContentHash &&
    left.traceDigest === right.traceDigest &&
    left.retainedPageDigest === right.retainedPageDigest &&
    left.renderDigest === right.renderDigest
  );
}

function normalizedProductionTaskId(rawVendorTaskId: string): string {
  return /^task_[a-z0-9_-]+$/i.test(rawVendorTaskId)
    ? rawVendorTaskId
    : `task_${createHash("sha256")
        .update(rawVendorTaskId)
        .digest("hex")
        .slice(0, 32)}`;
}

export async function validateDoubaoRecoveryStoresAgainstCheckpoint(
  command: DoubaoProductionRecoveryCommand,
  trustedCheckpoint: TrustedDoubaoRecoveryCheckpoint,
) {
const {
  registryId,
  artifactRecoveryRootReference,
  runSpecificationRootReference,
  checkpointRootReference,
  artifactStoreId,
  manifestKey,
  originalKey,
  runSpecificationStoreId,
  runSpecificationKey,
  checkpointStoreId,
  attemptId,
} = command;
const registry = await loadDurableRootRegistry(registryId);
const artifactStore = new FileSystemImmutableBlobStore({
  storeId: artifactStoreId,
  rootPath: resolveDurableRoot(
    registry,
    artifactRecoveryRootReference,
  ),
});
const runSpecificationStore = new FileSystemImmutableBlobStore({
  storeId: runSpecificationStoreId,
  rootPath: resolveDurableRoot(
    registry,
    runSpecificationRootReference,
  ),
});
const checkpointStore = new FileSystemAttemptCheckpointStore({
  checkpointStoreId,
  rootPath: resolveDurableRoot(registry, checkpointRootReference),
});
const [manifest, original, runSpecification, checkpoints] =
  await Promise.all([
    artifactStore.read(manifestKey),
    artifactStore.read(originalKey),
    runSpecificationStore.read(runSpecificationKey),
    checkpointStore.readAttempt(attemptId),
  ]);
if (
  manifest === null ||
  original === null ||
  runSpecification === null ||
  checkpoints.length === 0
) {
  throw new Error("Durable Doubao recovery payload is incomplete");
}

const manifestIdentity = json(manifest, "Artifact manifest");
exactKeys(
  manifestIdentity,
  trustedCheckpoint.purpose === "real_provider_recovery"
    ? [
        "artifact",
        "derivatives",
        "fidelity",
        "jobId",
        "productionExecutionEvidence",
        "renderManifestHash",
        "renderManifestId",
        "renderOutcome",
        "schemaVersion",
      ]
    : [
        "artifact",
        "derivatives",
        "jobId",
        "productionExecutionEvidence",
        "renderManifestHash",
        "renderManifestId",
        "renderOutcome",
        "schemaVersion",
      ],
  "Artifact manifest",
);
text(
  manifestIdentity.schemaVersion,
  "Artifact manifest.schemaVersion",
  "artifact-package-identity-v1",
);
const jobId = text(manifestIdentity.jobId, "Artifact manifest.jobId");
const artifact = record(
  manifestIdentity.artifact,
  "Artifact manifest.artifact",
);
exactKeys(
  artifact,
  trustedCheckpoint.purpose === "real_provider_recovery"
    ? ARTIFACT_KEYS
    : [...ARTIFACT_KEYS, "provenance"],
  "Artifact manifest.artifact",
);
const artifactId = text(
  artifact.artifactId,
  "Artifact manifest.artifact.artifactId",
);
const runId = text(
  artifact.runId,
  "Artifact manifest.artifact.runId",
);
const artifactContentHash = sha(
  artifact.contentHash,
  "Artifact manifest.artifact.contentHash",
);
text(
  artifact.mimeType,
  "Artifact manifest.artifact.mimeType",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
);
integer(
  artifact.byteSize,
  "Artifact manifest.artifact.byteSize",
  original.byteLength,
);
integer(
  artifact.pageCount,
  "Artifact manifest.artifact.pageCount",
  16,
);
iso(artifact.capturedAt, "Artifact manifest.artifact.capturedAt");
text(artifact.filename, "Artifact manifest.artifact.filename");
if (trustedCheckpoint.purpose !== "real_provider_recovery") {
  text(
    artifact.provenance,
    "Artifact manifest.artifact.provenance",
    "PRODUCTION_REPLAY",
  );
}
if (trustedCheckpoint.purpose === "real_provider_recovery") {
  const fidelity = record(
    manifestIdentity.fidelity,
    "Artifact manifest.fidelity",
  );
  exactKeys(
    fidelity,
    ["notes", "status"],
    "Artifact manifest.fidelity",
  );
  text(
    fidelity.status,
    "Artifact manifest.fidelity.status",
    "degraded",
  );
  if (
    !Array.isArray(fidelity.notes) ||
    fidelity.notes.some((note) => typeof note !== "string")
  ) {
    throw new Error(
      "Durable Doubao recovery Artifact manifest.fidelity.notes schema is invalid",
    );
  }
}
const renderManifestId = text(
  manifestIdentity.renderManifestId,
  "Artifact manifest.renderManifestId",
);
const renderManifestHash = sha(
  manifestIdentity.renderManifestHash,
  "Artifact manifest.renderManifestHash",
);
text(
  manifestIdentity.renderOutcome,
  "Artifact manifest.renderOutcome",
  "degraded",
);
if (
  manifestKey !== `artifacts/${artifactId}/manifest` ||
  originalKey !== `artifacts/${artifactId}/original`
) {
  throw new Error(
    "Durable Doubao recovery manifest/original Artifact key lineage mismatch",
  );
}
const originalHash = hash(original);
if (artifactContentHash !== originalHash) {
  throw new Error("Durable Doubao recovery original Artifact hash mismatch");
}
const originalSlideNames =
  validatedOpenXmlPresentationSlideNames(original);
if (originalSlideNames.length !== 16) {
  throw new Error(
    "Durable Doubao recovery original Artifact is not a safe 16-page PPTX",
  );
}

const rawDerivatives = manifestIdentity.derivatives;
if (!Array.isArray(rawDerivatives) || rawDerivatives.length !== 33) {
  throw new Error(
    "Durable Doubao recovery Artifact manifest requires exactly 33 derivatives",
  );
}
const derivatives: ValidatedDerivative[] = rawDerivatives.map(
  (value, index) => {
    const candidate = record(
      value,
      `Artifact manifest.derivatives[${index}]`,
    );
    exactKeys(
      candidate,
      DERIVATIVE_KEYS,
      `Artifact manifest.derivatives[${index}]`,
    );
    const derivativeType = text(
      candidate.derivativeType,
      `Artifact manifest.derivatives[${index}].derivativeType`,
    );
    if (
      derivativeType !== "static_slide" &&
      derivativeType !== "extracted_text" &&
      derivativeType !== "contact_sheet"
    ) {
      throw new Error(
        "Durable Doubao recovery derivative kind schema is invalid",
      );
    }
    const pageNumber =
      candidate.pageNumber === null
        ? null
        : integer(
            candidate.pageNumber,
            `Artifact manifest.derivatives[${index}].pageNumber`,
          );
    return Object.freeze({
      derivativeId: text(
        candidate.derivativeId,
        `Artifact manifest.derivatives[${index}].derivativeId`,
      ),
      sourceArtifactId: text(
        candidate.sourceArtifactId,
        `Artifact manifest.derivatives[${index}].sourceArtifactId`,
      ),
      derivativeType,
      pageNumber,
      filename: text(
        candidate.filename,
        `Artifact manifest.derivatives[${index}].filename`,
      ),
      mimeType: text(
        candidate.mimeType,
        `Artifact manifest.derivatives[${index}].mimeType`,
      ),
      byteSize: integer(
        candidate.byteSize,
        `Artifact manifest.derivatives[${index}].byteSize`,
      ),
      contentHash: sha(
        candidate.contentHash,
        `Artifact manifest.derivatives[${index}].contentHash`,
      ),
      pipelineVersion: text(
        candidate.pipelineVersion,
        `Artifact manifest.derivatives[${index}].pipelineVersion`,
      ),
    });
  },
);
if (
  new Set(derivatives.map(({ derivativeId }) => derivativeId)).size !==
  33
) {
  throw new Error(
    "Durable Doubao recovery derivative IDs are incomplete or duplicated",
  );
}

const executionEvidence = record(
  manifestIdentity.productionExecutionEvidence,
  "Artifact manifest.productionExecutionEvidence",
);
exactKeys(
  executionEvidence,
  EXECUTION_EVIDENCE_KEYS,
  "Artifact manifest.productionExecutionEvidence",
);
text(
  executionEvidence.executionMode,
  "Artifact manifest.executionMode",
  "PRODUCTION_REPLAY",
);
text(
  executionEvidence.captureSource,
  "Artifact manifest.captureSource",
  "REAL_PROVIDER_CAPTURE",
);
const adapterVersion = text(
  executionEvidence.adapterVersion,
  "Artifact manifest.adapterVersion",
  "doubao-web-ppt@1",
);
text(
  executionEvidence.driverSessionId,
  "Artifact manifest.driverSessionId",
);
text(
  executionEvidence.driverVersion,
  "Artifact manifest.driverVersion",
  trustedCheckpoint.driverVersion,
);
text(
  executionEvidence.outcome,
  "Artifact manifest.outcome",
  "captured",
);
const manifestTraceHash = sha(
  executionEvidence.traceHash,
  "Artifact manifest.productionExecutionEvidence.traceHash",
);
const manifestVendorTaskId = text(
  executionEvidence.vendorTaskId,
  "Artifact manifest.vendorTaskId",
);
const manifestTaskStateVersion = text(
  executionEvidence.taskStateVersion,
  "Artifact manifest.taskStateVersion",
);
if (
  sha(
    executionEvidence.artifactContentHash,
    "Artifact manifest.execution artifact hash",
  ) !== artifactContentHash ||
  sha(
    executionEvidence.rasterManifestHash,
    "Artifact manifest.raster manifest hash",
  ) !== renderManifestHash
) {
  throw new Error(
    "Durable Doubao recovery Artifact execution evidence lineage mismatch",
  );
}
const manifestReceipt = receipt(
  executionEvidence.captureReceipt,
  "Artifact manifest.captureReceipt",
);

const runSpecificationBundle = json(
  runSpecification,
  "Run Specification",
);
exactKeys(
  runSpecificationBundle,
  trustedCheckpoint.purpose === "real_provider_recovery"
    ? [
        "adapterSpecification",
        "environmentEvidence",
        "estimatorSnapshot",
        "evaluationCase",
        "jobId",
        "productPackage",
        "protocolSnapshot",
        "rubricSnapshot",
        "runId",
        "runnerCodeEvidence",
        "runnerImageEvidence",
        "schemaSnapshot",
        "schemaVersion",
        "specCommitSha",
        "versionReferences",
      ]
    : [
        "adapterSpecification",
        "evaluationCase",
        "jobId",
        "productPackage",
        "protocolSnapshot",
        "runId",
        "schemaVersion",
        "specCommitSha",
        "versionReferences",
      ],
  "Run Specification",
);
text(
  runSpecificationBundle.schemaVersion,
  "Run Specification.schemaVersion",
  "run-specification-bundle-v1",
);
if (
  text(
    runSpecificationBundle.jobId,
    "Run Specification.jobId",
  ) !== jobId ||
  text(
    runSpecificationBundle.runId,
    "Run Specification.runId",
  ) !== runId
) {
  throw new Error(
    "Durable Doubao recovery Run Specification job/run lineage mismatch",
  );
}
text(
  runSpecificationBundle.specCommitSha,
  "Run Specification.specCommitSha",
  BUILD_SPEC_COMMIT_SHA,
);
const evaluationCase = record(
  runSpecificationBundle.evaluationCase,
  "Run Specification.evaluationCase",
);
exactKeys(
  evaluationCase,
  EVALUATION_CASE_KEYS,
  "Run Specification.evaluationCase",
);
const caseId = text(
  evaluationCase.caseId,
  "Run Specification.evaluationCase.caseId",
);
const caseVersion = integer(
  evaluationCase.caseVersion,
  "Run Specification.evaluationCase.caseVersion",
);
const vendorPrompt = text(
  evaluationCase.vendorPrompt,
  "Run Specification.evaluationCase.vendorPrompt",
);
const vendorPromptHash = hash(canonicalJsonBytes(vendorPrompt));
const caseContentHash = hash(canonicalJsonBytes(evaluationCase));
const versionReferences = record(
  runSpecificationBundle.versionReferences,
  "Run Specification.versionReferences",
);
exactKeys(
  versionReferences,
  trustedCheckpoint.purpose === "real_provider_recovery"
    ? [
        "adapterSpecificationHash",
        "adapterVersion",
        "caseContentHash",
        "caseVersion",
        "environmentEvidenceHash",
        "estimatorSnapshotHash",
        "productPackageContentHash",
        "productPackageVersion",
        "protocolSnapshotContentHash",
        "rubricSnapshotHash",
        "rubricVersion",
        "runnerCodeDigest",
        "runnerImageDigest",
        "runPolicyVersion",
        "schemaSnapshotHash",
        "schemaVersion",
      ]
    : ["caseContentHash"],
  "Run Specification.versionReferences",
);
if (
  sha(
    versionReferences.caseContentHash,
    "Run Specification.versionReferences.caseContentHash",
  ) !== caseContentHash
) {
  throw new Error(
    "Durable Doubao recovery Run Specification evaluation Case hash mismatch",
  );
}
const caseEnvironmentOrigin = record(
  evaluationCase.environmentOrigin,
  "Run Specification.evaluationCase.environmentOrigin",
);
exactKeys(
  caseEnvironmentOrigin,
  ENVIRONMENT_ORIGIN_KEYS,
  "Run Specification.evaluationCase.environmentOrigin",
);
text(
  caseEnvironmentOrigin.environment,
  "Run Specification.evaluationCase.environmentOrigin.environment",
  "production",
);
text(
  caseEnvironmentOrigin.originId,
  "Run Specification.evaluationCase.environmentOrigin.originId",
  "production:ppt-evaluation-v1",
);
text(
  evaluationCase.provenance,
  "Run Specification.evaluationCase.provenance",
  "PRODUCTION",
);
integer(
  evaluationCase.targetPageCount,
  "Run Specification.evaluationCase.targetPageCount",
  16,
);
const track = text(
  evaluationCase.track,
  "Run Specification.evaluationCase.track",
  "query_generation",
);
const protocolSnapshot = record(
  runSpecificationBundle.protocolSnapshot,
  "Run Specification.protocolSnapshot",
);
exactKeys(
  protocolSnapshot,
  PROTOCOL_KEYS,
  "Run Specification.protocolSnapshot",
);
const protocolId = text(
  protocolSnapshot.protocolId,
  "Run Specification.protocolSnapshot.protocolId",
);
const referencePackMode = text(
  protocolSnapshot.referencePackMode,
  "Run Specification.protocolSnapshot.referencePackMode",
);
integer(
  protocolSnapshot.timeoutMs,
  "Run Specification.protocolSnapshot.timeoutMs",
  1_800_000,
);
text(
  protocolSnapshot.retryPolicy,
  "Run Specification.protocolSnapshot.retryPolicy",
  "one_if_provably_not_submitted",
);
text(
  protocolSnapshot.resultSelectionPolicy,
  "Run Specification.protocolSnapshot.resultSelectionPolicy",
  "first_policy_compliant_artifact",
);
text(
  protocolSnapshot.cancellationPolicy,
  "Run Specification.protocolSnapshot.cancellationPolicy",
  "independent_vendor_runs_continue",
);
const productPackage = record(
  runSpecificationBundle.productPackage,
  "Run Specification.productPackage",
);
exactKeys(
  productPackage,
  trustedCheckpoint.purpose === "real_provider_recovery"
    ? [
        "adapterVersion",
        "displayName",
        "egressDestination",
        "environmentOrigin",
        "evaluationConfiguration",
        "packageId",
        "provenance",
        "vendorId",
      ]
    : [
        "adapterVersion",
        "packageId",
        "provenance",
        "vendorId",
      ],
  "Run Specification.productPackage",
);
const packageId = text(
  productPackage.packageId,
  "Run Specification.productPackage.packageId",
);
const vendorId = text(
  productPackage.vendorId,
  "Run Specification.productPackage.vendorId",
  "doubao",
);
if (
  text(
    productPackage.adapterVersion,
    "Run Specification.productPackage.adapterVersion",
  ) !== adapterVersion ||
  text(
    productPackage.provenance,
    "Run Specification.productPackage.provenance",
  ) !== "PRODUCTION_REPLAY"
) {
  throw new Error(
    "Durable Doubao recovery Run Specification package lineage mismatch",
  );
}
if (trustedCheckpoint.purpose === "real_provider_recovery") {
  const productEnvironmentOrigin = record(
    productPackage.environmentOrigin,
    "Run Specification.productPackage.environmentOrigin",
  );
  exactKeys(
    productEnvironmentOrigin,
    ENVIRONMENT_ORIGIN_KEYS,
    "Run Specification.productPackage.environmentOrigin",
  );
  const productEgress = record(
    productPackage.egressDestination,
    "Run Specification.productPackage.egressDestination",
  );
  exactKeys(
    productEgress,
    EGRESS_DESTINATION_KEYS,
    "Run Specification.productPackage.egressDestination",
  );
  if (
    !Array.isArray(productEgress.subprocessors) ||
    productEgress.subprocessors.length !== 0
  ) {
    throw new Error(
      "Durable Doubao recovery product egress subprocessors schema is invalid",
    );
  }
  const evaluationConfiguration = record(
    productPackage.evaluationConfiguration,
    "Run Specification.productPackage.evaluationConfiguration",
  );
  exactKeys(
    evaluationConfiguration,
    [
      "accountContext",
      "benchmarkProtocol",
      "entryUrl",
      "modelSelection",
      "networking",
      "purchasePolicy",
      "requestedPageCount",
    ],
    "Run Specification.productPackage.evaluationConfiguration",
  );
  integer(
    evaluationConfiguration.requestedPageCount,
    "Run Specification.productPackage.evaluationConfiguration.requestedPageCount",
    16,
  );
}
const adapterSpecification = record(
  runSpecificationBundle.adapterSpecification,
  "Run Specification.adapterSpecification",
);
exactKeys(
  adapterSpecification,
  trustedCheckpoint.purpose === "real_provider_recovery"
    ? [
        "adapterVersion",
        "browserDriverEvidence",
        "egressDestination",
        "executionConfiguration",
        "executionConfigurationDigest",
        "executionConfigurationPackageByteSize",
        "executionConfigurationPackageName",
        "executionEntrypointDigest",
        "implementationDigest",
        "implementationPackageByteSize",
        "implementationPackageName",
        "packageId",
        "vendorId",
      ]
    : [
        "adapterVersion",
        "browserDriverEvidence",
        "executionConfigurationDigest",
        "executionEntrypointDigest",
        "implementationDigest",
        "packageId",
        "vendorId",
      ],
  "Run Specification.adapterSpecification",
);
if (
  text(
    adapterSpecification.packageId,
    "Run Specification.adapterSpecification.packageId",
  ) !== packageId ||
  text(
    adapterSpecification.vendorId,
    "Run Specification.adapterSpecification.vendorId",
  ) !== vendorId ||
  text(
    adapterSpecification.adapterVersion,
    "Run Specification.adapterSpecification.adapterVersion",
  ) !== adapterVersion
) {
  throw new Error(
    "Durable Doubao recovery Run Specification adapter lineage mismatch",
  );
}
const adapterImplementationDigest = sha(
  adapterSpecification.implementationDigest,
  "Run Specification.adapterSpecification.implementationDigest",
);
const executionEntrypointDigest = sha(
  adapterSpecification.executionEntrypointDigest,
  "Run Specification.adapterSpecification.executionEntrypointDigest",
);
const executionConfigurationDigest = sha(
  adapterSpecification.executionConfigurationDigest,
  "Run Specification.adapterSpecification.executionConfigurationDigest",
);
const browserEvidence = record(
  adapterSpecification.browserDriverEvidence,
  "Run Specification.browserDriverEvidence",
);
exactKeys(
  browserEvidence,
  BROWSER_EVIDENCE_KEYS,
  "Run Specification.browserDriverEvidence",
);
const browserDriverId = text(
  browserEvidence.driverId,
  "Run Specification.browserDriverEvidence.driverId",
  "doubao-real-provider-replay",
);
text(
  browserEvidence.provenance,
  "Run Specification.browserDriverEvidence.provenance",
  "PRODUCTION_REPLAY",
);
text(
  browserEvidence.captureSource,
  "Run Specification.browserDriverEvidence.captureSource",
  "REAL_PROVIDER_CAPTURE",
);
const driverVersion = text(
  browserEvidence.driverVersion,
  "Run Specification.browserDriverEvidence.driverVersion",
);
const browserProfileDigest = sha(
  browserEvidence.browserProfileDigest,
  "Run Specification.browserDriverEvidence.browserProfileDigest",
);
const driverImplementationDigest = sha(
  browserEvidence.implementationDigest,
  "Run Specification.browserDriverEvidence.implementationDigest",
);
const driverConfigurationDigest = sha(
  browserEvidence.configurationDigest,
  "Run Specification.browserDriverEvidence.configurationDigest",
);
const runSpecificationReceipt = receipt(
  browserEvidence.captureReceipt,
  "Run Specification.captureReceipt",
);
if (trustedCheckpoint.purpose === "real_provider_recovery") {
  const adapterEgress = record(
    adapterSpecification.egressDestination,
    "Run Specification.adapterSpecification.egressDestination",
  );
  exactKeys(
    adapterEgress,
    EGRESS_DESTINATION_KEYS,
    "Run Specification.adapterSpecification.egressDestination",
  );
  if (
    !Array.isArray(adapterEgress.subprocessors) ||
    adapterEgress.subprocessors.length !== 0
  ) {
    throw new Error(
      "Durable Doubao recovery adapter egress subprocessors schema is invalid",
    );
  }
  const executionConfiguration = record(
    adapterSpecification.executionConfiguration,
    "Run Specification.adapterSpecification.executionConfiguration",
  );
  exactKeys(
    executionConfiguration,
    ["adapterKind", "scenario", "schemaVersion"],
    "Run Specification.adapterSpecification.executionConfiguration",
  );
  integer(
    adapterSpecification.executionConfigurationPackageByteSize,
    "Run Specification.adapterSpecification.executionConfigurationPackageByteSize",
  );
  integer(
    adapterSpecification.implementationPackageByteSize,
    "Run Specification.adapterSpecification.implementationPackageByteSize",
  );
  text(
    adapterSpecification.executionConfigurationPackageName,
    "Run Specification.adapterSpecification.executionConfigurationPackageName",
  );
  text(
    adapterSpecification.implementationPackageName,
    "Run Specification.adapterSpecification.implementationPackageName",
  );

  const environmentEvidence = record(
    runSpecificationBundle.environmentEvidence,
    "Run Specification.environmentEvidence",
  );
  exactKeys(
    environmentEvidence,
    [
      "architecture",
      "environmentOriginId",
      "nodeVersion",
      "platform",
      "targetEnvironment",
    ],
    "Run Specification.environmentEvidence",
  );
  const estimatorSnapshot = record(
    runSpecificationBundle.estimatorSnapshot,
    "Run Specification.estimatorSnapshot",
  );
  exactKeys(
    estimatorSnapshot,
    ["deliveryGate", "estimatorVersion", "scoringScale"],
    "Run Specification.estimatorSnapshot",
  );
  const rubricSnapshot = record(
    runSpecificationBundle.rubricSnapshot,
    "Run Specification.rubricSnapshot",
  );
  exactKeys(
    rubricSnapshot,
    ["dimensions", "rubricVersion"],
    "Run Specification.rubricSnapshot",
  );
  if (
    !Array.isArray(rubricSnapshot.dimensions) ||
    rubricSnapshot.dimensions.some(
      (dimension) => typeof dimension !== "string",
    )
  ) {
    throw new Error(
      "Durable Doubao recovery rubric dimensions schema is invalid",
    );
  }
  const runnerCodeEvidence = record(
    runSpecificationBundle.runnerCodeEvidence,
    "Run Specification.runnerCodeEvidence",
  );
  exactKeys(
    runnerCodeEvidence,
    ["contentHash", "entrypoint", "files", "specCommitSha"],
    "Run Specification.runnerCodeEvidence",
  );
  if (!Array.isArray(runnerCodeEvidence.files)) {
    throw new Error(
      "Durable Doubao recovery runner code files schema is invalid",
    );
  }
  runnerCodeEvidence.files.forEach((value, index) => {
    const file = record(
      value,
      `Run Specification.runnerCodeEvidence.files[${index}]`,
    );
    exactKeys(
      file,
      ["contentHash", "path"],
      `Run Specification.runnerCodeEvidence.files[${index}]`,
    );
    sha(
      file.contentHash,
      `Run Specification.runnerCodeEvidence.files[${index}].contentHash`,
    );
    text(
      file.path,
      `Run Specification.runnerCodeEvidence.files[${index}].path`,
    );
  });
  const runnerImageEvidence = record(
    runSpecificationBundle.runnerImageEvidence,
    "Run Specification.runnerImageEvidence",
  );
  exactKeys(
    runnerImageEvidence,
    [
      "contentHash",
      "imageReference",
      "runtimeFamily",
      "runtimePackageManifest",
      "runtimeVersion",
    ],
    "Run Specification.runnerImageEvidence",
  );
  const runtimePackageManifest = record(
    runnerImageEvidence.runtimePackageManifest,
    "Run Specification.runnerImageEvidence.runtimePackageManifest",
  );
  exactKeys(
    runtimePackageManifest,
    [
      "architecture",
      "dependencyLockHash",
      "nodeExecutableHash",
      "platform",
      "runnerBundleHash",
    ],
    "Run Specification.runnerImageEvidence.runtimePackageManifest",
  );
  const schemaSnapshot = record(
    runSpecificationBundle.schemaSnapshot,
    "Run Specification.schemaSnapshot",
  );
  exactKeys(
    schemaSnapshot,
    ["requiredLineage", "schemaVersion"],
    "Run Specification.schemaSnapshot",
  );
  if (
    !Array.isArray(schemaSnapshot.requiredLineage) ||
    schemaSnapshot.requiredLineage.some(
      (entry) => typeof entry !== "string",
    )
  ) {
    throw new Error(
      "Durable Doubao recovery schema lineage schema is invalid",
    );
  }
}
if (!sameReceipt(manifestReceipt, runSpecificationReceipt)) {
  throw new Error(
    "Durable Doubao recovery capture receipt provenance mismatch",
  );
}
const runSpecificationHash = hash(runSpecification);
if (
  runSpecificationKey !==
  `run-specifications/${runSpecificationHash.slice("sha256:".length)}`
) {
  throw new Error(
    "Durable Doubao recovery Run Specification key/hash mismatch",
  );
}

const renderManifestKey =
  `artifacts/${artifactId}/render-manifest`;
const renderManifest = await artifactStore.read(renderManifestKey);
if (
  renderManifest === null ||
  hash(renderManifest) !== renderManifestHash
) {
  throw new Error("Durable Doubao recovery render manifest hash mismatch");
}
const renderIdentity = json(renderManifest, "render manifest");
exactKeys(
  renderIdentity,
  trustedCheckpoint.purpose === "real_provider_recovery"
    ? [
        "artifactHash",
        "artifactId",
        "contactSheet",
        "environmentOrigin",
        "fidelity",
        "pageCount",
        "provenance",
        "renderer",
        "rendererAuthorizationDecisionId",
        "renderManifestId",
        "renderOutcome",
        "renderPolicy",
        "schemaVersion",
        "slides",
      ]
    : [
        "artifactHash",
        "artifactId",
        "contactSheet",
        "pageCount",
        "renderer",
        "renderManifestId",
        "schemaVersion",
        "slides",
      ],
  "render manifest",
);
text(
  renderIdentity.schemaVersion,
  "render manifest.schemaVersion",
  "render-manifest-v1",
);
const rendererId = text(
  renderIdentity.renderer,
  "render manifest.renderer",
);
if (
  text(renderIdentity.renderManifestId, "render manifest.renderManifestId") !==
    renderManifestId ||
  text(renderIdentity.artifactId, "render manifest.artifactId") !==
    artifactId ||
  sha(renderIdentity.artifactHash, "render manifest.artifactHash") !==
    artifactContentHash ||
  integer(renderIdentity.pageCount, "render manifest.pageCount") !== 16
) {
  throw new Error(
    "Durable Doubao recovery render manifest lineage is invalid",
  );
}
const rawSlides = renderIdentity.slides;
if (!Array.isArray(rawSlides) || rawSlides.length !== 16) {
  throw new Error(
    "Durable Doubao recovery render manifest page lineage is incomplete",
  );
}
const slides = rawSlides.map((value, index) => {
  const slide = record(value, `render manifest.slides[${index}]`);
  exactKeys(
    slide,
    RENDER_SLIDE_KEYS,
    `render manifest.slides[${index}]`,
  );
  return Object.freeze({
    pageNumber: integer(
      slide.pageNumber,
      `render manifest.slides[${index}].pageNumber`,
      index + 1,
    ),
    contentHash: sha(
      slide.contentHash,
      `render manifest.slides[${index}].contentHash`,
    ),
    filename: text(
      slide.filename,
      `render manifest.slides[${index}].filename`,
    ),
    mimeType: text(
      slide.mimeType,
      `render manifest.slides[${index}].mimeType`,
      "image/png",
    ),
    extractedTextHash: sha(
      slide.extractedTextHash,
      `render manifest.slides[${index}].extractedTextHash`,
    ),
  });
});
const contactSheet = record(
  renderIdentity.contactSheet,
  "render manifest.contactSheet",
);
exactKeys(
  contactSheet,
  CONTACT_SHEET_KEYS,
  "render manifest.contactSheet",
);
const contactSheetHash = sha(
  contactSheet.contentHash,
  "render manifest.contactSheet.contentHash",
);
const contactSheetFilename = text(
  contactSheet.filename,
  "render manifest.contactSheet.filename",
);
text(
  contactSheet.mimeType,
  "render manifest.contactSheet.mimeType",
  "image/png",
);
if (trustedCheckpoint.purpose === "real_provider_recovery") {
  const renderEnvironmentOrigin = record(
    renderIdentity.environmentOrigin,
    "render manifest.environmentOrigin",
  );
  exactKeys(
    renderEnvironmentOrigin,
    ENVIRONMENT_ORIGIN_KEYS,
    "render manifest.environmentOrigin",
  );
  const renderFidelity = record(
    renderIdentity.fidelity,
    "render manifest.fidelity",
  );
  exactKeys(
    renderFidelity,
    ["notes", "status"],
    "render manifest.fidelity",
  );
  if (
    !Array.isArray(renderFidelity.notes) ||
    renderFidelity.notes.some((note) => typeof note !== "string")
  ) {
    throw new Error(
      "Durable Doubao recovery render manifest fidelity notes schema is invalid",
    );
  }
  const renderPolicy = record(
    renderIdentity.renderPolicy,
    "render manifest.renderPolicy",
  );
  exactKeys(
    renderPolicy,
    [
      "animationPolicy",
      "colorProfile",
      "externalAssetPolicy",
      "fontPack",
      "resolution",
    ],
    "render manifest.renderPolicy",
  );
  text(
    renderIdentity.provenance,
    "render manifest.provenance",
    "PRODUCTION_REPLAY",
  );
  text(
    renderIdentity.rendererAuthorizationDecisionId,
    "render manifest.rendererAuthorizationDecisionId",
  );
  text(
    renderIdentity.renderOutcome,
    "render manifest.renderOutcome",
    "degraded",
  );
}

const expectedDerivative = (
  derivativeType: "static_slide" | "extracted_text",
  pageNumber: number,
) => {
  const matches = derivatives.filter(
    (lineage) =>
      lineage.derivativeType === derivativeType &&
      lineage.pageNumber === pageNumber,
  );
  const slide = slides[pageNumber - 1]!;
  const expectedId =
    derivativeType === "static_slide"
      ? `${artifactId}:static-slide:${pageNumber}`
      : `${artifactId}:extracted-text:${pageNumber}`;
  const expectedHash =
    derivativeType === "static_slide"
      ? slide.contentHash
      : slide.extractedTextHash;
  const expectedFilename =
    derivativeType === "static_slide"
      ? slide.filename
      : `slide-${pageNumber}.txt`;
  const expectedMimeType =
    derivativeType === "static_slide"
      ? "image/png"
      : "text/plain; charset=utf-8";
  if (
    matches.length !== 1 ||
    matches[0]?.derivativeId !== expectedId ||
    matches[0].sourceArtifactId !== artifactId ||
    matches[0].contentHash !== expectedHash ||
    matches[0].filename !== expectedFilename ||
    matches[0].mimeType !== expectedMimeType
  ) {
    throw new Error(
      `Durable Doubao recovery derivative lineage mismatch: ${derivativeType}:${pageNumber}`,
    );
  }
  return matches[0];
};
const validatedDerivatives = Array.from(
  { length: 16 },
  (_, index) => index + 1,
).flatMap((pageNumber) => [
  expectedDerivative("static_slide", pageNumber),
  expectedDerivative("extracted_text", pageNumber),
]);
const contactDerivatives = derivatives.filter(
  ({ derivativeType }) => derivativeType === "contact_sheet",
);
if (
  contactDerivatives.length !== 1 ||
  contactDerivatives[0]?.derivativeId !== `${artifactId}:contact-sheet` ||
  contactDerivatives[0].sourceArtifactId !== artifactId ||
  contactDerivatives[0].pageNumber !== null ||
  contactDerivatives[0].contentHash !== contactSheetHash ||
  contactDerivatives[0].filename !== contactSheetFilename ||
  contactDerivatives[0].mimeType !== "image/png"
) {
  throw new Error(
    "Durable Doubao recovery contact-sheet derivative lineage mismatch",
  );
}
validatedDerivatives.push(contactDerivatives[0]);

const recoveredDerivatives = await Promise.all(
  validatedDerivatives.map(async (lineage) => {
    const suffix =
      lineage.derivativeType === "static_slide"
        ? `static-slide-${lineage.pageNumber}`
        : lineage.derivativeType === "extracted_text"
          ? `extracted-text-${lineage.pageNumber}`
          : "contact-sheet";
    const content = await artifactStore.read(
      `artifacts/${artifactId}/derivatives/${suffix}`,
    );
    if (
      content === null ||
      content.byteLength !== lineage.byteSize ||
      hash(content) !== lineage.contentHash
    ) {
      throw new Error(
        `Durable Doubao recovery derivative is missing or hash-mismatched: ${lineage.derivativeId}`,
      );
    }
    return Object.freeze({ lineage, content });
  }),
);
for (const recovered of recoveredDerivatives) {
  if (
    recovered.lineage.pipelineVersion !==
    trustedCheckpoint.derivativePipelineVersion
  ) {
    throw new Error(
      "Durable Doubao recovery renderer pipeline is not allowlisted",
    );
  }
  if (
    recovered.lineage.derivativeType !== "static_slide" &&
    recovered.lineage.derivativeType !== "contact_sheet"
  ) {
    continue;
  }
  const dimensions = await validatedSafePngDimensions(
    recovered.content,
    `Durable Doubao recovery ${recovered.lineage.derivativeId}`,
  );
  const expectedDimensions =
    recovered.lineage.derivativeType === "static_slide"
      ? trustedCheckpoint.slideDimensions
      : trustedCheckpoint.contactSheetDimensions;
  if (
    dimensions.width !== expectedDimensions.width ||
    dimensions.height !== expectedDimensions.height
  ) {
    throw new Error(
      `Durable Doubao recovery ${recovered.lineage.derivativeType} PNG dimensions do not match the trusted checkpoint`,
    );
  }
}
const derivativeSetHash = calculateArtifactDerivativeSetHash(
  validatedDerivatives.map(({ derivativeId, contentHash }) => ({
    derivativeId,
    contentHash,
  })),
);
if (
  derivativeSetHash !== manifestReceipt.renderDigest ||
  derivativeSetHash !== runSpecificationReceipt.renderDigest
) {
  throw new Error(
    "Durable Doubao recovery capture receipt render digest mismatch",
  );
}
if (
  manifestReceipt.artifactContentHash !== artifactContentHash ||
  runSpecificationReceipt.artifactContentHash !== artifactContentHash
) {
  throw new Error(
    "Durable Doubao recovery capture receipt Artifact hash mismatch",
  );
}
if (
  artifactContentHash !== trustedCheckpoint.artifactContentHash ||
  caseId !== trustedCheckpoint.caseId ||
  caseVersion !== trustedCheckpoint.caseVersion ||
  caseContentHash !== trustedCheckpoint.caseContentHash ||
  vendorPromptHash !== trustedCheckpoint.vendorPromptHash ||
  track !== trustedCheckpoint.track ||
  protocolId !== trustedCheckpoint.protocolId ||
  referencePackMode !== trustedCheckpoint.referencePackMode ||
  trustedCheckpoint.pageCount !== 16 ||
  packageId !== trustedCheckpoint.packageId ||
  adapterVersion !== trustedCheckpoint.adapterVersion ||
  adapterImplementationDigest !==
    trustedCheckpoint.adapterImplementationDigest ||
  executionEntrypointDigest !==
    trustedCheckpoint.executionEntrypointDigest ||
  executionConfigurationDigest !==
    trustedCheckpoint.executionConfigurationDigest ||
  browserDriverId !== trustedCheckpoint.driverId ||
  driverVersion !== trustedCheckpoint.driverVersion ||
  browserProfileDigest !== trustedCheckpoint.browserProfileDigest ||
  driverImplementationDigest !==
    trustedCheckpoint.driverImplementationDigest ||
  driverConfigurationDigest !==
    trustedCheckpoint.driverConfigurationDigest ||
  rendererId !== trustedCheckpoint.rendererId ||
  manifestVendorTaskId !== trustedCheckpoint.vendorTaskId ||
  manifestTaskStateVersion !== trustedCheckpoint.taskStateVersion ||
  !sameReceipt(manifestReceipt, trustedCheckpoint.captureReceipt) ||
  !sameReceipt(
    runSpecificationReceipt,
    trustedCheckpoint.captureReceipt,
  )
) {
  throw new Error(
    "Durable Doubao recovery bundle does not match the harness-owned trusted checkpoint",
  );
}

const expectedEventTypes = [
  "preflight_observed",
  "query_submitted",
  "generation_ready",
  "artifact_exported",
] as const;
const checkpointEventKeys = Object.freeze([
  "eventId",
  "jobId",
  "caseId",
  "runId",
  "attemptId",
  "attemptSeq",
  "eventType",
  "sourceAt",
  "observedAt",
  "writerId",
  "evidenceRef",
  "adapterVersion",
  "sourceUrl",
  "submissionEvidenceAtCheckpoint",
  "vendorTaskId",
  "taskStateVersion",
  "artifactId",
] as const);
if (checkpoints.length !== expectedEventTypes.length) {
  throw new Error(
    "Durable Doubao recovery checkpoint terminal sequence is incomplete",
  );
}
const eventIds = new Set<string>();
let rawVendorTaskId: string | null = null;
let priorObservedAt = Number.NEGATIVE_INFINITY;
checkpoints.forEach((event, index) => {
  const eventLabel = `checkpoint[${index}]`;
  exactKeys(record(event, eventLabel), checkpointEventKeys, eventLabel);
  const eventId = text(event.eventId, `${eventLabel}.eventId`);
  if (
    eventId !== `${attemptId}-event-${index + 1}` ||
    eventIds.has(eventId)
  ) {
    throw new Error(
      "Durable Doubao recovery checkpoint event order/identity is invalid",
    );
  }
  eventIds.add(eventId);
  if (
    text(event.jobId, `${eventLabel}.jobId`) !== jobId ||
    text(event.runId, `${eventLabel}.runId`) !== runId ||
    text(event.caseId, `${eventLabel}.caseId`) !== caseId ||
    text(event.attemptId, `${eventLabel}.attemptId`) !== attemptId ||
    integer(event.attemptSeq, `${eventLabel}.attemptSeq`, 1) !== 1 ||
    text(event.eventType, `${eventLabel}.eventType`) !==
      expectedEventTypes[index] ||
    text(event.writerId, `${eventLabel}.writerId`) !== adapterVersion ||
    text(event.adapterVersion, `${eventLabel}.adapterVersion`) !==
      adapterVersion
  ) {
    throw new Error(
      "Durable Doubao recovery checkpoint job/run/case/adapter lineage mismatch",
    );
  }
  const sourceAt = iso(event.sourceAt, `${eventLabel}.sourceAt`);
  const observedAt = iso(event.observedAt, `${eventLabel}.observedAt`);
  if (
    sourceAt !== observedAt ||
    Date.parse(observedAt) < priorObservedAt
  ) {
    throw new Error(
      "Durable Doubao recovery checkpoint timestamp order is invalid",
    );
  }
  priorObservedAt = Date.parse(observedAt);
  text(event.evidenceRef, `${eventLabel}.evidenceRef`);
  if (
    event.sourceUrl !== "https://www.doubao.com/" ||
    (index === 0
      ? event.vendorTaskId !== null ||
        event.taskStateVersion !== null ||
        event.submissionEvidenceAtCheckpoint !== "not_submitted" ||
        event.artifactId !== null
      : typeof event.vendorTaskId !== "string" ||
        event.vendorTaskId.length === 0 ||
        event.taskStateVersion !==
          `${expectedEventTypes[index]}@${index + 1}` ||
        event.submissionEvidenceAtCheckpoint !== "submitted" ||
        (index === expectedEventTypes.length - 1
          ? event.artifactId !== artifactId
          : event.artifactId !== null))
  ) {
    throw new Error(
      "Durable Doubao recovery checkpoint submission/artifact lineage mismatch",
    );
  }
  if (index > 0) {
    rawVendorTaskId ??= event.vendorTaskId as string;
    if (event.vendorTaskId !== rawVendorTaskId) {
      throw new Error(
        "Durable Doubao recovery checkpoint vendor task lineage mismatch",
      );
    }
  }
});
const checkpointTraceHash = hash(canonicalJsonBytes(checkpoints));
if (
  checkpointTraceHash !== trustedCheckpoint.checkpointTraceHash ||
  manifestTraceHash !== checkpointTraceHash
) {
  throw new Error(
    "Durable Doubao recovery manifest traceHash and checkpoint Trace do not match the harness-owned trusted checkpoint",
  );
}
if (
  rawVendorTaskId === null ||
  normalizedProductionTaskId(rawVendorTaskId) !== manifestVendorTaskId ||
  manifestTaskStateVersion !== "artifact_exported@4"
) {
  throw new Error(
    "Durable Doubao recovery terminal vendor task lineage mismatch",
  );
}

return Object.freeze({
    registryId,
    registryHash: registry.registryHash,
    rootReferences: {
      artifactRecovery: artifactRecoveryRootReference,
      runSpecification: runSpecificationRootReference,
      checkpoint: checkpointRootReference,
    },
    jobId,
    runId,
    caseId,
    attemptId,
    artifactId,
    manifestHash: hash(manifest),
    originalHash,
    renderManifestHash: hash(renderManifest),
    derivativeCount: derivatives.length,
    recoveredDerivativeCount: recoveredDerivatives.length,
    derivativeSetHash,
    runSpecificationHash,
    checkpointCount: checkpoints.length,
    checkpointTraceHash,
    browserDriverId,
    trustedRecoveryCheckpoint: {
      checkpointId: trustedCheckpoint.checkpointId,
      purpose: trustedCheckpoint.purpose,
      schemaVersion: trustedCheckpoint.schemaVersion,
    },
    binaryValidation: {
      pptxSlideCount: originalSlideNames.length,
      staticPngCount: recoveredDerivatives.filter(
        ({ lineage }) =>
          lineage.derivativeType === "static_slide",
      ).length,
      contactSheetPngCount: recoveredDerivatives.filter(
        ({ lineage }) =>
          lineage.derivativeType === "contact_sheet",
      ).length,
    },
  });
}

function productionCommandFromArguments(
  values: readonly string[],
): {
  readonly command: DoubaoProductionRecoveryCommand;
  readonly trustedCheckpointId: string;
} {
  const [
    registryId,
    artifactRecoveryRootReference,
    runSpecificationRootReference,
    checkpointRootReference,
    artifactStoreId,
    manifestKey,
    originalKey,
    runSpecificationStoreId,
    runSpecificationKey,
    checkpointStoreId,
    attemptId,
    trustedCheckpointId,
    ...unexpected
  ] = values;
  if (
    registryId === undefined ||
    artifactRecoveryRootReference === undefined ||
    runSpecificationRootReference === undefined ||
    checkpointRootReference === undefined ||
    artifactStoreId === undefined ||
    manifestKey === undefined ||
    originalKey === undefined ||
    runSpecificationStoreId === undefined ||
    runSpecificationKey === undefined ||
    checkpointStoreId === undefined ||
    attemptId === undefined ||
    trustedCheckpointId === undefined ||
    unexpected.length !== 0
  ) {
    throw new Error("Recovery command arguments are incomplete");
  }
  return {
    command: {
      registryId,
      artifactRecoveryRootReference,
      runSpecificationRootReference,
      checkpointRootReference,
      artifactStoreId,
      manifestKey,
      originalKey,
      runSpecificationStoreId,
      runSpecificationKey,
      checkpointStoreId,
      attemptId,
    },
    trustedCheckpointId,
  };
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const { command, trustedCheckpointId } =
    productionCommandFromArguments(process.argv.slice(2));
  if (
    trustedCheckpointId !==
    DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID
  ) {
    throw new Error(
      "Production Doubao recovery requires the real-provider trusted checkpoint",
    );
  }
  const trustedCheckpoint =
    trustedDoubaoRecoveryCheckpoint(trustedCheckpointId);
  if (trustedCheckpoint.purpose !== "real_provider_recovery") {
    throw new Error(
      "Production Doubao recovery checkpoint purpose is invalid",
    );
  }
  const result = await validateDoubaoRecoveryStoresAgainstCheckpoint(
    command,
    trustedCheckpoint,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
