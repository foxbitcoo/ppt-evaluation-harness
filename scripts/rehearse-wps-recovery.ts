import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import {
  BUILD_IDENTITY,
  InMemoryEgressAuthorizationAudit,
  InMemoryFeishuProjection,
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
  ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
  VOLCANO_CASE_ID,
  WPS_AIPPT_URL,
  WpsAiPptReplayAdapter,
  createBakeoffHarness,
  createHarnessOwnedProductionCapabilities,
  createWpsAiPptRealProviderReplayPackage,
  registerDurableRoots,
  resolveDurableRoot,
  retainedRehearsalRoot,
  type EgressAuthorizationPort,
  type WpsAiPptCapturedBrowserResult,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const [pptxPath, slidesDirectory, registryId] =
  process.argv.slice(2);
if (
  pptxPath === undefined ||
  slidesDirectory === undefined ||
  registryId === undefined
) {
  throw new Error(
    "Usage: rehearse-wps-recovery <retained-real-pptx> <retained-png-directory> <registry-id>",
  );
}

const retainedRoot = retainedRehearsalRoot(registryId);
const rootReferences = Object.freeze({
  artifactPrimary: "root:wps-replay-artifact-primary",
  artifactRecovery: "root:wps-replay-artifact-recovery",
  runSpecification: "root:wps-replay-run-specification",
  checkpoint: "root:wps-replay-checkpoint",
  profileLock: "root:wps-replay-profile-lock",
  operational: "root:wps-replay-operational",
});
const registry = await registerDurableRoots({
  registryId,
  roots: [
    {
      rootReference: rootReferences.artifactPrimary,
      absolutePath: join(retainedRoot, "artifact-primary"),
    },
    {
      rootReference: rootReferences.artifactRecovery,
      absolutePath: join(retainedRoot, "artifact-recovery"),
    },
    {
      rootReference: rootReferences.runSpecification,
      absolutePath: join(retainedRoot, "run-specification"),
    },
    {
      rootReference: rootReferences.checkpoint,
      absolutePath: join(retainedRoot, "checkpoint"),
    },
    {
      rootReference: rootReferences.profileLock,
      absolutePath: join(retainedRoot, "profile-lock"),
    },
    {
      rootReference: rootReferences.operational,
      absolutePath: join(retainedRoot, "operational"),
    },
  ],
});

const pptx = Uint8Array.from(await readFile(pptxPath));
const artifactContentHash = sha256(pptx);
const retainedRenderedPages = await Promise.all(
  Array.from({ length: 16 }, async (_, index) => {
    const pageNumber = index + 1;
    return {
      pageNumber,
      filename:
        `slide-${String(pageNumber).padStart(2, "0")}.png`,
      mimeType: "image/png" as const,
      content: Uint8Array.from(
        await readFile(
          join(
            slidesDirectory,
            `slide-${String(pageNumber).padStart(2, "0")}.png`,
          ),
        ),
      ),
    };
  }),
);
const tombstones = new InMemoryTombstoneLedger(
  "wps-real-provider-replay-tombstones-v3",
);
const payloadInventory = new InMemoryPayloadInventory(
  tombstones,
  "wps-real-provider-replay-inventory-v3",
);
const egressAudit = new InMemoryEgressAuthorizationAudit();
const authorization: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `real-provider-replay:${sha256(
        JSON.stringify(request),
      ).slice(7, 31)}`,
      policyVersion: "real-provider-replay-ingest-v1",
      request,
      legalSecurityBasis: "authorized retained real-provider capture ingest",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
};

const capabilities = createHarnessOwnedProductionCapabilities({
  artifactPrimary: {
    operatorDomainLabel: "local-artifact-primary-copy",
    rootPath: resolveDurableRoot(
      registry,
      rootReferences.artifactPrimary,
    ),
    rootReference: rootReferences.artifactPrimary,
    storeId: "wps-replay-artifact-primary-v3",
  },
  artifactRecovery: {
    operatorDomainLabel: "local-artifact-recovery-copy",
    rootPath: resolveDurableRoot(
      registry,
      rootReferences.artifactRecovery,
    ),
    rootReference: rootReferences.artifactRecovery,
    storeId: "wps-replay-artifact-recovery-v3",
  },
  runSpecification: {
    operatorDomainLabel: "local-run-specification-copy",
    rootPath: resolveDurableRoot(
      registry,
      rootReferences.runSpecification,
    ),
    rootReference: rootReferences.runSpecification,
    storeId: "wps-replay-run-specification-v3",
  },
  checkpoint: {
    rootPath: resolveDurableRoot(
      registry,
      rootReferences.checkpoint,
    ),
    rootReference: rootReferences.checkpoint,
    storeId: "wps-replay-checkpoints-v3",
  },
  profileLock: {
    rootPath: resolveDurableRoot(
      registry,
      rootReferences.profileLock,
    ),
    rootReference: rootReferences.profileLock,
    lockId: "wps-replay-profile-lock-v3",
  },
  renderer: {
    rendererId: "wps-retained-real-png-renderer-v3",
    slidesDirectory,
    extractedTextPrefix: "retained real WPS page",
    fontPack: "local-observed",
    resolution: "retained-native-size",
    colorProfile: "sRGB",
    fidelityNotes: [
      "retained local render may substitute or omit Chinese glyphs",
    ],
  },
  tombstones,
  payloadInventory,
  egressAuthorization: authorization,
  egressAudit,
});

