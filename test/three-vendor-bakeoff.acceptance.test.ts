import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  type ArtifactScoreTableRecord,
  type EvaluationCaseRecord,
  type FeishuReportDraft,
  type ProductAdapterPort,
  type ProductGapCardRecord,
  type RunRecord,
} from "../src/index.ts";

test("one test Bakeoff Job creates stable WPS, Qwen, and Doubao child Runs", async () => {
  const feishu = new InMemoryFeishuProjection();
  const harness = createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  });

  const outcome = await harness.startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const vendorRuns = feishu
    .snapshot()
    .runRecordTable.filter(({ recordType }) => recordType === "vendor_run");

  assert.equal(outcome.job.status, "completed");
  assert.deepEqual(
    vendorRuns.map(
      ({ recordId, parentRecordId, product, status, provenance }) => ({
        recordId,
        parentRecordId,
        product,
        status,
        provenance,
      }),
    ),
    [
      {
        recordId: "MOCK-run-wps-volcano-v1",
        parentRecordId: "MOCK-job-volcano-v1",
        product: "Mock WPS AI PPT",
        status: "completed",
        provenance: "MOCK",
      },
      {
        recordId: "MOCK-run-qwen-volcano-v1",
        parentRecordId: "MOCK-job-volcano-v1",
        product: "Mock Qwen PPT",
        status: "completed",
        provenance: "MOCK",
      },
      {
        recordId: "MOCK-run-doubao-volcano-v1",
        parentRecordId: "MOCK-job-volcano-v1",
        product: "Mock Doubao PPT",
        status: "completed",
        provenance: "MOCK",
      },
    ],
  );
});

test("the four Feishu projections preserve stable Case, Run, score, and product-gap lineage", async () => {
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
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

  const projection = feishu.snapshot();
  assert.deepEqual(
    Object.keys(projection)
      .filter((key) => key.endsWith("Table"))
      .sort(),
    [
      "artifactScoreTable",
      "caseTable",
      "productGapCardTable",
      "runRecordTable",
    ],
  );
  assert.deepEqual(
    projection.artifactScoreTable.map(
      ({ recordId, caseId, jobId, runId, artifactId }) => ({
        recordId,
        caseId,
        jobId,
        runId,
        artifactId,
      }),
    ),
    [
      {
        recordId: "MOCK-scorecard-wps-volcano-v1",
        caseId: VOLCANO_CASE_ID,
        jobId: "MOCK-job-volcano-v1",
        runId: "MOCK-run-wps-volcano-v1",
        artifactId: "MOCK-artifact-wps-volcano-v1",
      },
      {
        recordId: "MOCK-scorecard-qwen-volcano-v1",
        caseId: VOLCANO_CASE_ID,
        jobId: "MOCK-job-volcano-v1",
        runId: "MOCK-run-qwen-volcano-v1",
        artifactId: "MOCK-artifact-qwen-volcano-v1",
      },
      {
        recordId: "MOCK-scorecard-doubao-volcano-v1",
        caseId: VOLCANO_CASE_ID,
        jobId: "MOCK-job-volcano-v1",
        runId: "MOCK-run-doubao-volcano-v1",
        artifactId: "MOCK-artifact-doubao-volcano-v1",
      },
    ],
  );
  assert.deepEqual(
    projection.productGapCardTable.map(
      ({
        gapCardId,
        caseId,
        jobId,
        baselineRunId,
        candidateRunId,
        baselineScorecardId,
        candidateScorecardId,
      }) => ({
        gapCardId,
        caseId,
        jobId,
        baselineRunId,
        candidateRunId,
        baselineScorecardId,
        candidateScorecardId,
      }),
    ),
    [
      {
        gapCardId: "MOCK-gap-wps-vs-qwen-volcano-v1",
        caseId: VOLCANO_CASE_ID,
        jobId: "MOCK-job-volcano-v1",
        baselineRunId: "MOCK-run-wps-volcano-v1",
        candidateRunId: "MOCK-run-qwen-volcano-v1",
        baselineScorecardId: "MOCK-scorecard-wps-volcano-v1",
        candidateScorecardId: "MOCK-scorecard-qwen-volcano-v1",
      },
      {
        gapCardId: "MOCK-gap-wps-vs-doubao-volcano-v1",
        caseId: VOLCANO_CASE_ID,
        jobId: "MOCK-job-volcano-v1",
        baselineRunId: "MOCK-run-wps-volcano-v1",
        candidateRunId: "MOCK-run-doubao-volcano-v1",
        baselineScorecardId: "MOCK-scorecard-wps-volcano-v1",
        candidateScorecardId: "MOCK-scorecard-doubao-volcano-v1",
      },
    ],
  );
});

