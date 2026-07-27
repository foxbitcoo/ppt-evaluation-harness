import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  InMemoryReferencePackStore,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  VENDOR_GENERATION_TIMEOUT_MS,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createComparisonReportService,
  type ArtifactScoreTableRecord,
  type AttemptDeadlinePort,
  type ComparisonRecord,
  type EvaluationCaseRecord,
  type FeishuReportDraft,
  type ProductAdapterPort,
  type ProductGapCardRecord,
  type RunRecord,
} from "../src/index.ts";

function deterministicDeadline(
  options: {
    readonly timeoutCalls?: readonly number[];
    readonly successElapsedMs?: number;
  } = {},
): AttemptDeadlinePort {
  let call = 0;
  const timeoutCalls = new Set(options.timeoutCalls ?? []);
  return {
    async run(operation, timeoutMs) {
      call += 1;
      if (timeoutCalls.has(call)) {
        return {
          timedOut: true,
          elapsedMs: VENDOR_GENERATION_TIMEOUT_MS,
        };
      }
      const controller = new AbortController();
      return {
        timedOut: false,
        value: await operation(controller.signal),
        elapsedMs: options.successElapsedMs ?? 0,
      };
    },
  };
}

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

test("the Feishu projections preserve stable Case, Run, Artifact, score, and product-gap lineage", async () => {
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
      "adjudicationEventTable",
      "artifactScoreTable",
      "capturedArtifactTable",
      "caseTable",
      "gapCardWorkflowEventTable",
      "githubIssueDeliveryReservationTable",
      "githubIssueLinkEventTable",
      "productGapCardTable",
      "reviewEventTable",
      "runRecordTable",
    ],
  );
  assert.equal(projection.capturedArtifactTable.length, 3);
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
  const comparisonRecords = projection.productGapCardTable.filter(
    (record): record is ComparisonRecord =>
      record.recordType === "comparison",
  );
  const gapCardRecords = projection.productGapCardTable.filter(
    (record): record is ProductGapCardRecord =>
      record.recordType === "gap_card",
  );
  assert.deepEqual(
    comparisonRecords.map(
      ({ comparisonId, caseId, jobId }) => ({
        comparisonId,
        caseId,
        jobId,
      }),
    ),
    [
      {
        comparisonId: "MOCK-comparison-wps-qwen-volcano-v1",
        caseId: VOLCANO_CASE_ID,
        jobId: "MOCK-job-volcano-v1",
      },
      {
        comparisonId: "MOCK-comparison-wps-doubao-volcano-v1",
        caseId: VOLCANO_CASE_ID,
        jobId: "MOCK-job-volcano-v1",
      },
    ],
  );
  assert.equal(gapCardRecords.length, 3);
  assert.ok(
    gapCardRecords.every(
      ({ gapCardId, caseId, jobId, causeAttribution }) =>
        /^gap-[a-f0-9]{16}$/.test(gapCardId) &&
        caseId === VOLCANO_CASE_ID &&
        jobId === "MOCK-job-volcano-v1" &&
        causeAttribution === "HYPOTHESIS",
    ),
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
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter({ scenario: "quota_blocked" }),
    ],
    attemptDeadline: deterministicDeadline({ timeoutCalls: [2] }),
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
        elapsedMs: 0,
        submissionEvidence: "submitted",
        terminalReason: "success",
      },
      {
        parentRecordId: "MOCK-run-qwen-volcano-v1",
        attemptSeq: 1,
        elapsedMs: 1_800_000,
        submissionEvidence: "unknown",
        terminalReason: "vendor_timeout",
      },
      {
        parentRecordId: "MOCK-run-doubao-volcano-v1",
        attemptSeq: 1,
        elapsedMs: 0,
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
      jobStatus: "partial",
      terminalReason: "payment",
      blockReason: "payment",
      submissionEvidence: "not_submitted",
      waitingReason: null,
    },
    {
      scenario: "authentication_blocked" as const,
      status: "blocked",
      jobStatus: "partial",
      terminalReason: "authentication",
      blockReason: "authentication",
      submissionEvidence: "not_submitted",
      waitingReason: null,
    },
    {
      scenario: "human_wait" as const,
      status: "waiting_for_human",
      jobStatus: "active",
      terminalReason: null,
      blockReason: null,
      submissionEvidence: "submitted",
      waitingReason: "human_intervention",
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

    assert.equal(outcome.job.status, expected.jobStatus);
    assert.equal(qwenRecords.length, 2);
    assert.deepEqual(
      qwenRecords.map(
        ({
          recordType,
          status,
          terminalReason,
          blockReason,
          submissionEvidence,
          waitingReason,
        }) => ({
          recordType,
          status,
          terminalReason,
          blockReason,
          submissionEvidence,
          waitingReason,
        }),
      ),
      [
        {
          recordType: "vendor_run",
          status: expected.status,
          terminalReason: expected.terminalReason,
          blockReason: expected.blockReason,
          submissionEvidence: null,
          waitingReason: expected.waitingReason,
        },
        {
          recordType: "evaluation_attempt",
          status: expected.status,
          terminalReason: expected.terminalReason,
          blockReason: expected.blockReason,
          submissionEvidence: expected.submissionEvidence,
          waitingReason: expected.waitingReason,
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
  const comparison = snapshot.productGapCardTable.find(
    (record): record is ComparisonRecord => record.recordType === "comparison",
  );
  const gapCard = snapshot.productGapCardTable.find(
    (record): record is ProductGapCardRecord =>
      record.recordType === "gap_card",
  );
  assert.ok(comparison);
  assert.ok(gapCard);
  const relabeledComparison = {
    ...comparison,
    ...productionLabel,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  } as ComparisonRecord;
  const relabeledGapCard = {
    ...gapCard,
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
    productionFeishu.appendComparison(relabeledComparison),
    /production.*environment origin/i,
  );
  await assert.rejects(
    productionFeishu.appendProductGapCard(relabeledGapCard),
    /production.*environment origin/i,
  );
  await assert.rejects(
    productionFeishu.createReport(relabeledReport),
    /production.*environment origin/i,
  );

  const mockAdapter = new MockWpsProductAdapter();
  const relabeledAdapter: ProductAdapterPort = {
    implementationPackage: mockAdapter.implementationPackage,
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

test("the command environment must match the projection environment before any adapter executes", async () => {
  const mockAdapter = new MockWpsProductAdapter();
  let executeCount = 0;
  const productionLabeledAdapter: ProductAdapterPort = {
    implementationPackage: mockAdapter.implementationPackage,
    productPackage: {
      ...mockAdapter.productPackage,
      provenance: "PRODUCTION",
      environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    },
    async execute(command) {
      executeCount += 1;
      return mockAdapter.execute(command);
    },
  };

  await assert.rejects(
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection(),
      productAdapters: [productionLabeledAdapter],
    }).startBakeoffJob({
      environment: "production",
      caseId: VOLCANO_CASE_ID,
    }),
    /production.*test projection environment/i,
  );
  assert.equal(executeCount, 0);
});

test("an all-failed Bakeoff persists every failure and returns a MOCK failure report without captured output", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter({ scenario: "quota_blocked" }),
      new MockDoubaoProductAdapter({ scenario: "payment_blocked" }),
    ],
    attemptDeadline: deterministicDeadline({ timeoutCalls: [1] }),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const projection = feishu.snapshot();

  assert.equal(outcome.job.status, "failed");
  assert.equal(outcome.artifact, null);
  assert.equal(outcome.renderManifest, null);
  assert.equal(outcome.scorecard, null);
  assert.deepEqual(outcome.artifacts, []);
  assert.equal(projection.caseTable.length, 1);
  assert.deepEqual(
    projection.runRecordTable
      .filter(({ recordType }) => recordType === "vendor_run")
      .map(({ status, terminalReason }) => ({ status, terminalReason })),
    [
      { status: "timed_out", terminalReason: "vendor_timeout" },
      { status: "blocked", terminalReason: "quota" },
      { status: "blocked", terminalReason: "payment" },
    ],
  );
  assert.equal(
    projection.runRecordTable.filter(
      ({ recordType }) => recordType === "evaluation_attempt",
    ).length,
    3,
  );
  assert.deepEqual(outcome.report.artifactIds, []);
  assert.match(outcome.report.title, /^MOCK/);
  assert.match(outcome.report.markdown, /Job 状态：`failed`/);
});

test("Comparison and Gap Card are separate neutral lineage records without a permanent WPS baseline", async () => {
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
  const records = feishu.snapshot().productGapCardTable;
  const comparisons = records.filter(
    (record): record is ComparisonRecord => record.recordType === "comparison",
  );
  const gapCards = records.filter(
    (record): record is ProductGapCardRecord =>
      record.recordType === "gap_card",
  );

  assert.deepEqual(
    comparisons.map(
      ({
        comparisonId,
        leftRunId,
        rightRunId,
        leftScorecardId,
        rightScorecardId,
      }) => ({
        comparisonId,
        leftRunId,
        rightRunId,
        leftScorecardId,
        rightScorecardId,
      }),
    ),
    [
      {
        comparisonId: "MOCK-comparison-wps-qwen-volcano-v1",
        leftRunId: "MOCK-run-wps-volcano-v1",
        rightRunId: "MOCK-run-qwen-volcano-v1",
        leftScorecardId: "MOCK-scorecard-wps-volcano-v1",
        rightScorecardId: "MOCK-scorecard-qwen-volcano-v1",
      },
      {
        comparisonId: "MOCK-comparison-wps-doubao-volcano-v1",
        leftRunId: "MOCK-run-wps-volcano-v1",
        rightRunId: "MOCK-run-doubao-volcano-v1",
        leftScorecardId: "MOCK-scorecard-wps-volcano-v1",
        rightScorecardId: "MOCK-scorecard-doubao-volcano-v1",
      },
    ],
  );
  assert.equal(gapCards.length, 3);
  assert.ok(
    gapCards.every(
      ({ comparisonId, causeAttribution, leftEvidence, rightEvidence }) =>
        comparisons.some(
          (comparison) => comparison.comparisonId === comparisonId,
        ) &&
        causeAttribution === "HYPOTHESIS" &&
        leftEvidence.links.length > 0 &&
        rightEvidence.links.length > 0,
    ),
  );

  const competitorOnlyFeishu = new InMemoryFeishuProjection();
  const competitorBakeoff = await createBakeoffHarness({
    feishu: competitorOnlyFeishu,
    productAdapters: [
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const [competitorComparison] = (
    await createComparisonReportService({
      feishu: competitorOnlyFeishu,
    }).createReport({
      jobId: competitorBakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    })
  ).comparisons;
  assert.equal(competitorComparison?.leftRunId, "MOCK-run-qwen-volcano-v1");
  assert.equal(competitorComparison?.rightRunId, "MOCK-run-doubao-volcano-v1");
});

test("the Job freezes its selected Runs and protocol while Attempts retain observable timing, action, and cost evidence", async () => {
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter({ scenario: "human_wait" }),
      new MockDoubaoProductAdapter(),
    ],
    attemptDeadline: deterministicDeadline({ successElapsedMs: 7 }),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const projection = feishu.snapshot();
  const job = projection.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const qwenAttempt = projection.runRecordTable.find(
    ({ recordType, parentRecordId }) =>
      recordType === "evaluation_attempt" &&
      parentRecordId === "MOCK-run-qwen-volcano-v1",
  );

  assert.deepEqual(job?.selectedRunIds, [
    "MOCK-run-wps-volcano-v1",
    "MOCK-run-qwen-volcano-v1",
    "MOCK-run-doubao-volcano-v1",
  ]);
  assert.deepEqual(job?.protocolSnapshot, {
    protocolId: "MOCK-query-default-cost-v1",
    referencePackMode: "automatic",
    timeoutMs: 1_800_000,
    retryPolicy: "one_if_provably_not_submitted",
    resultSelectionPolicy: "first_policy_compliant_artifact",
    cancellationPolicy: "independent_vendor_runs_continue",
  });
  assert.equal(job?.deadlineAt, "2026-01-01T00:30:00.000Z");
  assert.equal(qwenAttempt?.vendorGenerationMs, 7);
  assert.equal(qwenAttempt?.vendorReportedElapsedMs, 1);
  assert.equal(qwenAttempt?.humanWaitMs, null);
  assert.equal(qwenAttempt?.timingPausedAt, "2026-01-01T00:00:00.007Z");
  assert.deepEqual(qwenAttempt?.manualActions, []);
  assert.deepEqual(qwenAttempt?.costEvidence, {
    classification: "unknown",
    amount: null,
    currency: null,
  });
  assert.deepEqual(qwenAttempt?.observableEvents, [
    {
      eventId: "MOCK-run-qwen-volcano-v1-attempt-1-event-1",
      jobId: "MOCK-job-volcano-v1",
      caseId: VOLCANO_CASE_ID,
      runId: "MOCK-run-qwen-volcano-v1",
      attemptId: "MOCK-run-qwen-volcano-v1-attempt-1",
      attemptSeq: 1,
      eventType: "waiting_for_human",
      sourceAt: "2026-01-01T00:00:00.007Z",
      observedAt: "2026-01-01T00:00:00.007Z",
      writerId: "mock-runner@1",
      evidenceRef: "mock://qwen/attempt-1",
    },
  ]);
});

test("the 30-minute wall-clock deadline aborts a hung adapter without trusting adapter-reported elapsed time", async () => {
  const wps = new MockWpsProductAdapter();
  let executeCount = 0;
  let observedAbort = false;
  const hungWps: ProductAdapterPort = {
    implementationPackage: wps.implementationPackage,
    productPackage: wps.productPackage,
    execute(command) {
      executeCount += 1;
      command.signal.addEventListener("abort", () => {
        observedAbort = true;
      });
      return new Promise(() => {});
    },
  };
  let deadlineCall = 0;
  const immediateDeadline: AttemptDeadlinePort = {
    async run(operation, timeoutMs) {
      deadlineCall += 1;
      const controller = new AbortController();
      if (deadlineCall === 1) {
        void operation(controller.signal);
        controller.abort();
        return { timedOut: true, elapsedMs: timeoutMs };
      }
      return {
        timedOut: false,
        value: await operation(controller.signal),
        elapsedMs: 0,
      };
    },
  };
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [
      hungWps,
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
    attemptDeadline: immediateDeadline,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const wpsAttempt = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordType, parentRecordId }) =>
        recordType === "evaluation_attempt" &&
        parentRecordId === "MOCK-run-wps-volcano-v1",
    );

  assert.equal(executeCount, 1);
  assert.equal(observedAbort, true);
  assert.equal(outcome.job.status, "partial");
  assert.equal(wpsAttempt?.status, "timed_out");
  assert.equal(wpsAttempt?.elapsedMs, 1_800_000);
  assert.equal(wpsAttempt?.submissionEvidence, "unknown");
  assert.equal(wpsAttempt?.terminalReason, "vendor_timeout");
});

test("a thrown adapter error becomes a persisted technical failure with unknown submission evidence", async () => {
  const wps = new MockWpsProductAdapter();
  const qwen = new MockQwenProductAdapter();
  const throwingQwen: ProductAdapterPort = {
    implementationPackage: qwen.implementationPackage,
    productPackage: qwen.productPackage,
    async execute() {
      throw new Error("simulated adapter crash");
    },
  };
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [wps, throwingQwen],
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
      ({ recordType, status, terminalReason, submissionEvidence }) => ({
        recordType,
        status,
        terminalReason,
        submissionEvidence,
      }),
    ),
    [
      {
        recordType: "vendor_run",
        status: "failed",
        terminalReason: "technical_failure",
        submissionEvidence: null,
      },
      {
        recordType: "evaluation_attempt",
        status: "failed",
        terminalReason: "technical_failure",
        submissionEvidence: "unknown",
      },
    ],
  );
});

