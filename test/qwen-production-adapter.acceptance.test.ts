import assert from "node:assert/strict";
import test from "node:test";

import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  MockQwenProductAdapter,
  QwenProductionProductAdapter,
  VOLCANO_EVALUATION_CASE,
  createQwenProductAdapterExecutorForTest,
  parseAdapterExecutionConfiguration,
  sha256Bytes,
  type Artifact,
  type ProductAdapterPort,
  type QwenBrowserDriverPort,
  type QwenBrowserExecutionCommand,
  type QwenBrowserExecution,
} from "../src/index.ts";
import {
  renderStaticArtifact,
  resolveHarnessProductAdapterExecutor,
} from "../src/mock-wps.ts";

type CallerExecutionKeys = Extract<
  keyof ProductAdapterPort,
  "execute" | "executorFactory" | "browserDriver"
>;
const productAdapterPortHasNoQwenExecutionKeys:
  CallerExecutionKeys extends never ? true : false = true;
void productAdapterPortHasNoQwenExecutionKeys;

test("the Qwen production adapter is a pure-data descriptor for the frozen zero-added-cost 16-page package", () => {
  const adapter = new QwenProductionProductAdapter();

  assert.deepEqual(Object.keys(adapter).sort(), [
    "executionConfigurationPackage",
    "implementationPackage",
    "productPackage",
  ]);
  assert.deepEqual(adapter.productPackage.declaredConfiguration, {
    entryUrl: "https://www.qianwen.com/",
    accountReference: "current_signed_in_account",
    packageSelection: "best_available_zero_added_cost",
    modelSelection: "best_available_zero_added_cost",
    expertMode: "best_available_zero_added_cost",
    networking: "enabled",
    pageCount: 16,
  });
  assert.equal(adapter.productPackage.provenance, "PRODUCTION");
  assert.equal(
    adapter.productPackage.environmentOrigin.environment,
    "production",
  );
  assert.equal(
    JSON.stringify(adapter),
    JSON.stringify(adapter),
  );
  assert.doesNotMatch(
    JSON.stringify(adapter),
    /cookie|authorization|localstorage|password|token|secret|chain.of.thought/i,
  );
});

