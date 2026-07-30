import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import {
  BUILD_IDENTITY,
  DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
  DOUBAO_VOLCANO_REAL_CAPTURE_ID,
  DoubaoProductionReplayAdapter,
  InMemoryEgressAuthorizationAudit,
  InMemoryFeishuProjection,
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
  ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createDoubaoRealProviderReplayPackage,
  createHarnessOwnedProductionCapabilities,
  registerDurableRoots,
  resolveDurableRoot,
  retainedRehearsalRoot,
  trustedDoubaoRecoveryCheckpoint,
  type DoubaoRealProviderCapture,
  type EgressAuthorizationPort,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
const sha256 = (content: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
function assertExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} schema is invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} schema contains an unexpected field`);
  }
}
const [pptxPath, slidesDirectory, registryId] = process.argv.slice(2);
if (
  pptxPath === undefined ||
  slidesDirectory === undefined ||
  registryId === undefined
) {
  throw new Error(
    "Usage: rehearse-doubao-recovery <retained-real-pptx> <retained-png-directory> <registry-id>",
  );
}

const retainedRoot = retainedRehearsalRoot(registryId);
const roots = Object.freeze({
  artifactPrimary: "root:doubao-replay-artifact-primary",
  artifactRecovery: "root:doubao-replay-artifact-recovery",
  runSpecification: "root:doubao-replay-run-specification",
  checkpoint: "root:doubao-replay-checkpoint",
  profileLock: "root:doubao-replay-profile-lock",
  operational: "root:doubao-replay-operational",
});
const registry = await registerDurableRoots({
  registryId,
  roots: Object.entries(roots).map(([name, rootReference]) => ({
    rootReference,
    absolutePath: join(retainedRoot, name),
  })),
});
const pptx = Uint8Array.from(await readFile(pptxPath));
const artifactContentHash = sha256(pptx);
const retainedRenderedPages = await Promise.all(
  Array.from({ length: 16 }, async (_, index) => {
    const pageNumber = index + 1;
    return Object.freeze({
      pageNumber,
      filename: `slide-${pageNumber}.png`,
      mimeType: "image/png" as const,
      content: Uint8Array.from(
        await readFile(join(slidesDirectory, `slide-${pageNumber}.png`)),
      ),
    });
  }),
);
const tombstones = new InMemoryTombstoneLedger(
  "doubao-real-provider-replay-tombstones-v1",
);
const payloadInventory = new InMemoryPayloadInventory(
  tombstones,
  "doubao-real-provider-replay-inventory-v1",
);
const egressAudit = new InMemoryEgressAuthorizationAudit();
const authorization: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `doubao-replay:${sha256(
        JSON.stringify(request),
      ).slice(7, 31)}`,
      policyVersion: "doubao-real-provider-replay-ingest-v1",
      request,
      legalSecurityBasis:
        "authorized retained real-provider capture ingest",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
};
const capabilities = createHarnessOwnedProductionCapabilities({
  artifactPrimary: {
    operatorDomainLabel: "local-artifact-primary-copy",
    rootPath: resolveDurableRoot(registry, roots.artifactPrimary),
    rootReference: roots.artifactPrimary,
    storeId: "doubao-replay-artifact-primary-v1",
  },
  artifactRecovery: {
    operatorDomainLabel: "local-artifact-recovery-copy",
    rootPath: resolveDurableRoot(registry, roots.artifactRecovery),
    rootReference: roots.artifactRecovery,
    storeId: "doubao-replay-artifact-recovery-v1",
  },
  runSpecification: {
    operatorDomainLabel: "local-run-specification-copy",
    rootPath: resolveDurableRoot(registry, roots.runSpecification),
    rootReference: roots.runSpecification,
    storeId: "doubao-replay-run-specification-v1",
  },
  checkpoint: {
    rootPath: resolveDurableRoot(registry, roots.checkpoint),
    rootReference: roots.checkpoint,
    storeId: "doubao-replay-checkpoints-v1",
  },
  profileLock: {
    rootPath: resolveDurableRoot(registry, roots.profileLock),
    rootReference: roots.profileLock,
    lockId: "doubao-replay-profile-lock-v1",
  },
  renderer: {
    rendererId: "doubao-retained-real-png-renderer-v1",
    slidesDirectory,
    extractedTextPrefix: "retained real Doubao page",
    fontPack: "local-observed",
    resolution: "1600x900",
    colorProfile: "sRGB",
    fidelityNotes: [
      "slide 9 title clipping observed in retained render",
      "overflow checker warning retained for slides 2-16",
      "no quality retry was performed",
    ],
  },
  tombstones,
  payloadInventory,
  egressAuthorization: authorization,
  egressAudit,
});

const capture: DoubaoRealProviderCapture = {
  packageObservation: {
    observedAt: "2026-07-27T10:34:46.000Z",
    sourceUrl:
      "https://www.doubao.com/chat/38435879568317954",
    accountEvidence: "current_account_signed_in",
    planName: "not_visibly_exposed",
    modelName: "unknown",
    modeName: "AI PPT",
    networking: "enabled",
    requestedPageCount: 16,
    bestAvailableForCurrentAccount: true,
    incrementalChargeRequired: false,
    evidenceRef: "ui://doubao/preflight-audit-anchor",
    manualActions: [
      "open a new Doubao task",
      "select PPT mode",
      "select detailed length",
      "retain intelligent matching",
    ],
  },
  submission: {
    status: "submitted",
    vendorTaskId: "task_38435879568317954",
    observedAt: "2026-07-27T10:34:46.000Z",
    evidenceRef: "ui://doubao/submitted-audit-anchor",
    manualActions: [
      "enter the frozen 16-page Volcano prompt",
      "submit exactly once",
    ],
  },
  generation: {
    status: "generated",
    observedAt: "2026-07-27T10:45:58.000Z",
    completionUrl:
      "https://www.doubao.com/chat/38435879568317954",
    previewPageCount: 16,
    evidenceRef: "ui://doubao/generated-audit-anchor",
    manualActions: [
      "observe vendor completion label: 9m 31s",
      "observe completed 16-page editor and enabled Download control",
    ],
  },
  artifact: {
    status: "exported",
    observedAt: "2026-07-27T10:45:58.000Z",
    filename: "doubao-volcano-16.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pageCount: 16,
    content: pptx,
    evidenceRef: "download://doubao/doubao-volcano-16.pptx",
    manualActions: [
      "choose Download -> PPTX exactly once",
      "validate the one retained PPTX after the download listener timed out",
      "do not click export again; do not retry",
    ],
  },
};

const feishu = new InMemoryFeishuProjection({
  targetEnvironment: "production",
});
const outcome = await createBakeoffHarness({
  feishu,
  productAdapter: new DoubaoProductionReplayAdapter(),
  doubaoBrowserDriver:
    createDoubaoRealProviderReplayPackage({
      captureId: DOUBAO_VOLCANO_REAL_CAPTURE_ID,
      renderedPages: retainedRenderedPages,
      captures: [capture],
    }),
  egressAuthorization: authorization,
  egressAudit,
  payloadInventory,
  tombstones,
  rendererDestination: ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
  ...capabilities,
}).startBakeoffJob({
  environment: "production",
  caseId: VOLCANO_CASE_ID,
  referencePackMode: "off",
});
if (
  outcome.artifact === null ||
  outcome.renderManifest === null ||
  outcome.artifact.contentHash !== artifactContentHash ||
  outcome.artifact.provenance !== "PRODUCTION_REPLAY"
) {
  throw new Error(
    `Public Doubao replay did not capture the exact retained Artifact: ${JSON.stringify({
      job: outcome.job,
      artifact: outcome.artifact,
      renderManifest: outcome.renderManifest,
      runRecords: feishu.snapshot().runRecordTable,
    }, (_key, value) =>
      value instanceof Uint8Array
        ? `<Uint8Array:${value.byteLength}>`
        : value)}`,
  );
}
const snapshot = feishu.snapshot();
const vendorRun = snapshot.runRecordTable.find(
  ({ recordType, artifactId }) =>
    recordType === "vendor_run" &&
    artifactId === outcome.artifact?.artifactId,
);
const attempt = snapshot.runRecordTable.find(
  ({ recordType, parentRecordId }) =>
    recordType === "evaluation_attempt" &&
    parentRecordId === vendorRun?.recordId,
);
const manifest = vendorRun?.artifactPackageManifest;
const specReference = vendorRun?.specificationReference;
if (
  attempt === undefined ||
  manifest === null ||
  manifest === undefined ||
  specReference === null ||
  specReference === undefined
) {
  throw new Error("Doubao replay durable lineage is incomplete");
}
const [recoveredArtifact, recoveredSpec, checkpoints] =
  await Promise.all([
    capabilities.artifactVault.readFromSecondary(manifest),
    capabilities.runSpecificationVault.read(specReference),
    capabilities.attemptCheckpointStore.readAttempt?.(attempt.recordId),
  ]);
if (
  sha256(recoveredArtifact.original) !== artifactContentHash ||
  recoveredArtifact.derivatives.length !== 33 ||
  recoveredSpec.adapterSpecification.browserDriverEvidence?.driverId !==
    "doubao-real-provider-replay" ||
  checkpoints === undefined ||
  checkpoints.length < 4
) {
  throw new Error("Doubao replay durable recovery verification failed");
}
const contactSheet = outcome.renderManifest.contactSheet.content;
if (!(contactSheet instanceof Uint8Array)) {
  throw new Error("Doubao replay contact sheet is not retained PNG bytes");
}
const contactMetadata = await sharp(Buffer.from(contactSheet)).metadata();
if (contactMetadata.width !== 1280 || contactMetadata.height !== 720) {
  throw new Error("Doubao replay contact sheet is not a 4x4 mosaic");
}

const secondary = manifest.payloadLocations.filter(
  ({ copyRole }) => copyRole === "secondary",
);
const original = secondary.find(({ key }) => key.endsWith("/original"));
const manifestLocation = secondary.find(({ key }) =>
  key.endsWith("/manifest"),
);
if (original === undefined || manifestLocation === undefined) {
  throw new Error("Doubao recovery payload locations are incomplete");
}
const specLocation =
  capabilities.runSpecificationVault.retentionLocation(specReference);
const recoveryArguments = [
  registryId,
  roots.artifactRecovery,
  roots.runSpecification,
  roots.checkpoint,
  capabilities.evidence.artifactRecovery.storeId,
  manifestLocation.key,
  original.key,
  capabilities.evidence.runSpecification.storeId,
  specLocation.key,
  capabilities.attemptCheckpointStore.checkpointStoreId,
  attempt.recordId,
  DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
];
const recovery = await execFileAsync(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/recover-doubao-production-run.ts",
    ...recoveryArguments,
  ],
  { cwd: new URL("..", import.meta.url).pathname },
);
const recoveryResult = recovery.stdout.trim();
const trustedRecoveryCheckpoint =
  trustedDoubaoRecoveryCheckpoint(
    DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
  );
const parsedRecoveryResult = JSON.parse(recoveryResult) as {
  readonly registryId: string;
  readonly manifestHash: `sha256:${string}`;
  readonly originalHash: `sha256:${string}`;
  readonly renderManifestHash: `sha256:${string}`;
  readonly derivativeCount: number;
  readonly recoveredDerivativeCount: number;
  readonly derivativeSetHash: `sha256:${string}`;
  readonly runSpecificationHash: `sha256:${string}`;
  readonly checkpointCount: number;
  readonly checkpointTraceHash: `sha256:${string}`;
  readonly browserDriverId: string;
  readonly trustedRecoveryCheckpoint: {
    readonly checkpointId: string;
    readonly purpose: string;
    readonly schemaVersion: string;
  };
  readonly binaryValidation: {
    readonly pptxSlideCount: number;
    readonly staticPngCount: number;
    readonly contactSheetPngCount: number;
  };
};
assertExactObjectKeys(
  parsedRecoveryResult,
  [
    "artifactId",
    "attemptId",
    "binaryValidation",
    "browserDriverId",
    "caseId",
    "checkpointCount",
    "checkpointTraceHash",
    "derivativeCount",
    "derivativeSetHash",
    "jobId",
    "manifestHash",
    "originalHash",
    "recoveredDerivativeCount",
    "registryHash",
    "registryId",
    "renderManifestHash",
    "rootReferences",
    "runId",
    "runSpecificationHash",
    "trustedRecoveryCheckpoint",
  ],
  "Doubao recovery CLI result",
);
assertExactObjectKeys(
  parsedRecoveryResult.rootReferences,
  ["artifactRecovery", "checkpoint", "runSpecification"],
  "Doubao recovery CLI result.rootReferences",
);
assertExactObjectKeys(
  parsedRecoveryResult.trustedRecoveryCheckpoint,
  ["checkpointId", "purpose", "schemaVersion"],
  "Doubao recovery CLI result.trustedRecoveryCheckpoint",
);
assertExactObjectKeys(
  parsedRecoveryResult.binaryValidation,
  ["contactSheetPngCount", "pptxSlideCount", "staticPngCount"],
  "Doubao recovery CLI result.binaryValidation",
);
if (
  parsedRecoveryResult.registryId !== registryId ||
  parsedRecoveryResult.manifestHash !==
    manifest.artifactIdentityHash ||
  parsedRecoveryResult.originalHash !== artifactContentHash ||
  parsedRecoveryResult.renderManifestHash !==
    outcome.renderManifest.contentHash ||
  parsedRecoveryResult.derivativeCount !== 33 ||
  parsedRecoveryResult.recoveredDerivativeCount !== 33 ||
  parsedRecoveryResult.runSpecificationHash !==
    specReference.contentHash ||
  parsedRecoveryResult.checkpointCount !== checkpoints.length ||
  parsedRecoveryResult.checkpointTraceHash !==
    trustedRecoveryCheckpoint.checkpointTraceHash ||
  parsedRecoveryResult.browserDriverId !==
    "doubao-real-provider-replay" ||
  parsedRecoveryResult.trustedRecoveryCheckpoint.checkpointId !==
    DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID ||
  parsedRecoveryResult.trustedRecoveryCheckpoint.purpose !==
    "real_provider_recovery" ||
  parsedRecoveryResult.binaryValidation.pptxSlideCount !== 16 ||
  parsedRecoveryResult.binaryValidation.staticPngCount !== 16 ||
  parsedRecoveryResult.binaryValidation.contactSheetPngCount !== 1
) {
  throw new Error("Doubao recovery CLI result failed exact lineage verification");
}
await writeFile(
  join(
    resolveDurableRoot(registry, roots.operational),
    "recovery-cli-result.json",
  ),
  `${recoveryResult}\n`,
  { encoding: "utf8", mode: 0o600 },
);

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: "doubao-real-provider-replay-smoke-v1",
    status: "observed_real_provider_replay_ingest_recovered",
    execution: {
      publicHarnessReplayIngest: true,
      liveAutomatedRun: false,
      browserRerun: false,
      captureSource: "REAL_PROVIDER_CAPTURE",
      executionMode: "PRODUCTION_REPLAY",
      submitCount: 1,
      retryCount: 0,
    },
    trace: {
      timestampGranularity:
        "Attempt start/submission share the first confirmed observation; generation-ready uses the artifact-capture observation as a conservative upper bound. The vendor-reported 9m 31s is retained as a label, not converted into an invented milestone timestamp.",
      conversationUrl:
        "https://www.doubao.com/chat/38435879568317954",
      vendorTaskId: "task_38435879568317954",
      attemptStartedAt: "2026-07-27T10:34:46.000Z",
      artifactCapturedAt: "2026-07-27T10:45:58.000Z",
      vendorReportedElapsed: "9m 31s",
      manualActions: [
        ...capture.packageObservation.manualActions,
        ...capture.submission.manualActions,
        ...capture.generation.manualActions,
        ...capture.artifact.manualActions,
      ],
    },
    buildIdentity: BUILD_IDENTITY,
    artifact: {
      contentHash: outcome.artifact.contentHash,
      byteSize: outcome.artifact.byteSize,
      pageCount: outcome.artifact.pageCount,
      provenance: outcome.artifact.provenance,
    },
    render: {
      outcome: outcome.renderManifest.renderOutcome,
      fidelity: outcome.renderManifest.fidelity,
      pageCount: outcome.renderManifest.pageCount,
      staticSlideHashes: outcome.renderManifest.slides.map(
        ({ contentHash }) => contentHash,
      ),
      contactSheetHash:
        outcome.renderManifest.contactSheet.contentHash,
      contactSheetDimensions: "1280x720",
      warnings: [
        "slide 9 title clipping observed in retained render",
        "overflow checker warning retained for slides 2-16",
        "no quality retry was performed",
      ],
    },
    recovery: {
      registryId,
      registryHash: registry.registryHash,
      rootReferences: roots,
      artifactManifestHash: manifest.manifestHash,
      cliArtifactIdentityHash:
        parsedRecoveryResult.manifestHash,
      recoveredOriginalHash: sha256(recoveredArtifact.original),
      derivativeCount: manifest.derivatives.length,
      recoveredDerivativeCount:
        recoveredArtifact.derivatives.length,
      cliRenderManifestHash:
        parsedRecoveryResult.renderManifestHash,
      cliDerivativeCount: parsedRecoveryResult.derivativeCount,
      cliRecoveredDerivativeCount:
        parsedRecoveryResult.recoveredDerivativeCount,
      cliDerivativeSetHash:
        parsedRecoveryResult.derivativeSetHash,
      runSpecificationHash: specReference.contentHash,
      browserDriverEvidence:
        recoveredSpec.adapterSpecification.browserDriverEvidence,
      checkpointCount: checkpoints.length,
      checkpointTraceHash:
        parsedRecoveryResult.checkpointTraceHash,
      trustedRecoveryCheckpoint:
        parsedRecoveryResult.trustedRecoveryCheckpoint,
      binaryValidation: parsedRecoveryResult.binaryValidation,
      profileLock: capabilities.evidence.profileLock,
      recoveryCommand:
        `node --import tsx scripts/recover-doubao-production-run.ts ${recoveryArguments.join(" ")}`,
      recoveryCliExecuted: true,
      recoveryCliResultHash: sha256(recoveryResult),
      recoveryCliResultReference:
        `${roots.operational}:recovery-cli-result.json`,
    },
  }, null, 2)}\n`,
);
