import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ObservableAttemptEvent } from "../src/domain.ts";
import { VOLCANO_EVALUATION_CASE } from "../src/fixtures/volcano-case.ts";
import {
  createProviderSubmissionIntentCheckpoint,
  InMemoryAttemptCheckpointStore,
  parseAdapterExecutionConfiguration,
} from "../src/product-adapter.ts";
import {
  createWpsAiPptBrowserDriverPackage,
} from "../src/wps-aippt-driver.ts";
import {
  createWpsAiPptReplayBehaviorExecutorForTest,
  resolveWpsAiPptProductAdapterExecutorForTest,
  WPS_AIPPT_ADAPTER_VERSION,
  WpsAiPptProductAdapter,
} from "../src/wps-aippt.ts";
import {
  createQwenProductAdapterExecutorForTest,
  QWEN_ADAPTER_VERSION,
  type QwenBrowserDriverPort,
} from "../src/qwen-production-adapter.ts";
import {
  DOUBAO_PRODUCTION_ADAPTER_VERSION,
  DoubaoProductionProductAdapter,
  resolveDoubaoProductionExecutor,
  type DoubaoBrowserDriverPort,
} from "../src/doubao-production-adapter.ts";

const COMMAND = Object.freeze({
  jobId: "job-t10-provider-restart",
  runId: "run-t10-provider-restart",
  attemptId: "attempt-t10-provider-restart-1",
  attemptSeq: 1,
  timeoutMs: 30 * 60 * 1_000,
  signal: new AbortController().signal,
  evaluationCase: VOLCANO_EVALUATION_CASE,
});

async function appendPreSubmitTaskThenTerminalNonSubmission(
  checkpointStore: InMemoryAttemptCheckpointStore,
  adapterVersion: string,
  preSubmitEventType:
    | "configuration_observed"
    | "configuration_applied",
): Promise<void> {
  const intent = createProviderSubmissionIntentCheckpoint(
    COMMAND,
    adapterVersion,
    "2026-07-31T01:00:00.000Z",
  );
  const preSubmitTask: ObservableAttemptEvent = Object.freeze({
    ...intent,
    eventId: `${COMMAND.attemptId}-configuration`,
    eventType: preSubmitEventType,
    sourceAt: "2026-07-31T01:00:01.000Z",
    observedAt: "2026-07-31T01:00:01.000Z",
    evidenceRef: "ev_1111111111111111",
    sourceUrl: null,
    vendorTaskId: "task_pre_submit_identity_1234",
    taskStateVersion: "created@1",
  });
  const terminalNotSubmitted: ObservableAttemptEvent = Object.freeze({
    ...preSubmitTask,
    eventId: `${COMMAND.attemptId}-terminal-not-submitted`,
    eventType: "query_not_submitted",
    sourceAt: "2026-07-31T01:00:02.000Z",
    observedAt: "2026-07-31T01:00:02.000Z",
    evidenceRef: "ev_2222222222222222",
    submissionEvidenceAtCheckpoint: "not_submitted",
    vendorTaskId: null,
    taskStateVersion: "not_submitted@1",
  });
  for (const event of [intent, preSubmitTask, terminalNotSubmitted]) {
    await checkpointStore.append(event);
  }
}

function durableWpsReconciliation(
  overrides: Partial<ObservableAttemptEvent>,
): ObservableAttemptEvent {
  return Object.freeze({
    eventId: `${COMMAND.attemptId}-wps-reconciliation-forged`,
    jobId: COMMAND.jobId,
    caseId: COMMAND.evaluationCase.caseId,
    runId: COMMAND.runId,
    attemptId: COMMAND.attemptId,
    attemptSeq: COMMAND.attemptSeq,
    eventType: "task_reconciliation_result",
    sourceAt: "2026-07-31T01:00:01.000Z",
    observedAt: "2026-07-31T01:00:01.000Z",
    writerId: WPS_AIPPT_ADAPTER_VERSION,
    evidenceRef: "ev_3333333333333333",
    sourceUrl: null,
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "task_wps_recovered_1234",
    taskStateVersion: "failed@1",
    adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
    artifactId: null,
    reconciliationObservedState: "failed",
    reconciliationTerminalReason: "technical_failure",
    reconciliationArtifactReference: null,
    ...overrides,
  });
}