const vendorTaskId = "task_wps_real_capture_20260727" as const;
const taskStateVersion = "artifact_ready@6";
const evidenceIds = [
  "ev_0000000000000201",
  "ev_0000000000000202",
] as const;
const replayResult: WpsAiPptCapturedBrowserResult = {
  outcome: "captured",
  submissionEvidence: "submitted",
  elapsedMs: 121_000,
  observedConfiguration: {
    productUrl: WPS_AIPPT_URL,
    accountScope: "current_authenticated_account",
    accountObservationPolicy:
      "observe_category_or_record_ui_unavailable",
    commercialPlanObservationPolicy:
      "observe_plan_name_or_record_ui_unavailable",
    packageSelection: "best_available_zero_incremental_cost",
    incrementalCost: 0,
    mode: "professional",
    networking: "enabled",
    pageCount: 16,
    evidenceIds,
    accountCategoryObservation: {
      status: "ui_unavailable",
      reason:
        "account category UI was not retained in the real-provider capture",
      evidenceId: evidenceIds[0],
    },
    commercialPlanObservation: {
      status: "ui_unavailable",
      reason:
        "commercial plan UI was not retained in the real-provider capture",
      evidenceId: evidenceIds[1],
    },
  },
  events: [
    {
      eventType: "configuration_observed",
      sourceAt: "2026-07-27T06:00:00.000Z",
      observedAt: "2026-07-27T06:00:01.000Z",
      evidenceId: evidenceIds[0],
      sourceUrl: WPS_AIPPT_URL,
      submissionEvidenceAtCheckpoint: "not_submitted",
      vendorTaskId,
      taskStateVersion: "created@1",
      adapterVersion: "wps-aippt-browser@1",
      artifactId: null,
    },
    {
      eventType: "artifact_downloaded",
      sourceAt: "2026-07-27T06:02:00.000Z",
      observedAt: "2026-07-27T06:02:01.000Z",
      evidenceId: evidenceIds[1],
      sourceUrl: "https://365.kdocs.cn/l/redacted",
      submissionEvidenceAtCheckpoint: "submitted",
      vendorTaskId,
      taskStateVersion,
      adapterVersion: "wps-aippt-browser@1",
      artifactId: "artifact_wps_retained_real_capture",
    },
  ],
  manualActions: [
    "ingested retained REAL_PROVIDER_CAPTURE without live browser automation",
  ],
  artifact: {
    filename: "wps-volcano-16.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    content: pptx,
    pageCount: 16,
    capturedAt: "2026-07-27T06:02:01.000Z",
  },
};