test("the MOCK report includes all successful vendors while delivery remains an automatic gate outside the six scores", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
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
  const scorecards = feishu
    .snapshot()
    .artifactScoreTable.map(({ scorecard }) => scorecard);

  assert.deepEqual(outcome.report.runIds, [
    "MOCK-run-wps-volcano-v1",
    "MOCK-run-qwen-volcano-v1",
    "MOCK-run-doubao-volcano-v1",
  ]);
  assert.deepEqual(outcome.report.artifactIds, [
    "MOCK-artifact-wps-volcano-v1",
    "MOCK-artifact-qwen-volcano-v1",
    "MOCK-artifact-doubao-volcano-v1",
  ]);
  assert.match(outcome.report.title, /^MOCK/);
  assert.match(outcome.report.markdown, /Mock WPS AI PPT/);
  assert.match(outcome.report.markdown, /Mock Qwen PPT/);
  assert.match(outcome.report.markdown, /Mock Doubao PPT/);
  assert.ok(
    scorecards.every(
      ({ dimensions, deliveryQualityGates }) =>
        dimensions.length === 6 &&
        dimensions.every(({ dimension }) => !dimension.includes("delivery")) &&
        deliveryQualityGates.every(({ status }) => status === "PASS"),
    ),
  );
});

test("timeout and quota-blocked vendors end deterministically without blocking a partial Bakeoff Job", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter({ scenario: "timeout" }),
      new MockDoubaoProductAdapter({ scenario: "quota_blocked" }),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const projection = feishu.snapshot();
  const vendorRuns = projection.runRecordTable.filter(
    ({ recordType }) => recordType === "vendor_run",
  );
  const attempts = projection.runRecordTable.filter(
    ({ recordType }) => recordType === "evaluation_attempt",
  );

  assert.equal(outcome.job.status, "partial");
  assert.deepEqual(
    vendorRuns.map(
      ({ recordId, status, terminalReason, blockReason, artifactId }) => ({
        recordId,
        status,
        terminalReason,
        blockReason,
        artifactId,
      }),
    ),
    [
      {
        recordId: "MOCK-run-wps-volcano-v1",
        status: "completed",
        terminalReason: "success",
        blockReason: null,
        artifactId: "MOCK-artifact-wps-volcano-v1",
      },
      {
        recordId: "MOCK-run-qwen-volcano-v1",
        status: "timed_out",
        terminalReason: "vendor_timeout",
        blockReason: null,
        artifactId: null,
      },
      {
        recordId: "MOCK-run-doubao-volcano-v1",
        status: "blocked",
        terminalReason: "quota",
        blockReason: "quota",
        artifactId: null,
      },
    ],
  );
  assert.deepEqual(
    attempts.map(
      ({
        parentRecordId,
        attemptSeq,
        elapsedMs,
        submissionEvidence,
        terminalReason,
      }) => ({
        parentRecordId,
        attemptSeq,
        elapsedMs,
        submissionEvidence,
        terminalReason,
      }),
    ),
    [
      {
        parentRecordId: "MOCK-run-wps-volcano-v1",
        attemptSeq: 1,
        elapsedMs: 1,
        submissionEvidence: "submitted",
        terminalReason: "success",
      },
      {
        parentRecordId: "MOCK-run-qwen-volcano-v1",
        attemptSeq: 1,
        elapsedMs: 1_800_000,
        submissionEvidence: "submitted",
        terminalReason: "vendor_timeout",
      },
      {
        parentRecordId: "MOCK-run-doubao-volcano-v1",
        attemptSeq: 1,
        elapsedMs: 1,
        submissionEvidence: "not_submitted",
        terminalReason: "quota",
      },
    ],
  );
  assert.deepEqual(outcome.report.artifactIds, [
    "MOCK-artifact-wps-volcano-v1",
  ]);
  assert.match(outcome.report.markdown, /partial/);
  assert.match(outcome.report.markdown, /vendor_timeout/);
  assert.match(outcome.report.markdown, /quota/);
});

