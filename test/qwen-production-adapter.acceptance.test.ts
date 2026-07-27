import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  InMemoryFeishuProjection,
  InMemoryAttemptCheckpointStore,
  MockQwenProductAdapter,
  QwenProductionProductAdapter,
  QwenReplayProductAdapter,
  PRODUCTION_VOLCANO_EVALUATION_CASE,
  VOLCANO_EVALUATION_CASE,
  createQwenProductAdapterExecutorForTest,
  createQwenRealProviderReplayPackage,
  createBakeoffHarness,
  parseAdapterExecutionConfiguration,
  registeredQwenBrowserDriverEvidence,
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
  assert.deepEqual(adapter.productPackage.experienceConfiguration, {
    productUrl: "https://www.qianwen.com/",
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
  });
  assert.equal(adapter.productPackage.provenance, "LIVE_PRODUCTION");
  assert.equal(
    adapter.productPackage.environmentOrigin.environment,
    "production",
  );
  assert.equal(
    JSON.stringify(adapter),
    JSON.stringify(adapter),
  );
  assert.equal(
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ).scenario,
    "production-live",
  );
  assert.doesNotMatch(
    JSON.stringify(adapter),
    /cookie|authorization|localstorage|password|token|secret|chain.of.thought/i,
  );
});

test("Qwen retained captures are declared as PRODUCTION_REPLAY rather than LIVE_PRODUCTION", () => {
  const replay = new QwenReplayProductAdapter();

  assert.equal(replay.productPackage.provenance, "PRODUCTION_REPLAY");
  assert.equal(
    parseAdapterExecutionConfiguration(
      replay.executionConfigurationPackage,
    ).scenario,
    "production-replay",
  );
  assert.equal(
    replay.productPackage.egressDestination.targetService,
    "qwen-replay-ingest",
  );
});

test("Qwen replay driver identity is frozen for Run Specification lineage", () => {
  const replayDriver = createQwenRealProviderReplayPackage({
    sessions: [],
    reconciliations: [
      {
        query: {
          vendorTaskId: "task_qwen_identity_1234",
          taskStateVersion: "submitted@1",
          eventHistoryHash:
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          artifactContentHash: null,
        },
        observedState: "submitted",
        observedAt: "2026-07-27T10:01:00.000Z",
        evidenceId: "ev_3333333333333333",
      },
    ],
  });

  assert.deepEqual(
    registeredQwenBrowserDriverEvidence(replayDriver),
    {
      driverId: "qwen-real-provider-replay",
      provenance: "PRODUCTION_REPLAY",
      captureSource: "REAL_PROVIDER_CAPTURE",
      driverVersion: "qwen-harness-browser-bridge@1",
      browserProfileDigest:
        registeredQwenBrowserDriverEvidence(replayDriver)
          .browserProfileDigest,
      implementationDigest:
        replayDriver.implementationPackage?.contentHash,
      configurationDigest:
        replayDriver.configurationPackage?.contentHash,
    },
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
        content:
          typeof slide.content === "string"
            ? new TextEncoder().encode(slide.content)
            : Uint8Array.from(slide.content),
      })),
    };
  }
}

