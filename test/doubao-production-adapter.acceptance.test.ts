import assert from "node:assert/strict";
import test from "node:test";

import {
  DoubaoProductionProductAdapter,
  InMemoryFeishuProjection,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  VOLCANO_EVALUATION_CASE,
  createBakeoffHarness,
  parseAdapterExecutionConfiguration,
  resolveHarnessProductAdapterExecutor,
  type DoubaoBrowserDriverPort,
  type ProductAttemptResult,
  type ProductAdapterPort,
} from "../src/index.ts";

type CallerExecutionKeys = Extract<
  keyof ProductAdapterPort,
  "execute" | "executorFactory" | "browserDriver" | "driverFactory"
>;
const productAdapterPortStaysPureData:
  CallerExecutionKeys extends never ? true : false = true;
void productAdapterPortStaysPureData;

function completeDoubaoDriver(): DoubaoBrowserDriverPort {
  return {
    async inspectCurrentPackage() {
      return {
        observedAt: "2026-07-27T06:00:00.000Z",
        sourceUrl: "https://www.doubao.com/chat/ppt-observed",
        accountEvidence: "current_account_signed_in",
        planName: "免费版",
        modelName: "豆包当前账号最佳可用模型",
        modeName: "AI PPT",
        networking: "enabled",
        requestedPageCount: 16,
        bestAvailableForCurrentAccount: true,
        incrementalChargeRequired: false,
        evidenceRef: "screenshot://doubao/preflight-redacted",
        manualActions: ["打开豆包 AI PPT"],
      };
    },
    async submitFrozenQuery() {
      return {
        status: "submitted",
        vendorTaskId: "doubao-task-observed-1",
        observedAt: "2026-07-27T06:00:10.000Z",
        evidenceRef: "screenshot://doubao/submitted-redacted",
        manualActions: ["点击生成"],
      };
    },
    async waitForGeneration() {
      return {
        status: "generated",
        observedAt: "2026-07-27T06:04:00.000Z",
        completionUrl: "https://www.doubao.com/chat/ppt-observed",
        previewPageCount: 16,
        evidenceRef: "screenshot://doubao/generated-redacted",
        manualActions: [],
      };
    },
    async exportPresentation() {
      return {
        status: "exported",
        observedAt: "2026-07-27T06:04:20.000Z",
        filename: "doubao-volcano-16.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        pageCount: 16,
        content: new TextEncoder().encode(
          "PK\u0003\u0004fake-doubao-pptx",
        ),
        evidenceRef: "download://doubao/doubao-volcano-16.pptx",
        manualActions: ["点击导出 PPTX"],
      };
    },
    async renderPresentation() {
      return {
        status: "rendered",
        observedAt: "2026-07-27T06:05:00.000Z",
        renderer: "libreoffice-headless@observed",
        pages: Array.from({ length: 16 }, (_, index) => ({
          pageNumber: index + 1,
          filename: `slide-${index + 1}.png`,
          mimeType: "image/png" as const,
          content: new TextEncoder().encode(`slide-${index + 1}`),
        })),
        evidenceRef: "render://doubao/volcano-16",
      };
    },
  };
}

