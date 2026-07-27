import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  MockWpsProductAdapter,
  InMemoryAttemptCheckpointStore,
  InMemoryFeishuProjection,
  ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  VOLCANO_EVALUATION_CASE,
  VENDOR_GENERATION_TIMEOUT_MS,
  WPS_AIPPT_URL,
  WpsAiPptProductAdapter,
  createWpsAiPptBrowserDriverPackage,
  createBakeoffHarness,
  parseAdapterExecutionConfiguration,
  type ProductAttemptResult,
  type ProductAdapterPort,
  type AttemptDeadlinePort,
  type EgressAuthorizationPort,
  type WpsAiPptBrowserDriverPort,
  type WpsAiPptBrowserResult,
  type WpsAiPptCapturedBrowserResult,
} from "../src/index.ts";
import { resolveHarnessProductAdapterExecutor } from "../src/mock-wps.ts";

test("the WPS AI PPT production adapter is a pure-data descriptor for the frozen package", () => {
  const adapter: ProductAdapterPort = new WpsAiPptProductAdapter();

  assert.equal(WPS_AIPPT_URL, "https://aippt.wps.cn/aippt/");
  assert.deepEqual(adapter.productPackage.experienceConfiguration, {
    productUrl: WPS_AIPPT_URL,
    accountScope: "current_authenticated_account",
    accountIdentityObservation: "unknown",
    commercialPlanObservation: "unknown",
    packageSelection: "best_available_zero_incremental_cost",
    incrementalCost: 0,
    mode: "professional",
    networking: "enabled",
    pageCount: 16,
  });
  assert.equal(adapter.productPackage.provenance, "PRODUCTION");
  assert.equal(
    adapter.productPackage.environmentOrigin.environment,
    "production",
  );
  assert.equal(
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ).adapterKind,
    "wps-aippt-browser",
  );
  assert.equal("execute" in adapter, false);
  assert.equal("factory" in adapter, false);
});

