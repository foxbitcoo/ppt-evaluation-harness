import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createComparisonReportService,
} from "../src/index.ts";

test("an already-scored compatible Qwen–Doubao pair can be selected without rescoring", async () => {
  const feishu = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const scorecardIdsBefore = feishu
    .snapshot()
    .artifactScoreTable.map(({ scorecard }) => scorecard.scorecardId);

  const report = await createComparisonReportService({
    feishu,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-doubao-volcano-v1",
      },
    ],
  });

  assert.deepEqual(
    report.comparisons.map(
      ({ leftRunId, rightRunId, dimensions }) => ({
        leftRunId,
        rightRunId,
        dimensions: dimensions.length,
      }),
    ),
    [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-doubao-volcano-v1",
        dimensions: 6,
      },
    ],
  );
  assert.deepEqual(
    feishu
      .snapshot()
      .artifactScoreTable.map(({ scorecard }) => scorecard.scorecardId),
    scorecardIdsBefore,
  );
});

test("the report view defaults to WPS–Qwen and WPS–Doubao without making WPS a stored baseline", async () => {
  const feishu = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockDoubaoProductAdapter(),
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  const report = await createComparisonReportService({
    feishu,
  }).createReport({
    jobId: bakeoff.job.jobId,
  });

  assert.deepEqual(
    report.comparisons.map(({ leftRunId, rightRunId }) => [
      leftRunId,
      rightRunId,
    ]),
    [
      [
        "MOCK-run-wps-volcano-v1",
        "MOCK-run-qwen-volcano-v1",
      ],
      [
        "MOCK-run-wps-volcano-v1",
        "MOCK-run-doubao-volcano-v1",
      ],
    ],
  );
  assert.ok(
    report.comparisons.every(
      (comparison) =>
        !Object.prototype.hasOwnProperty.call(comparison, "baselineRunId"),
    ),
  );
});

test("the concise Case Sample report limits actionable gap cards and vendor findings while linking both-side evidence", async () => {
  const feishu = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  const outcome = await createComparisonReportService({
    feishu,
  }).createReport({
    jobId: bakeoff.job.jobId,
  });

  assert.ok(outcome.gapCards.length > 0);
  assert.ok(outcome.gapCards.length <= 3);
  for (const card of outcome.gapCards) {
    assert.ok(card.dimension.length > 0);
    assert.ok(card.keyPages.left.length > 0);
    assert.ok(card.keyPages.right.length > 0);
    assert.ok(card.leftEvidence.links.every(({ url }) => /^mock-feishu:/.test(url)));
    assert.ok(card.rightEvidence.links.every(({ url }) => /^mock-feishu:/.test(url)));
    assert.ok(card.impact.length > 0);
    assert.equal(card.causeAttribution, "HYPOTHESIS");
    assert.equal(card.causeHypothesis.label, "HYPOTHESIS");
    assert.ok(card.causeHypothesis.statement.length > 0);
    assert.ok(card.proposedExperiment.length > 0);
    assert.ok(card.acceptanceMetric.length > 0);
  }
  assert.ok(outcome.vendorSummaries.length <= 3);
  assert.ok(
    outcome.vendorSummaries.every(
      ({ majorStrengths, majorIssues }) =>
        majorStrengths.length <= 3 && majorIssues.length <= 3,
    ),
  );
  assert.match(
    outcome.report.markdown,
    /^> \*\*单次 Case Sample：/m,
  );
  assert.match(outcome.report.markdown, /\[第 \d+ 页证据\]\(mock-feishu:/);
  assert.doesNotMatch(outcome.report.markdown, /^## .*总冠军/m);
  assert.doesNotMatch(outcome.report.markdown, /\|\s*通用总分\s*\|/);
  assert.ok(!Object.prototype.hasOwnProperty.call(outcome, "winner"));
  assert.ok(!Object.prototype.hasOwnProperty.call(outcome, "total"));

  const parentJob = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "bakeoff_job");
  assert.equal(parentJob?.reportUrl, outcome.report.url);
});

test("dynamic comparison preserves NOT_ASSESSABLE instead of inventing factual scores or gap cards", async () => {
  const feishu = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    referencePackMode: "off",
  });

  const outcome = await createComparisonReportService({
    feishu,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-doubao-volcano-v1",
      },
    ],
  });
  const factual = outcome.comparisons[0]?.dimensions.find(
    ({ dimension }) =>
      dimension === "factual_accuracy_and_content_quality",
  );

  assert.deepEqual(factual, {
    dimension: "factual_accuracy_and_content_quality",
    assessmentStatus: "NOT_ASSESSABLE",
    leftValue: null,
    rightValue: null,
    difference: null,
    leftEvidencePages: [],
    rightEvidencePages: [],
  });
  assert.ok(
    outcome.gapCards.every(
      ({ dimension }) =>
        dimension !== "factual_accuracy_and_content_quality",
    ),
  );
  assert.match(outcome.report.markdown, /NOT_ASSESSABLE/);
});
