import assert from "node:assert/strict";
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