test("the selected adapter set is defensively frozen before any adapter can mutate its caller array", async () => {
  const wps = new MockWpsProductAdapter();
  const qwen = new MockQwenProductAdapter();
  const selectedAdapters: ProductAdapterPort[] = [];
  const mutatingWps: ProductAdapterPort = {
    implementationPackage: wps.implementationPackage,
    productPackage: wps.productPackage,
    async execute(command) {
      selectedAdapters.push(new MockDoubaoProductAdapter());
      return wps.execute(command);
    },
  };
  selectedAdapters.push(mutatingWps, qwen);
  const feishu = new InMemoryFeishuProjection();

  await createBakeoffHarness({
    feishu,
    productAdapters: selectedAdapters,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const vendorRuns = feishu
    .snapshot()
    .runRecordTable.filter(({ recordType }) => recordType === "vendor_run");

  assert.equal(selectedAdapters.length, 3);
  assert.deepEqual(
    vendorRuns.map(({ recordId }) => recordId),
    ["MOCK-run-wps-volcano-v1", "MOCK-run-qwen-volcano-v1"],
  );
});

test("all selected vendors begin under one shared 30-minute Job deadline", async () => {
  let started = 0;
  const pending: Array<() => void> = [];
  const sharedDeadline: AttemptDeadlinePort = {
    async run(operation, timeoutMs) {
      assert.ok(timeoutMs > 0 && timeoutMs <= 1_800_000);
      const controller = new AbortController();
      const execution = operation(controller.signal);
      started += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("vendors did not start concurrently")),
          25,
        );
        pending.push(() => {
          clearTimeout(timer);
          resolve();
        });
        if (started === 3) {
          for (const release of pending) release();
        }
      });
      return { timedOut: false, value: await execution, elapsedMs: 0 };
    },
  };
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
    attemptDeadline: sharedDeadline,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const jobRecord = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "bakeoff_job");

  assert.equal(started, 3);
  assert.equal(jobRecord?.deadlineAt, "2026-01-01T00:30:00.000Z");
  assert.equal(outcome.job.status, "completed");
});