test("WPS rejects internally inconsistent durable reconciliation results", async (t) => {
  const cases = [
    {
      name: "terminal reason",
      event: durableWpsReconciliation({
        reconciliationTerminalReason: "success",
      }),
    },
    {
      name: "task identity",
      event: durableWpsReconciliation({
        vendorTaskId: null,
        taskStateVersion: null,
      }),
    },
    {
      name: "artifact reference",
      event: durableWpsReconciliation({
        reconciliationObservedState: "artifact_ready",
        reconciliationTerminalReason: "download_failure",
        reconciliationArtifactReference:
          "wps-task:task_wps_different_1234",
      }),
    },
    {
      name: "submission evidence",
      event: durableWpsReconciliation({
        submissionEvidenceAtCheckpoint: "not_submitted",
      }),
    },
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const checkpoints = new InMemoryAttemptCheckpointStore(
        `wps-inconsistent-reconciliation-${testCase.name}`,
      );
      await checkpoints.append(testCase.event);
      const executor = createWpsAiPptReplayBehaviorExecutorForTest({
        sessions: [],
        checkpointStore: checkpoints,
      });

      await assert.rejects(
        executor(COMMAND),
        /durable WPS reconciliation result is (?:structurally incomplete|internally inconsistent)/i,
      );
    });
  }
});

test("WPS records concrete recovered task states as submitted evidence before restart", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "wps-concrete-reconciliation-submission-evidence",
  );
  const recoveredTask: ObservableAttemptEvent = Object.freeze({
    eventId: `${COMMAND.attemptId}-wps-task-unknown`,
    jobId: COMMAND.jobId,
    caseId: COMMAND.evaluationCase.caseId,
    runId: COMMAND.runId,
    attemptId: COMMAND.attemptId,
    attemptSeq: COMMAND.attemptSeq,
    eventType: "query_submission_unknown",
    sourceAt: "2026-07-31T01:00:00.000Z",
    observedAt: "2026-07-31T01:00:00.000Z",
    writerId: WPS_AIPPT_ADAPTER_VERSION,
    evidenceRef: "ev_4444444444444444",
    sourceUrl: null,
    submissionEvidenceAtCheckpoint: "unknown",
    vendorTaskId: "task_wps_recovered_unknown_1234",
    taskStateVersion: "submitted@1",
    adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
    artifactId: null,
  });
  await checkpoints.append(recoveredTask);
  const eventHistoryHash =
    `sha256:${createHash("sha256")
      .update(JSON.stringify([recoveredTask]))
      .digest("hex")}` as const;
  const executor = createWpsAiPptReplayBehaviorExecutorForTest({
    sessions: [],
    checkpointStore: checkpoints,
    reconciliations: [
      {
        query: {
          vendorTaskId: "task_wps_recovered_unknown_1234",
          taskStateVersion: "submitted@1",
          eventHistoryHash,
          artifactContentHash: null,
        },
        observedState: "failed",
        observedAt: "2026-07-31T01:00:01.000Z",
        evidenceId: "ev_5555555555555555",
      },
    ],
  });

  const first = await executor(COMMAND);
  const restarted = await executor(COMMAND);

  assert.ok(!("content" in first));
  assert.equal(first.terminalReason, "technical_failure");
  assert.equal(first.submissionEvidence, "submitted");
  assert.deepEqual(restarted, first);
  assert.equal(
    checkpoints.snapshot().at(-1)?.submissionEvidenceAtCheckpoint,
    "submitted",
  );
});

test("WPS starts the next submission epoch after durable terminal non-submission", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "wps-terminal-non-submission-restart",
  );
  await appendPreSubmitTaskThenTerminalNonSubmission(
    checkpoints,
    WPS_AIPPT_ADAPTER_VERSION,
    "configuration_observed",
  );
  const adapter = new WpsAiPptProductAdapter();
  const driver = createWpsAiPptBrowserDriverPackage({
    provenance: "TEST_FAKE",
    sessions: [
      {
        outcome: "technical_failure",
        submissionEvidence: "not_submitted",
        elapsedMs: 1,
        events: [],
        manualActions: [],
      },
    ],
  });
  const executor = resolveWpsAiPptProductAdapterExecutorForTest(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    driver,
    checkpoints,
    true,
  );

  const result = await executor(COMMAND);

  assert.ok(!("content" in result));
  assert.equal(result.terminalReason, "technical_failure");
  assert.deepEqual(
    checkpoints
      .snapshot()
      .filter(({ eventType }) => eventType === "submission_intent")
      .map(({ eventId }) => eventId),
    [
      `${COMMAND.attemptId}-submission-intent`,
      `${COMMAND.attemptId}-submission-intent-2`,
    ],
  );
  assert.equal(
    checkpoints
      .snapshot()
      .some(({ eventType }) => eventType === "task_reconciliation_result"),
    false,
  );
});