async function qwenPptxFixture(): Promise<Artifact> {
  const adapter = new MockQwenProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
  );
  const execution = await executor({
    jobId: "fixture-job",
    runId: "fixture-run",
    attemptId: "fixture-attempt",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok(!("content" in execution));
  const artifact = execution.artifactCandidates[0]?.artifact;
  assert.ok(artifact);
  return artifact;
}

class SuccessfulQwenBrowserFake implements QwenBrowserDriverPort {
  readonly runtimeProvenance = "TEST" as const;
  executeCount = 0;

  constructor(private readonly fixture: Artifact) {}

  async execute(command: QwenBrowserExecutionCommand) {
    this.executeCount += 1;
    assert.deepEqual(
      {
        entryUrl: command.entryUrl,
        prompt: command.prompt,
        pageCount: command.pageCount,
        networking: command.networking,
        packageSelection: command.packageSelection,
        timeoutMs: command.timeoutMs,
      },
      {
        entryUrl: "https://www.qianwen.com/",
        prompt: VOLCANO_EVALUATION_CASE.vendorPrompt,
        pageCount: 16 as const,
        networking: "enabled",
        packageSelection: "best_available_zero_added_cost",
        timeoutMs: 30 * 60 * 1_000,
      },
    );
    const renderManifest = renderStaticArtifact(this.fixture);
    return {
      status: "completed" as const,
      submissionEvidence: "submitted" as const,
      elapsedMs: 396_000,
      observedConfiguration: {
        actualUrl:
          "https://www.qianwen.com/chat/observable-task?session=must-not-persist#progress",
        accountReference: "current_signed_in_account" as const,
        packageLabel: "current-account-included",
        addedCost: "zero" as const,
        modelLabel: "Qwen3.7",
        expertMode: "enabled" as const,
        networking: "enabled" as const,
        pageCount: 16 as const,
      },
      milestones: [
        {
          eventType: "page_opened" as const,
          observedAt: "2026-07-27T10:00:00.000Z",
          url: "https://www.qianwen.com/",
        },
        {
          eventType: "submission_observed" as const,
          observedAt: "2026-07-27T10:01:00.000Z",
          url: "https://www.qianwen.com/chat/observable-task?session=must-not-persist",
        },
        {
          eventType: "export_ready" as const,
          observedAt: "2026-07-27T10:06:30.000Z",
          url: "https://www.qianwen.com/chat/observable-task?session=must-not-persist",
        },
      ],
      manualActions: [
        {
          action: "confirmed_visible_package" as const,
          observedAt: "2026-07-27T10:00:30.000Z",
        },
      ],
      download: {
        filename: "qwen-volcano-16.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const,
        capturedAt: "2026-07-27T10:06:36.000Z",
        content: this.fixture.content,
      },
      staticRenders: renderManifest.slides.map((slide) => ({
        pageNumber: slide.pageNumber,
        filename: slide.filename,
        mimeType: slide.mimeType,
        contentHash: slide.contentHash,
        content: new TextEncoder().encode(slide.content),
      })),
    };
  }
}

test("the Qwen workflow captures the first downloaded PPTX with hash, 16 static pages, and allowlisted observable trace", async () => {
  const fixture = await qwenPptxFixture();
  const executor = createQwenProductAdapterExecutorForTest(
    new SuccessfulQwenBrowserFake(fixture),
  );

  const result = await executor({
    jobId: "job-qwen-real-path",
    runId: "run-qwen-real-path",
    attemptId: "attempt-qwen-real-path-1",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });

  assert.equal(result.terminalReason, "success");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(result.artifactCandidates.length, 1);
  const artifact = result.artifactCandidates[0]?.artifact;
  assert.ok(artifact);
  assert.equal(artifact.provenance, "MOCK");
  assert.equal(artifact.environmentOrigin, MOCK_TEST_ENVIRONMENT_ORIGIN);
  assert.equal(artifact.pageCount, 16);
  assert.equal(
    artifact.contentHash,
    "sha256:6a0d07f9c97c1a62d52e6fd8530b16c4d35942447cda61cb8674f41ad404b415",
  );
  assert.equal(result.staticRenders.length, 16);
  assert.deepEqual(
    result.staticRenders.map(({ pageNumber }) => pageNumber),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.deepEqual(result.observedConfiguration, {
    actualUrl: "https://www.qianwen.com/chat/observable-task",
    accountReference: "current_signed_in_account",
    packageLabel: "current-account-included",
    addedCost: "zero",
    modelLabel: "Qwen3.7",
    expertMode: "enabled",
    networking: "enabled",
    pageCount: 16,
  });
  assert.deepEqual(
    result.trace.map(({ eventType }) => eventType),
    [
      "page_opened",
      "submission_observed",
      "export_ready",
      "artifact_downloaded",
      "artifact_validated",
      "static_render_validated",
    ],
  );
  assert.doesNotMatch(
    JSON.stringify({
      trace: result.trace,
      manualActions: result.manualActions,
      observedConfiguration: result.observedConfiguration,
    }),
    /cookie|authorization|localstorage|password|token|secret|chain.of.thought/i,
  );
  assert.doesNotMatch(JSON.stringify(result.trace), /must-not-persist/);
});

class TerminalQwenBrowserFake implements QwenBrowserDriverPort {
  readonly runtimeProvenance = "TEST" as const;
  executeCount = 0;

  constructor(private readonly outcome: QwenBrowserExecution) {}

  async execute() {
    this.executeCount += 1;
    return this.outcome;
  }
}

test("the Qwen adapter returns retry-safe submission evidence and never resubmits by itself", async () => {
  const cases = [
    {
      outcome: {
        status: "terminal" as const,
        terminalReason: "technical_failure" as const,
        blockReason: null,
        submissionEvidence: "not_submitted" as const,
        elapsedMs: 2_000,
        observedAt: "2026-07-27T10:00:02.000Z",
        observedConfiguration: null,
        milestones: [
          {
            eventType: "page_opened" as const,
            observedAt: "2026-07-27T10:00:00.000Z",
            url: "https://www.qianwen.com/",
          },
        ],
        manualActions: [],
      },
      expected: {
        terminalReason: "technical_failure",
        submissionEvidence: "not_submitted",
      },
    },
    {
      outcome: {
        status: "terminal" as const,
        terminalReason: "vendor_timeout" as const,
        blockReason: null,
        submissionEvidence: "submitted" as const,
        elapsedMs: 30 * 60 * 1_000,
        observedAt: "2026-07-27T10:30:00.000Z",
        observedConfiguration: null,
        milestones: [
          {
            eventType: "submission_observed" as const,
            observedAt: "2026-07-27T10:01:00.000Z",
            url: "https://www.qianwen.com/chat/observable-task",
          },
        ],
        manualActions: [],
      },
      expected: {
        terminalReason: "vendor_timeout",
        submissionEvidence: "submitted",
      },
    },
    {
      outcome: {
        status: "terminal" as const,
        terminalReason: "technical_failure" as const,
        blockReason: null,
        submissionEvidence: "unknown" as const,
        elapsedMs: 10_000,
        observedAt: "2026-07-27T10:00:10.000Z",
        observedConfiguration: null,
        milestones: [],
        manualActions: [],
      },
      expected: {
        terminalReason: "technical_failure",
        submissionEvidence: "unknown",
      },
    },
  ];

  for (const { outcome, expected } of cases) {
    const driver = new TerminalQwenBrowserFake(outcome);
    const result = await createQwenProductAdapterExecutorForTest(driver)({
      jobId: "job-qwen-terminal-path",
      runId: "run-qwen-terminal-path",
      attemptId: "attempt-qwen-terminal-path-1",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    });

    assert.equal(result.terminalReason, expected.terminalReason);
    assert.equal(
      result.submissionEvidence,
      expected.submissionEvidence,
    );
    assert.equal(result.artifactCandidates.length, 0);
    assert.equal(driver.executeCount, 1);
    assert.equal(result.trace.at(-1)?.eventType, "terminal_observed");
  }
});

test("a successful Qwen attempt captures the first compliant output without quality-based retry", async () => {
  const fixture = await qwenPptxFixture();
  const driver = new SuccessfulQwenBrowserFake(fixture);
  const executor = createQwenProductAdapterExecutorForTest(driver);

  const result = await executor({
    jobId: "job-qwen-first-output",
    runId: "run-qwen-first-output",
    attemptId: "attempt-qwen-first-output-1",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });

  assert.equal(result.terminalReason, "success");
  assert.equal(result.artifactCandidates.length, 1);
  assert.equal(driver.executeCount, 1);
});

test("the harness-owned registry binds Qwen execution from frozen packages instead of ProductAdapterPort functions", async () => {
  const descriptor = new QwenProductionProductAdapter();
  const testDriver = new TerminalQwenBrowserFake({
    status: "terminal",
    terminalReason: "technical_failure",
    blockReason: null,
    submissionEvidence: "not_submitted",
    elapsedMs: 1,
    observedAt: "2026-07-27T10:00:00.001Z",
    observedConfiguration: null,
    milestones: [],
    manualActions: [],
  });
  let callerCalls = 0;
  const callerExtendedDescriptor = {
    ...descriptor,
    browserDriver: testDriver,
    execute: async () => {
      callerCalls += 1;
      throw new Error("caller execution must not run");
    },
  };
  const executionConfiguration =
    parseAdapterExecutionConfiguration(
      descriptor.executionConfigurationPackage,
    );

  assert.throws(
    () =>
      resolveHarnessProductAdapterExecutor(
        callerExtendedDescriptor.implementationPackage,
        executionConfiguration,
      ),
    /production Qwen browser driver/i,
  );
  assert.throws(
    () =>
      resolveHarnessProductAdapterExecutor(
        callerExtendedDescriptor.implementationPackage,
        executionConfiguration,
        { qwenBrowserDriver: testDriver },
      ),
    /PRODUCTION browser driver/i,
  );
  assert.equal(callerCalls, 0);
});

test("the registry rejects a Qwen production implementation package whose bytes do not match the frozen module", () => {
  const descriptor = new QwenProductionProductAdapter();
  const content = descriptor.implementationPackage.content.slice();
  content[0] = (content[0] ?? 0) ^ 0xff;
  const tampered = {
    ...descriptor.implementationPackage,
    content,
  };

  assert.throws(
    () =>
      resolveHarnessProductAdapterExecutor(
        tampered,
        parseAdapterExecutionConfiguration(
          descriptor.executionConfigurationPackage,
        ),
        {
          qwenBrowserDriver: {
            runtimeProvenance: "PRODUCTION",
            execute: async () => {
              throw new Error("must not execute");
            },
          },
        },
      ),
    /implementation package is not registered/i,
  );
});

test("the Qwen artifact safety gate rejects a downloaded presentation containing an embedded macro payload", async () => {
  const fixture = await qwenPptxFixture();
  const marker = new TextEncoder().encode("ppt/vbaProject.bin");
  const content = new Uint8Array(
    fixture.content.byteLength + marker.byteLength,
  );
  content.set(fixture.content, 0);
  content.set(marker, fixture.content.byteLength);
  const unsafeFixture: Artifact = {
    ...fixture,
    byteSize: content.byteLength,
    contentHash: sha256Bytes(content),
    content,
  };

  await assert.rejects(
    createQwenProductAdapterExecutorForTest(
      new SuccessfulQwenBrowserFake(unsafeFixture),
    )({
      jobId: "job-qwen-macro",
      runId: "run-qwen-macro",
      attemptId: "attempt-qwen-macro-1",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /macro|unsafe PPTX/i,
  );
});