async function knownGoodPptxBytes(): Promise<Uint8Array> {
  const mock = new MockWpsProductAdapter();
  const execute = resolveHarnessProductAdapterExecutor(
    mock.implementationPackage,
    parseAdapterExecutionConfiguration(
      mock.executionConfigurationPackage,
    ),
  );
  const artifact = await execute({
    jobId: "fixture-job",
    runId: "fixture-run",
    attemptId: "fixture-attempt",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok("content" in artifact);
  return artifact.content;
}

function capturedBrowserResult(
  pptx: Uint8Array,
  submissionEvidence: "submitted" | "unknown" = "submitted",
  renderOutcome: "faithful" | "degraded" = "faithful",
): WpsAiPptCapturedBrowserResult {
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return {
    outcome: "captured",
    submissionEvidence,
    elapsedMs: 120_000,
    observedConfiguration: {
      productUrl: WPS_AIPPT_URL,
      accountScope: "current_authenticated_account",
      accountIdentityObservation: "unknown",
      commercialPlanObservation: "unknown",
      packageSelection: "best_available_zero_incremental_cost",
      incrementalCost: 0,
      mode: "professional",
      networking: "enabled",
      pageCount: 16,
      evidenceIds: [
        "ev_0000000000000001",
        "ev_0000000000000002",
      ],
    },
    events: [
      {
        eventType: "configuration_observed",
        sourceAt: "2026-07-27T06:00:00.000Z",
        observedAt: "2026-07-27T06:00:01.000Z",
        evidenceId: "ev_0000000000000001",
        sourceUrl:
          "https://aippt.wps.cn/aippt/?task=redacted#step",
        submissionEvidenceAtCheckpoint: "not_submitted",
      },
      {
        eventType: "artifact_downloaded",
        sourceAt: "2026-07-27T06:02:00.000Z",
        observedAt: "2026-07-27T06:02:01.000Z",
        evidenceId: "ev_0000000000000002",
        sourceUrl: "https://365.kdocs.cn/l/redacted?auth=removed",
        submissionEvidenceAtCheckpoint: "submitted",
      },
    ],
    manualActions: ["selected professional mode"],
    artifact: {
      filename: "wps-volcano-16.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: pptx,
      pageCount: 16,
      capturedAt: "2026-07-27T06:02:01.000Z",
    },
    render: {
      renderer: "chrome-native-static-capture@1",
      fontPack: "wps-web-current",
      resolution: "1280x720",
      colorProfile: "sRGB",
      redactionStatus: "passed",
      renderOutcome,
      fidelity: {
        status: renderOutcome === "faithful" ? "verified" : "degraded",
        notes:
          renderOutcome === "faithful"
            ? []
            : ["local renderer substituted Chinese glyphs"],
      },
      slides: Array.from({ length: 16 }, (_, index) => {
        const pageNumber = index + 1;
        return {
          pageNumber,
          filename: `slide-${pageNumber}.png`,
          mimeType: "image/png" as const,
          content: png,
          extractedText: `WPS page ${pageNumber}`,
        };
      }),
      contactSheet: {
        filename: "contact-sheet.png",
        mimeType: "image/png",
        content: png,
      },
    },
  };
}

function browserDriverPackage(
  result: WpsAiPptBrowserResult,
  provenance: "PRODUCTION" | "TEST_FAKE" = "TEST_FAKE",
): WpsAiPptBrowserDriverPort {
  return createWpsAiPptBrowserDriverPackage({
    provenance,
    sessions: [result],
  });
}

function testWpsBoundaryAdapter(
  packageId = "MOCK-wps-aippt-browser-package-v1",
): ProductAdapterPort {
  const productionAdapter = new WpsAiPptProductAdapter();
  return {
    implementationPackage:
      productionAdapter.implementationPackage,
    executionConfigurationPackage:
      productionAdapter.executionConfigurationPackage,
    productPackage: {
      ...productionAdapter.productPackage,
      packageId,
      displayName: "Mock-boundary WPS AI PPT",
      provenance: "MOCK",
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      egressDestination: {
        targetService: "mock-wps-aippt-browser",
        targetAccount: "mock-current-account",
        targetRegion: "test",
        subprocessors: [],
      },
    },
  };
}

test("the trusted registry executes the WPS package only through the registered browser-driver package", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(capturedBrowserResult(pptx));
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "test-wps-checkpoints",
  );

  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: driver,
      attemptCheckpointStore: checkpoints,
    },
  );
  const result = (await execute({
    jobId: "job-wps-real",
    runId: "run-wps-real",
    attemptId: "attempt-wps-real-1",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  })) as ProductAttemptResult;

  assert.equal(result.terminalReason, "success");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(result.artifactCandidates.length, 1);
  assert.equal(
    result.artifactCandidates[0]?.artifact.provenance,
    "MOCK",
  );
  assert.equal(
    result.artifactCandidates[0]?.artifact.pageCount,
    16,
  );
  assert.equal(
    result.artifactCandidates[0]?.safeRasterCandidate?.slides.length,
    16,
  );
  assert.match(
    result.artifactCandidates[0]?.artifact.contentHash ?? "",
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(
    result.observableEvents?.map(({ eventType }) => eventType),
    ["configuration_observed", "artifact_downloaded"],
  );
  assert.deepEqual(
    checkpoints.snapshot().map((event) => ({
      evidenceRef: event.evidenceRef,
      sourceUrl: event.sourceUrl,
      submissionEvidenceAtCheckpoint:
        event.submissionEvidenceAtCheckpoint,
    })),
    [
      {
        evidenceRef: "ev_0000000000000001",
        sourceUrl: "https://aippt.wps.cn/aippt/",
        submissionEvidenceAtCheckpoint: "not_submitted",
      },
      {
        evidenceRef: "ev_0000000000000002",
        sourceUrl: "https://365.kdocs.cn/l/redacted",
        submissionEvidenceAtCheckpoint: "submitted",
      },
    ],
  );
});

test("production rejects an arbitrary browser closure that is not backed by the harness allowlist packages", async () => {
  const forgedDriver = {
    driverId: "wps-aippt-captured-chrome-session",
    provenance: "PRODUCTION",
    async run() {
      throw new Error("must never execute");
    },
  } as unknown as WpsAiPptBrowserDriverPort;

  await assert.rejects(
    async () =>
      createBakeoffHarness({
        feishu: new InMemoryFeishuProjection({
          targetEnvironment: "production",
        }),
        productAdapter: new WpsAiPptProductAdapter(),
        wpsAiPptBrowserDriver: forgedDriver,
        rendererDestination:
          ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
      egressAuthorization: {
          async authorize() {
            throw new Error("driver allowlist must run before egress");
          },
        },
        specCommitSha:
          "ee115b77abe05dae522fdf8c878bc7d701b3dcc1",
      }).startBakeoffJob({
        environment: "production",
        caseId: VOLCANO_EVALUATION_CASE.caseId,
      }),
    /registered browser driver package|implementation package.*allowlisted/i,
  );
});