test("Qwen starts the next submission epoch after durable terminal non-submission", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "qwen-terminal-non-submission-restart",
  );
  await appendPreSubmitTaskThenTerminalNonSubmission(
    checkpoints,
    QWEN_ADAPTER_VERSION,
    "configuration_applied",
  );
  let executeCalls = 0;
  const driver: QwenBrowserDriverPort = {
    runtimeProvenance: "TEST",
    async execute() {
      executeCalls += 1;
      return {
        status: "terminal",
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "not_submitted",
        elapsedMs: 1,
        observedAt: "2026-07-31T01:00:03.000Z",
        observedConfiguration: null,
        milestones: [],
        manualActions: [],
      };
    },
  };
  const executor = createQwenProductAdapterExecutorForTest(
    driver,
    checkpoints,
  );

  const result = await executor(COMMAND);

  assert.ok(!("content" in result));
  assert.equal(result.terminalReason, "technical_failure");
  assert.equal(executeCalls, 1);
  assert.deepEqual(
    checkpoints
      .snapshot()
      .filter(({ eventType }) => eventType === "submission_intent")
      .map(({ eventId }) => eventId),
    [
      `${COMMAND.attemptId}-submission-intent`,
      `${COMMAND.attemptId}-submission-intent-2`,
    ],
  );
  assert.equal(
    checkpoints
      .snapshot()
      .some(({ eventType }) => eventType === "task_reconciliation_result"),
    false,
  );
});

test("Qwen gives consecutive real submission epochs distinct durable event identities", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "qwen-consecutive-submission-epochs",
  );
  let executeCalls = 0;
  const driver: QwenBrowserDriverPort = {
    runtimeProvenance: "TEST",
    async execute() {
      executeCalls += 1;
      const second = executeCalls === 2;
      return {
        status: "terminal",
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "not_submitted",
        elapsedMs: 1,
        observedAt: second
          ? "2026-07-31T01:01:04.000Z"
          : "2026-07-31T01:01:02.000Z",
        observedConfiguration: null,
        milestones: [
          {
            eventType: "configuration_applied",
            observedAt: second
              ? "2026-07-31T01:01:03.000Z"
              : "2026-07-31T01:01:01.000Z",
            url: "https://www.qianwen.com/chat/redacted",
          },
        ],
        manualActions: [],
      };
    },
  };
  const firstExecutor = createQwenProductAdapterExecutorForTest(
    driver,
    checkpoints,
  );

  const first = await firstExecutor(COMMAND);
  const restartedExecutor = createQwenProductAdapterExecutorForTest(
    driver,
    checkpoints,
  );
  const second = await restartedExecutor(COMMAND);

  assert.ok(!("content" in first));
  assert.ok(!("content" in second));
  assert.equal(first.terminalReason, "technical_failure");
  assert.equal(second.terminalReason, "technical_failure");
  assert.equal(executeCalls, 2);
  assert.deepEqual(
    checkpoints
      .snapshot()
      .filter(({ eventId }) => eventId.includes("-qwen-event-"))
      .map(({ eventId }) => eventId),
    [
      `${COMMAND.attemptId}-qwen-event-1`,
      `${COMMAND.attemptId}-qwen-event-2`,
      `${COMMAND.attemptId}-qwen-event-3`,
      `${COMMAND.attemptId}-qwen-event-4`,
    ],
  );
});

