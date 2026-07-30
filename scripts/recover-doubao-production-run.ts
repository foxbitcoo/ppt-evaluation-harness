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
const caseId = text(
  evaluationCase.caseId,
  "Run Specification.evaluationCase.caseId",
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
text(
  evaluationCase.track,
  "Run Specification.evaluationCase.track",
  "query_generation",
);
const productPackage = record(
  runSpecificationBundle.productPackage,
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
const adapterSpecification = record(
  runSpecificationBundle.adapterSpecification,
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
  checkpointTraceHash !== trustedCheckpoint.checkpointTraceHash
) {
  throw new Error(
    "Durable Doubao recovery checkpoint Trace does not match the harness-owned trusted checkpoint",
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