test("payment, authentication, and human-wait states stay distinct and never retry", async () => {
  const scenarios = [
    {
      scenario: "payment_blocked" as const,
      status: "blocked",
      terminalReason: "payment",
      blockReason: "payment",
      submissionEvidence: "not_submitted",
    },
    {
      scenario: "authentication_blocked" as const,
      status: "blocked",
      terminalReason: "authentication",
      blockReason: "authentication",
      submissionEvidence: "not_submitted",
    },
    {
      scenario: "human_wait" as const,
      status: "waiting_for_human",
      terminalReason: "human_wait",
      blockReason: null,
      submissionEvidence: "submitted",
    },
  ];

  for (const expected of scenarios) {
    const feishu = new InMemoryFeishuProjection();
    const outcome = await createBakeoffHarness({
      feishu,
      productAdapters: [
        new MockWpsProductAdapter(),
        new MockQwenProductAdapter({ scenario: expected.scenario }),
        new MockDoubaoProductAdapter(),
      ],
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    });
    const qwenRecords = feishu
      .snapshot()
      .runRecordTable.filter(
        ({ recordId, parentRecordId }) =>
          recordId === "MOCK-run-qwen-volcano-v1" ||
          parentRecordId === "MOCK-run-qwen-volcano-v1",
      );

    assert.equal(outcome.job.status, "partial");
    assert.equal(qwenRecords.length, 2);
    assert.deepEqual(
      qwenRecords.map(
        ({
          recordType,
          status,
          terminalReason,
          blockReason,
          submissionEvidence,
        }) => ({
          recordType,
          status,
          terminalReason,
          blockReason,
          submissionEvidence,
        }),
      ),
      [
        {
          recordType: "vendor_run",
          status: expected.status,
          terminalReason: expected.terminalReason,
          blockReason: expected.blockReason,
          submissionEvidence: null,
        },
        {
          recordType: "evaluation_attempt",
          status: expected.status,
          terminalReason: expected.terminalReason,
          blockReason: expected.blockReason,
          submissionEvidence: expected.submissionEvidence,
        },
      ],
    );
  }
});

test("only a provably unsubmitted technical failure retries once and the first compliant Artifact wins", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter({ scenario: "retry_then_success" }),
      new MockDoubaoProductAdapter({ scenario: "first_compliant_artifact" }),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const projection = feishu.snapshot();
  const qwenAttempts = projection.runRecordTable.filter(
    ({ recordType, parentRecordId }) =>
      recordType === "evaluation_attempt" &&
      parentRecordId === "MOCK-run-qwen-volcano-v1",
  );
  const doubaoRun = projection.runRecordTable.find(
    ({ recordId }) => recordId === "MOCK-run-doubao-volcano-v1",
  );

  assert.equal(outcome.job.status, "completed");
  assert.deepEqual(
    qwenAttempts.map(
      ({
        recordId,
        attemptSeq,
        status,
        terminalReason,
        submissionEvidence,
        retryOfAttemptId,
      }) => ({
        recordId,
        attemptSeq,
        status,
        terminalReason,
        submissionEvidence,
        retryOfAttemptId,
      }),
    ),
    [
      {
        recordId: "MOCK-run-qwen-volcano-v1-attempt-1",
        attemptSeq: 1,
        status: "failed",
        terminalReason: "technical_failure",
        submissionEvidence: "not_submitted",
        retryOfAttemptId: null,
      },
      {
        recordId: "MOCK-run-qwen-volcano-v1-attempt-2",
        attemptSeq: 2,
        status: "completed",
        terminalReason: "success",
        submissionEvidence: "submitted",
        retryOfAttemptId: "MOCK-run-qwen-volcano-v1-attempt-1",
      },
    ],
  );
  assert.equal(
    doubaoRun?.artifactId,
    "MOCK-artifact-doubao-volcano-v1-candidate-2",
  );
  assert.ok(
    !outcome.report.artifactIds.includes(
      "MOCK-artifact-doubao-volcano-v1-candidate-1",
    ),
  );
  assert.ok(
    !outcome.report.artifactIds.includes(
      "MOCK-artifact-doubao-volcano-v1-candidate-3",
    ),
  );
});

