import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import {
  BUILD_IDENTITY,
  InMemoryEgressAuthorizationAudit,
  InMemoryFeishuProjection,
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
  ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
  VOLCANO_CASE_ID,
  WPS_AIPPT_BROWSER_DRIVER_VERSION,
  WPS_AIPPT_URL,
  WpsAiPptProductAdapter,
  createBakeoffHarness,
  createHarnessOwnedProductionCapabilities,
  type EgressAuthorizationPort,
} from "../src/index.ts";
import { wpsDriverSessionIdForRequest } from "../src/wps-aippt-external-runtime.ts";

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const [
  pptxPath,
  slidesDirectory,
  primaryFailureDomainRoot,
  recoveryFailureDomainRoot,
  operationalRoot,
] = process.argv.slice(2);
if (
  pptxPath === undefined ||
  slidesDirectory === undefined ||
  primaryFailureDomainRoot === undefined ||
  recoveryFailureDomainRoot === undefined ||
  operationalRoot === undefined
) {
  throw new Error(
    "Usage: rehearse-wps-recovery <pptx> <slides-directory> <primary-failure-domain-root> <recovery-failure-domain-root> <operational-root>",
  );
}

const pptx = Uint8Array.from(await readFile(pptxPath));
const artifactContentHash = sha256(pptx);
const tombstones = new InMemoryTombstoneLedger(
  "wps-public-production-replay-tombstones-v1",
);
const payloadInventory = new InMemoryPayloadInventory(
  tombstones,
  "wps-public-production-replay-inventory-v1",
);
const egressAudit = new InMemoryEgressAuthorizationAudit();
const authorization: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `public-production-replay:${sha256(
        JSON.stringify(request),
      ).slice(7, 31)}`,
      policyVersion: "controlled-public-production-replay-v1",
      request,
      legalSecurityBasis: "authorized local retained-artifact replay",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
};

const capabilities = createHarnessOwnedProductionCapabilities({
  artifactPrimary: {
    failureDomainId: "artifact-primary-domain-v1",
    rootPath: join(primaryFailureDomainRoot, "immutable-artifacts"),
    rootReference: "root:artifact-primary-domain-v1",
    storeId: "wps-smoke-artifact-primary-v2",
  },
  artifactRecovery: {
    failureDomainId: "artifact-recovery-domain-v1",
    rootPath: join(recoveryFailureDomainRoot, "immutable-artifacts"),
    rootReference: "root:artifact-recovery-domain-v1",
    storeId: "wps-smoke-artifact-recovery-v2",
  },
  runSpecification: {
    failureDomainId: "run-spec-recovery-domain-v1",
    rootPath: join(recoveryFailureDomainRoot, "run-specifications"),
    rootReference: "root:run-spec-recovery-domain-v1",
    storeId: "wps-smoke-run-spec-recovery-v2",
  },
  checkpoint: {
    rootPath: join(operationalRoot, "attempt-checkpoints"),
    rootReference: "root:checkpoint-domain-v1",
    storeId: "wps-smoke-checkpoints-v2",
  },
  profileLock: {
    rootPath: join(operationalRoot, "browser-profile-lock"),
    rootReference: "root:profile-lock-domain-v1",
    lockId: "wps-smoke-profile-lock-v2",
  },
  renderer: {
    rendererId: "wps-retained-png-contact-sheet-renderer-v2",
    slidesDirectory,
    extractedTextPrefix: "retained WPS page",
    fontPack: "local-observed",
    resolution: "retained-native-size",
    colorProfile: "sRGB",
    fidelityNotes: [
      "retained local render substituted or omitted Chinese glyphs",
    ],
  },
  tombstones,
  payloadInventory,
  egressAuthorization: authorization,
  egressAudit,
});

const vendorTaskId = "task_wps_public_replay_20260727" as const;
const taskStateVersion = "artifact_ready@6";
const evidenceIds = [
  "ev_0000000000000201",
  "ev_0000000000000202",
] as const;