test("arbitrary package IDs use own-safe stable IDs with a 128-bit digest", async () => {
  const wps = new MockWpsProductAdapter();
  const inheritedKeyAdapter: ProductAdapterPort = {
    implementationPackage: wps.implementationPackage,
    productPackage: {
      ...wps.productPackage,
      packageId: "__proto__",
      displayName: "Custom Prototype Vendor",
    },
    execute: (command) => wps.execute(command),
  };

  const runOnce = async () => {
    const feishu = new InMemoryFeishuProjection();
    await createBakeoffHarness({
      feishu,
      productAdapters: [inheritedKeyAdapter],
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    });
    return feishu
      .snapshot()
      .runRecordTable.find(({ recordType }) => recordType === "vendor_run")
      ?.recordId;
  };

  const firstRunId = await runOnce();
  const secondRunId = await runOnce();
  assert.equal(firstRunId, secondRunId);
  assert.match(firstRunId ?? "", /^MOCK-run-proto-[a-f0-9]{32}-volcano-v1$/);
  assert.doesNotMatch(firstRunId ?? "", /\[object Object\]/);
});

test("measured deadline time overrides a successful adapter's self-reported elapsed time", async () => {
  const wps = new MockWpsProductAdapter();
  const inflatedElapsedAdapter: ProductAdapterPort = {
    implementationPackage: wps.implementationPackage,
    productPackage: wps.productPackage,
    async execute(command) {
      const artifact = await wps.execute(command);
      assert.ok("content" in artifact);
      return {
        terminalReason: "success",
        blockReason: null,
        submissionEvidence: "submitted",
        elapsedMs: 1_800_000,
        artifactCandidates: [{ artifact, policyCompliant: true }],
      };
    },
  };
  const measuredDeadline: AttemptDeadlinePort = {
    async run(operation) {
      const controller = new AbortController();
      return {
        timedOut: false,
        value: await operation(controller.signal),
        elapsedMs: 5,
      };
    },
  };
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [inflatedElapsedAdapter],
    attemptDeadline: measuredDeadline,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const attempt = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordType }) => recordType === "evaluation_attempt",
    );

  assert.equal(outcome.job.status, "completed");
  assert.equal(attempt?.terminalReason, "success");
  assert.equal(attempt?.elapsedMs, 5);
  assert.equal(attempt?.vendorGenerationMs, 5);
  assert.equal(attempt?.vendorReportedElapsedMs, 1_800_000);
});