test("production requires an explicit frozen spec commit instead of the stale test default", async () => {
  const pptx = await knownGoodPptxBytes();
  await assert.rejects(
    async () =>
      createBakeoffHarness({
        feishu: new InMemoryFeishuProjection({
          targetEnvironment: "production",
        }),
        productAdapter: new WpsAiPptProductAdapter(),
        wpsAiPptBrowserDriver: browserDriverPackage(
          capturedBrowserResult(pptx),
          "PRODUCTION",
        ),
        egressAuthorization: {
          async authorize() {
            throw new Error("spec identity must be checked before egress");
          },
        },
      }).startBakeoffJob({
        environment: "production",
        caseId: VOLCANO_EVALUATION_CASE.caseId,
      }),
    /production.*explicit.*spec commit/i,
  );
});

test("the Bakeoff harness owns WPS browser-driver injection and still blocks production lineage in test", async () => {
  const driver = createWpsAiPptBrowserDriverPackage({
    provenance: "TEST_FAKE",
    sessions: [],
  });

  await assert.rejects(
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection(),
      productAdapter: new WpsAiPptProductAdapter(),
      wpsAiPptBrowserDriver: driver,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /test rejected Product Package/,
  );
});

test("WPS observable Trace rejects credential-bearing evidence before persistence", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const driver = browserDriverPackage({
        outcome: "technical_failure",
        submissionEvidence: "unknown",
        elapsedMs: 1,
        events: [
          {
            eventType: "submission_reconcile_failed access_token",
            sourceAt: "2026-07-27T06:00:00.000Z",
            observedAt: "2026-07-27T06:00:01.000Z",
            evidenceId: "ev_0000000000000003",
            sourceUrl: "https://aippt.wps.cn/aippt/",
            submissionEvidenceAtCheckpoint: "unknown",
          },
        ],
        manualActions: [],
      });
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { wpsAiPptBrowserDriver: driver },
  );

  await assert.rejects(
    execute({
      jobId: "job-wps-trace",
      runId: "run-wps-trace",
      attemptId: "attempt-wps-trace-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /not safe to persist/,
  );
});

test("a captured WPS Artifact must carry proved submission evidence", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(
    capturedBrowserResult(pptx, "unknown"),
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { wpsAiPptBrowserDriver: driver },
  );

  await assert.rejects(
    execute({
      jobId: "job-wps-unknown",
      runId: "run-wps-unknown",
      attemptId: "attempt-wps-unknown-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /captured Artifact requires submitted evidence/,
  );
});

test("the WPS adapter rejects a PPTX whose ZIP central-directory CRC does not match its entry bytes", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const corrupted = Uint8Array.from(await knownGoodPptxBytes());
  const view = new DataView(
    corrupted.buffer,
    corrupted.byteOffset,
    corrupted.byteLength,
  );
  let centralOffset = -1;
  for (let offset = 0; offset + 46 <= corrupted.byteLength; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      centralOffset = offset;
      break;
    }
  }
  assert.notEqual(centralOffset, -1);
  view.setUint32(
    centralOffset + 16,
    view.getUint32(centralOffset + 16, true) ^ 0xffffffff,
    true,
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: browserDriverPackage(
        capturedBrowserResult(corrupted),
      ),
    },
  );

  await assert.rejects(
    execute({
      jobId: "job-wps-crc",
      runId: "run-wps-crc",
      attemptId: "attempt-wps-crc-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /CRC|ZIP|OPC/i,
  );
});

test("the harness persists WPS observable Trace and the driver-provided 16-page static render", async () => {
  const productionAdapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(capturedBrowserResult(pptx));
  const testDescriptor: ProductAdapterPort = {
    implementationPackage:
      productionAdapter.implementationPackage,
    executionConfigurationPackage:
      productionAdapter.executionConfigurationPackage,
    productPackage: {
      ...productionAdapter.productPackage,
      packageId: "MOCK-wps-aippt-browser-package-v1",
      displayName: "Mock-boundary WPS AI PPT",
      provenance: "MOCK",
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      egressDestination: {
        targetService: "mock-wps-aippt-browser",
        targetAccount: "mock-current-account",
        targetRegion: "test",
        subprocessors: [],
      },
    },
  };
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: testDescriptor,
    wpsAiPptBrowserDriver: driver,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(
    outcome.renderManifest?.renderer,
    "chrome-native-static-capture@1",
  );
  assert.equal(outcome.renderManifest?.slides.length, 16);
  const attempt = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordType }) => recordType === "evaluation_attempt",
    );
  assert.deepEqual(
    attempt?.observableEvents?.map(({ eventType }) => eventType),
    ["configuration_observed", "artifact_downloaded"],
  );
  assert.deepEqual(attempt?.manualActions, [
    "selected professional mode",
  ]);
});

