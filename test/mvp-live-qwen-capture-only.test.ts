// @ts-nocheck -- the capture-only MVP entrypoint is intentionally standalone .mjs.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  QWEN_CAPTURE_ONLY_PROTOCOL,
  QWEN_LIVE_PRODUCT_CONFIGURATION,
  buildQwenLiveCaptureRequest,
  runQwenLiveCaptureOnly,
} from "../mvp/live-qwen-capture-only.mjs";
import {
  LIVE_VOLCANO_QUERY_V1,
  WPS_CAPTURE_ONLY_PROTOCOL,
} from "../mvp/live-wps-capture-only.mjs";

test("Qwen capture-only request reuses the 16-page live case and one-attempt protocol", () => {
  const request = buildQwenLiveCaptureRequest({
    localJobId: "job-live-volcano-001",
    localRunId: "run-live-qwen-001",
  });

  assert.equal(request.schemaVersion, "qwen-live-capture-request-v1");
  assert.equal(request.intendedExecutionProvenance, "LIVE_PRODUCTION");
  assert.equal(request.case, LIVE_VOLCANO_QUERY_V1);
  assert.equal(request.protocol, WPS_CAPTURE_ONLY_PROTOCOL);
  assert.equal(QWEN_CAPTURE_ONLY_PROTOCOL, WPS_CAPTURE_ONLY_PROTOCOL);
  assert.deepEqual(request.productConfiguration, {
    product: "千问",
    productUrl: "https://www.qianwen.com/",
    accountScope: "current_authenticated_account",
    accountObservationPolicy: "observe_category_or_record_ui_unavailable",
    commercialPlanObservationPolicy:
      "observe_plan_name_or_record_ui_unavailable",
    commercialConstraint: "zero_incremental_cost",
    packageSelection: "best_available_zero_incremental_cost",
    modelSelection: "selection_at_runtime",
    expertMode: "enabled",
    networking: "enabled",
    pageCount: 16,
  });
  assert.equal(request.productConfiguration, QWEN_LIVE_PRODUCT_CONFIGURATION);
  assert.deepEqual(request.protocol, {
    maxAttempts: 1,
    timeoutMs: 1_800_000,
    resultSelectionPolicy: "first_downloaded_pptx",
    retryPolicy: "never_after_submitted_or_unknown",
    unknownSubmissionRetryAllowed: false,
  });
});

test("Qwen capture-only CLI seam fails closed before browser submission when the live executable is unavailable", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "qwen-live-capture-closed-"));
  const times = [
    "2026-08-03T00:00:00.000Z",
    "2026-08-03T00:00:00.125Z",
  ];
  const outcome = await runQwenLiveCaptureOnly({
    localJobId: "job-live-volcano-001",
    localRunId: "run-live-qwen-001",
    outputDir,
    now: () => times.shift() ?? "2026-08-03T00:00:00.125Z",
  });

  assert.equal(outcome.status, "waiting_for_human");
  assert.equal(outcome.terminalReason, "human_wait");
  assert.equal(outcome.submissionEvidence, "not_submitted");
  assert.equal(outcome.executionProvenance, null);
  assert.equal(outcome.intendedExecutionProvenance, "LIVE_PRODUCTION");
  assert.equal(outcome.liveProductionCaptured, false);
  assert.equal(outcome.vendorTaskId, null);
  assert.equal(outcome.artifact, null);
  assert.equal(outcome.attemptCount, 0);
  assert.deepEqual(outcome.timing, {
    startedAt: "2026-08-03T00:00:00.000Z",
    endedAt: "2026-08-03T00:00:00.125Z",
    elapsedMs: 125,
    elapsedMinutes: 0.002,
  });
  assert.deepEqual(outcome.handoff, {
    state: "waiting_for_human",
    reason: "harness_owned_qwen_live_executable_unavailable",
    browserStateMutated: false,
    safeToRetryAfterResolution: true,
    requiredAction:
      "Provide an attested harness-owned Qwen external Chrome bridge, then rerun without exporting cookies.",
  });
  assert.deepEqual(outcome.observableTrace, [
    {
      sequence: 1,
      eventType: "trusted_qwen_live_preflight_failed",
      sourceAt: "2026-08-03T00:00:00.125Z",
      observedAt: "2026-08-03T00:00:00.125Z",
      scope: "LOCAL_PREFLIGHT",
      submissionEvidenceAtCheckpoint: "not_submitted",
      vendorTaskId: null,
      detail:
        "Harness-owned Qwen live executable is not embedded; capture-only execution fails closed.",
    },
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(join(outputDir, "run-record.json"), "utf8")),
    outcome,
  );
  assert.deepEqual((await readdir(outputDir)).sort(), [
    "capture-request.json",
    "run-record.json",
    "trace.jsonl",
  ]);
  assert.doesNotMatch(
    await readFile(join(outputDir, "trace.jsonl"), "utf8"),
    /cookie|authorization|bearer|token|password|secret/iu,
  );
});