async function executeWithDriver(
  driver: DoubaoBrowserDriverPort,
  attemptId: string,
): Promise<ProductAttemptResult> {
  const adapter = new DoubaoProductionProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { doubaoBrowserDriver: driver },
  );
  const execution = await executor({
    jobId: `job-${attemptId}`,
    runId: `run-${attemptId}`,
    attemptId,
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok(!("content" in execution));
  return execution as ProductAttemptResult;
}

test("the Doubao production adapter declares the frozen zero-incremental-cost 16-page package as pure data", () => {
  const adapter = new DoubaoProductionProductAdapter();

  assert.deepEqual(Object.keys(adapter).sort(), [
    "executionConfigurationPackage",
    "implementationPackage",
    "productPackage",
  ]);
  assert.deepEqual(adapter.productPackage.evaluationConfiguration, {
    accountContext: "current_authenticated_account",
    benchmarkProtocol: "best_available_zero_incremental_cost",
    entryUrl: "https://www.doubao.com/",
    modelSelection: "best_available_for_current_account",
    networking: "enabled",
    purchasePolicy: "no_incremental_charge",
    requestedPageCount: 16,
  });
  assert.equal(adapter.productPackage.provenance, "PRODUCTION");
  assert.equal(
    adapter.productPackage.environmentOrigin.environment,
    "production",
  );
  assert.deepEqual(
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      adapterKind: "doubao-web-ppt",
      scenario: "volcano-16-current-account-zero-cost-network-on",
      schemaVersion: "product-adapter-execution-configuration-v1",
    },
  );
  assert.match(
    new TextDecoder().decode(adapter.implementationPackage.content),
    /export function resolveDoubaoProductionExecutor/,
  );
  assert.doesNotMatch(
    JSON.stringify(adapter),
    /cookie|authorization|bearer|password|localstorage|sessionstorage/i,
  );
});

test("each Doubao adapter owns an isolated recoverable implementation package snapshot", () => {
  const first = new DoubaoProductionProductAdapter();
  const second = new DoubaoProductionProductAdapter();
  const originalSecondByte = second.implementationPackage.content[0];

  first.implementationPackage.content[0] =
    (first.implementationPackage.content[0] ?? 0) ^ 0xff;

  assert.equal(
    second.implementationPackage.content[0],
    originalSecondByte,
  );
});