test("the public WPS real-smoke fixture records one safe 16-page capture without browser secrets or local paths", () => {
  const fixtureText = readFileSync(
    new URL(
      "../docs/smoke/wps-aippt-real-smoke-2026-07-27.json",
      import.meta.url,
    ),
    "utf8",
  );
  const fixture = JSON.parse(fixtureText) as {
    artifact: {
      byteSize: number;
      contentHash: string;
      pageCount: number;
    };
    execution: {
      retryCount: number;
      submitCount: number;
    };
    observableEvents: Array<{ eventType: string }>;
    render: {
      contactSheetHash: string;
      fidelityStatus: string;
      outcome: string;
      pageCount: number;
      staticSlideHashes: string[];
      visualAssessment: string;
    };
    productionHarness: {
      checkpointCount: number;
      derivativeCount: number;
      environment: string;
      provenance: string;
      protocolId: string;
      specCommitSha: string;
      status: string;
    };
    productPackage: {
      accountIdentityObservation: string;
      commercialPlanObservation: string;
    };
  };

  assert.equal(fixture.execution.submitCount, 1);
  assert.equal(fixture.execution.retryCount, 0);
  assert.equal(fixture.artifact.pageCount, 16);
  assert.equal(fixture.render.pageCount, 16);
  assert.equal(fixture.render.outcome, "degraded");
  assert.equal(fixture.render.fidelityStatus, "degraded");
  assert.equal(fixture.render.visualAssessment, "NOT_ASSESSABLE");
  assert.equal(fixture.render.staticSlideHashes.length, 16);
  assert.match(fixture.render.contactSheetHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    {
      environment: fixture.productionHarness.environment,
      status: fixture.productionHarness.status,
      provenance: fixture.productionHarness.provenance,
      protocolId: fixture.productionHarness.protocolId,
      checkpointCount: fixture.productionHarness.checkpointCount,
      derivativeCount: fixture.productionHarness.derivativeCount,
    },
    {
      environment: "production",
      status: "completed",
      provenance: "PRODUCTION",
      protocolId: "production-query-default-cost-v1",
      checkpointCount: 6,
      derivativeCount: 33,
    },
  );
  assert.equal(fixture.productionHarness.specCommitSha.length, 40);
  assert.equal(
    fixture.productPackage.accountIdentityObservation,
    "unknown",
  );
  assert.equal(
    fixture.productPackage.commercialPlanObservation,
    "unknown",
  );
  assert.equal(
    fixture.artifact.contentHash,
    "sha256:c87cf5bd16ee81ebd72bd2e1df9705e4336576d5f6976323de3925d886b54e86",
  );
  assert.equal(fixture.artifact.byteSize, 1_805_544);
  assert.deepEqual(
    fixture.observableEvents.map(({ eventType }) => eventType),
    [
      "home_loaded",
      "professional_mode_observed",
      "query_submitted",
      "network_search_observed",
      "intent_confirmed",
      "outline_completed_16_pages",
      "artifact_generation_completed",
      "cloud_editor_opened",
      "artifact_downloaded",
      "static_render_completed_degraded",
    ],
  );
  assert.doesNotMatch(
    fixtureText,
    /cookie|authorization|bearer|token|password|localstorage|sessionstorage|\/Users\/|\/tmp\/|"account(?:Id|Name|Email)"\s*:/i,
  );
});