test("an explicit Qwen TEST_FAKE port captures only the first PPTX without minting LIVE evidence", async (t) => {
  const sourcePptx = join(process.cwd(), "tmp/live-mvp-m0/qwen-history.pptx");
  try {
    await stat(sourcePptx);
  } catch {
    t.skip("historical PPTX fixture is unavailable");
    return;
  }
  const outputDir = await mkdtemp(join(tmpdir(), "qwen-test-capture-"));
  const content = Uint8Array.from(await readFile(sourcePptx));
  const receivedRequests = [];
  const times = [
    "2026-08-03T01:00:00.000Z",
    "2026-08-03T01:02:30.000Z",
  ];
  const outcome = await runQwenLiveCaptureOnly({
    localJobId: "job-live-volcano-002",
    localRunId: "run-live-qwen-002",
    outputDir,
    now: () => times.shift() ?? "2026-08-03T01:02:30.000Z",
    testCapturePort: Object.freeze({
      kind: "TEST_FAKE_CAPTURE_PORT",
      async capture(request) {
        receivedRequests.push(request);
        return {
          outcome: "captured",
          executionProvenance: "TEST_FAKE",
          submissionEvidence: "submitted",
          vendorTaskId: null,
          observedProductConfiguration: {
            ...request.productConfiguration,
            accountCategoryObservation: "ui_unavailable",
            commercialPlanObservation: "ui_unavailable",
            selectedModelLabel: "selection_at_runtime",
          },
          observableTrace: [
            {
              eventType: "test_fixture_submission_observed",
              sourceAt: "2026-08-03T01:00:01.000Z",
              observedAt: "2026-08-03T01:00:01.050Z",
              sourceUrl: "https://www.qianwen.com/",
              submissionEvidenceAtCheckpoint: "submitted",
              vendorTaskId: null,
            },
          ],
          artifact: {
            filename: "historical-qwen-fixture.pptx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            content,
          },
        };
      },
    }),
  });

  assert.equal(receivedRequests.length, 1);
  assert.equal(receivedRequests[0].case, LIVE_VOLCANO_QUERY_V1);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.terminalReason, "success");
  assert.equal(outcome.submissionEvidence, "submitted");
  assert.equal(outcome.executionProvenance, "TEST_FAKE");
  assert.equal(outcome.liveProductionCaptured, false);
  assert.equal(outcome.attemptCount, 1);
  assert.equal(outcome.vendorTaskId, null);
  assert.deepEqual(outcome.timing, {
    startedAt: "2026-08-03T01:00:00.000Z",
    endedAt: "2026-08-03T01:02:30.000Z",
    elapsedMs: 150_000,
    elapsedMinutes: 2.5,
  });
  assert.deepEqual(outcome.artifact, {
    filename: "qwen-first.pptx",
    relativePath: "artifacts/qwen-first.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: 12_064_776,
    contentHash:
      "sha256:4a67b9e504e8d1e0636de03f755d840a49c520f621a715dfc81227e44e0cca70",
    actualPageCount: 8,
    targetPageCount: 16,
    pageCountDeviation: -8,
    basicValidation: "PASS",
  });
  assert.deepEqual(outcome.observableTrace, [
    {
      sequence: 1,
      eventType: "test_fixture_submission_observed",
      sourceAt: "2026-08-03T01:00:01.000Z",
      observedAt: "2026-08-03T01:00:01.050Z",
      sourceUrl: "https://www.qianwen.com/",
      submissionEvidenceAtCheckpoint: "submitted",
      vendorTaskId: null,
    },
  ]);
  assert.deepEqual((await readdir(outputDir)).sort(), [
    "artifacts",
    "capture-request.json",
    "run-record.json",
    "trace.jsonl",
  ]);
  assert.ok(
    (await readFile(join(outputDir, outcome.artifact.relativePath))).equals(
      Buffer.from(content),
    ),
  );
});

test("Qwen TEST_FAKE cannot mint LIVE_PRODUCTION or a vendor task ID", async (t) => {
  const sourcePptx = join(process.cwd(), "tmp/live-mvp-m0/qwen-history.pptx");
  try {
    await stat(sourcePptx);
  } catch {
    t.skip("historical PPTX fixture is unavailable");
    return;
  }
  const content = Uint8Array.from(await readFile(sourcePptx));
  for (const unsafeResult of [
    { executionProvenance: "LIVE_PRODUCTION", vendorTaskId: null },
    { executionProvenance: "TEST_FAKE", vendorTaskId: "task_fabricated" },
  ]) {
    const outputDir = await mkdtemp(join(tmpdir(), "qwen-test-unsafe-"));
    await assert.rejects(
      runQwenLiveCaptureOnly({
        localJobId: "job-live-volcano-unsafe",
        localRunId: "run-live-qwen-unsafe",
        outputDir,
        testCapturePort: {
          kind: "TEST_FAKE_CAPTURE_PORT",
          async capture() {
            return {
              outcome: "captured",
              submissionEvidence: "submitted",
              observedProductConfiguration: {},
              observableTrace: [],
              artifact: {
                mimeType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                content,
              },
              ...unsafeResult,
            };
          },
        },
      }),
      /TEST_FAKE capture result is invalid/u,
    );
  }
});

test("the Qwen CLI persists a fail-closed handoff and exits distinctly from success", async () => {
  const parent = await mkdtemp(join(tmpdir(), "qwen-live-capture-cli-"));
  const outputDir = join(parent, "run");
  const result = spawnSync(
    process.execPath,
    [
      "mvp/live-qwen-capture-only.mjs",
      "--job-id",
      "job-live-volcano-cli-001",
      "--run-id",
      "run-live-qwen-cli-001",
      "--output-dir",
      outputDir,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const record = JSON.parse(
    await readFile(join(outputDir, "run-record.json"), "utf8"),
  );
  assert.equal(record.status, "waiting_for_human");
  assert.equal(record.submissionEvidence, "not_submitted");
  assert.equal(record.executionProvenance, null);
  assert.equal(JSON.parse(result.stdout).localRunId, "run-live-qwen-cli-001");
});
