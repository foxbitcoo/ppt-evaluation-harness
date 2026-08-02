// @ts-nocheck -- the capture-only MVP entrypoint is intentionally standalone .mjs.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DOUBAO_LIVE_PRODUCT_CONFIGURATION,
  LIVE_VOLCANO_QUERY_V1,
  buildDoubaoLiveCaptureRequest,
  runDoubaoLiveCaptureOnly,
} from "../mvp/live-doubao-capture-only.mjs";
import {
  LIVE_VOLCANO_QUERY_V1 as WPS_LIVE_VOLCANO_QUERY_V1,
} from "../mvp/live-wps-capture-only.mjs";

test("Doubao capture-only request reuses the 16-page live case and freezes its observable one-attempt package", () => {
  const request = buildDoubaoLiveCaptureRequest({
    localJobId: "job-live-volcano-001",
    localRunId: "run-live-doubao-001",
  });

  assert.equal(LIVE_VOLCANO_QUERY_V1, WPS_LIVE_VOLCANO_QUERY_V1);
  assert.equal(request.schemaVersion, "doubao-live-capture-request-v1");
  assert.equal(request.intendedExecutionProvenance, "LIVE_PRODUCTION");
  assert.deepEqual(DOUBAO_LIVE_PRODUCT_CONFIGURATION, {
    product: "豆包",
    productUrl: "https://www.doubao.com/",
    accountScope: "current_authenticated_account",
    commercialConstraint: "zero_incremental_cost",
    packageSelection: "best_available_zero_incremental_cost",
    commercialPlanObservation: "ui_unavailable",
    modelSelection: "selection_at_runtime",
    modelNameObservation: "ui_unavailable",
    mode: "ppt_generation",
    length: "detailed",
    style: "intelligent_matching",
    networking: "enabled",
    pageCount: 16,
  });
  assert.equal(request.productConfiguration, DOUBAO_LIVE_PRODUCT_CONFIGURATION);
  assert.deepEqual(request.protocol, {
    maxSubmittedAttempts: 1,
    maxPreSubmissionRetries: 1,
    timeoutMs: 1_800_000,
    resultSelectionPolicy: "first_downloaded_pptx",
    retryPolicy: "never_after_submitted_or_unknown",
    unknownSubmissionRetryAllowed: false,
  });
});

test("Doubao capture-only CLI seam fails closed before browser submission when the trusted bridge is unavailable", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "doubao-live-capture-closed-"));
  const times = [
    "2026-08-03T00:00:00.000Z",
    "2026-08-03T00:00:00.125Z",
  ];
  const outcome = await runDoubaoLiveCaptureOnly({
    localJobId: "job-live-volcano-001",
    localRunId: "run-live-doubao-001",
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
    reason: "trusted_doubao_live_bridge_executable_unavailable",
    browserStateMutated: false,
    safeToRetryAfterResolution: true,
    requiredAction:
      "Provide an attested harness-owned external Chrome bridge for Doubao, then rerun without exporting cookies.",
  });
  assert.deepEqual(outcome.observableTrace, [
    {
      sequence: 1,
      eventType: "trusted_bridge_preflight_failed",
      sourceAt: "2026-08-03T00:00:00.125Z",
      observedAt: "2026-08-03T00:00:00.125Z",
      scope: "LOCAL_PREFLIGHT",
      submissionEvidenceAtCheckpoint: "not_submitted",
      vendorTaskId: null,
      detail: "Trusted Doubao live bridge executable is unavailable in this build.",
    },
  ]);
  const persisted = JSON.parse(
    await readFile(join(outputDir, "run-record.json"), "utf8"),
  );
  assert.deepEqual(persisted, outcome);
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

test("an explicit Doubao TEST_FAKE capture proves first-PPTX persistence without minting LIVE production evidence", async (t) => {
  const sourcePptx = join(process.cwd(), "tmp/live-mvp-m0/doubao-history.pptx");
  try {
    await stat(sourcePptx);
  } catch {
    t.skip("historical Doubao PPTX fixture is unavailable");
    return;
  }
  const outputDir = await mkdtemp(join(tmpdir(), "doubao-test-capture-"));
  const content = Uint8Array.from(await readFile(sourcePptx));
  const receivedRequests = [];
  const times = [
    "2026-08-03T01:00:00.000Z",
    "2026-08-03T01:02:30.000Z",
  ];
  const outcome = await runDoubaoLiveCaptureOnly({
    localJobId: "job-live-volcano-002",
    localRunId: "run-live-doubao-002",
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
            commercialPlanObservation: "ui_unavailable",
            modelNameObservation: "ui_unavailable",
          },
          observableTrace: [
            {
              eventType: "test_fixture_submission_observed",
              sourceAt: "2026-08-03T01:00:01.000Z",
              observedAt: "2026-08-03T01:00:01.050Z",
              sourceUrl: "https://www.doubao.com/",
              submissionEvidenceAtCheckpoint: "submitted",
              vendorTaskId: null,
            },
          ],
          artifact: {
            filename: "historical-doubao-fixture.pptx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            content,
          },
        };
      },
    }),
  });

  assert.equal(receivedRequests.length, 1);
  assert.equal(receivedRequests[0].case, WPS_LIVE_VOLCANO_QUERY_V1);
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
    filename: "doubao-first.pptx",
    relativePath: "artifacts/doubao-first.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: 4_550_119,
    contentHash:
      "sha256:82552599dfba489abf408c68f4ba9413a903e46e77642960911a30f56860636d",
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
      sourceUrl: "https://www.doubao.com/",
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

test("the Doubao CLI persists a fail-closed handoff and exits distinctly from success", async () => {
  const parent = await mkdtemp(join(tmpdir(), "doubao-live-capture-cli-"));
  const outputDir = join(parent, "run");
  const result = spawnSync(
    process.execPath,
    [
      "mvp/live-doubao-capture-only.mjs",
      "--job-id",
      "job-live-volcano-cli-001",
      "--run-id",
      "run-live-doubao-cli-001",
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
  assert.equal(JSON.parse(result.stdout).localRunId, "run-live-doubao-cli-001");
});