async function retainedQwenReplaySession(
  fixture: Artifact,
  evidenceBindings: Readonly<{
    package: `ev_${string}`;
    model: `ev_${string}`;
    configuration: `ev_${string}`;
  }>,
): Promise<QwenBrowserExecution> {
  const captured = await new SuccessfulQwenBrowserFake(fixture).execute({
    attemptSeq: 1,
    entryUrl: "https://www.qianwen.com/",
    prompt: VOLCANO_EVALUATION_CASE.vendorPrompt,
    pageCount: 16,
    networking: "enabled",
    packageSelection: "best_available_zero_added_cost",
    modelSelection: "best_available_zero_added_cost",
    expertMode: "best_available_zero_added_cost",
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
  });
  return {
    ...captured,
    observedConfiguration: {
      ...captured.observedConfiguration,
      evidenceBindings,
    },
    milestones: [
      captured.milestones[0]!,
      {
        eventType: "package_observed" as const,
        observedAt: "2026-07-27T10:00:10.000Z",
        url: "https://www.qianwen.com/chat/observable-task",
      },
      {
        eventType: "model_observed" as const,
        observedAt: "2026-07-27T10:00:15.000Z",
        url: "https://www.qianwen.com/chat/observable-task",
      },
      {
        eventType: "configuration_applied" as const,
        observedAt: "2026-07-27T10:00:20.000Z",
        url: "https://www.qianwen.com/chat/observable-task",
      },
      ...captured.milestones.slice(1),
    ].map((milestone, index) => ({
      ...milestone,
      evidenceId:
        `ev_${String(index + 1).repeat(16)}` as `ev_${string}`,
      ...(milestone.eventType === "page_opened"
        ? {}
        : {
            vendorTaskId:
              "task_qwen_capture_1234" as `task_${string}`,
            taskStateVersion:
              milestone.eventType === "submission_observed"
                ? "submitted@1"
                : "artifact_ready@2",
          }),
    })),
    staticRenders: [],
  };
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
    actualUrl: "https://www.qianwen.com/chat/redacted",
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

test("Qwen rejects completed output whose submission claim contradicts its observable checkpoints", async () => {
  const fixture = await qwenPptxFixture();
  const successful = new SuccessfulQwenBrowserFake(fixture);
  const contradictory: QwenBrowserDriverPort = {
    runtimeProvenance: "TEST",
    async execute(command) {
      const result = await successful.execute(command);
      return {
        ...result,
        milestones: result.milestones.filter(
          ({ eventType }) =>
            ![
              "submission_observed",
              "generation_ready",
              "export_ready",
            ].includes(eventType),
        ),
      };
    },
  };

  await assert.rejects(
    createQwenProductAdapterExecutorForTest(contradictory)({
      jobId: "job-qwen-contradictory-submission",
      runId: "run-qwen-contradictory-submission",
      attemptId: "attempt-qwen-contradictory-submission-1",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /submission evidence contradicts observable checkpoints/i,
  );
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

  const liveExecutor = resolveHarnessProductAdapterExecutor(
    callerExtendedDescriptor.implementationPackage,
    executionConfiguration,
  );
  await assert.rejects(
    liveExecutor({
      jobId: "qwen-live-registry-job",
      runId: "qwen-live-registry-run",
      attemptId: "qwen-live-registry-attempt",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /live executable is not embedded.*fails closed/i,
  );
  assert.throws(
    () =>
      resolveHarnessProductAdapterExecutor(
        callerExtendedDescriptor.implementationPackage,
        executionConfiguration,
        { qwenBrowserDriver: testDriver },
      ),
    /Qwen browser driver.*not allowlisted/i,
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
            runtimeProvenance: "LIVE_PRODUCTION",
            execute: async () => {
              throw new Error("must not execute");
            },
          },
        },
      ),
    /implementation package is not registered/i,
  );
});

test("the production registry rejects an arbitrary Qwen browser closure that only self-reports real-provider provenance", () => {
  const descriptor = new QwenProductionProductAdapter();

  assert.throws(
    () =>
      resolveHarnessProductAdapterExecutor(
        descriptor.implementationPackage,
        parseAdapterExecutionConfiguration(
          descriptor.executionConfigurationPackage,
        ),
        {
          qwenBrowserDriver: {
            runtimeProvenance: "PRODUCTION_REPLAY",
            execute: async () => {
              throw new Error("arbitrary browser closure must not run");
            },
          },
        },
      ),
    /Qwen browser driver.*not allowlisted/i,
  );
});

test("the public production start path rejects a caller-supplied Qwen browser closure before execution", async () => {
  let calls = 0;
  const harness = createBakeoffHarness({
    feishu: new InMemoryFeishuProjection({
      targetEnvironment: "production",
    }),
    productAdapter: new QwenReplayProductAdapter(),
    qwenBrowserDriver: {
      runtimeProvenance: "PRODUCTION_REPLAY",
      async execute() {
        calls += 1;
        throw new Error("arbitrary closure must not execute");
      },
    },
  });

  await assert.rejects(
    async () =>
      harness.startBakeoffJob({
        caseId: VOLCANO_EVALUATION_CASE.caseId,
        environment: "production",
      }),
    /Qwen browser driver.*not allowlisted/i,
  );
  assert.equal(calls, 0);
});

test("a restarted Qwen replay reuses its durable reconciliation result idempotently", async () => {
  const attemptId = "attempt-qwen-recovery-1";
  const checkpointStore = new InMemoryAttemptCheckpointStore(
    "qwen-recovery-checkpoints",
  );
  const checkpoint = {
    eventId: `${attemptId}-qwen-event-1`,
    jobId: "job-qwen-recovery",
    caseId: PRODUCTION_VOLCANO_EVALUATION_CASE.caseId,
    runId: "run-qwen-recovery",
    attemptId,
    attemptSeq: 1,
    eventType: "submission_observed",
    sourceAt: "2026-07-27T10:01:00.000Z",
    observedAt: "2026-07-27T10:01:00.000Z",
    writerId: "qwen-web@1",
    evidenceRef: "ev_1111111111111111",
    sourceUrl: "urn:qwen-evidence:ev_1111111111111111",
    submissionEvidenceAtCheckpoint: "submitted" as const,
    vendorTaskId: "task_qwen_recovery_1234",
    taskStateVersion: "generating@7",
    adapterVersion: "qwen-web@1",
    artifactId: null,
  };
  await checkpointStore.append(checkpoint);
  const eventHistoryHash = sha256Bytes(
    new TextEncoder().encode(JSON.stringify([checkpoint])),
  );
  const replayDriver = createQwenRealProviderReplayPackage({
    sessions: [],
    reconciliations: [
      {
        query: {
          vendorTaskId: "task_qwen_recovery_1234",
          taskStateVersion: "generating@7",
          eventHistoryHash,
          artifactContentHash: null,
        },
        observedState: "artifact_ready",
        observedAt: "2026-07-27T10:05:00.000Z",
        evidenceId: "ev_2222222222222222",
      },
    ],
  });
  const descriptor = new QwenReplayProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    descriptor.implementationPackage,
    parseAdapterExecutionConfiguration(
      descriptor.executionConfigurationPackage,
    ),
    {
      qwenBrowserDriver: replayDriver,
      attemptCheckpointStore: checkpointStore,
    },
  );

  const command = {
    jobId: checkpoint.jobId,
    runId: checkpoint.runId,
    attemptId,
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
  };
  const result = await executor(command);

  assert.ok(!("content" in result));
  assert.equal(result.terminalReason, "download_failure");
  assert.equal(result.artifactCandidates.length, 0);
  assert.equal(
    result.observableEvents?.at(-1)?.eventType,
    "task_reconciliation_result",
  );
  assert.equal(
    result.observableEvents?.at(-1)
      ?.reconciliationArtifactReference,
    "qwen-task:task_qwen_recovery_1234",
  );
  const persistedAfterFirstRestart =
    await checkpointStore.readAttempt(attemptId);
  const restartedAgain = await executor(command);

  assert.deepEqual(restartedAgain, result);
  assert.deepEqual(
    await checkpointStore.readAttempt(attemptId),
    persistedAfterFirstRestart,
  );
});

test("Qwen replay rejects unknown final evidence after a durable submission checkpoint", async () => {
  const descriptor = new QwenReplayProductAdapter();
  const checkpointStore = new InMemoryAttemptCheckpointStore(
    "qwen-unknown-after-submission-checkpoints",
  );
  const executor = resolveHarnessProductAdapterExecutor(
    descriptor.implementationPackage,
    parseAdapterExecutionConfiguration(
      descriptor.executionConfigurationPackage,
    ),
    {
      qwenBrowserDriver: createQwenRealProviderReplayPackage({
        sessions: [
          {
            status: "terminal",
            terminalReason: "task_state_unknown",
            blockReason: null,
            submissionEvidence: "unknown",
            elapsedMs: 30_000,
            observedAt: "2026-07-27T10:01:30.000Z",
            observedConfiguration: null,
            milestones: [
              {
                eventType: "submission_observed",
                observedAt: "2026-07-27T10:01:00.000Z",
                url: "https://www.qianwen.com/chat/observable-task",
                evidenceId: "ev_4444444444444444",
                vendorTaskId: "task_qwen_unknown_1234",
                taskStateVersion: "submitted@1",
              },
            ],
            manualActions: [],
          },
        ],
      }),
      attemptCheckpointStore: checkpointStore,
    },
  );

  await assert.rejects(
    executor({
      jobId: "job-qwen-unknown-after-submission",
      runId: "run-qwen-unknown-after-submission",
      attemptId: "attempt-qwen-unknown-after-submission-1",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
    }),
    /submission evidence contradicts observable checkpoints/i,
  );
  assert.equal(
    (
      await checkpointStore.readAttempt?.(
        "attempt-qwen-unknown-after-submission-1",
      )
    )?.at(-1)?.submissionEvidenceAtCheckpoint,
    "submitted",
  );
});

test("Qwen replay treats generation-ready evidence as submitted and rejects an unknown final claim", async () => {
  const descriptor = new QwenReplayProductAdapter();
  const executor = resolveHarnessProductAdapterExecutor(
    descriptor.implementationPackage,
    parseAdapterExecutionConfiguration(
      descriptor.executionConfigurationPackage,
    ),
    {
      qwenBrowserDriver: createQwenRealProviderReplayPackage({
        sessions: [
          {
            status: "terminal",
            terminalReason: "technical_failure",
            blockReason: null,
            submissionEvidence: "unknown",
            elapsedMs: 60_000,
            observedAt: "2026-07-27T10:02:00.000Z",
            observedConfiguration: null,
            milestones: [
              {
                eventType: "generation_ready",
                observedAt: "2026-07-27T10:01:30.000Z",
                url: "https://www.qianwen.com/chat/observable-task",
                evidenceId: "ev_5555555555555555",
                vendorTaskId: "task_qwen_generation_1234",
                taskStateVersion: "generation_ready@2",
              },
            ],
            manualActions: [],
          },
        ],
      }),
      attemptCheckpointStore: new InMemoryAttemptCheckpointStore(
        "qwen-generation-ready-checkpoints",
      ),
    },
  );

  await assert.rejects(
    executor({
      jobId: "job-qwen-generation-ready",
      runId: "run-qwen-generation-ready",
      attemptId: "attempt-qwen-generation-ready-1",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
    }),
    /post-submit milestone.*submission evidence/i,
  );
});

test("Qwen replay rejects unsafe structured evidence before persisting any checkpoint", async (t) => {
  const observedAt = "2026-07-27T10:01:30.000Z";
  const baseExecution = {
    status: "terminal",
    terminalReason: "technical_failure",
    blockReason: null,
    submissionEvidence: "submitted",
    elapsedMs: 60_000,
    observedAt: "2026-07-27T10:02:00.000Z",
    observedConfiguration: null,
    milestones: [
      {
        eventType: "submission_observed",
        observedAt,
        url: "https://www.qianwen.com/chat/observable-task",
        evidenceId: "ev_6666666666666666",
        vendorTaskId: "task_qwen_structured_1234",
        taskStateVersion: "submitted@2",
      },
    ],
    manualActions: [],
  } satisfies QwenBrowserExecution;
  const unsafeExecutions = [
    {
      label: "manual action",
      execution: {
        ...baseExecution,
        manualActions: [
          {
            action: "Bearer authorization token",
            observedAt,
          },
        ],
      },
    },
    {
      label: "vendor task ID",
      execution: {
        ...baseExecution,
        milestones: [
          {
            ...baseExecution.milestones[0],
            vendorTaskId: "task_bearer_authorization_token",
          },
        ],
      },
    },
    {
      label: "task state version",
      execution: {
        ...baseExecution,
        milestones: [
          {
            ...baseExecution.milestones[0],
            taskStateVersion: `Bearer ${"x".repeat(160)}`,
          },
        ],
      },
    },
    {
      label: "evidence reference",
      execution: {
        ...baseExecution,
        milestones: [
          {
            ...baseExecution.milestones[0],
            evidenceId: "ev_bearer_authorization_token",
          },
        ],
      },
    },
  ] as const;

  for (const { label, execution } of unsafeExecutions) {
    await t.test(label, async () => {
      const checkpointStore = new InMemoryAttemptCheckpointStore(
        `qwen-unsafe-${label}`,
      );
      const descriptor = new QwenReplayProductAdapter();
      const executor = resolveHarnessProductAdapterExecutor(
        descriptor.implementationPackage,
        parseAdapterExecutionConfiguration(
          descriptor.executionConfigurationPackage,
        ),
        {
          qwenBrowserDriver: createQwenRealProviderReplayPackage({
            sessions: [
              execution as unknown as QwenBrowserExecution,
            ],
          }),
          attemptCheckpointStore: checkpointStore,
        },
      );
      const attemptId = `attempt-qwen-unsafe-${label}`;

      await assert.rejects(
        executor({
          jobId: `job-qwen-unsafe-${label}`,
          runId: `run-qwen-unsafe-${label}`,
          attemptId,
          attemptSeq: 1,
          timeoutMs: 30 * 60 * 1_000,
          signal: new AbortController().signal,
          evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
        }),
        /unsafe|allowlisted|opaque/i,
      );
      assert.deepEqual(
        await checkpointStore.readAttempt(attemptId),
        [],
      );
    });
  }
});

test("Qwen configuration evidence cannot be borrowed from a submission milestone", async () => {
  const fixture = await qwenPptxFixture();
  const replaySession = await retainedQwenReplaySession(fixture, {
    package: "ev_2222222222222222",
    model: "ev_5555555555555555",
    configuration: "ev_4444444444444444",
  });
  const descriptor = new QwenReplayProductAdapter();

  await assert.rejects(
    resolveHarnessProductAdapterExecutor(
      descriptor.implementationPackage,
      parseAdapterExecutionConfiguration(
        descriptor.executionConfigurationPackage,
      ),
      {
        qwenBrowserDriver: createQwenRealProviderReplayPackage({
          sessions: [replaySession],
        }),
        attemptCheckpointStore: new InMemoryAttemptCheckpointStore(
          "qwen-misbound-configuration-checkpoints",
        ),
      },
    )({
      jobId: "job-qwen-misbound-configuration",
      runId: "run-qwen-misbound-configuration",
      attemptId: "attempt-qwen-misbound-configuration-1",
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
    }),
    /configuration evidence.*dedicated.*milestone/i,
  );
});

test("a retained Qwen capture produces PRODUCTION_REPLAY Artifact and bound opaque execution evidence", async () => {
  const fixture = await qwenPptxFixture();
  const replaySession = await retainedQwenReplaySession(fixture, {
    package: "ev_2222222222222222",
    model: "ev_3333333333333333",
    configuration: "ev_4444444444444444",
  });
  const descriptor = new QwenReplayProductAdapter();
  const checkpointStore = new InMemoryAttemptCheckpointStore(
    "qwen-capture-checkpoints",
  );
  const result = await resolveHarnessProductAdapterExecutor(
    descriptor.implementationPackage,
    parseAdapterExecutionConfiguration(
      descriptor.executionConfigurationPackage,
    ),
    {
      qwenBrowserDriver: createQwenRealProviderReplayPackage({
        sessions: [replaySession],
      }),
      attemptCheckpointStore: checkpointStore,
    },
  )({
    jobId: "job-qwen-capture",
    runId: "run-qwen-capture",
    attemptId: "attempt-qwen-capture-1",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
  });

  assert.ok(!("content" in result));
  const candidate = result.artifactCandidates[0];
  assert.ok(candidate);
  assert.equal(candidate.artifact.provenance, "PRODUCTION_REPLAY");
  assert.equal(
    candidate.productionExecutionEvidence?.captureSource,
    "REAL_PROVIDER_CAPTURE",
  );
  assert.equal(
    candidate.productionExecutionEvidence?.traceHash,
    sha256Bytes(
      new TextEncoder().encode(
        JSON.stringify(result.observableEvents),
      ),
    ),
  );
  assert.ok(
    result.observableEvents?.every(
      ({ evidenceRef, sourceUrl }) =>
        /^ev_[a-f0-9]{16,64}$/.test(evidenceRef) &&
        sourceUrl === `urn:qwen-evidence:${evidenceRef}`,
    ),
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
    /macro|PPTX|ZIP.*unsafe/i,
  );
});

test("the real Qwen smoke metadata keeps a timed-out partial output out of Artifact, scorecard, and comparison", () => {
  const raw = readFileSync(
    new URL(
      "../docs/smoke/qwen-real-smoke-2026-07-27.json",
      import.meta.url,
    ),
    "utf8",
  );
  const smoke = JSON.parse(raw) as {
    readonly result: {
      readonly status: string;
      readonly pptxCaptured: boolean;
      readonly sha256: string | null;
      readonly staticRenderCount: number;
    };
    readonly reconciliation: {
      readonly status: string;
      readonly completionVerified: boolean;
      readonly downloadReady: boolean | null;
      readonly downloadCount: number;
      readonly retryPerformed: boolean;
      readonly artifactCaptured: boolean;
    };
    readonly evaluationGate: {
      readonly artifactAccepted: boolean;
      readonly scorecardProduced: boolean;
      readonly comparisonProduced: boolean;
    };
  };

  assert.equal(smoke.result.status, "timeout_partial");
  assert.equal(smoke.result.pptxCaptured, false);
  assert.equal(smoke.result.sha256, null);
  assert.equal(smoke.result.staticRenderCount, 0);
  assert.equal(
    smoke.reconciliation.status,
    "browser_connection_blocked",
  );
  assert.equal(smoke.reconciliation.completionVerified, false);
  assert.equal(smoke.reconciliation.downloadReady, null);
  assert.equal(smoke.reconciliation.downloadCount, 0);
  assert.equal(smoke.reconciliation.retryPerformed, false);
  assert.equal(smoke.reconciliation.artifactCaptured, false);
  assert.equal(smoke.evaluationGate.artifactAccepted, false);
  assert.equal(smoke.evaluationGate.scorecardProduced, false);
  assert.equal(smoke.evaluationGate.comparisonProduced, false);
  assert.doesNotMatch(
    raw,
    /Qwen1062|\/Users\/|localStorage|authorization|password/i,
  );
});