test("retry is capped at one and submitted or unknown submission evidence never retries", async () => {
  const scenarios = [
    {
      scenario: "repeat_not_submitted_failure" as const,
      attemptCount: 2,
      submissionEvidence: "not_submitted",
    },
    {
      scenario: "submitted_technical_failure" as const,
      attemptCount: 1,
      submissionEvidence: "submitted",
    },
    {
      scenario: "unknown_submission_failure" as const,
      attemptCount: 1,
      submissionEvidence: "unknown",
    },
  ];

  for (const expected of scenarios) {
    const feishu = new InMemoryFeishuProjection();
    const outcome = await createBakeoffHarness({
      feishu,
      productAdapters: [
        new MockWpsProductAdapter(),
        new MockQwenProductAdapter({ scenario: expected.scenario }),
        new MockDoubaoProductAdapter(),
      ],
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    });
    const projection = feishu.snapshot();
    const qwenRun = projection.runRecordTable.find(
      ({ recordId }) => recordId === "MOCK-run-qwen-volcano-v1",
    );
    const qwenAttempts = projection.runRecordTable.filter(
      ({ recordType, parentRecordId }) =>
        recordType === "evaluation_attempt" &&
        parentRecordId === "MOCK-run-qwen-volcano-v1",
    );

    assert.equal(outcome.job.status, "partial");
    assert.equal(qwenRun?.status, "failed");
    assert.equal(qwenRun?.terminalReason, "technical_failure");
    assert.equal(qwenAttempts.length, expected.attemptCount);
    assert.ok(
      qwenAttempts.every(
        ({ submissionEvidence }) =>
          submissionEvidence === expected.submissionEvidence,
      ),
    );
  }
});

test("production rejects every Mock lineage even when every visible provenance label is changed", async () => {
  const testFeishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: testFeishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = testFeishu.snapshot();
  const productionFeishu = new InMemoryFeishuProjection({
    targetEnvironment: "production",
  });
  const productionLabel = { provenance: "PRODUCTION" as const };
  const relabeledCase = {
    ...snapshot.caseTable[0],
    ...productionLabel,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  } as EvaluationCaseRecord;
  const relabeledRun = {
    ...snapshot.runRecordTable[0],
    ...productionLabel,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  } as RunRecord;
  const relabeledEvaluation = {
    ...snapshot.artifactScoreTable[0],
    ...productionLabel,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    artifact: {
      ...snapshot.artifactScoreTable[0]?.artifact,
      ...productionLabel,
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    },
    renderManifest: {
      ...snapshot.artifactScoreTable[0]?.renderManifest,
      ...productionLabel,
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    },
    scorecard: {
      ...snapshot.artifactScoreTable[0]?.scorecard,
      ...productionLabel,
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    },
  } as ArtifactScoreTableRecord;
  const relabeledComparison = {
    ...snapshot.productGapCardTable[0],
    ...productionLabel,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  } as ProductGapCardRecord;
  const relabeledReport = {
    ...snapshot.reports[0],
    ...productionLabel,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  } as FeishuReportDraft;

  await assert.rejects(
    productionFeishu.upsertCase(relabeledCase),
    /production.*environment origin/i,
  );
  await assert.rejects(
    productionFeishu.appendRunRecord(relabeledRun),
    /production.*environment origin/i,
  );
  await assert.rejects(
    productionFeishu.appendArtifactScore(relabeledEvaluation),
    /production.*environment origin/i,
  );
  await assert.rejects(
    productionFeishu.appendProductGapCard(relabeledComparison),
    /production.*environment origin/i,
  );
  await assert.rejects(
    productionFeishu.createReport(relabeledReport),
    /production.*environment origin/i,
  );

  const mockAdapter = new MockWpsProductAdapter();
  const relabeledAdapter: ProductAdapterPort = {
    productPackage: {
      ...mockAdapter.productPackage,
      provenance: "PRODUCTION",
    },
    execute: (command) => mockAdapter.execute(command),
  };
  await assert.rejects(
    createBakeoffHarness({
      feishu: productionFeishu,
      productAdapters: [relabeledAdapter],
    }).startBakeoffJob({
      environment: "production",
      caseId: VOLCANO_CASE_ID,
    }),
    /production.*environment origin/i,
  );
});