test("the trusted registry drives the real Doubao boundary from the frozen Query to a hashed 16-page static Artifact", async () => {
  let submittedQuery: string | null = null;
  let submittedPageCount: number | null = null;
  let submittedNetworking: string | null = null;
  let generationTimeoutMs: number | null = null;
  const artifactContent = new TextEncoder().encode(
    "PK\u0003\u0004fake-doubao-pptx",
  );
  const driver: DoubaoBrowserDriverPort = {
    async inspectCurrentPackage() {
      return {
        observedAt: "2026-07-27T06:00:00.000Z",
        sourceUrl: "https://www.doubao.com/chat/ppt-observed",
        accountEvidence: "current_account_signed_in",
        planName: "免费版",
        modelName: "豆包当前账号最佳可用模型",
        modeName: "AI PPT",
        networking: "enabled",
        requestedPageCount: 16,
        bestAvailableForCurrentAccount: true,
        incrementalChargeRequired: false,
        evidenceRef: "screenshot://doubao/preflight-redacted",
        manualActions: ["打开豆包 AI PPT"],
      };
    },
    async submitFrozenQuery(command) {
      submittedQuery = command.vendorPrompt;
      submittedPageCount = command.requestedPageCount;
      submittedNetworking = command.networking;
      return {
        status: "submitted",
        vendorTaskId: "doubao-task-observed-1",
        observedAt: "2026-07-27T06:00:10.000Z",
        evidenceRef: "screenshot://doubao/submitted-redacted",
        manualActions: ["点击生成"],
      };
    },
    async waitForGeneration(command) {
      generationTimeoutMs = command.timeoutMs;
      return {
        status: "generated",
        observedAt: "2026-07-27T06:04:00.000Z",
        completionUrl: "https://www.doubao.com/chat/ppt-observed",
        previewPageCount: 16,
        evidenceRef: "screenshot://doubao/generated-redacted",
        manualActions: [],
      };
    },
    async exportPresentation() {
      return {
        status: "exported",
        observedAt: "2026-07-27T06:04:20.000Z",
        filename: "doubao-volcano-16.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        pageCount: 16,
        content: artifactContent,
        evidenceRef: "download://doubao/doubao-volcano-16.pptx",
        manualActions: ["点击导出 PPTX"],
      };
    },
    async renderPresentation() {
      return {
        status: "rendered",
        observedAt: "2026-07-27T06:05:00.000Z",
        renderer: "libreoffice-headless@observed",
        pages: Array.from({ length: 16 }, (_, index) => ({
          pageNumber: index + 1,
          filename: `slide-${index + 1}.png`,
          mimeType: "image/png" as const,
          content: new TextEncoder().encode(`slide-${index + 1}`),
        })),
        evidenceRef: "render://doubao/volcano-16",
      };
    },
  };
  const adapter = new DoubaoProductionProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { doubaoBrowserDriver: driver },
  );
  const execution = await executor({
    jobId: "job-doubao-real-1",
    runId: "run-doubao-real-1",
    attemptId: "attempt-doubao-real-1",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok(!("content" in execution));
  const result = execution as ProductAttemptResult;
  const artifact = result.artifactCandidates[0]?.artifact;

  assert.equal(submittedQuery, VOLCANO_EVALUATION_CASE.vendorPrompt);
  assert.equal(submittedPageCount, 16);
  assert.equal(submittedNetworking, "enabled");
  assert.equal(generationTimeoutMs, 30 * 60 * 1_000);
  assert.equal(result.terminalReason, "success");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(result.artifactCandidates.length, 1);
  assert.equal(artifact?.provenance, "PRODUCTION");
  assert.equal(artifact?.environmentOrigin, PRODUCTION_ENVIRONMENT_ORIGIN);
  assert.equal(artifact?.pageCount, 16);
  assert.equal(
    artifact?.contentHash,
    "sha256:7610a36690f081bfea8618c6450c2b939aa9769f224b05f629de7fc66c531236",
  );
  assert.equal(result.captureEvidence?.staticRenders.length, 16);
  assert.deepEqual(
    result.captureEvidence?.staticRenders.map(({ pageNumber }) => pageNumber),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.ok(
    result.captureEvidence?.staticRenders.every(({ contentHash }) =>
      /^sha256:[a-f0-9]{64}$/.test(contentHash),
    ),
  );
  assert.deepEqual(result.manualActions, [
    "打开豆包 AI PPT",
    "点击生成",
    "点击导出 PPTX",
  ]);
  assert.deepEqual(result.observedConfiguration, {
    sourceUrl: "https://www.doubao.com/chat/ppt-observed",
    accountEvidence: "current_account_signed_in",
    planName: "免费版",
    modelName: "豆包当前账号最佳可用模型",
    modeName: "AI PPT",
    networking: "enabled",
    requestedPageCount: 16,
    bestAvailableForCurrentAccount: true,
    incrementalChargeRequired: false,
  });
  assert.doesNotMatch(
    JSON.stringify({
      trace: result.observableEvents,
      configuration: result.observedConfiguration,
    }),
    /cookie|authorization|bearer|password|localstorage|sessionstorage|chain.of.thought/i,
  );
});

test("a package that needs new payment is blocked before submission with observable not-submitted evidence", async () => {
  const unexpected = async (): Promise<never> => {
    throw new Error("paid preflight must stop before submission");
  };
  const driver: DoubaoBrowserDriverPort = {
    async inspectCurrentPackage() {
      return {
        observedAt: "2026-07-27T06:00:00.000Z",
        sourceUrl: "https://www.doubao.com/chat/",
        accountEvidence: "current_account_signed_in",
        planName: "需要新增付费",
        modelName: "豆包 PPT",
        modeName: "AI PPT",
        networking: "enabled",
        requestedPageCount: 16,
        bestAvailableForCurrentAccount: true,
        incrementalChargeRequired: true,
        evidenceRef: "screenshot://doubao/payment-blocked-redacted",
        manualActions: ["打开豆包 AI PPT"],
      };
    },
    submitFrozenQuery: unexpected,
    waitForGeneration: unexpected,
    exportPresentation: unexpected,
    renderPresentation: unexpected,
  };
  const adapter = new DoubaoProductionProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { doubaoBrowserDriver: driver },
  );
  const execution = await executor({
    jobId: "job-doubao-payment",
    runId: "run-doubao-payment",
    attemptId: "attempt-doubao-payment",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok(!("content" in execution));
  const result = execution as ProductAttemptResult;

  assert.equal(result.terminalReason, "payment");
  assert.equal(result.blockReason, "payment");
  assert.equal(result.submissionEvidence, "not_submitted");
  assert.deepEqual(
    result.observableEvents?.map(({ eventType }) => eventType),
    ["preflight_observed", "query_not_submitted"],
  );
  assert.deepEqual(result.artifactCandidates, []);
});

test("an incomplete static render remains a submitted technical capture failure and never becomes an Artifact", async () => {
  const complete = completeDoubaoDriver();
  const result = await executeWithDriver(
    {
      ...complete,
      async renderPresentation(command) {
        const rendered = await complete.renderPresentation(command);
        assert.equal(rendered.status, "rendered");
        return {
          ...rendered,
          pages: rendered.pages.slice(0, 15),
        };
      },
    },
    "attempt-doubao-incomplete-render",
  );

  assert.equal(result.terminalReason, "technical_failure");
  assert.equal(result.submissionEvidence, "submitted");
  assert.deepEqual(result.artifactCandidates, []);
  assert.equal(result.captureEvidence, undefined);
  assert.deepEqual(
    result.observableEvents?.map(({ eventType }) => eventType),
    [
      "preflight_observed",
      "query_submitted",
      "generation_ready",
      "artifact_exported",
      "render_failed",
    ],
  );
});

test("a generated preview with the wrong page count stays a submitted failure without export or retry", async () => {
  const complete = completeDoubaoDriver();
  const result = await executeWithDriver(
    {
      ...complete,
      async waitForGeneration(command) {
        const generated = await complete.waitForGeneration(command);
        assert.equal(generated.status, "generated");
        return {
          ...generated,
          previewPageCount: 15,
        };
      },
      async exportPresentation() {
        throw new Error("wrong-page preview must stop before export");
      },
    },
    "attempt-doubao-wrong-preview-pages",
  );

  assert.equal(result.terminalReason, "technical_failure");
  assert.equal(result.submissionEvidence, "submitted");
  assert.deepEqual(result.artifactCandidates, []);
  assert.deepEqual(
    result.observableEvents?.map(({ eventType }) => eventType),
    [
      "preflight_observed",
      "query_submitted",
      "generation_failed",
    ],
  );
});

test("a non-PPTX export is a submitted export failure and cannot become a policy-compliant Artifact", async () => {
  const complete = completeDoubaoDriver();
  const result = await executeWithDriver(
    {
      ...complete,
      async exportPresentation(command) {
        const exported = await complete.exportPresentation(command);
        assert.equal(exported.status, "exported");
        return {
          ...exported,
          content: new TextEncoder().encode("not-a-pptx"),
        };
      },
      async renderPresentation() {
        throw new Error("invalid PPTX must stop before rendering");
      },
    },
    "attempt-doubao-invalid-pptx",
  );

  assert.equal(result.terminalReason, "technical_failure");
  assert.equal(result.submissionEvidence, "submitted");
  assert.deepEqual(result.artifactCandidates, []);
  assert.deepEqual(
    result.observableEvents?.map(({ eventType }) => eventType),
    [
      "preflight_observed",
      "query_submitted",
      "generation_ready",
      "export_failed",
    ],
  );
});

test("the harness retries once only after proven non-submission and never retries the submitted timeout", async () => {
  const productionAdapter = new DoubaoProductionProductAdapter();
  const testAdapter: ProductAdapterPort = {
    implementationPackage: productionAdapter.implementationPackage,
    executionConfigurationPackage:
      productionAdapter.executionConfigurationPackage,
    productPackage: {
      ...productionAdapter.productPackage,
      packageId: "MOCK-doubao-production-boundary-v1",
      provenance: "MOCK",
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      egressDestination: {
        targetService: "mock-doubao-production-boundary",
        targetAccount: "mock-current-account",
        targetRegion: "test",
        subprocessors: [],
      },
    },
  };
  const complete = completeDoubaoDriver();
  const driver: DoubaoBrowserDriverPort = {
    ...complete,
    async submitFrozenQuery(command) {
      if (command.attemptSeq === 1) {
        return {
          status: "not_submitted",
          observedAt: "2026-07-27T06:00:05.000Z",
          evidenceRef: "screenshot://doubao/not-submitted-redacted",
          manualActions: ["提交前页面失败"],
        };
      }
      return complete.submitFrozenQuery(command);
    },
    async waitForGeneration() {
      return {
        status: "timed_out",
        observedAt: "2026-07-27T06:30:00.000Z",
        evidenceRef: "screenshot://doubao/timed-out-redacted",
        manualActions: [],
      };
    },
  };
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [testAdapter],
    doubaoBrowserDriver: driver,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });
  const attempts = feishu
    .snapshot()
    .runRecordTable.filter(
      ({ recordType }) => recordType === "evaluation_attempt",
    );

  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map(
      ({
        attemptSeq,
        submissionEvidence,
        terminalReason,
        retryOfAttemptId,
      }) => ({
        attemptSeq,
        submissionEvidence,
        terminalReason,
        retryOfAttemptId,
      }),
    ),
    [
      {
        attemptSeq: 1,
        submissionEvidence: "not_submitted",
        terminalReason: "technical_failure",
        retryOfAttemptId: null,
      },
      {
        attemptSeq: 2,
        submissionEvidence: "submitted",
        terminalReason: "vendor_timeout",
        retryOfAttemptId: attempts[0]?.recordId,
      },
    ],
  );
  assert.deepEqual(
    attempts[1]?.productConfigurationEvidence,
    {
      sourceUrl: "https://www.doubao.com/chat/ppt-observed",
      accountEvidence: "current_account_signed_in",
      planName: "免费版",
      modelName: "豆包当前账号最佳可用模型",
      modeName: "AI PPT",
      networking: "enabled",
      requestedPageCount: 16,
      bestAvailableForCurrentAccount: true,
      incrementalChargeRequired: false,
    },
  );
});

