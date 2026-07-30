import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DoubaoProductionProductAdapter,
  DOUBAO_VOLCANO_REAL_CAPTURE_ID,
  InMemoryAttemptCheckpointStore,
  InMemoryFeishuProjection,
  MockWpsProductAdapter,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  PRODUCTION_VOLCANO_EVALUATION_CASE,
  VOLCANO_EVALUATION_CASE,
  createBakeoffHarness,
  createDoubaoRealProviderReplayPackage,
  parseAdapterExecutionConfiguration,
  resolveHarnessProductAdapterExecutor,
  type AttemptDeadlinePort,
  type DoubaoBrowserDriverPort,
  type ProductAttemptResult,
  type ProductAdapterPort,
} from "../src/index.ts";
import { createFailedSafeRasterManifest } from "../src/safe-raster.ts";

type CallerExecutionKeys = Extract<
  keyof ProductAdapterPort,
  "execute" | "executorFactory" | "browserDriver" | "driverFactory"
>;
const productAdapterPortStaysPureData:
  CallerExecutionKeys extends never ? true : false = true;
void productAdapterPortStaysPureData;

async function knownGoodPptxBytes(): Promise<Uint8Array> {
  const mock = new MockWpsProductAdapter();
  const execute = resolveHarnessProductAdapterExecutor(
    mock.implementationPackage,
    parseAdapterExecutionConfiguration(
      mock.executionConfigurationPackage,
    ),
  );
  const artifact = await execute({
    jobId: "doubao-pptx-fixture-job",
    runId: "doubao-pptx-fixture-run",
    attemptId: "doubao-pptx-fixture-attempt",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok("content" in artifact);
  return artifact.content;
}

function testCrc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function realMinimalPptxWithPageCount(pageCount: 15 | 17): Uint8Array {
  const encode = (value: string) => new TextEncoder().encode(value);
  const slideIds = Array.from(
    { length: pageCount },
    (_, index) =>
      `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
  ).join("");
  const slideRelationships = Array.from(
    { length: pageCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  const slideContentTypes = Array.from(
    { length: pageCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
  const entries = [
    {
      name: "[Content_Types].xml",
      content: encode(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slideContentTypes}</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      content: encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      ),
    },
    {
      name: "ppt/presentation.xml",
      content: encode(
        `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${slideIds}</p:sldIdLst></p:presentation>`,
      ),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      content: encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRelationships}</Relationships>`,
      ),
    },
    ...Array.from({ length: pageCount }, (_, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      content: encode(
        `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
      ),
    })),
  ];
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content);
    const checksum = testCrc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, content);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Uint8Array.from(
    Buffer.concat([...localParts, centralDirectory, end]),
  );
}

function completeDoubaoDriver(): DoubaoBrowserDriverPort {
  return {
    async inspectCurrentPackage() {
      return {
        observedAt: "2026-07-27T06:00:00.000Z",
        sourceUrl:
          "https://www.doubao.com/chat/ppt-observed#private-fragment",
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
        content: await knownGoodPptxBytes(),
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
  controller = new AbortController(),
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
    signal: controller.signal,
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
  assert.equal(adapter.productPackage.provenance, "LIVE_PRODUCTION");
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

test("LIVE_PRODUCTION fails closed when the trusted Doubao executable is not embedded", async () => {
  const adapter = new DoubaoProductionProductAdapter();
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
  );

  await assert.rejects(
    execute({
      jobId: "job-doubao-live-unavailable",
      runId: "run-doubao-live-unavailable",
      attemptId: "attempt-doubao-live-unavailable-1",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
    }),
    /trusted live Doubao bridge executable is unavailable/i,
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
  const artifactContent = await knownGoodPptxBytes();
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
  assert.equal(artifact?.provenance, "MOCK");
  assert.equal(artifact?.environmentOrigin, MOCK_TEST_ENVIRONMENT_ORIGIN);
  assert.equal(artifact?.pageCount, 16);
  assert.match(artifact?.contentHash ?? "", /^sha256:[a-f0-9]{64}$/);
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
    sourceUrl: "https://www.doubao.com/",
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

test("a Doubao crash after submit begins leaves durable unknown intent and never submits again", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "doubao-submission-intent-crash",
  );
  let submitCalls = 0;
  let reconcileCalls = 0;
  const driver: DoubaoBrowserDriverPort = {
    ...completeDoubaoDriver(),
    async submitFrozenQuery() {
      submitCalls += 1;
      throw new Error(
        "simulated process crash after the provider accepted submission",
      );
    },
    async reconcileTask(query) {
      reconcileCalls += 1;
      return {
        query,
        observedState: "failed",
        observedAt: "2026-07-27T06:01:00.000Z",
        evidenceRef:
          "screenshot://doubao/crash-reconciliation-failed",
      };
    },
  };
  const adapter = new DoubaoProductionProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      attemptCheckpointStore: checkpoints,
      doubaoBrowserDriver: driver,
    },
  );
  const command = {
    jobId: "job-doubao-submission-intent-crash",
    runId: "run-doubao-submission-intent-crash",
    attemptId: "attempt-doubao-submission-intent-crash-1",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  } as const;

  await assert.rejects(
    executor(command),
    /simulated process crash/i,
  );
  const durableIntent = checkpoints
    .snapshot()
    .find(({ eventType }) => eventType === "submission_intent");
  assert.equal(
    durableIntent?.submissionEvidenceAtCheckpoint,
    "unknown",
  );

  const restarted = await executor(command);
  assert.ok(!("content" in restarted));
  assert.equal(restarted.terminalReason, "task_state_unknown");
  assert.equal(restarted.submissionEvidence, "unknown");
  assert.equal(submitCalls, 1);

  await checkpoints.append({
    eventId:
      "attempt-doubao-submission-intent-crash-1-submitted",
    jobId: command.jobId,
    caseId: command.evaluationCase.caseId,
    runId: command.runId,
    attemptId: command.attemptId,
    attemptSeq: command.attemptSeq,
    eventType: "query_submitted",
    sourceAt: "2026-07-27T06:00:10.000Z",
    observedAt: "2026-07-27T06:00:10.000Z",
    writerId: "doubao-web-ppt@1",
    evidenceRef: "screenshot://doubao/submitted-after-intent",
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "task_doubao_crash_1234",
    taskStateVersion: "query_submitted@2",
    adapterVersion: "doubao-web-ppt@1",
    artifactId: null,
  });
  const reconciled = await executor(command);
  assert.ok(!("content" in reconciled));
  assert.equal(reconciled.terminalReason, "technical_failure");
  assert.equal(reconciled.submissionEvidence, "submitted");
  assert.equal(reconcileCalls, 1);
  assert.equal(submitCalls, 1);
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

test("an incomplete static render cannot discard the already exported PPTX", async () => {
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

  assert.equal(result.terminalReason, "success");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(result.artifactCandidates.length, 1);
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

test("a failed raster manifest keeps original Artifact lineage and marks fidelity unknown", async () => {
  const result = await executeWithDriver(
    completeDoubaoDriver(),
    "attempt-doubao-failed-render-manifest",
  );
  const artifact = result.artifactCandidates[0]?.artifact;
  assert.ok(artifact);
  for (const failure of [
    new Error(
      "render input missing under /Users/redacted/private-file",
    ),
    new Error("OPENAI_API_KEY=sk-live-super-secret-value"),
    new Error(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature",
    ),
    new Error(
      "renderer stderr: password=hunter2; cookie=session-secret",
    ),
  ]) {
    const manifest = createFailedSafeRasterManifest({
      artifact,
      renderer: "authorized-safe-raster@1",
      rendererAuthorizationDecisionId: "decision-render-failed",
      failure,
      renderManifestId: `${artifact.artifactId}-render`,
    });

    assert.equal(manifest.artifactId, artifact.artifactId);
    assert.equal(manifest.renderOutcome, "failed");
    assert.deepEqual(manifest.slides, []);
    assert.equal(manifest.fidelity.status, "unknown");
    assert.deepEqual(manifest.fidelity.notes, [
      "RASTERIZATION_FAILED: static rendering failed; inspect the authorized operator diagnostic channel",
    ]);
    assert.doesNotMatch(
      JSON.stringify(manifest),
      /\/Users\/|private-file|sk-live|eyJhbGci|hunter2|session-secret|stderr/i,
    );
  }
});

test("a generated preview page deviation remains task success and proceeds to export", async () => {
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
    },
    "attempt-doubao-wrong-preview-pages",
  );

  assert.equal(result.terminalReason, "success");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(result.artifactCandidates.length, 1);
  assert.ok(
    result.manualActions?.includes(
      "page-count-deviation: preview=15 requested=16",
    ),
  );
});

test("a 15-page or 17-page real OPC export fails closed without a compliant Artifact", async (context) => {
  for (const pageCount of [15, 17] as const) {
    await context.test(`${pageCount} pages`, async () => {
      const complete = completeDoubaoDriver();
      let renderCalled = false;
      const result = await executeWithDriver(
        {
          ...complete,
          async exportPresentation(command) {
            const exported =
              await complete.exportPresentation(command);
            assert.equal(exported.status, "exported");
            return {
              ...exported,
              pageCount,
              content: realMinimalPptxWithPageCount(pageCount),
            };
          },
          async renderPresentation(command) {
            renderCalled = true;
            return complete.renderPresentation(command);
          },
        },
        `attempt-doubao-${pageCount}-page-export`,
      );

      assert.equal(result.terminalReason, "technical_failure");
      assert.equal(result.submissionEvidence, "submitted");
      assert.equal(result.artifactCandidates.length, 0);
      assert.equal(renderCalled, false);
    });
  }
});

test("driver page-count metadata must independently report the frozen 16 pages", async () => {
  const complete = completeDoubaoDriver();
  const result = await executeWithDriver(
    {
      ...complete,
      async exportPresentation(command) {
        const exported = await complete.exportPresentation(command);
        assert.equal(exported.status, "exported");
        return { ...exported, pageCount: 15 };
      },
      async renderPresentation() {
        throw new Error(
          "mismatched driver metadata must stop before rendering",
        );
      },
    },
    "attempt-doubao-wrong-export-metadata",
  );

  assert.equal(result.terminalReason, "technical_failure");
  assert.equal(result.artifactCandidates.length, 0);
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
      displayName: "Mock-boundary Doubao PPT",
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
      sourceUrl: "https://www.doubao.com/",
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

test("the public replay factory rejects an unregistered self-minted real-provider capture", async () => {
  const driver = completeDoubaoDriver();
  const packageObservation = await driver.inspectCurrentPackage({
    jobId: "unregistered",
    runId: "unregistered",
    attemptId: "unregistered",
    attemptSeq: 1,
    signal: new AbortController().signal,
  });
  const submission = await driver.submitFrozenQuery({
    jobId: "unregistered",
    runId: "unregistered",
    attemptId: "unregistered",
    attemptSeq: 1,
    signal: new AbortController().signal,
    vendorPrompt: VOLCANO_EVALUATION_CASE.vendorPrompt,
    requestedPageCount: 16,
    networking: "enabled",
  });
  assert.equal(submission.status, "submitted");
  const generation = await driver.waitForGeneration({
    jobId: "unregistered",
    runId: "unregistered",
    attemptId: "unregistered",
    attemptSeq: 1,
    signal: new AbortController().signal,
    vendorTaskId: submission.vendorTaskId,
    timeoutMs: 30 * 60 * 1_000,
  });
  assert.equal(generation.status, "generated");
  const artifact = await driver.exportPresentation({
    jobId: "unregistered",
    runId: "unregistered",
    attemptId: "unregistered",
    attemptSeq: 1,
    signal: new AbortController().signal,
    vendorTaskId: submission.vendorTaskId,
  });
  assert.equal(artifact.status, "exported");

  assert.throws(
    () =>
      createDoubaoRealProviderReplayPackage({
        captureId: "self-minted-unregistered-capture",
        renderedPages: Array.from({ length: 16 }, (_, index) => ({
          pageNumber: index + 1,
          filename: `slide-${index + 1}.png`,
          mimeType: "image/png" as const,
          content: new TextEncoder().encode(`forged-slide-${index + 1}`),
        })),
        captures: [{
          packageObservation,
          submission,
          generation,
          artifact,
        }],
      }),
    /registered immutable capture receipt/i,
  );
});

test("a known capture ID cannot bless forged artifact, trace, or render bytes", async () => {
  const pptx = await knownGoodPptxBytes();
  const complete = completeDoubaoDriver();
  const packageObservation =
    await complete.inspectCurrentPackage({
      jobId: "fixture",
      runId: "fixture",
      attemptId: "fixture",
      attemptSeq: 1,
      signal: new AbortController().signal,
    });
  const submission = await complete.submitFrozenQuery({
    jobId: "fixture",
    runId: "fixture",
    attemptId: "fixture",
    attemptSeq: 1,
    signal: new AbortController().signal,
    vendorPrompt: VOLCANO_EVALUATION_CASE.vendorPrompt,
    requestedPageCount: 16,
    networking: "enabled",
  });
  assert.equal(submission.status, "submitted");
  const generation = await complete.waitForGeneration({
    jobId: "fixture",
    runId: "fixture",
    attemptId: "fixture",
    attemptSeq: 1,
    signal: new AbortController().signal,
    vendorTaskId: "task_doubao_retained_20260727",
    timeoutMs: 30 * 60 * 1_000,
  });
  assert.equal(generation.status, "generated");
  assert.throws(
    () =>
      createDoubaoRealProviderReplayPackage({
        captureId: DOUBAO_VOLCANO_REAL_CAPTURE_ID,
        renderedPages: Array.from({ length: 16 }, (_, index) => ({
          pageNumber: index + 1,
          filename: `slide-${index + 1}.png`,
          mimeType: "image/png" as const,
          content: new TextEncoder().encode(`forged-slide-${index + 1}`),
        })),
        captures: [{
          packageObservation,
          submission: {
            ...submission,
            vendorTaskId: "task_doubao_retained_20260727",
          },
          generation,
          artifact: {
            status: "exported",
            observedAt: "2026-07-27T06:04:20.000Z",
            filename: "doubao-volcano-16.pptx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            pageCount: 16,
            content: pptx,
            evidenceRef: "download://doubao/retained-real-pptx",
            manualActions: [],
          },
        }],
      }),
    /registered immutable capture receipt/i,
  );
});

test("the retained historical v28 Doubao provider fixture records durable recovery and retained render warnings", () => {
  const text = readFileSync(
    new URL(
      "../docs/smoke/doubao-real-provider-replay-2026-07-28.json",
      import.meta.url,
    ),
    "utf8",
  );
  const fixture = JSON.parse(text) as {
    readonly status: string;
    readonly execution: {
      readonly submitCount: number;
      readonly retryCount: number;
      readonly executionMode: string;
      readonly captureSource: string;
    };
    readonly trace: {
      readonly timestampGranularity: string;
      readonly conversationUrl: string;
      readonly vendorTaskId: string;
      readonly attemptStartedAt: string;
      readonly artifactCapturedAt: string;
      readonly vendorReportedElapsed: string;
      readonly manualActions: readonly string[];
    };
    readonly buildIdentity: {
      readonly source: string;
      readonly specCommitSha: string;
      readonly sourceArchiveDigest: string;
      readonly sourceArchiveEntryCount: number;
    };
    readonly artifact: {
      readonly contentHash: string;
      readonly byteSize: number;
      readonly pageCount: number;
    };
    readonly render: {
      readonly staticSlideHashes: readonly string[];
      readonly contactSheetHash: string;
      readonly warnings: readonly string[];
    };
    readonly recovery: {
      readonly derivativeCount: number;
      readonly recoveredDerivativeCount: number;
      readonly cliArtifactIdentityHash: string;
      readonly cliRenderManifestHash: string;
      readonly cliDerivativeCount: number;
      readonly cliRecoveredDerivativeCount: number;
      readonly cliDerivativeSetHash: string;
      readonly checkpointCount: number;
      readonly checkpointTraceHash: string;
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
      readonly browserDriverEvidence: {
        readonly driverId: string;
        readonly provenance: string;
        readonly captureReceipt: {
          readonly captureId: string;
          readonly artifactContentHash: string;
          readonly traceDigest: string;
          readonly retainedPageDigest: string;
          readonly renderDigest: string;
        };
      };
      readonly recoveryCliExecuted: boolean;
    };
  };

  assert.equal(
    fixture.status,
    "observed_real_provider_replay_ingest_recovered",
  );
  assert.deepEqual(fixture.execution, {
    publicHarnessReplayIngest: true,
    liveAutomatedRun: false,
    browserRerun: false,
    captureSource: "REAL_PROVIDER_CAPTURE",
    executionMode: "PRODUCTION_REPLAY",
    submitCount: 1,
    retryCount: 0,
  });
  assert.deepEqual(
    {
      source: fixture.buildIdentity.source,
      specCommitSha: fixture.buildIdentity.specCommitSha,
      sourceArchiveDigest:
        fixture.buildIdentity.sourceArchiveDigest,
      sourceArchiveEntryCount:
        fixture.buildIdentity.sourceArchiveEntryCount,
    },
    {
      source: "EMBEDDED_VERIFIED_BUILD_MANIFEST",
      specCommitSha:
        "fb08a1096bad8e63f33c27bd6add40e0ee6c792c",
      sourceArchiveDigest:
        "sha256:5b6709475e79b7d6fcc591d5ba4eef6a6716e79afb8aec28e77575d4cccf9982",
      sourceArchiveEntryCount: 43,
    },
  );
  assert.deepEqual(fixture.artifact, {
    contentHash:
      "sha256:ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4",
    byteSize: 5_184_523,
    pageCount: 16,
    provenance: "PRODUCTION_REPLAY",
  });
  assert.deepEqual(
    {
      conversationUrl: fixture.trace.conversationUrl,
      vendorTaskId: fixture.trace.vendorTaskId,
      attemptStartedAt: fixture.trace.attemptStartedAt,
      artifactCapturedAt: fixture.trace.artifactCapturedAt,
      vendorReportedElapsed: fixture.trace.vendorReportedElapsed,
    },
    {
      conversationUrl:
        "https://www.doubao.com/chat/38435879568317954",
      vendorTaskId: "task_38435879568317954",
      attemptStartedAt: "2026-07-27T10:34:46.000Z",
      artifactCapturedAt: "2026-07-27T10:45:58.000Z",
      vendorReportedElapsed: "9m 31s",
    },
  );
  assert.match(
    fixture.trace.timestampGranularity,
    /conservative upper bound.*not converted into an invented milestone timestamp/i,
  );
  assert.deepEqual(fixture.trace.manualActions, [
    "open a new Doubao task",
    "select PPT mode",
    "select detailed length",
    "retain intelligent matching",
    "enter the frozen 16-page Volcano prompt",
    "submit exactly once",
    "observe vendor completion label: 9m 31s",
    "observe completed 16-page editor and enabled Download control",
    "choose Download -> PPTX exactly once",
    "validate the one retained PPTX after the download listener timed out",
    "do not click export again; do not retry",
  ]);
  assert.equal(fixture.render.staticSlideHashes.length, 16);
  assert.match(
    fixture.render.contactSheetHash,
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(fixture.render.warnings, [
    "slide 9 title clipping observed in retained render",
    "overflow checker warning retained for slides 2-16",
    "no quality retry was performed",
  ]);
  assert.equal(fixture.recovery.derivativeCount, 33);
  assert.equal(fixture.recovery.recoveredDerivativeCount, 33);
  assert.equal(
    fixture.recovery.cliArtifactIdentityHash,
    "sha256:d37a99031eb726a27a9baf02b053b130282f89d4508136c392524c428b742774",
  );
  assert.equal(fixture.recovery.cliDerivativeCount, 33);
  assert.equal(
    fixture.recovery.cliRecoveredDerivativeCount,
    33,
  );
  assert.equal(
    fixture.recovery.cliRenderManifestHash,
    "sha256:11d68948fc4c200499af92b4acd4aed2a59bb2d22d7b47eaba6915f7c7db29d6",
  );
  assert.equal(
    fixture.recovery.cliDerivativeSetHash,
    "sha256:047f33568528b87be6abc3ce17898fdb98d36ed5f38742eed3d4b05db7e26826",
  );
  assert.equal(fixture.recovery.checkpointCount, 4);
  assert.equal(
    fixture.recovery.checkpointTraceHash,
    "sha256:f2b51f7de6b15d9676ee3d345ba406be0f7aeb42a10443e2c0d562fe2508ca0d",
  );
  assert.deepEqual(fixture.recovery.trustedRecoveryCheckpoint, {
    checkpointId: "doubao-volcano-20260727-real-provider-v1",
    purpose: "real_provider_recovery",
    schemaVersion: "doubao-recovery-checkpoint-v1",
  });
  assert.deepEqual(fixture.recovery.binaryValidation, {
    pptxSlideCount: 16,
    staticPngCount: 16,
    contactSheetPngCount: 1,
  });
  assert.deepEqual(fixture.recovery.browserDriverEvidence, {
    browserProfileDigest:
      "sha256:c6e451e70a930e80e799843cd8b1576d2bcaf47eb59c33ea1767e009fd599222",
    captureReceipt: {
      artifactContentHash:
        "sha256:ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4",
      captureId: "doubao-volcano-20260727-1845",
      renderDigest:
        "sha256:047f33568528b87be6abc3ce17898fdb98d36ed5f38742eed3d4b05db7e26826",
      retainedPageDigest:
        "sha256:8f9453b0cf3b88525d2ad69d7f0d854efd24cc7e86108fcafb82727912b46c3f",
      traceDigest:
        "sha256:594d9b94d81d98e4b8a1986db7353f6852ac17201076d85e5d6f64df505d40ad",
    },
    captureSource: "REAL_PROVIDER_CAPTURE",
    configurationDigest:
      "sha256:b79c9b95ad7e8180ee67ff1cc5554f604ec748871e71cc8da2b3334cd5310f7b",
    driverId: "doubao-real-provider-replay",
    driverVersion: "doubao-harness-browser-bridge@2",
    implementationDigest:
      "sha256:2317479ba1044dba3f3989b33445924bb5f6456b11d11dc56c0525403e1b7c6a",
    provenance: "PRODUCTION_REPLAY",
  });
  assert.equal(fixture.recovery.recoveryCliExecuted, true);
  assert.doesNotMatch(
    text,
    /cookie|authorization|bearer|token|password|localstorage|sessionstorage|\/Users\/|\/tmp\//i,
  );
});

test("an aborted submitted task is checkpointed and never proceeds to export", async () => {
  const complete = completeDoubaoDriver();
  const controller = new AbortController();
  let exportCount = 0;
  const result = await executeWithDriver(
    {
      ...complete,
      async waitForGeneration(command) {
        const generated = await complete.waitForGeneration(command);
        controller.abort();
        return generated;
      },
      async exportPresentation(command) {
        exportCount += 1;
        return complete.exportPresentation(command);
      },
    },
    "attempt-doubao-aborted",
    controller,
  );

  assert.equal(result.terminalReason, "task_state_unknown");
  assert.equal(exportCount, 0);
});

test("a recovered submitted task that the vendor reports failed resolves as a technical failure", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "doubao-vendor-failed-reconciliation",
  );
  await checkpoints.append({
    eventId: "attempt-doubao-vendor-failed-event-1",
    jobId: "job-doubao-vendor-failed",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
    runId: "run-doubao-vendor-failed",
    attemptId: "attempt-doubao-vendor-failed",
    attemptSeq: 1,
    eventType: "query_submitted",
    sourceAt: "2026-07-27T06:00:10.000Z",
    observedAt: "2026-07-27T06:00:10.000Z",
    writerId: "doubao-web-ppt@1",
    evidenceRef: "screenshot://doubao/submitted-redacted",
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "doubao-task-failed-1",
    taskStateVersion: "query_submitted@2",
    adapterVersion: "doubao-web-ppt@1",
    artifactId: null,
  });
  const adapter = new DoubaoProductionProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      attemptCheckpointStore: checkpoints,
      doubaoBrowserDriver: {
        ...completeDoubaoDriver(),
        async reconcileTask(query) {
          return {
            query,
            observedState: "failed",
            observedAt: "2026-07-27T06:01:00.000Z",
            evidenceRef:
              "screenshot://doubao/reconciliation-failed-redacted",
          };
        },
      },
    },
  );

  const execution = await executor({
    jobId: "job-doubao-vendor-failed",
    runId: "run-doubao-vendor-failed",
    attemptId: "attempt-doubao-vendor-failed",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok(!("content" in execution));
  const result = execution as ProductAttemptResult;
  const reconciliation = result.observableEvents?.at(-1);

  assert.equal(result.terminalReason, "technical_failure");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(reconciliation?.reconciliationObservedState, "failed");
  assert.equal(
    reconciliation?.reconciliationTerminalReason,
    "technical_failure",
  );
});

test("deadline shutdown completes when durable reconciliation confirms the submitted Doubao task failed", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "doubao-deadline-vendor-failed",
  );
  const runId =
    "MOCK-run-mock-doubao-production-boundary--f06b6b1c3ff3fdd00f55761d6926e4ea-volcano-v1";
  const attemptId = `${runId}-attempt-1`;
  await checkpoints.append({
    eventId: `${attemptId}-event-1`,
    jobId: "MOCK-job-volcano-v1",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
    runId,
    attemptId,
    attemptSeq: 1,
    eventType: "query_submitted",
    sourceAt: "2026-07-27T06:00:10.000Z",
    observedAt: "2026-07-27T06:00:10.000Z",
    writerId: "doubao-web-ppt@1",
    evidenceRef: "screenshot://doubao/submitted-redacted",
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "doubao-task-deadline-failed-1",
    taskStateVersion: "query_submitted@2",
    adapterVersion: "doubao-web-ppt@1",
    artifactId: null,
  });
  const productionAdapter = new DoubaoProductionProductAdapter();
  const testAdapter: ProductAdapterPort = {
    implementationPackage: productionAdapter.implementationPackage,
    executionConfigurationPackage:
      productionAdapter.executionConfigurationPackage,
    productPackage: {
      ...productionAdapter.productPackage,
      packageId: "MOCK-doubao-production-boundary-v1",
      displayName: "Mock-boundary Doubao PPT",
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
  const driver: DoubaoBrowserDriverPort = {
    ...completeDoubaoDriver(),
    async reconcileTask(query) {
      return {
        query,
        observedState: "failed",
        observedAt: "2026-07-27T06:01:00.000Z",
        evidenceRef:
          "screenshot://doubao/reconciliation-failed-redacted",
      };
    },
  };
  const deadline: AttemptDeadlinePort = {
    async run(operation, timeoutMs) {
      const controller = new AbortController();
      controller.abort();
      return {
        timedOut: true,
        elapsedMs: timeoutMs,
        shutdownCompleted: true,
        shutdownValue: await operation(controller.signal),
      };
    },
  };
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: testAdapter,
    doubaoBrowserDriver: driver,
    attemptCheckpointStore: checkpoints,
    attemptDeadline: deadline,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });
  const attempt = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordId }) => recordId === attemptId,
    );

  assert.equal(outcome.job.status, "failed");
  assert.equal(attempt?.status, "timed_out");
  assert.equal(attempt?.terminalReason, "vendor_timeout");
  assert.equal(attempt?.submissionEvidence, "submitted");
  assert.ok(
    checkpoints.snapshot().some(
      ({
        reconciliationObservedState,
        reconciliationTerminalReason,
      }) =>
        reconciliationObservedState === "failed" &&
        reconciliationTerminalReason === "technical_failure",
    ),
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

test("the production boundary rejects credential key-value material hidden in a URL fragment", async () => {
  const complete = completeDoubaoDriver();
  for (const fragment of [
    "access_token=secret-value",
    "session_token=secret-session",
    "authorization=Bearer%20secret-bearer",
  ]) {
    await assert.rejects(
      executeWithDriver(
        {
          ...complete,
          async inspectCurrentPackage(command) {
            return {
              ...(await complete.inspectCurrentPackage(command)),
              sourceUrl:
                `https://www.doubao.com/chat/ppt-observed#${fragment}`,
            };
          },
        },
        `attempt-doubao-unsafe-fragment-${fragment.length}`,
      ),
      /sensitive URL fragment|not secret-safe/i,
    );
  }
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