const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
      if (
        chunks.reduce((sum, item) => sum + item.byteLength, 0) >
        2 * 1024 * 1024
      ) {
        throw new Error("Replay bridge request exceeded its bound");
      }
    }
    const body = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as {
      readonly requestId: string;
      readonly commandHash: `sha256:${string}`;
      readonly command: {
        readonly jobId: string;
        readonly runId: string;
        readonly attemptId: string;
        readonly attemptSeq: number;
      };
    };
    if (
      request.method !== "POST" ||
      request.url !== "/v1/wps-aippt/run" ||
      body.commandHash !== sha256(JSON.stringify(body.command))
    ) {
      response.writeHead(400).end();
      return;
    }
    const artifactId =
      `${body.command.attemptId}-artifact-${artifactContentHash.slice(7, 23)}`;
    const events = [
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
        artifactId,
      },
    ] as const;
    const observableEvents = events.map((event, index) => ({
      eventId: `${body.command.attemptId}-wps-event-${index + 1}`,
      jobId: body.command.jobId,
      caseId: VOLCANO_CASE_ID,
      runId: body.command.runId,
      attemptId: body.command.attemptId,
      attemptSeq: body.command.attemptSeq,
      eventType: event.eventType,
      sourceAt: event.sourceAt,
      observedAt: event.observedAt,
      writerId: "wps-aippt-browser@1",
      evidenceRef: event.evidenceId,
      sourceUrl: event.sourceUrl,
      submissionEvidenceAtCheckpoint:
        event.submissionEvidenceAtCheckpoint,
      vendorTaskId: event.vendorTaskId,
      taskStateVersion: event.taskStateVersion,
      adapterVersion: event.adapterVersion,
      artifactId: event.artifactId,
    }));
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
    });
    for (const event of events) {
      response.write(
        `${JSON.stringify({
          type: "checkpoint",
          requestId: body.requestId,
          commandHash: body.commandHash,
          event,
        })}\n`,
      );
    }
    response.end(
      `${JSON.stringify({
        type: "result",
        requestId: body.requestId,
        commandHash: body.commandHash,
        result: {
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
            packageSelection:
              "best_available_zero_incremental_cost",
            incrementalCost: 0,
            mode: "professional",
            networking: "enabled",
            pageCount: 16,
            evidenceIds,
            accountCategoryObservation: {
              status: "ui_unavailable",
              reason:
                "account category UI was not retained in the historical capture",
              evidenceId: evidenceIds[0],
            },
            commercialPlanObservation: {
              status: "ui_unavailable",
              reason:
                "commercial plan UI was not retained in the historical capture",
              evidenceId: evidenceIds[1],
            },
          },
          artifact: {
            filename: "wps-volcano-16.pptx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            contentBase64: Buffer.from(pptx).toString("base64"),
            pageCount: 16,
            capturedAt: "2026-07-27T06:02:01.000Z",
          },
          events: [],
          manualActions: [
            "replayed retained production capture through controlled bridge",
          ],
          productionExecutionEvidence: {
            driverSessionId: wpsDriverSessionIdForRequest(
              body.requestId,
            ),
            vendorTaskId,
            taskStateVersion,
            driverVersion: WPS_AIPPT_BROWSER_DRIVER_VERSION,
            adapterVersion: "wps-aippt-browser@1",
            outcome: "captured",
            artifactContentHash,
            traceHash: sha256(JSON.stringify(observableEvents)),
          },
        },
      })}\n`,
    );
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(47821, "127.0.0.1", () => resolveListen());
});

try {
  const feishu = new InMemoryFeishuProjection({
    targetEnvironment: "production",
  });
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: new WpsAiPptProductAdapter(),
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
    outcome.artifact.contentHash !== artifactContentHash
  ) {
    throw new Error("Public production replay did not capture the Artifact");
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
    artifactManifest.productionExecutionEvidence === null ||
    artifactManifest.productionExecutionEvidence === undefined
  ) {
    throw new Error(
      "Public production replay omitted execution or recovery evidence",
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
    throw new Error("Public production durable recovery verification failed");
  }
  const contactSheet = outcome.renderManifest.contactSheet.content;
  if (!(contactSheet instanceof Uint8Array)) {
    throw new Error("Public production contact sheet is not PNG bytes");
  }
  const contactMetadata = await sharp(Buffer.from(contactSheet)).metadata();
  if (contactMetadata.width !== 1280 || contactMetadata.height !== 720) {
    throw new Error("Public production contact sheet is not a 4x4 mosaic");
  }
  const recoveryLocations =
    artifactManifest.payloadLocations.filter(
      ({ copyRole, key }) =>
        copyRole === "secondary" &&
        (key.endsWith("/original") || key.endsWith("/manifest")),
    );
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "public_production_replay_recovered",
        publicProductionHarness: true,
        browserRerun: false,
        controlledBridge: {
          endpoint: "http://127.0.0.1:47821/v1/wps-aippt/run",
          oneTimeRequestCorrelation: true,
        },
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
          capabilities.runSpecificationVault.retentionLocation(
            specificationReference,
          ),
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
        recoveryCommand:
          "node --import tsx scripts/recover-wps-production-run.ts <artifact-recovery-root> <run-spec-root> <checkpoint-root> <artifact-store-id> <manifest-key> <original-key> <run-spec-store-id> <run-spec-key> <checkpoint-store-id> <attempt-id>",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });
}
