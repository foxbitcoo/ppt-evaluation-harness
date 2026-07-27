import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import {
  BUILD_IDENTITY,
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
  type DoubaoRealProviderCapture,
  type EgressAuthorizationPort,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
const sha256 = (content: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
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
    observedAt: "2026-07-27T10:45:00.000Z",
    sourceUrl:
      "https://www.doubao.com/chat/ppt-retained#redacted-task-fragment",
    accountEvidence: "current_account_signed_in",
    planName: "not_visibly_exposed",
    modelName: "unknown",
    modeName: "AI PPT",
    networking: "enabled",
    requestedPageCount: 16,
    bestAvailableForCurrentAccount: true,
    incrementalChargeRequired: false,
    evidenceRef: "screenshot://doubao/preflight-retained-redacted",
    manualActions: [
      "ingested retained REAL_PROVIDER_CAPTURE without browser rerun",
    ],
  },
  submission: {
    status: "submitted",
    vendorTaskId: "task_doubao_volcano_20260727",
    observedAt: "2026-07-27T10:45:10.000Z",
    evidenceRef: "screenshot://doubao/submitted-retained-redacted",
    manualActions: [],
  },
  generation: {
    status: "generated",
    observedAt: "2026-07-27T10:54:11.000Z",
    completionUrl:
      "https://www.doubao.com/chat/ppt-retained#redacted-result-fragment",
    previewPageCount: 16,
    evidenceRef: "screenshot://doubao/generated-retained-redacted",
    manualActions: [],
  },
  artifact: {
    status: "exported",
    observedAt: "2026-07-27T10:54:31.000Z",
    filename: "doubao-volcano-16.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pageCount: 16,
    content: pptx,
    evidenceRef: "download://doubao/doubao-volcano-16.pptx",
    manualActions: ["one retained provider export; no retry"],
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
  readonly browserDriverId: string;
};
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
  parsedRecoveryResult.browserDriverId !==
    "doubao-real-provider-replay"
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