test("an explicit vendor timeout remains timed out without trusting its self-reported elapsed time", async () => {
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [new MockQwenProductAdapter({ scenario: "timeout" })],
    attemptDeadline: deterministicDeadline({ successElapsedMs: 5 }),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const attempt = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordType }) => recordType === "evaluation_attempt",
    );

  assert.equal(outcome.job.status, "failed");
  assert.equal(attempt?.status, "timed_out");
  assert.equal(attempt?.terminalReason, "vendor_timeout");
  assert.equal(attempt?.elapsedMs, 5);
  assert.equal(attempt?.vendorReportedElapsedMs, 1_800_000);
});

test("a settled Bakeoff rejects a Mock adapter whose runtime scenario differs from the frozen implementation evidence", async () => {
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockQwenProductAdapter({ scenario: "success" })],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: [
        new MockQwenProductAdapter({ scenario: "timeout" }),
      ],
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /identity conflict|protocol mismatch/i,
  );
});

test("a settled Bakeoff rejects a changed execute entrypoint even when the caller reuses the declared implementation package", async () => {
  const delegate = new MockWpsProductAdapter();
  let firstCalls = 0;
  const firstAdapter: ProductAdapterPort = {
    implementationPackage: delegate.implementationPackage,
    productPackage: delegate.productPackage,
    async execute(command) {
      firstCalls += 1;
      return delegate.execute(command);
    },
  };
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [firstAdapter],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  let changedCalls = 0;
  const changedAdapter: ProductAdapterPort = {
    implementationPackage: delegate.implementationPackage,
    productPackage: delegate.productPackage,
    async execute() {
      changedCalls += 1;
      throw new Error("changed execute entrypoint must not replay");
    },
  };

  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: [changedAdapter],
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /identity conflict|protocol mismatch/i,
  );
  assert.equal(firstCalls, 1);
  assert.equal(changedCalls, 0);
});

