import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  MockWpsProductAdapter,
  InMemoryFeishuProjection,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  VOLCANO_EVALUATION_CASE,
  VENDOR_GENERATION_TIMEOUT_MS,
  WPS_AIPPT_URL,
  WpsAiPptProductAdapter,
  createBakeoffHarness,
  parseAdapterExecutionConfiguration,
  type ProductAttemptResult,
  type ProductAdapterPort,
  type WpsAiPptBrowserDriverPort,
  type WpsAiPptCapturedBrowserResult,
} from "../src/index.ts";
import { resolveHarnessProductAdapterExecutor } from "../src/mock-wps.ts";

test("the WPS AI PPT production adapter is a pure-data descriptor for the frozen package", () => {
  const adapter: ProductAdapterPort = new WpsAiPptProductAdapter();

  assert.equal(WPS_AIPPT_URL, "https://aippt.wps.cn/aippt/");
  assert.deepEqual(adapter.productPackage.experienceConfiguration, {
    productUrl: WPS_AIPPT_URL,
    accountScope: "current_authenticated_account",
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
): WpsAiPptCapturedBrowserResult {
  return {
    outcome: "captured",
    submissionEvidence,
    elapsedMs: 120_000,
    observedConfiguration: {
      productUrl: WPS_AIPPT_URL,
      accountScope: "current_authenticated_account",
      packageSelection: "best_available_zero_incremental_cost",
      incrementalCost: 0,
      mode: "professional",
      networking: "enabled",
      pageCount: 16,
      evidenceRefs: [
        "ui:wps-aippt:account-and-plan",
        "ui:wps-aippt:professional-networking-pages",
      ],
    },
    events: [
      {
        eventType: "configuration_observed",
        sourceAt: "2026-07-27T06:00:00.000Z",
        observedAt: "2026-07-27T06:00:01.000Z",
        evidenceRef:
          "ui:wps-aippt:professional-networking-pages",
      },
      {
        eventType: "artifact_downloaded",
        sourceAt: "2026-07-27T06:02:00.000Z",
        observedAt: "2026-07-27T06:02:01.000Z",
        evidenceRef: "download:wps-volcano-16.pptx",
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
      slides: Array.from({ length: 16 }, (_, index) => {
        const pageNumber = index + 1;
        return {
          pageNumber,
          filename: `slide-${pageNumber}.svg`,
          mimeType: "image/svg+xml" as const,
          content: `<svg xmlns="http://www.w3.org/2000/svg"><text>WPS page ${pageNumber}</text></svg>`,
          extractedText: `WPS page ${pageNumber}`,
        };
      }),
      contactSheet: {
        filename: "contact-sheet.svg",
        mimeType: "image/svg+xml",
        content:
          '<svg xmlns="http://www.w3.org/2000/svg"><text>WPS 16 pages</text></svg>',
      },
    },
  };
}

test("the trusted registry executes the WPS package only through the browser-driver boundary", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const observedCommands: unknown[] = [];
  const driver: WpsAiPptBrowserDriverPort = {
    driverId: "test-fake-wps-browser@1",
    provenance: "TEST_FAKE",
    async run(command) {
      observedCommands.push(command);
      return capturedBrowserResult(pptx);
    },
  };

  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { wpsAiPptBrowserDriver: driver },
  );
  const result = (await execute({
    jobId: "job-wps-real",
    runId: "run-wps-real",
    attemptId: "attempt-wps-real-1",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: {
      ...VOLCANO_EVALUATION_CASE,
      provenance: "PRODUCTION",
      environmentOrigin: adapter.productPackage.environmentOrigin,
    },
  })) as ProductAttemptResult;

  assert.equal(observedCommands.length, 1);
  assert.deepEqual(
    observedCommands.map(
      ({
        url,
        mode,
        networking,
        pageCount,
        packageSelection,
        timeoutMs,
      }: any) => ({
        url,
        mode,
        networking,
        pageCount,
        packageSelection,
        timeoutMs,
      }),
    ),
    [
      {
        url: WPS_AIPPT_URL,
        mode: "professional",
        networking: "enabled",
        pageCount: 16,
        packageSelection: "best_available_zero_incremental_cost",
        timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      },
    ],
  );
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
    result.artifactCandidates[0]?.renderManifest?.slides.length,
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
});

test("the Bakeoff harness owns WPS browser-driver injection and still blocks production lineage in test", async () => {
  let driverCalls = 0;
  const driver: WpsAiPptBrowserDriverPort = {
    driverId: "test-fake-wps-browser@1",
    provenance: "TEST_FAKE",
    async run() {
      driverCalls += 1;
      throw new Error("test environment gate should run first");
    },
  };

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
  assert.equal(driverCalls, 0);
});

test("WPS observable Trace rejects credential-bearing evidence before persistence", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const driver: WpsAiPptBrowserDriverPort = {
    driverId: "test-fake-wps-browser@1",
    provenance: "TEST_FAKE",
    async run() {
      return {
        outcome: "technical_failure",
        submissionEvidence: "unknown",
        elapsedMs: 1,
        events: [
          {
            eventType: "submission_reconcile_failed",
            sourceAt: "2026-07-27T06:00:00.000Z",
            observedAt: "2026-07-27T06:00:01.000Z",
            evidenceRef: "ui:wps-aippt?access_token=must-not-persist",
          },
        ],
        manualActions: [],
      };
    },
  };
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
  const driver: WpsAiPptBrowserDriverPort = {
    driverId: "test-fake-wps-browser@1",
    provenance: "TEST_FAKE",
    async run() {
      return capturedBrowserResult(pptx, "unknown");
    },
  };
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

test("the harness persists WPS observable Trace and the driver-provided 16-page static render", async () => {
  const productionAdapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver: WpsAiPptBrowserDriverPort = {
    driverId: "test-fake-wps-browser@1",
    provenance: "TEST_FAKE",
    async run() {
      return capturedBrowserResult(pptx);
    },
  };
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
      outcome: string;
      pageCount: number;
    };
  };

  assert.equal(fixture.execution.submitCount, 1);
  assert.equal(fixture.execution.retryCount, 0);
  assert.equal(fixture.artifact.pageCount, 16);
  assert.equal(fixture.render.pageCount, 16);
  assert.equal(fixture.render.outcome, "degraded");
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
    /cookie|authorization|bearer|token|password|localstorage|sessionstorage|\/Users\/|\/tmp\/|account(?:Id|Name|Email)/i,
  );
});
