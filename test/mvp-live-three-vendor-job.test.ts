// @ts-nocheck -- the MVP orchestration entrypoint is intentionally standalone .mjs.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LIVE_VENDOR_SEQUENCE,
  runThreeVendorLiveJob,
} from "../mvp/live-three-vendor-job.mjs";

function completedRecord(product, localRunId) {
  return {
    schemaVersion: "capture-run-record-test-fixture-v1",
    localRunId,
    product,
    caseId: "volcano-query-v1",
    status: "completed",
    submissionEvidence: "submitted",
    executionProvenance: "TEST_FAKE",
    liveProductionCaptured: false,
    artifact: { contentHash: `sha256:${product.toLowerCase()}` },
  };
}

test("one Job invokes WPS, Qwen, and Doubao once in the frozen order", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "three-vendor-live-job-"));
  const calls = [];
  const outcome = await runThreeVendorLiveJob({
    localJobId: "job-live-volcano-001",
    outputDir,
    runners: {
      wps: async (input) => {
        calls.push(["wps", input]);
        return completedRecord("WPS AI PPT", input.localRunId);
      },
      qwen: async (input) => {
        calls.push(["qwen", input]);
        return completedRecord("千问", input.localRunId);
      },
      doubao: async (input) => {
        calls.push(["doubao", input]);
        return completedRecord("豆包", input.localRunId);
      },
    },
  });

  assert.deepEqual(LIVE_VENDOR_SEQUENCE, ["wps", "qwen", "doubao"]);
  assert.deepEqual(calls.map(([vendor]) => vendor), LIVE_VENDOR_SEQUENCE);
  assert.equal(new Set(calls.map(([, input]) => input.localRunId)).size, 3);
  assert.ok(calls.every(([, input]) => input.localJobId === "job-live-volcano-001"));
  assert.equal(outcome.caseId, "volcano-query-v1");
  assert.equal(outcome.status, "test_only_completed");
  assert.equal(outcome.liveProductionRunCount, 0);
  assert.equal(outcome.testFakeRunCount, 3);
  assert.equal(outcome.runs.length, 3);
  assert.deepEqual(
    JSON.parse(await readFile(join(outputDir, "job-record.json"), "utf8")),
    outcome,
  );
});

test("a blocked vendor cannot prevent later vendors and an exception forbids retry", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "three-vendor-live-job-"));
  const calls = [];
  const outcome = await runThreeVendorLiveJob({
    localJobId: "job-live-volcano-002",
    outputDir,
    runners: {
      wps: async () => {
        calls.push("wps");
        throw new Error("external Chrome disconnected");
      },
      qwen: async (input) => {
        calls.push("qwen");
        return completedRecord("千问", input.localRunId);
      },
      doubao: async (input) => {
        calls.push("doubao");
        return {
          ...completedRecord("豆包", input.localRunId),
          status: "waiting_for_human",
          submissionEvidence: "not_submitted",
          executionProvenance: null,
          artifact: null,
        };
      },
    },
  });

  assert.deepEqual(calls, ["wps", "qwen", "doubao"]);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.runs[0].record.status, "orchestration_error");
  assert.equal(outcome.runs[0].record.submissionEvidence, "unknown");
  assert.equal(outcome.runs[0].record.safeToRetry, false);
  assert.equal(outcome.runs[0].record.executionProvenance, null);
  assert.equal(outcome.runs[1].record.executionProvenance, "TEST_FAKE");
  assert.equal(outcome.runs[2].record.status, "waiting_for_human");
});