test("Doubao gives consecutive real submission epochs distinct durable event identities", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "doubao-consecutive-submission-epochs",
  );
  let preflightCalls = 0;
  let submitCalls = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error("not-submitted Doubao execution must stop after submit");
  };
  const driver: DoubaoBrowserDriverPort = {
    async inspectCurrentPackage() {
      preflightCalls += 1;
      return {
        observedAt: preflightCalls === 2
          ? "2026-07-31T01:02:03.000Z"
          : "2026-07-31T01:02:01.000Z",
        sourceUrl: "https://www.doubao.com/chat/redacted",
        accountEvidence: "current_account_signed_in",
        planName: "免费版",
        modelName: "豆包当前账号最佳可用模型",
        modeName: "AI PPT",
        networking: "enabled",
        requestedPageCount: 16,
        bestAvailableForCurrentAccount: true,
        incrementalChargeRequired: false,
        evidenceRef: preflightCalls === 2
          ? "screenshot://doubao/preflight-epoch-2"
          : "screenshot://doubao/preflight-epoch-1",
        manualActions: [],
      };
    },
    async submitFrozenQuery() {
      submitCalls += 1;
      return {
        status: "not_submitted",
        observedAt: submitCalls === 2
          ? "2026-07-31T01:02:04.000Z"
          : "2026-07-31T01:02:02.000Z",
        evidenceRef: submitCalls === 2
          ? "screenshot://doubao/not-submitted-epoch-2"
          : "screenshot://doubao/not-submitted-epoch-1",
        manualActions: [],
      };
    },
    waitForGeneration: unexpected,
    exportPresentation: unexpected,
    renderPresentation: unexpected,
  };
  const adapter = new DoubaoProductionProductAdapter();
  const firstExecutor = resolveDoubaoProductionExecutor(
    adapter.implementationPackage,
    driver,
    checkpoints,
  );

  const first = await firstExecutor(COMMAND);
  const restartedExecutor = resolveDoubaoProductionExecutor(
    adapter.implementationPackage,
    driver,
    checkpoints,
  );
  const second = await restartedExecutor(COMMAND);

  assert.ok(!("content" in first));
  assert.ok(!("content" in second));
  assert.equal(first.terminalReason, "technical_failure");
  assert.equal(second.terminalReason, "technical_failure");
  assert.equal(preflightCalls, 2);
  assert.equal(submitCalls, 2);
  assert.deepEqual(
    checkpoints
      .snapshot()
      .filter(({ eventId }) => /-event-\d+$/.test(eventId))
      .map(({ eventId }) => eventId),
    [
      `${COMMAND.attemptId}-event-1`,
      `${COMMAND.attemptId}-event-2`,
      `${COMMAND.attemptId}-event-3`,
      `${COMMAND.attemptId}-event-4`,
    ],
  );
});

test("Doubao reuses a durable terminal reconciliation after a lost response", async () => {
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "doubao-durable-reconciliation-restart",
  );
  await checkpoints.append({
    eventId: `${COMMAND.attemptId}-query-submitted`,
    jobId: COMMAND.jobId,
    caseId: COMMAND.evaluationCase.caseId,
    runId: COMMAND.runId,
    attemptId: COMMAND.attemptId,
    attemptSeq: COMMAND.attemptSeq,
    eventType: "query_submitted",
    sourceAt: "2026-07-31T01:00:00.000Z",
    observedAt: "2026-07-31T01:00:00.000Z",
    writerId: DOUBAO_PRODUCTION_ADAPTER_VERSION,
    evidenceRef: "screenshot://doubao/submitted",
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "task_doubao_restart_1234",
    taskStateVersion: "query_submitted@1",
    adapterVersion: DOUBAO_PRODUCTION_ADAPTER_VERSION,
    artifactId: null,
  });
  let reconcileCalls = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error("recovered Doubao task must not reopen the browser");
  };
  const driver: DoubaoBrowserDriverPort = {
    inspectCurrentPackage: unexpected,
    submitFrozenQuery: unexpected,
    waitForGeneration: unexpected,
    exportPresentation: unexpected,
    renderPresentation: unexpected,
    async reconcileTask(query) {
      reconcileCalls += 1;
      return {
        query,
        observedState: "failed",
        observedAt: "2026-07-31T01:00:01.000Z",
        evidenceRef: "screenshot://doubao/reconciled-failed",
      };
    },
  };
  const adapter = new DoubaoProductionProductAdapter();
  const executor = resolveDoubaoProductionExecutor(
    adapter.implementationPackage,
    driver,
    checkpoints,
  );

  const first = await executor(COMMAND);
  const afterFirst = checkpoints.snapshot();
  const restarted = await executor(COMMAND);

  assert.deepEqual(restarted, first);
  assert.equal(reconcileCalls, 1);
  assert.deepEqual(checkpoints.snapshot(), afterFirst);
  assert.equal(
    afterFirst.filter(
      ({ eventType }) => eventType === "task_reconciliation_result",
    ).length,
    1,
  );
});