test("package metadata and derived Run IDs are snapshotted before any adapter executes", async () => {
  const wps = new MockWpsProductAdapter();
  const qwen = new MockQwenProductAdapter();
  const mutableQwenPackage = { ...qwen.productPackage };
  const mutableQwen: ProductAdapterPort = {
    implementationPackage: qwen.implementationPackage,
    productPackage: mutableQwenPackage,
    execute: (command) => qwen.execute(command),
  };
  const mutatingWps: ProductAdapterPort = {
    implementationPackage: wps.implementationPackage,
    productPackage: wps.productPackage,
    async execute(command) {
      mutableQwenPackage.packageId = "MUTATED-package-id";
      mutableQwenPackage.displayName = "Mutated after selection";
      return wps.execute(command);
    },
  };
  const feishu = new InMemoryFeishuProjection();

  await createBakeoffHarness({
    feishu,
    productAdapters: [mutatingWps, mutableQwen],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const qwenRun = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordId }) => recordId === "MOCK-run-qwen-volcano-v1",
    );

  assert.equal(mutableQwenPackage.packageId, "MUTATED-package-id");
  assert.equal(qwenRun?.productPackageId, "MOCK-qwen-package-v1");
  assert.equal(qwenRun?.product, "Mock Qwen PPT");
});

test("distinct package Runs cannot persist the same Artifact ID", async () => {
  const wps = new MockWpsProductAdapter();
  const duplicateArtifactAdapters: ProductAdapterPort[] = [
    {
      implementationPackage: wps.implementationPackage,
      productPackage: {
        ...wps.productPackage,
        packageId: "custom-package-a",
        displayName: "Custom A",
      },
      execute: (command) => wps.execute(command),
    },
    {
      implementationPackage: wps.implementationPackage,
      productPackage: {
        ...wps.productPackage,
        packageId: "custom-package-b",
        displayName: "Custom B",
      },
      execute: (command) => wps.execute(command),
    },
  ];
  const feishu = new InMemoryFeishuProjection();
  const referencePackStore = new InMemoryReferencePackStore();

  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: duplicateArtifactAdapters,
      referencePackStore,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /duplicate Artifact IDs/i,
  );
  assert.equal(feishu.snapshot().runRecordTable.length, 0);
  assert.equal(referencePackStore.snapshot().temporary.length, 0);
  assert.equal(referencePackStore.snapshot().used.length, 1);
});