test("the production boundary fails closed when observable configuration contains session-like URL material", async () => {
  const complete = completeDoubaoDriver();
  await assert.rejects(
    executeWithDriver(
      {
        ...complete,
        async inspectCurrentPackage(command) {
          return {
            ...(await complete.inspectCurrentPackage(command)),
            sourceUrl:
              "https://www.doubao.com/chat/ppt-observed?session_token=redacted-value",
          };
        },
      },
      "attempt-doubao-unsafe-trace",
    ),
    /sensitive URL parameters/i,
  );
});

test("the production boundary rejects hidden-reasoning text in observable manual-action evidence", async () => {
  const complete = completeDoubaoDriver();
  await assert.rejects(
    executeWithDriver(
      {
        ...complete,
        async inspectCurrentPackage(command) {
          return {
            ...(await complete.inspectCurrentPackage(command)),
            manualActions: ["查看隐藏思考"],
          };
        },
      },
      "attempt-doubao-hidden-reasoning-trace",
    ),
    /not secret-safe/i,
  );
});

test("the trusted registry rejects a tampered Doubao implementation package before browser access", () => {
  const adapter = new DoubaoProductionProductAdapter();
  const content = Uint8Array.from(adapter.implementationPackage.content);
  content[0] = (content[0] ?? 0) ^ 0xff;

  assert.throws(
    () =>
      resolveHarnessProductAdapterExecutor(
        {
          ...adapter.implementationPackage,
          content,
        },
        parseAdapterExecutionConfiguration(
          adapter.executionConfigurationPackage,
        ),
        { doubaoBrowserDriver: completeDoubaoDriver() },
      ),
    /implementation package is not registered/i,
  );
});