const feishu = new InMemoryFeishuProjection({
  targetEnvironment: "production",
});
const outcome = await createBakeoffHarness({
  feishu,
  productAdapter: new WpsAiPptReplayAdapter(),
  wpsAiPptBrowserDriver:
    createWpsAiPptRealProviderReplayPackage({
      captureId:
        "wps-real-provider-20260728-round5-resolution-final",
      sessions: [replayResult],
      renderedPages: retainedRenderedPages,
    }),
  egressAuthorization: authorization,
  egressAudit,
  payloadInventory,
  tombstones,
  rendererDestination:
    ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
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
    "Public replay ingest did not capture a PRODUCTION_REPLAY Artifact",
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
const artifactManifest = vendorRun?.artifactPackageManifest;
const specificationReference = vendorRun?.specificationReference;
if (
  attempt === undefined ||
  artifactManifest === null ||
  artifactManifest === undefined ||
  specificationReference === null ||
  specificationReference === undefined ||
  artifactManifest.productionExecutionEvidence?.executionMode !==
    "PRODUCTION_REPLAY" ||
  artifactManifest.productionExecutionEvidence.captureSource !==
    "REAL_PROVIDER_CAPTURE"
) {
  throw new Error(
    "Replay ingest omitted downgraded execution or recovery evidence",
  );
}

const recoveredArtifact =
  await capabilities.artifactVault.readFromSecondary(
    artifactManifest,
  );
const recoveredSpecification =
  await capabilities.runSpecificationVault.read(
    specificationReference,
  );
const recoveredCheckpoints =
  await capabilities.attemptCheckpointStore.readAttempt?.(
    attempt.recordId,
  );
if (
  recoveredArtifact.original.byteLength !== pptx.byteLength ||
  sha256(recoveredArtifact.original) !== artifactContentHash ||
  recoveredArtifact.derivatives.length !== 33 ||
  recoveredSpecification.evaluationCase.provenance !== "PRODUCTION" ||
  recoveredCheckpoints?.length !== 2
) {
  throw new Error("Replay ingest durable recovery verification failed");
}
const contactSheet = outcome.renderManifest.contactSheet.content;
if (!(contactSheet instanceof Uint8Array)) {
  throw new Error("Replay contact sheet is not PNG bytes");
}
const contactMetadata = await sharp(Buffer.from(contactSheet)).metadata();
if (contactMetadata.width !== 1280 || contactMetadata.height !== 720) {
  throw new Error("Replay contact sheet is not a 4x4 mosaic");
}

const recoveryLocations =
  artifactManifest.payloadLocations.filter(
    ({ copyRole, key }) =>
      copyRole === "secondary" &&
      (key.endsWith("/original") || key.endsWith("/manifest")),
  );
const originalLocation = recoveryLocations.find(({ key }) =>
  key.endsWith("/original"),
);
const manifestLocation = recoveryLocations.find(({ key }) =>
  key.endsWith("/manifest"),
);
if (originalLocation === undefined || manifestLocation === undefined) {
  throw new Error("Replay recovery locations are incomplete");
}
const runSpecificationLocation =
  capabilities.runSpecificationVault.retentionLocation(
    specificationReference,
  );
const recoveryArguments = [
  registryId,
  rootReferences.artifactRecovery,
  rootReferences.runSpecification,
  rootReferences.checkpoint,
  capabilities.evidence.artifactRecovery.storeId,
  manifestLocation.key,
  originalLocation.key,
  capabilities.evidence.runSpecification.storeId,
  runSpecificationLocation.key,
  capabilities.attemptCheckpointStore.checkpointStoreId,
  attempt.recordId,
];
const recoveryCommand =
  `node --import tsx scripts/recover-wps-production-run.ts ${recoveryArguments.join(" ")}`;
const recoveryCli = await execFileAsync(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/recover-wps-production-run.ts",
    ...recoveryArguments,
  ],
  { cwd: new URL("..", import.meta.url).pathname },
);
const recoveryCliResult = recoveryCli.stdout.trim();
const recoveryCliResultHash = sha256(recoveryCliResult);
await writeFile(
  join(
    resolveDurableRoot(registry, rootReferences.operational),
    "recovery-cli-result.json",
  ),
  `${recoveryCliResult}\n`,
  { encoding: "utf8", mode: 0o600 },
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "observed_real_provider_replay_ingest_recovered",
      publicHarnessReplayIngest: true,
      liveAutomatedRun: false,
      browserRerun: false,
      captureSource: "REAL_PROVIDER_CAPTURE",
      executionMode: "PRODUCTION_REPLAY",
      buildIdentity: BUILD_IDENTITY,
      artifactContentHash,
      artifactManifestHash: artifactManifest.manifestHash,
      artifactIdentityHash:
        artifactManifest.artifactIdentityHash,
      executionEvidencePresent: true,
      renderManifestHash: outcome.renderManifest.contentHash,
      contactSheetHash:
        outcome.renderManifest.contactSheet.contentHash,
      contactSheetDimensions: "1280x720",
      derivativeCount: artifactManifest.derivatives.length,
      recoveredDerivativeCount:
        recoveredArtifact.derivatives.length,
      recoveredOriginalHash: sha256(recoveredArtifact.original),
      artifactRecoveryLocations: recoveryLocations,
      runSpecificationRecoveryLocation:
        runSpecificationLocation,
      recoveredRunSpecificationCaseProvenance:
        recoveredSpecification.evaluationCase.provenance,
      checkpointRecovery: {
        storeId:
          capabilities.attemptCheckpointStore.checkpointStoreId,
        attemptId: attempt.recordId,
        recoveredCheckpointCount:
          recoveredCheckpoints.length,
        replayAvailable: true,
      },
      capabilityEvidence: capabilities.evidence,
      durableRootRegistry: {
        registryId,
        registryHash: registry.registryHash,
        rootReferences,
      },
      recoveryCommand,
      recoveryCliResultReference:
        `${rootReferences.operational}:recovery-cli-result.json`,
      recoveryCliResultHash,
    },
    null,
    2,
  )}\n`,
);
