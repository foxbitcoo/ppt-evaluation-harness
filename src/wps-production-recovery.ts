import { createHash } from "node:crypto";

import type { ObservableAttemptEvent } from "./domain.ts";
import {
  calculateArtifactDerivativeSetHash,
} from "./artifact-vault.ts";
import {
  canonicalJsonBytes,
} from "./run-specification.ts";
import { validatedSafePngDimensions } from "./safe-raster.ts";
import { parseStrictJson } from "./strict-json.ts";
import {
  validatedOpenXmlPresentationSlideNames,
} from "./wps-aippt.ts";
import type {
  TrustedWpsRecoveryCheckpoint,
  WpsRecoverySha256,
} from "./wps-recovery-checkpoints.ts";

type JsonRecord = Record<string, unknown>;
type Sha256 = WpsRecoverySha256;

export interface WpsVerifiedBuildIdentity {
  readonly schemaVersion: "ppt-evaluation-build-identity-v1";
  readonly specCommitSha: string;
  readonly source: "EMBEDDED_VERIFIED_BUILD_MANIFEST";
  readonly sourceArchiveDigest: Sha256;
  readonly sourceArchiveEntryCount: number;
  readonly embeddedManifestHash: Sha256;
  readonly manifestHash: Sha256;
}

export interface WpsProductionRecoveryCommand {
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

export interface WpsProductionRecoveryPayloads {
  readonly command: WpsProductionRecoveryCommand;
  readonly registryHash: Sha256;
  readonly manifest: Uint8Array;
  readonly original: Uint8Array;
  readonly runSpecification: Uint8Array;
  readonly checkpoints: readonly ObservableAttemptEvent[];
  readonly readArtifactPayload: (
    key: string,
  ) => Promise<Uint8Array | null>;
  readonly trustedCheckpoint: TrustedWpsRecoveryCheckpoint;
  readonly verifierBuildIdentity: WpsVerifiedBuildIdentity;
}

export interface WpsProductionRecoveryResult {
  readonly registryId: string;
  readonly registryHash: Sha256;
  readonly rootReferences: {
    readonly artifactRecovery: string;
    readonly runSpecification: string;
    readonly checkpoint: string;
  };
  readonly jobId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly attemptId: string;
  readonly artifactId: string;
  readonly providerArtifactReference: string;
  readonly manifestHash: Sha256;
  readonly originalHash: Sha256;
  readonly renderManifestHash: Sha256;
  readonly derivativeCount: number;
  readonly recoveredDerivativeCount: number;
  readonly derivativeSetHash: Sha256;
  readonly runSpecificationHash: Sha256;
  readonly checkpointCount: number;
  readonly checkpointCanonicalHash: Sha256;
  readonly persistedCheckpointTraceHash: Sha256;
  readonly trustedRecoveryCheckpoint: {
    readonly schemaVersion: string;
    readonly checkpointId: string;
    readonly purpose: string;
  };
  readonly captureReceipt: TrustedWpsRecoveryCheckpoint["captureReceipt"];
  readonly evaluatedRunIdentity: {
    readonly specCommitSha: string;
    readonly buildIdentitySource: string;
    readonly runnerCodeDigest: Sha256;
    readonly runSpecificationCanonicalHash: Sha256;
  };
  readonly verifierBuildIdentity: WpsVerifiedBuildIdentity;
  readonly binaryValidation: {
    readonly pptxSlideCount: number;
    readonly staticPngCount: number;
    readonly contactSheetPngCount: number;
  };
}

interface Derivative {
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

const decoder = new TextDecoder("utf-8", { fatal: true });

function hash(content: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function object(value: unknown, label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`WPS recovery ${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `WPS recovery ${label} contains missing or unexpected fields`,
    );
  }
}

function text(
  value: unknown,
  label: string,
  expected?: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    (expected !== undefined && value !== expected)
  ) {
    throw new Error(`WPS recovery ${label} is invalid`);
  }
  return value;
}

function sha(
  value: unknown,
  label: string,
  expected?: Sha256,
): Sha256 {
  const candidate = text(value, label);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(candidate) ||
    (expected !== undefined && candidate !== expected)
  ) {
    throw new Error(`WPS recovery ${label} is not the expected SHA-256`);
  }
  return candidate as Sha256;
}

function integer(
  value: unknown,
  label: string,
  expected?: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (expected !== undefined && value !== expected)
  ) {
    throw new Error(`WPS recovery ${label} is invalid`);
  }
  return value as number;
}

function iso(value: unknown, label: string): string {
  const candidate = text(value, label);
  if (
    !Number.isFinite(Date.parse(candidate)) ||
    new Date(candidate).toISOString() !== candidate
  ) {
    throw new Error(`WPS recovery ${label} is not an ISO timestamp`);
  }
  return candidate;
}

function authenticatedJson(
  content: Uint8Array,
  expectedHash: Sha256,
  label: string,
): JsonRecord {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      decoder.decode(content),
      `WPS recovery ${label}`,
    );
  } catch {
    throw new Error(`WPS recovery ${label} JSON is invalid`);
  }
  const record = object(parsed, label);
  if (
    hash(content) !== expectedHash ||
    hash(canonicalJsonBytes(record)) !== expectedHash
  ) {
    throw new Error(
      `WPS recovery ${label} does not match its harness-owned checkpoint`,
    );
  }
  return record;
}

function derivativeKey(
  artifactId: string,
  derivative: Derivative,
): string {
  switch (derivative.derivativeType) {
    case "static_slide":
      return `artifacts/${artifactId}/derivatives/static-slide-${derivative.pageNumber}`;
    case "extracted_text":
      return `artifacts/${artifactId}/derivatives/extracted-text-${derivative.pageNumber}`;
    case "contact_sheet":
      return `artifacts/${artifactId}/derivatives/contact-sheet`;
  }
}

function validatedDerivative(
  value: unknown,
  index: number,
  artifactId: string,
  pipelineVersion: string,
): Derivative {
  const label = `Artifact manifest.derivatives[${index}]`;
  const entry = object(value, label);
  exactKeys(
    entry,
    [
      "byteSize",
      "contentHash",
      "derivativeId",
      "derivativeType",
      "filename",
      "mimeType",
      "pageNumber",
      "pipelineVersion",
      "sourceArtifactId",
    ],
    label,
  );
  const derivativeType = text(
    entry.derivativeType,
    `${label}.derivativeType`,
  );
  if (
    ![
      "static_slide",
      "extracted_text",
      "contact_sheet",
    ].includes(derivativeType)
  ) {
    throw new Error(`WPS recovery ${label}.derivativeType is invalid`);
  }
  const pageNumber =
    entry.pageNumber === null
      ? null
      : integer(entry.pageNumber, `${label}.pageNumber`);
  if (
    (derivativeType === "contact_sheet" && pageNumber !== null) ||
    (derivativeType !== "contact_sheet" &&
      (pageNumber === null || pageNumber < 1 || pageNumber > 16))
  ) {
    throw new Error(`WPS recovery ${label}.pageNumber is invalid`);
  }
  return Object.freeze({
    derivativeId: text(entry.derivativeId, `${label}.derivativeId`),
    sourceArtifactId: text(
      entry.sourceArtifactId,
      `${label}.sourceArtifactId`,
      artifactId,
    ),
    derivativeType: derivativeType as Derivative["derivativeType"],
    pageNumber,
    filename: text(entry.filename, `${label}.filename`),
    mimeType: text(entry.mimeType, `${label}.mimeType`),
    byteSize: integer(entry.byteSize, `${label}.byteSize`),
    contentHash: sha(entry.contentHash, `${label}.contentHash`),
    pipelineVersion: text(
      entry.pipelineVersion,
      `${label}.pipelineVersion`,
      pipelineVersion,
    ),
  });
}

function executionTraceEvents(
  checkpoints: readonly ObservableAttemptEvent[],
): readonly Record<string, unknown>[] {
  return checkpoints.map((event) =>
    Object.freeze({
      eventId: event.eventId,
      jobId: event.jobId,
      caseId: event.caseId,
      runId: event.runId,
      attemptId: event.attemptId,
      attemptSeq: event.attemptSeq,
      eventType: event.eventType,
      sourceAt: event.sourceAt,
      observedAt: event.observedAt,
      writerId: event.writerId,
      evidenceRef: event.evidenceRef,
      sourceUrl: event.sourceUrl,
      submissionEvidenceAtCheckpoint:
        event.submissionEvidenceAtCheckpoint,
      vendorTaskId: event.vendorTaskId,
      taskStateVersion: event.taskStateVersion,
      adapterVersion: event.adapterVersion,
      artifactId: event.artifactId,
    }),
  );
}

function receiptTraceEvents(
  checkpoints: readonly ObservableAttemptEvent[],
): readonly Record<string, unknown>[] {
  return checkpoints.map((event) => ({
    eventType: event.eventType,
    sourceAt: event.sourceAt,
    observedAt: event.observedAt,
    evidenceId: event.evidenceRef,
    sourceUrl: event.sourceUrl,
    submissionEvidenceAtCheckpoint:
      event.submissionEvidenceAtCheckpoint,
    vendorTaskId: event.vendorTaskId,
    taskStateVersion: event.taskStateVersion,
    adapterVersion: event.adapterVersion,
    artifactId: event.artifactId,
  }));
}

function assertCommandBound(
  command: WpsProductionRecoveryCommand,
  trusted: TrustedWpsRecoveryCheckpoint,
): void {
  if (
    command.registryId !== trusted.registryId ||
    command.artifactRecoveryRootReference !==
      trusted.rootReferences.artifactRecovery ||
    command.runSpecificationRootReference !==
      trusted.rootReferences.runSpecification ||
    command.checkpointRootReference !==
      trusted.rootReferences.checkpoint ||
    command.artifactStoreId !== trusted.storeIds.artifact ||
    command.runSpecificationStoreId !==
      trusted.storeIds.runSpecification ||
    command.checkpointStoreId !== trusted.storeIds.checkpoint ||
    command.manifestKey !== trusted.keys.manifest ||
    command.originalKey !== trusted.keys.original ||
    command.runSpecificationKey !==
      trusted.keys.runSpecification ||
    command.attemptId !== trusted.attemptId
  ) {
    throw new Error(
      "WPS recovery command is not bound to the trusted registry, stores, keys, and Attempt",
    );
  }
}

function assertVersionReference(
  references: JsonRecord,
  key: string,
  payload: unknown,
): void {
  sha(
    references[key],
    `Run Specification.versionReferences.${key}`,
    hash(canonicalJsonBytes(payload)),
  );
}

export async function validateWpsProductionRecoveryPayloads(
  input: WpsProductionRecoveryPayloads,
): Promise<WpsProductionRecoveryResult> {
  const trusted = input.trustedCheckpoint;
  assertCommandBound(input.command, trusted);
  if (input.registryHash !== trusted.registryHash) {
    throw new Error(
      "WPS recovery durable root registry does not match the trusted checkpoint",
    );
  }

  const manifest = authenticatedJson(
    input.manifest,
    trusted.artifactManifestCanonicalHash,
    "Artifact manifest",
  );
  exactKeys(
    manifest,
    [
      "artifact",
      "derivatives",
      "fidelity",
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
    manifest.schemaVersion,
    "Artifact manifest.schemaVersion",
    "artifact-package-identity-v1",
  );
  const jobId = text(
    manifest.jobId,
    "Artifact manifest.jobId",
    trusted.jobId,
  );
  const artifact = object(
    manifest.artifact,
    "Artifact manifest.artifact",
  );
  exactKeys(
    artifact,
    [
      "artifactId",
      "byteSize",
      "capturedAt",
      "contentHash",
      "filename",
      "mimeType",
      "pageCount",
      "runId",
    ],
    "Artifact manifest.artifact",
  );
  const artifactId = text(
    artifact.artifactId,
    "Artifact manifest.artifact.artifactId",
    trusted.artifactId,
  );
  const runId = text(
    artifact.runId,
    "Artifact manifest.artifact.runId",
    trusted.runId,
  );
  const originalHash = hash(input.original);
  sha(
    artifact.contentHash,
    "Artifact manifest.artifact.contentHash",
    trusted.artifactContentHash,
  );
  if (
    originalHash !== trusted.artifactContentHash ||
    integer(
      artifact.byteSize,
      "Artifact manifest.artifact.byteSize",
      input.original.byteLength,
    ) !== input.original.byteLength
  ) {
    throw new Error(
      "WPS recovery original Artifact bytes do not match the trusted manifest",
    );
  }
  text(
    artifact.mimeType,
    "Artifact manifest.artifact.mimeType",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  text(
    artifact.filename,
    "Artifact manifest.artifact.filename",
    "wps-volcano-16.pptx",
  );
  integer(
    artifact.pageCount,
    "Artifact manifest.artifact.pageCount",
    16,
  );
  iso(artifact.capturedAt, "Artifact manifest.artifact.capturedAt");
  const slideNames =
    validatedOpenXmlPresentationSlideNames(input.original);
  if (slideNames.length !== 16) {
    throw new Error("WPS recovery PPTX does not contain 16 safe slides");
  }

  const execution = object(
    manifest.productionExecutionEvidence,
    "Artifact manifest.productionExecutionEvidence",
  );
  exactKeys(
    execution,
    [
      "adapterVersion",
      "artifactContentHash",
      "captureSource",
      "driverSessionId",
      "driverVersion",
      "executionMode",
      "outcome",
      "rasterManifestHash",
      "taskStateVersion",
      "traceHash",
      "vendorTaskId",
    ],
    "Artifact manifest.productionExecutionEvidence",
  );
  text(
    execution.executionMode,
    "Artifact manifest.productionExecutionEvidence.executionMode",
    "PRODUCTION_REPLAY",
  );
  text(
    execution.captureSource,
    "Artifact manifest.productionExecutionEvidence.captureSource",
    "REAL_PROVIDER_CAPTURE",
  );
  text(
    execution.outcome,
    "Artifact manifest.productionExecutionEvidence.outcome",
    "captured",
  );
  text(
    execution.adapterVersion,
    "Artifact manifest.productionExecutionEvidence.adapterVersion",
    trusted.adapterVersion,
  );
  text(
    execution.driverVersion,
    "Artifact manifest.productionExecutionEvidence.driverVersion",
    trusted.driverVersion,
  );
  text(
    execution.vendorTaskId,
    "Artifact manifest.productionExecutionEvidence.vendorTaskId",
    trusted.vendorTaskId,
  );
  text(
    execution.taskStateVersion,
    "Artifact manifest.productionExecutionEvidence.taskStateVersion",
    trusted.taskStateVersion,
  );
  sha(
    execution.artifactContentHash,
    "Artifact manifest.productionExecutionEvidence.artifactContentHash",
    originalHash,
  );
  const renderManifestHash = sha(
    manifest.renderManifestHash,
    "Artifact manifest.renderManifestHash",
    trusted.renderManifestCanonicalHash,
  );
  sha(
    execution.rasterManifestHash,
    "Artifact manifest.productionExecutionEvidence.rasterManifestHash",
    renderManifestHash,
  );

  if (!Array.isArray(manifest.derivatives)) {
    throw new Error("WPS recovery Artifact derivatives are invalid");
  }
  const derivatives = manifest.derivatives.map((entry, index) =>
    validatedDerivative(
      entry,
      index,
      artifactId,
      trusted.derivativePipelineVersion,
    ),
  );
  if (
    derivatives.length !== 33 ||
    new Set(derivatives.map(({ derivativeId }) => derivativeId)).size !==
      derivatives.length
  ) {
    throw new Error(
      "WPS recovery Artifact derivative set is incomplete or duplicated",
    );
  }
  const derivativeSetHash =
    calculateArtifactDerivativeSetHash(derivatives);
  if (derivativeSetHash !== trusted.captureReceipt.renderDigest) {
    throw new Error(
      "WPS recovery derivative set does not match the trusted capture receipt",
    );
  }

  const renderKey = `artifacts/${artifactId}/render-manifest`;
  const renderBytes = await input.readArtifactPayload(renderKey);
  if (renderBytes === null) {
    throw new Error("WPS recovery render manifest is missing");
  }
  const render = authenticatedJson(
    renderBytes,
    trusted.renderManifestCanonicalHash,
    "Render manifest",
  );
  exactKeys(
    render,
    [
      "artifactHash",
      "artifactId",
      "contactSheet",
      "environmentOrigin",
      "fidelity",
      "pageCount",
      "provenance",
      "renderManifestId",
      "renderOutcome",
      "renderPolicy",
      "renderer",
      "rendererAuthorizationDecisionId",
      "schemaVersion",
      "slides",
    ],
    "Render manifest",
  );
  text(
    render.schemaVersion,
    "Render manifest.schemaVersion",
    "render-manifest-v1",
  );
  text(render.artifactId, "Render manifest.artifactId", artifactId);
  sha(
    render.artifactHash,
    "Render manifest.artifactHash",
    originalHash,
  );
  text(
    render.renderManifestId,
    "Render manifest.renderManifestId",
    text(
      manifest.renderManifestId,
      "Artifact manifest.renderManifestId",
    ),
  );
  text(
    render.renderer,
    "Render manifest.renderer",
    trusted.rendererId,
  );
  text(
    render.provenance,
    "Render manifest.provenance",
    "PRODUCTION_REPLAY",
  );
  text(
    render.renderOutcome,
    "Render manifest.renderOutcome",
    text(
      manifest.renderOutcome,
      "Artifact manifest.renderOutcome",
    ),
  );
  integer(render.pageCount, "Render manifest.pageCount", 16);
  const renderEnvironment = object(
    render.environmentOrigin,
    "Render manifest.environmentOrigin",
  );
  exactKeys(
    renderEnvironment,
    ["environment", "originId"],
    "Render manifest.environmentOrigin",
  );
  text(
    renderEnvironment.environment,
    "Render manifest.environmentOrigin.environment",
    "production",
  );
  text(
    renderEnvironment.originId,
    "Render manifest.environmentOrigin.originId",
    "production:ppt-evaluation-v1",
  );
  const renderPolicy = object(
    render.renderPolicy,
    "Render manifest.renderPolicy",
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
    "Render manifest.renderPolicy",
  );
  text(
    renderPolicy.externalAssetPolicy,
    "Render manifest.renderPolicy.externalAssetPolicy",
    "network_disabled",
  );
  text(
    renderPolicy.animationPolicy,
    "Render manifest.renderPolicy.animationPolicy",
    "first_frame",
  );

  if (!Array.isArray(render.slides) || render.slides.length !== 16) {
    throw new Error("WPS recovery Render manifest slides are incomplete");
  }
  const recovered = new Map<string, Uint8Array>();
  for (const derivative of derivatives) {
    const content = await input.readArtifactPayload(
      derivativeKey(artifactId, derivative),
    );
    if (
      content === null ||
      content.byteLength !== derivative.byteSize ||
      hash(content) !== derivative.contentHash
    ) {
      throw new Error(
        `WPS recovery derivative payload mismatch: ${derivative.derivativeId}`,
      );
    }
    if (
      derivative.derivativeType === "static_slide" ||
      derivative.derivativeType === "contact_sheet"
    ) {
      await validatedSafePngDimensions(
        content,
        `WPS recovery ${derivative.derivativeId}`,
      );
    } else {
      decoder.decode(content);
    }
    recovered.set(derivative.derivativeId, content);
  }

  for (let index = 0; index < 16; index += 1) {
    const pageNumber = index + 1;
    const slide = object(
      render.slides[index],
      `Render manifest.slides[${index}]`,
    );
    exactKeys(
      slide,
      [
        "contentHash",
        "extractedTextHash",
        "filename",
        "mimeType",
        "pageNumber",
      ],
      `Render manifest.slides[${index}]`,
    );
    integer(
      slide.pageNumber,
      `Render manifest.slides[${index}].pageNumber`,
      pageNumber,
    );
    const staticDerivative = derivatives.filter(
      (entry) =>
        entry.derivativeType === "static_slide" &&
        entry.pageNumber === pageNumber,
    );
    const textDerivative = derivatives.filter(
      (entry) =>
        entry.derivativeType === "extracted_text" &&
        entry.pageNumber === pageNumber,
    );
    if (
      staticDerivative.length !== 1 ||
      textDerivative.length !== 1 ||
      staticDerivative[0]?.derivativeId !==
        `${artifactId}:static-slide:${pageNumber}` ||
      textDerivative[0]?.derivativeId !==
        `${artifactId}:extracted-text:${pageNumber}` ||
      text(
        slide.filename,
        `Render manifest.slides[${index}].filename`,
      ) !== staticDerivative[0].filename ||
      text(
        slide.mimeType,
        `Render manifest.slides[${index}].mimeType`,
        "image/png",
      ) !== staticDerivative[0].mimeType ||
      sha(
        slide.contentHash,
        `Render manifest.slides[${index}].contentHash`,
      ) !== staticDerivative[0].contentHash ||
      sha(
        slide.extractedTextHash,
        `Render manifest.slides[${index}].extractedTextHash`,
      ) !== textDerivative[0].contentHash
    ) {
      throw new Error(
        `WPS recovery slide/derivative lineage mismatch: ${pageNumber}`,
      );
    }
  }
  const contactSheet = object(
    render.contactSheet,
    "Render manifest.contactSheet",
  );
  exactKeys(
    contactSheet,
    ["contentHash", "filename", "mimeType"],
    "Render manifest.contactSheet",
  );
  const contactDerivatives = derivatives.filter(
    ({ derivativeType }) => derivativeType === "contact_sheet",
  );
  if (
    contactDerivatives.length !== 1 ||
    contactDerivatives[0]?.derivativeId !==
      `${artifactId}:contact-sheet` ||
    text(
      contactSheet.filename,
      "Render manifest.contactSheet.filename",
    ) !== contactDerivatives[0].filename ||
    text(
      contactSheet.mimeType,
      "Render manifest.contactSheet.mimeType",
      "image/png",
    ) !== contactDerivatives[0].mimeType ||
    sha(
      contactSheet.contentHash,
      "Render manifest.contactSheet.contentHash",
    ) !== contactDerivatives[0].contentHash
  ) {
    throw new Error(
      "WPS recovery contact-sheet derivative lineage mismatch",
    );
  }

  const retainedPageReceipt = derivatives
    .filter(
      (entry): entry is Derivative & { readonly pageNumber: number } =>
        entry.derivativeType === "static_slide" &&
        entry.pageNumber !== null,
    )
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map((entry) => ({
      pageNumber: entry.pageNumber,
      filename: entry.filename,
      mimeType: entry.mimeType,
      contentHash: hash(recovered.get(entry.derivativeId)!),
    }));
  if (
    retainedPageReceipt.length !== 16 ||
    hash(
      new TextEncoder().encode(JSON.stringify(retainedPageReceipt)),
    ) !== trusted.captureReceipt.retainedPageDigest
  ) {
    throw new Error(
      "WPS recovery retained pages do not match the trusted capture receipt",
    );
  }

  const runSpecification = authenticatedJson(
    input.runSpecification,
    trusted.runSpecificationCanonicalHash,
    "Run Specification",
  );
  exactKeys(
    runSpecification,
    [
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
    ],
    "Run Specification",
  );
  text(
    runSpecification.schemaVersion,
    "Run Specification.schemaVersion",
    "run-specification-bundle-v1",
  );
  text(runSpecification.jobId, "Run Specification.jobId", jobId);
  text(runSpecification.runId, "Run Specification.runId", runId);
  text(
    runSpecification.specCommitSha,
    "Run Specification.specCommitSha",
    trusted.evaluatedSpecCommitSha,
  );

  const evaluationCase = object(
    runSpecification.evaluationCase,
    "Run Specification.evaluationCase",
  );
  text(
    evaluationCase.caseId,
    "Run Specification.evaluationCase.caseId",
    trusted.caseId,
  );
  integer(
    evaluationCase.caseVersion,
    "Run Specification.evaluationCase.caseVersion",
    1,
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

  const productPackage = object(
    runSpecification.productPackage,
    "Run Specification.productPackage",
  );
  text(
    productPackage.vendorId,
    "Run Specification.productPackage.vendorId",
    "wps",
  );
  text(
    productPackage.packageId,
    "Run Specification.productPackage.packageId",
    trusted.packageId,
  );
  text(
    productPackage.adapterVersion,
    "Run Specification.productPackage.adapterVersion",
    trusted.adapterVersion,
  );
  text(
    productPackage.provenance,
    "Run Specification.productPackage.provenance",
    "PRODUCTION_REPLAY",
  );

  const protocol = object(
    runSpecification.protocolSnapshot,
    "Run Specification.protocolSnapshot",
  );
  text(
    protocol.protocolId,
    "Run Specification.protocolSnapshot.protocolId",
    "production-query-default-cost-v1",
  );
  text(
    protocol.retryPolicy,
    "Run Specification.protocolSnapshot.retryPolicy",
    "one_if_provably_not_submitted",
  );
  text(
    protocol.resultSelectionPolicy,
    "Run Specification.protocolSnapshot.resultSelectionPolicy",
    "first_policy_compliant_artifact",
  );
  text(
    protocol.referencePackMode,
    "Run Specification.protocolSnapshot.referencePackMode",
    "off",
  );
  integer(
    protocol.timeoutMs,
    "Run Specification.protocolSnapshot.timeoutMs",
    1_800_000,
  );

  const adapter = object(
    runSpecification.adapterSpecification,
    "Run Specification.adapterSpecification",
  );
  text(
    adapter.vendorId,
    "Run Specification.adapterSpecification.vendorId",
    "wps",
  );
  text(
    adapter.packageId,
    "Run Specification.adapterSpecification.packageId",
    trusted.packageId,
  );
  text(
    adapter.adapterVersion,
    "Run Specification.adapterSpecification.adapterVersion",
    trusted.adapterVersion,
  );
  const browser = object(
    adapter.browserDriverEvidence,
    "Run Specification.adapterSpecification.browserDriverEvidence",
  );
  exactKeys(
    browser,
    [
      "browserProfileDigest",
      "captureSource",
      "configurationDigest",
      "driverId",
      "driverVersion",
      "implementationDigest",
      "provenance",
    ],
    "Run Specification.adapterSpecification.browserDriverEvidence",
  );
  text(
    browser.driverId,
    "Run Specification.adapterSpecification.browserDriverEvidence.driverId",
    trusted.driverId,
  );
  text(
    browser.driverVersion,
    "Run Specification.adapterSpecification.browserDriverEvidence.driverVersion",
    trusted.driverVersion,
  );
  text(
    browser.provenance,
    "Run Specification.adapterSpecification.browserDriverEvidence.provenance",
    "PRODUCTION_REPLAY",
  );
  text(
    browser.captureSource,
    "Run Specification.adapterSpecification.browserDriverEvidence.captureSource",
    "REAL_PROVIDER_CAPTURE",
  );
  sha(
    browser.browserProfileDigest,
    "Run Specification.adapterSpecification.browserDriverEvidence.browserProfileDigest",
    trusted.browserProfileDigest,
  );
  sha(
    browser.implementationDigest,
    "Run Specification.adapterSpecification.browserDriverEvidence.implementationDigest",
    trusted.driverImplementationDigest,
  );
  sha(
    browser.configurationDigest,
    "Run Specification.adapterSpecification.browserDriverEvidence.configurationDigest",
    trusted.driverConfigurationDigest,
  );
  const packageIdentityDigest = hash(
    new TextEncoder().encode(
      JSON.stringify({
        configurationDigest: trusted.driverConfigurationDigest,
        driverVersion: trusted.driverVersion,
        browserProfileDigest: trusted.browserProfileDigest,
      }),
    ),
  );
  if (
    packageIdentityDigest !==
    trusted.captureReceipt.packageIdentityDigest
  ) {
    throw new Error(
      "WPS recovery browser package does not match the trusted capture receipt",
    );
  }

  const runnerCode = object(
    runSpecification.runnerCodeEvidence,
    "Run Specification.runnerCodeEvidence",
  );
  exactKeys(
    runnerCode,
    ["contentHash", "entrypoint", "files", "specCommitSha"],
    "Run Specification.runnerCodeEvidence",
  );
  text(
    runnerCode.specCommitSha,
    "Run Specification.runnerCodeEvidence.specCommitSha",
    trusted.evaluatedSpecCommitSha,
  );
  text(
    runnerCode.entrypoint,
    "Run Specification.runnerCodeEvidence.entrypoint",
    "src/bakeoff.ts",
  );
  if (!Array.isArray(runnerCode.files)) {
    throw new Error("WPS recovery runner code file inventory is invalid");
  }
  const runnerPaths = runnerCode.files.map((entry, index) => {
    const file = object(
      entry,
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
    return text(
      file.path,
      `Run Specification.runnerCodeEvidence.files[${index}].path`,
    );
  });
  if (
    new Set(runnerPaths).size !== runnerPaths.length ||
    runnerPaths.includes("src/wps-recovery-checkpoints.ts")
  ) {
    throw new Error(
      "WPS recovery runner inventory is duplicate or circular",
    );
  }
  sha(
    runnerCode.contentHash,
    "Run Specification.runnerCodeEvidence.contentHash",
    trusted.runnerCodeDigest,
  );
  if (
    hash(canonicalJsonBytes(runnerCode.files)) !==
    trusted.runnerCodeDigest
  ) {
    throw new Error(
      "WPS recovery runner code inventory digest is invalid",
    );
  }

  const runnerImage = object(
    runSpecification.runnerImageEvidence,
    "Run Specification.runnerImageEvidence",
  );
  const runtimeManifest = object(
    runnerImage.runtimePackageManifest,
    "Run Specification.runnerImageEvidence.runtimePackageManifest",
  );
  const runnerImageDigest = sha(
    runnerImage.contentHash,
    "Run Specification.runnerImageEvidence.contentHash",
  );
  if (
    hash(canonicalJsonBytes(runtimeManifest)) !== runnerImageDigest ||
    text(
      runnerImage.imageReference,
      "Run Specification.runnerImageEvidence.imageReference",
    ) !== `local-runtime-package@${runnerImageDigest}` ||
    sha(
      runtimeManifest.runnerBundleHash,
      "Run Specification.runnerImageEvidence.runtimePackageManifest.runnerBundleHash",
    ) !== trusted.runnerCodeDigest
  ) {
    throw new Error(
      "WPS recovery runner image evidence is not bound to runner code",
    );
  }

  const references = object(
    runSpecification.versionReferences,
    "Run Specification.versionReferences",
  );
  for (const [key, payload] of [
    ["caseContentHash", evaluationCase],
    ["productPackageContentHash", productPackage],
    ["protocolSnapshotContentHash", protocol],
    ["adapterSpecificationHash", adapter],
    ["schemaSnapshotHash", runSpecification.schemaSnapshot],
    ["rubricSnapshotHash", runSpecification.rubricSnapshot],
    ["estimatorSnapshotHash", runSpecification.estimatorSnapshot],
    ["environmentEvidenceHash", runSpecification.environmentEvidence],
  ] as const) {
    assertVersionReference(references, key, payload);
  }
  sha(
    references.runnerCodeDigest,
    "Run Specification.versionReferences.runnerCodeDigest",
    trusted.runnerCodeDigest,
  );
  sha(
    references.runnerImageDigest,
    "Run Specification.versionReferences.runnerImageDigest",
    runnerImageDigest,
  );
  text(
    references.caseVersion,
    "Run Specification.versionReferences.caseVersion",
    "1",
  );
  text(
    references.productPackageVersion,
    "Run Specification.versionReferences.productPackageVersion",
    trusted.packageId,
  );
  text(
    references.adapterVersion,
    "Run Specification.versionReferences.adapterVersion",
    trusted.adapterVersion,
  );
  text(
    references.runPolicyVersion,
    "Run Specification.versionReferences.runPolicyVersion",
    "production-query-default-cost-v1",
  );

  if (input.checkpoints.length !== 2) {
    throw new Error(
      "WPS recovery checkpoint terminal sequence is incomplete",
    );
  }
  const checkpointKeys = [
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
    "sourceUrl",
    "submissionEvidenceAtCheckpoint",
    "vendorTaskId",
    "taskStateVersion",
    "adapterVersion",
    "artifactId",
  ] as const;
  const expectedTypes = [
    "configuration_observed",
    "artifact_downloaded",
  ] as const;
  let priorSourceAt = Number.NEGATIVE_INFINITY;
  let priorObservedAt = Number.NEGATIVE_INFINITY;
  let priorStateVersion = Number.NEGATIVE_INFINITY;
  input.checkpoints.forEach((event, index) => {
    const label = `checkpoint[${index}]`;
    exactKeys(object(event, label), checkpointKeys, label);
    if (
      text(event.eventId, `${label}.eventId`) !==
        `${trusted.attemptId}-wps-event-${index + 1}` ||
      text(event.jobId, `${label}.jobId`) !== jobId ||
      text(event.caseId, `${label}.caseId`) !== trusted.caseId ||
      text(event.runId, `${label}.runId`) !== runId ||
      text(event.attemptId, `${label}.attemptId`) !==
        trusted.attemptId ||
      integer(event.attemptSeq, `${label}.attemptSeq`, 1) !== 1 ||
      text(event.eventType, `${label}.eventType`) !==
        expectedTypes[index] ||
      text(event.writerId, `${label}.writerId`) !==
        trusted.adapterVersion ||
      text(event.adapterVersion, `${label}.adapterVersion`) !==
        trusted.adapterVersion ||
      text(event.vendorTaskId, `${label}.vendorTaskId`) !==
        trusted.vendorTaskId
    ) {
      throw new Error(
        "WPS recovery checkpoint job/case/run/attempt/adapter lineage mismatch",
      );
    }
    const sourceAt = Date.parse(iso(event.sourceAt, `${label}.sourceAt`));
    const observedAt = Date.parse(
      iso(event.observedAt, `${label}.observedAt`),
    );
    const stateVersion = Number(
      /@([1-9]\d*)$/.exec(
        text(event.taskStateVersion, `${label}.taskStateVersion`),
      )?.[1],
    );
    if (
      sourceAt > observedAt ||
      sourceAt < priorSourceAt ||
      observedAt < priorObservedAt ||
      !Number.isSafeInteger(stateVersion) ||
      stateVersion <= priorStateVersion
    ) {
      throw new Error(
        "WPS recovery checkpoint timestamp or state order regressed",
      );
    }
    priorSourceAt = sourceAt;
    priorObservedAt = observedAt;
    priorStateVersion = stateVersion;
    if (
      (index === 0 &&
        (event.submissionEvidenceAtCheckpoint !== "not_submitted" ||
          event.taskStateVersion !== "created@1" ||
          event.artifactId !== null)) ||
      (index === 1 &&
        (event.submissionEvidenceAtCheckpoint !== "submitted" ||
          event.taskStateVersion !== trusted.taskStateVersion ||
          event.artifactId !== trusted.providerArtifactReference))
    ) {
      throw new Error(
        "WPS recovery checkpoint submission/artifact sequence is invalid",
      );
    }
  });
  const checkpointCanonicalHash = hash(
    canonicalJsonBytes(input.checkpoints),
  );
  const persistedCheckpointTraceHash = hash(
    new TextEncoder().encode(
      JSON.stringify(executionTraceEvents(input.checkpoints)),
    ),
  );
  if (
    checkpointCanonicalHash !== trusted.checkpointCanonicalHash ||
    persistedCheckpointTraceHash !==
      trusted.persistedCheckpointTraceHash ||
    sha(
      execution.traceHash,
      "Artifact manifest.productionExecutionEvidence.traceHash",
    ) !== persistedCheckpointTraceHash ||
    hash(
      new TextEncoder().encode(
        JSON.stringify(receiptTraceEvents(input.checkpoints)),
      ),
    ) !== trusted.captureReceipt.traceDigest
  ) {
    throw new Error(
      "WPS recovery checkpoint Trace does not match execution evidence and the trusted receipt",
    );
  }
  if (
    trusted.captureReceipt.artifactContentHash !== originalHash ||
    trusted.captureReceipt.renderDigest !== derivativeSetHash
  ) {
    throw new Error(
      "WPS recovery Artifact/render payloads do not match the trusted receipt",
    );
  }

  return Object.freeze({
    registryId: input.command.registryId,
    registryHash: input.registryHash,
    rootReferences: Object.freeze({
      artifactRecovery:
        input.command.artifactRecoveryRootReference,
      runSpecification:
        input.command.runSpecificationRootReference,
      checkpoint: input.command.checkpointRootReference,
    }),
    jobId,
    runId,
    caseId: trusted.caseId,
    attemptId: trusted.attemptId,
    artifactId,
    providerArtifactReference: trusted.providerArtifactReference,
    manifestHash: hash(input.manifest),
    originalHash,
    renderManifestHash: hash(renderBytes),
    derivativeCount: derivatives.length,
    recoveredDerivativeCount: recovered.size,
    derivativeSetHash,
    runSpecificationHash: hash(input.runSpecification),
    checkpointCount: input.checkpoints.length,
    checkpointCanonicalHash,
    persistedCheckpointTraceHash,
    trustedRecoveryCheckpoint: Object.freeze({
      schemaVersion: trusted.schemaVersion,
      checkpointId: trusted.checkpointId,
      purpose: trusted.purpose,
    }),
    captureReceipt: trusted.captureReceipt,
    evaluatedRunIdentity: Object.freeze({
      specCommitSha: trusted.evaluatedSpecCommitSha,
      buildIdentitySource: trusted.evaluatedBuildIdentitySource,
      runnerCodeDigest: trusted.runnerCodeDigest,
      runSpecificationCanonicalHash:
        trusted.runSpecificationCanonicalHash,
    }),
    verifierBuildIdentity: input.verifierBuildIdentity,
    binaryValidation: Object.freeze({
      pptxSlideCount: slideNames.length,
      staticPngCount: derivatives.filter(
        ({ derivativeType }) => derivativeType === "static_slide",
      ).length,
      contactSheetPngCount: contactDerivatives.length,
    }),
  });
}