test("the public harness completes a production WPS Run through authorized projection and ArtifactVault capture", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(
    capturedBrowserResult(pptx),
    "PRODUCTION",
  );
  const egressAuthorization: EgressAuthorizationPort = {
    async authorize(request) {
      return {
        status: "approved",
        decisionId: `production-approved:${request.requestId}`,
        policyVersion: "production-public-synthetic-v1",
        request,
        legalSecurityBasis: "authorized public synthetic evaluation",
        approvedAt: request.requestedAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
  };
  const feishu = new InMemoryFeishuProjection({
    targetEnvironment: "production",
  });

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: adapter,
    wpsAiPptBrowserDriver: driver,
    egressAuthorization,
    rendererDestination:
      ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
    specCommitSha:
      "ee115b77abe05dae522fdf8c878bc7d701b3dcc1",
  }).startBakeoffJob({
    environment: "production",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(outcome.job.environment, "production");
  assert.equal(outcome.job.provenance, "PRODUCTION");
  assert.equal(outcome.artifact?.provenance, "PRODUCTION");
  assert.equal(outcome.artifact?.pageCount, 16);
  assert.equal(
    feishu
      .snapshot()
      .runRecordTable.find(({ recordType }) => recordType === "vendor_run")
      ?.artifactPackageManifest
      ?.artifact.contentHash,
    outcome.artifact?.contentHash,
  );
});

test("a degraded production raster is captured but visual dimensions are NOT_ASSESSABLE and comparison is prohibited", async () => {
  const pptx = await knownGoodPptxBytes();
  const feishu = new InMemoryFeishuProjection({
    targetEnvironment: "production",
  });
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: new WpsAiPptProductAdapter(),
    wpsAiPptBrowserDriver: browserDriverPackage(
      capturedBrowserResult(pptx, "submitted", "degraded"),
      "PRODUCTION",
    ),
    egressAuthorization: {
      async authorize(request) {
        return {
          status: "approved",
          decisionId: `production-approved:${request.requestId}`,
          policyVersion: "production-public-synthetic-v1",
          request,
          legalSecurityBasis: "authorized public synthetic evaluation",
          approvedAt: request.requestedAt,
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    rendererDestination:
      ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
    specCommitSha:
      "ee115b77abe05dae522fdf8c878bc7d701b3dcc1",
  }).startBakeoffJob({
    environment: "production",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(outcome.renderManifest?.renderOutcome, "degraded");
  assert.deepEqual(outcome.renderManifest?.fidelity, {
    status: "degraded",
    notes: ["local renderer substituted Chinese glyphs"],
  });
  const visualDimensions = outcome.scorecard?.dimensions.filter(
    ({ dimension }) =>
      dimension === "visual_aesthetics_and_professional_finish" ||
      dimension === "layout_hierarchy_and_readability" ||
      dimension === "imagery_chart_and_information_expression",
  );
  assert.equal(visualDimensions?.length, 3);
  assert.ok(
    visualDimensions?.every(
      ({ assessmentStatus, value }) =>
        assessmentStatus === "NOT_ASSESSABLE" && value === null,
    ),
  );
  assert.equal(
    outcome.scorecard?.deliveryQualityGates.find(
      ({ gate }) => gate === "sufficient_faithful_visual_input",
    )?.status,
    "CONDITIONAL",
  );
  const vendorRun = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "vendor_run");
  assert.equal(
    vendorRun?.artifactPackageManifest?.renderOutcome,
    "degraded",
  );
});

test("production serializes WPS UI Runs that share one account browser profile", async () => {
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(
    capturedBrowserResult(pptx),
    "PRODUCTION",
  );
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondEntered = false;
  const firstDeadline: AttemptDeadlinePort = {
    async run(operation) {
      markFirstEntered();
      await firstRelease;
      return {
        timedOut: false,
        value: await operation(new AbortController().signal),
        elapsedMs: 1,
      };
    },
  };
  const secondDeadline: AttemptDeadlinePort = {
    async run(operation) {
      secondEntered = true;
      return {
        timedOut: false,
        value: await operation(new AbortController().signal),
        elapsedMs: 1,
      };
    },
  };
  const authorization: EgressAuthorizationPort = {
    async authorize(request) {
      return {
        status: "approved",
        decisionId: `production-approved:${request.requestId}`,
        policyVersion: "production-public-synthetic-v1",
        request,
        legalSecurityBasis: "authorized public synthetic evaluation",
        approvedAt: request.requestedAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
  };
  const run = (attemptDeadline: AttemptDeadlinePort) =>
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection({
        targetEnvironment: "production",
      }),
      productAdapter: new WpsAiPptProductAdapter(),
      wpsAiPptBrowserDriver: driver,
      egressAuthorization: authorization,
      rendererDestination:
        ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
      attemptDeadline,
      specCommitSha:
        "ee115b77abe05dae522fdf8c878bc7d701b3dcc1",
    }).startBakeoffJob({
      environment: "production",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    });

  const first = run(firstDeadline);
  await firstEntered;
  const second = run(secondDeadline);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});

test("CAPTCHA, capacity, UI drift, export, and download failures are distinct and never auto-retried", async () => {
  const pptx = await knownGoodPptxBytes();
  const failures = [
    "captcha",
    "capacity",
    "ui_drift",
    "export_failure",
    "download_failure",
  ] as const;
  for (const [index, outcomeName] of failures.entries()) {
    const feishu = new InMemoryFeishuProjection();
    const failed: WpsAiPptBrowserResult = {
      outcome: outcomeName,
      submissionEvidence: "not_submitted",
      elapsedMs: 1,
      events: [
        {
          eventType: outcomeName,
          sourceAt: "2026-07-27T06:00:00.000Z",
          observedAt: "2026-07-27T06:00:01.000Z",
          evidenceId:
            `ev_${String(index + 10).padStart(16, "0")}` as const,
          sourceUrl: "https://aippt.wps.cn/aippt/",
          submissionEvidenceAtCheckpoint: "not_submitted",
        },
      ],
      manualActions: [],
    };
    const driver = createWpsAiPptBrowserDriverPackage({
      provenance: "TEST_FAKE",
      sessions: [failed, capturedBrowserResult(pptx)],
    });

    const result = await createBakeoffHarness({
      feishu,
      productAdapter: testWpsBoundaryAdapter(
        `MOCK-wps-${outcomeName}-package-v1`,
      ),
      wpsAiPptBrowserDriver: driver,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    });

    assert.equal(result.artifact, null);
    const attempts = feishu
      .snapshot()
      .runRecordTable.filter(
        ({ recordType }) => recordType === "evaluation_attempt",
      );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.terminalReason, outcomeName);
  }
});

test("an unknown WPS task state requires and persists an explicit reconciliation checkpoint", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "unknown-task-reconciliation",
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: createWpsAiPptBrowserDriverPackage({
        provenance: "TEST_FAKE",
        sessions: [
          {
            outcome: "task_state_unknown",
            submissionEvidence: "unknown",
            elapsedMs: 1,
            events: [
              {
                eventType: "task_reconciliation_checked",
                sourceAt: "2026-07-27T06:00:00.000Z",
                observedAt: "2026-07-27T06:00:01.000Z",
                evidenceId: "ev_0000000000000099",
                sourceUrl:
                  "https://aippt.wps.cn/aippt/?task=private#state",
                submissionEvidenceAtCheckpoint: "unknown",
              },
            ],
            manualActions: [],
          },
        ],
      }),
      attemptCheckpointStore: checkpoints,
    },
  );

  const result = (await execute({
    jobId: "job-wps-reconcile",
    runId: "run-wps-reconcile",
    attemptId: "attempt-wps-reconcile-1",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  })) as ProductAttemptResult;

  assert.equal(result.terminalReason, "task_state_unknown");
  assert.equal(result.submissionEvidence, "unknown");
  assert.deepEqual(
    checkpoints.snapshot().map((event) => ({
      eventType: event.eventType,
      sourceUrl: event.sourceUrl,
      submissionEvidenceAtCheckpoint:
        event.submissionEvidenceAtCheckpoint,
    })),
    [
      {
        eventType: "task_reconciliation_checked",
        sourceUrl: "https://aippt.wps.cn/aippt/",
        submissionEvidenceAtCheckpoint: "unknown",
      },
    ],
  );
});

