import assert from "node:assert/strict";
import test from "node:test";

import type { ObservableAttemptEvent, RunRecord } from "../src/domain.ts";
import {
  conciseTimingMarkdown,
  timingFromRun,
} from "../src/report-timing.ts";

function event(
  attemptId: string,
  attemptSeq: number,
  eventType: string,
  seconds: number,
): ObservableAttemptEvent {
  const at = new Date(
    Date.parse("2026-08-02T00:00:00.000Z") + seconds * 1_000,
  ).toISOString();
  return {
    eventId: `${attemptId}-${eventType}`,
    jobId: "job-timing",
    caseId: "case-timing",
    runId: "run-timing",
    attemptId,
    attemptSeq,
    eventType,
    sourceAt: at,
    observedAt: at,
    writerId: "timing-test",
    evidenceRef: `evidence://${attemptId}/${eventType}`,
  };
}

test("persisted aggregate Run timing reconstructs stage totals across retries", () => {
  const run = {
    elapsedMs: 300_000,
    vendorGenerationMs: 150_000,
    observableEvents: [
      event("attempt-1", 1, "preflight_observed", 0),
      event("attempt-1", 1, "query_submitted", 30),
      event("attempt-1", 1, "generation_ready", 90),
      event("attempt-1", 1, "artifact_exported", 120),
      event("attempt-1", 1, "static_render_completed", 150),
      event("attempt-2", 2, "preflight_observed", 180),
      event("attempt-2", 2, "query_submitted", 210),
      event("attempt-2", 2, "generation_ready", 300),
      event("attempt-2", 2, "artifact_exported", 330),
      event("attempt-2", 2, "static_render_completed", 390),
    ],
  } as unknown as RunRecord;

  assert.equal(
    conciseTimingMarkdown(timingFromRun(run)),
    "总计 5.00 分钟；队列 1.00 分钟；生成 2.50 分钟；导出 1.00 分钟；捕获 1.50 分钟",
  );
});