test("renderer authorization is decided before an untrusted WPS raster candidate is decoded", async () => {
  const pptx = await knownGoodPptxBytes();
  const captured = capturedBrowserResult(pptx);
  const unsafe: WpsAiPptCapturedBrowserResult = {
    ...captured,
    render: {
      ...captured.render,
      slides: captured.render.slides.map((slide, index) =>
        index === 0
          ? { ...slide, content: new TextEncoder().encode("<svg/>") }
          : slide,
      ),
    },
  };
  const feishu = new InMemoryFeishuProjection();
  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapter: testWpsBoundaryAdapter(
        "MOCK-wps-render-authorization-package-v1",
      ),
      wpsAiPptBrowserDriver: browserDriverPackage(unsafe),
      egressAuthorization: {
        async authorize(request) {
          if (request.processingPurpose === "artifact_rendering") {
            return {
              status: "denied",
              decisionId: "deny-render-before-decode",
              policyVersion: "test-render-deny-v1",
              request,
              reason: "renderer not authorized",
              decidedAt: request.requestedAt,
            };
          }
          return {
            status: "approved",
            decisionId: `approved:${request.requestId}`,
            policyVersion: "test-vendor-only-v1",
            request,
            legalSecurityBasis: "synthetic fixture",
            approvedAt: request.requestedAt,
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
        },
      },
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /renderer not authorized|egress authorization denied/i,
  );
  assert.equal(feishu.snapshot().capturedArtifactTable.length, 0);
});
