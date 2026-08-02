import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  calculateRenderManifestHash,
  createBakeoffHarness,
  createComparisonReportService,
  expectedComparisonCompatibilityFingerprint,
  type ArtifactScoreTableRecord,
  type AttemptDeadlinePort,
  type CapturedArtifactTableRecord,
  type ComparisonReportSource,
  type FeishuProjectionPort,
  type ProductAdapterPort,
  type ReferencePackGeneratorPort,
} from "../src/index.ts";

function rehashRenderManifest(
  artifactContentHash: ArtifactScoreTableRecord["artifact"]["contentHash"],
  renderManifest: ArtifactScoreTableRecord["renderManifest"],
): ArtifactScoreTableRecord["renderManifest"] {
  const { contentHash: _previousContentHash, ...hashInput } =
    renderManifest;
  return {
    ...renderManifest,
    contentHash: calculateRenderManifestHash(
      artifactContentHash,
      hashInput,
    ),
  };
}

function withComparisonSourceOverride(
  feishu: InMemoryFeishuProjection,
  transform: (
    source: ComparisonReportSource,
  ) => ComparisonReportSource,
): FeishuProjectionPort {
  return new Proxy(feishu, {
    get(target, property, receiver) {
      if (property === "loadComparisonReportSource") {
        return async (jobId: string) =>
          transform(await target.loadComparisonReportSource(jobId));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seededThreeVendorProjection(): Promise<{
  readonly feishu: InMemoryFeishuProjection;
  readonly jobId: string;
}> {
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
  return { feishu, jobId: bakeoff.job.jobId };
}

async function projectionBeforeScores(): Promise<{
  readonly feishu: InMemoryFeishuProjection;
  readonly score: ArtifactScoreTableRecord;
}> {
  const { feishu: source } = await seededThreeVendorProjection();
  const snapshot = source.snapshot();
  const feishu = new InMemoryFeishuProjection();
  for (const record of snapshot.caseTable) {
    await feishu.upsertCase(record);
  }
  for (const record of snapshot.runRecordTable) {
    await feishu.appendRunRecord(record);
  }
  for (const record of snapshot.capturedArtifactTable) {
    await feishu.appendCapturedArtifact(record);
  }
  const score = snapshot.artifactScoreTable.find(
    ({ runId }) => runId === "MOCK-run-qwen-volcano-v1",
  );
  assert.ok(score);
  return { feishu, score };
}

async function projectionBeforeCaptures(): Promise<{
  readonly feishu: InMemoryFeishuProjection;
  readonly capture: CapturedArtifactTableRecord;
}> {
  const { feishu: source } = await seededThreeVendorProjection();
  const snapshot = source.snapshot();
  const feishu = new InMemoryFeishuProjection();
  for (const record of snapshot.caseTable) {
    await feishu.upsertCase(record);
  }
  for (const record of snapshot.runRecordTable) {
    await feishu.appendRunRecord(record);
  }
  const capture = snapshot.capturedArtifactTable[0];
  assert.ok(capture);
  return { feishu, capture };
}

test("a Case already referenced by a Run rejects non-idempotent identity overwrite", async () => {
  const { feishu } = await seededThreeVendorProjection();
  const before = feishu.snapshot();
  const evaluationCase = before.caseTable[0];
  assert.ok(evaluationCase);

  await assert.rejects(
    feishu.upsertCase({
      ...evaluationCase,
      caseId: "cross-wired-case-v999",
    }),
    /Case.*identity|referenced.*Case|non-idempotent/i,
  );
  assert.deepEqual(feishu.snapshot().caseTable, before.caseTable);
});

test("Captured Artifact projection rejects an incomplete Render Manifest page inventory", async () => {
  const { feishu, capture } = await projectionBeforeCaptures();
  const invalidCapture: CapturedArtifactTableRecord = {
    ...capture,
    renderManifest: {
      ...capture.renderManifest,
      pageCount: capture.renderManifest.pageCount - 1,
      slides: capture.renderManifest.slides.slice(0, -1),
    },
  };

  await assert.rejects(
    feishu.appendCapturedArtifact(invalidCapture),
    /Render Manifest.*page|page inventory|content hash/i,
  );
});

test("Captured Artifact projection verifies Artifact bytes, page identities, and rendered content hashes", async (t) => {
  const invalidCaptures = [
    {
      label: "Artifact byte-size drift",
      mutate: (capture: CapturedArtifactTableRecord) => ({
        ...capture,
        artifact: {
          ...capture.artifact,
          byteSize: capture.artifact.byteSize + 1,
        },
      }),
    },
    {
      label: "Artifact content hash drift",
      mutate: (capture: CapturedArtifactTableRecord) => {
        const content = Uint8Array.from(capture.artifact.content);
        content[0] = content[0]! ^ 0xff;
        return {
          ...capture,
          artifact: {
            ...capture.artifact,
            content,
          },
        };
      },
    },
    {
      label: "duplicate page identity",
      mutate: (capture: CapturedArtifactTableRecord) => ({
        ...capture,
        renderManifest: {
          ...capture.renderManifest,
          slides: capture.renderManifest.slides.map(
            (slide, index) =>
              index === 1
                ? { ...slide, pageNumber: 1 }
                : slide,
          ),
        },
      }),
    },
    {
      label: "slide content hash drift",
      mutate: (capture: CapturedArtifactTableRecord) => ({
        ...capture,
        renderManifest: {
          ...capture.renderManifest,
          slides: capture.renderManifest.slides.map(
            (slide, index) =>
              index === 0
                ? {
                    ...slide,
                    content:
                      typeof slide.content === "string"
                        ? `${slide.content}drift`
                        : Uint8Array.from([
                            ...slide.content,
                            0,
                          ]),
                  }
                : slide,
          ),
        },
      }),
    },
    {
      label: "contact-sheet content hash drift",
      mutate: (capture: CapturedArtifactTableRecord) => ({
        ...capture,
        renderManifest: {
          ...capture.renderManifest,
          contactSheet: {
            ...capture.renderManifest.contactSheet,
            content:
              typeof capture.renderManifest.contactSheet.content ===
              "string"
                ? `${capture.renderManifest.contactSheet.content}drift`
                : Uint8Array.from([
                    ...capture.renderManifest.contactSheet.content,
                    0,
                  ]),
          },
        },
      }),
    },
    {
      label: "manifest content hash drift",
      mutate: (capture: CapturedArtifactTableRecord) => ({
        ...capture,
        renderManifest: {
          ...capture.renderManifest,
          contentHash:
            `sha256:${"0".repeat(64)}` as `sha256:${string}`,
        },
      }),
    },
  ] as const;

  for (const { label, mutate } of invalidCaptures) {
    await t.test(label, async () => {
      const { feishu, capture } =
        await projectionBeforeCaptures();
      await assert.rejects(
        feishu.appendCapturedArtifact(mutate(capture)),
        /Artifact.*byte|Artifact.*hash|Render Manifest.*page|page inventory|content hash/i,
      );
    });
  }
});

test("Artifact Score projection rejects a six-dimension value outside 1–5", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? { ...dimension, value: 6 }
            : dimension,
      ),
    },
  } as ArtifactScoreTableRecord;

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*value|six-dimension.*schema|1.*5/i,
  );
});

test("Artifact Score projection rejects duplicate dimension evidence pages", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore: ArtifactScoreTableRecord = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? { ...dimension, evidencePages: [1, 1] }
            : dimension,
      ),
    },
  };

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*evidence.*unique|duplicate.*evidence/i,
  );
});

test("Artifact Score projection rejects evidence outside the Artifact page range", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore: ArtifactScoreTableRecord = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? {
                ...dimension,
                evidencePages: [score.artifact.pageCount + 1],
              }
            : dimension,
      ),
    },
  };

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*evidence.*page range|invalid evidence.*page/i,
  );
});

test("Artifact Score projection rejects an assessment/deduction mismatch", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore: ArtifactScoreTableRecord = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? {
                ...dimension,
                deductionBasis:
                  "not_assessable_degraded_render",
              }
            : dimension,
      ),
    },
  };

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*deduction.*assessment|field combination/i,
  );
});

test("Artifact Score projection enforces NOT_ASSESSABLE ownership and its persisted render gate", async (t) => {
  await t.test(
    "no-reference-pack is owned only by factual accuracy",
    async () => {
      const { feishu, score } = await projectionBeforeScores();
      const invalidScore: ArtifactScoreTableRecord = {
        ...score,
        scorecard: {
          ...score.scorecard,
          dimensions: score.scorecard.dimensions.map(
            (dimension) =>
              dimension.dimension ===
              "requirement_understanding_and_content_coverage"
                ? {
                    ...dimension,
                    assessmentStatus:
                      "NOT_ASSESSABLE" as const,
                    value: null,
                    deductionBasis:
                      "not_assessable_no_reference_pack" as const,
                    evidencePages: [],
                  }
                : dimension,
          ),
        },
      };

      await assert.rejects(
        feishu.appendArtifactScore(invalidScore),
        /NOT_ASSESSABLE.*ownership|Reference Pack.*factual|deduction basis/i,
      );
    },
  );
  await t.test(
    "no-reference-pack requires no persisted Reference Pack",
    async () => {
      const { feishu, score } = await projectionBeforeScores();
      assert.notEqual(
        score.scorecard.evaluationInputManifest.referencePackHash,
        null,
      );
      const invalidScore: ArtifactScoreTableRecord = {
        ...score,
        scorecard: {
          ...score.scorecard,
          dimensions: score.scorecard.dimensions.map(
            (dimension) =>
              dimension.dimension ===
              "factual_accuracy_and_content_quality"
                ? {
                    ...dimension,
                    assessmentStatus:
                      "NOT_ASSESSABLE" as const,
                    value: null,
                    deductionBasis:
                      "not_assessable_no_reference_pack" as const,
                    evidencePages: [],
                    rationale:
                      "No Reference Pack was available.",
                  }
                : dimension,
          ),
        },
      };

      await assert.rejects(
        feishu.appendArtifactScore(invalidScore),
        /Reference Pack|NOT_ASSESSABLE.*ownership|no-reference/i,
      );
    },
  );
  await t.test(
    "degraded-render requires a persisted degraded render gate",
    async () => {
      const { feishu, score } = await projectionBeforeScores();
      const invalidScore: ArtifactScoreTableRecord = {
        ...score,
        scorecard: {
          ...score.scorecard,
          dimensions: score.scorecard.dimensions.map(
            (dimension) =>
              dimension.dimension ===
              "visual_aesthetics_and_professional_finish"
                ? {
                    ...dimension,
                    assessmentStatus:
                      "NOT_ASSESSABLE" as const,
                    value: null,
                    deductionBasis:
                      "not_assessable_degraded_render" as const,
                    evidencePages: [],
                  }
                : dimension,
          ),
        },
      };

      await assert.rejects(
        feishu.appendArtifactScore(invalidScore),
        /NOT_ASSESSABLE.*ownership|degraded render|render gate/i,
      );
    },
  );
});

test("Artifact Score projection enforces the strict six-dimension schema", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? { ...dimension, unexpectedField: true }
            : dimension,
      ),
    },
  } as ArtifactScoreTableRecord;

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*dimension.*strict schema|six-dimension.*schema/i,
  );
});

test("Artifact Score projection requires evidence only for assessed dimensions", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore: ArtifactScoreTableRecord = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? { ...dimension, evidencePages: [] }
            : dimension,
      ),
    },
  };

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*ASSESSED.*evidence|evidence.*assessment status/i,
  );
});

test("Artifact Score projection rejects an empty dimension rationale", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore: ArtifactScoreTableRecord = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? { ...dimension, rationale: " " }
            : dimension,
      ),
    },
  };

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*rationale|six-dimension.*schema/i,
  );
});

test("Artifact Score projection enforces each dimension deduction basis", async () => {
  const { feishu, score } = await projectionBeforeScores();
  const invalidScore: ArtifactScoreTableRecord = {
    ...score,
    scorecard: {
      ...score.scorecard,
      dimensions: score.scorecard.dimensions.map(
        (dimension, index) =>
          index === 0
            ? {
                ...dimension,
                value: 4,
                deductionBasis:
                  "visible_visual_finish_gap",
              }
            : dimension,
      ),
    },
  };

  await assert.rejects(
    feishu.appendArtifactScore(invalidScore),
    /Scorecard.*dimension.*deduction basis|unowned.*deduction/i,
  );
});

test("Comparison projection rejects cross-wired Run and Scorecard lineage", async () => {
  const { feishu } = await seededThreeVendorProjection();
  const comparison = feishu
    .snapshot()
    .productGapCardTable.find(
      (record) => record.recordType === "comparison",
  );
  assert.ok(comparison);

  await assert.rejects(
    feishu.appendComparison({
      ...comparison,
      comparisonId: `${comparison.comparisonId}-cross-wired`,
      leftRunId: comparison.rightRunId,
      leftScorecardId: comparison.rightScorecardId,
    }),
    /Comparison.*lineage|distinct Runs|Scorecard/i,
  );
});

test("Comparison projection enforces one ID for each unordered logical pair", async (t) => {
  const { feishu } = await seededThreeVendorProjection();
  const comparison = feishu
    .snapshot()
    .productGapCardTable.find(
      (record) => record.recordType === "comparison",
  );
  assert.ok(comparison);
  const reversedComparison = (comparisonId: string) => ({
    ...comparison,
    comparisonId,
    leftRunId: comparison.rightRunId,
    leftScorecardId: comparison.rightScorecardId,
    leftProduct: comparison.rightProduct,
    rightRunId: comparison.leftRunId,
    rightScorecardId: comparison.leftScorecardId,
    rightProduct: comparison.leftProduct,
    dimensions: comparison.dimensions.map((dimension) => ({
      ...dimension,
      leftAssessmentStatus: dimension.rightAssessmentStatus,
      rightAssessmentStatus: dimension.leftAssessmentStatus,
      leftValue: dimension.rightValue,
      rightValue: dimension.leftValue,
      difference:
        dimension.difference === null
          ? null
          : -dimension.difference,
      leftEvidencePages: dimension.rightEvidencePages,
      rightEvidencePages: dimension.leftEvidencePages,
      leftReviewState: dimension.rightReviewState,
      rightReviewState: dimension.leftReviewState,
      leftScoreSource: dimension.rightScoreSource,
      rightScoreSource: dimension.leftScoreSource,
      leftAdjudicationEventId:
        dimension.rightAdjudicationEventId,
      rightAdjudicationEventId:
        dimension.leftAdjudicationEventId,
    })),
  });

  await t.test("same orientation with a new ID", async () => {
    await assert.rejects(
      feishu.appendComparison({
        ...comparison,
        comparisonId: `${comparison.comparisonId}-duplicate`,
      }),
      /Comparison.*logical|duplicate|unordered|identity/i,
    );
  });
  await t.test("reversed orientation with a new ID", async () => {
    await assert.rejects(
      feishu.appendComparison(
        reversedComparison(
          `${comparison.comparisonId}-reversed`,
        ),
      ),
      /Comparison.*(?:logical|duplicate|unordered|identity|derived)/i,
    );
  });
  await t.test(
    "snapshot readback rejects a reversed new ID",
    () => {
      const snapshot = feishu.snapshot();
      const invalidSnapshot = {
        ...snapshot,
        productGapCardTable: [
          ...snapshot.productGapCardTable,
          reversedComparison(
            `${comparison.comparisonId}-readback-reversed`,
          ),
        ],
      };

      assert.throws(
        () => feishu.forkForStaging(invalidSnapshot),
        /Comparison.*logical|duplicate|unordered|identity/i,
      );
    },
  );
});

test("Gap projection rejects evidence that is not bound to its Comparison side", async () => {
  const { feishu } = await seededThreeVendorProjection();
  const gapCard = feishu
    .snapshot()
    .productGapCardTable.find(
      (record) => record.recordType === "gap_card",
    );
  assert.ok(gapCard);

  await assert.rejects(
    feishu.appendProductGapCard({
      ...gapCard,
      gapCardId: `${gapCard.gapCardId}-cross-wired`,
      comparisonId: "missing-comparison",
      leftEvidence: {
        ...gapCard.leftEvidence,
        runId: gapCard.rightEvidence.runId,
        artifactId: gapCard.rightEvidence.artifactId,
        scorecardId: gapCard.rightEvidence.scorecardId,
      },
    }),
    /Gap Card.*lineage|Comparison.*not found/i,
  );
});

test("Report projection rejects Run and Artifact IDs outside its Job", async () => {
  const { feishu } = await seededThreeVendorProjection();
  const report = feishu.snapshot().reports[0];
  assert.ok(report);
  const { url: _url, ...draft } = report;

  await assert.rejects(
    feishu.createReport({
      ...draft,
      reportId: `${report.reportId}-cross-wired`,
      runIds: ["missing-run"],
      artifactIds: ["missing-artifact"],
    }),
    /Report.*lineage|Run.*Job|Artifact.*Job/i,
  );
});

test("compatibility fingerprint distinguishes complete static render policies", async () => {
  const { feishu } = await seededThreeVendorProjection();
  const snapshot = feishu.snapshot();
  const evaluationCase = snapshot.caseTable[0];
  const job = snapshot.runRecordTable.find(
    (record) => record.recordType === "bakeoff_job",
  );
  const qwen = snapshot.artifactScoreTable.find(
    ({ runId }) => runId === "MOCK-run-qwen-volcano-v1",
  );
  const doubao = snapshot.artifactScoreTable.find(
    ({ runId }) => runId === "MOCK-run-doubao-volcano-v1",
  );
  assert.ok(evaluationCase);
  assert.ok(job?.protocolSnapshot);
  assert.ok(qwen);
  assert.ok(doubao);
  const changedQwenManifest = {
    ...qwen.renderManifest,
    renderPolicy: {
      ...qwen.renderManifest.renderPolicy,
      resolution: "640x360",
    },
  };
  const {
    contentHash: _previousHash,
    ...changedQwenManifestHashInput
  } = changedQwenManifest;
  const qwenManifest = {
    ...changedQwenManifest,
    contentHash: calculateRenderManifestHash(
      qwen.artifact.contentHash,
      changedQwenManifestHashInput,
    ),
  };
  const qwenScorecard = {
    ...qwen.scorecard,
    evaluationInputManifest: {
      ...qwen.scorecard.evaluationInputManifest,
      renderManifestHash: qwenManifest.contentHash,
    },
  };

  assert.notDeepEqual(
    expectedComparisonCompatibilityFingerprint(
      qwenScorecard,
      job.protocolSnapshot,
      evaluationCase,
      qwenManifest,
    ),
    expectedComparisonCompatibilityFingerprint(
      doubao.scorecard,
      job.protocolSnapshot,
      evaluationCase,
      doubao.renderManifest,
    ),
  );
});

test("Bakeoff Job report links reject a Report owned by another Job", async () => {
  const { feishu } = await seededThreeVendorProjection();
  const snapshot = feishu.snapshot();
  const job = snapshot.runRecordTable.find(
    (record) => record.recordType === "bakeoff_job",
  );
  const report = snapshot.reports[0];
  assert.ok(job);
  assert.ok(report);
  await feishu.appendRunRecord({
    ...job,
    recordId: "other-job",
    jobId: "other-job",
    selectedRunIds: [],
    reportUrl: null,
    auxiliaryReportUrls: null,
  });

  await assert.rejects(
    feishu.linkReportToBakeoffJob("other-job", report.url),
    /Report.*another Job|Report.*ownership|Report.*lineage/i,
  );
});

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
  const primaryReportUrl = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "bakeoff_job")
    ?.reportUrl;

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
  const parentJob = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "bakeoff_job");
  assert.equal(parentJob?.reportUrl, primaryReportUrl);
  assert.deepEqual(parentJob?.auxiliaryReportUrls, [report.report.url]);
});

test("explicit duplicate or reversed pairs converge to one unordered logical Comparison", async () => {
  const { feishu, jobId } = await seededThreeVendorProjection();
  const service = createComparisonReportService({ feishu });
  const comparisonIdsBefore = feishu
    .snapshot()
    .productGapCardTable.filter(
      ({ recordType }) => recordType === "comparison",
    )
    .map(({ comparisonId }) => comparisonId);
  const report = await service.createReport({
    jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-wps-volcano-v1",
        rightRunId: "MOCK-run-qwen-volcano-v1",
      },
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-wps-volcano-v1",
      },
      {
        leftRunId: "MOCK-run-wps-volcano-v1",
        rightRunId: "MOCK-run-qwen-volcano-v1",
      },
    ],
  });

  assert.equal(report.comparisons.length, 1);
  assert.equal(
    report.comparisons[0]?.comparisonId,
    "MOCK-comparison-wps-qwen-volcano-v1",
  );
  const reversedReplay = await service.createReport({
    jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-wps-volcano-v1",
      },
    ],
  });
  assert.equal(
    reversedReplay.comparisons[0]?.comparisonId,
    report.comparisons[0]?.comparisonId,
  );
  assert.equal(reversedReplay.report.reportId, report.report.reportId);
  assert.deepEqual(
    feishu
      .snapshot()
      .productGapCardTable.filter(
        ({ recordType }) => recordType === "comparison",
      )
      .map(({ comparisonId }) => comparisonId),
    comparisonIdsBefore,
  );
});

test("the report view defaults to every compatible pair without making any product a stored baseline", async () => {
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
      [
        "MOCK-run-qwen-volcano-v1",
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
    leftAssessmentStatus: "NOT_ASSESSABLE",
    rightAssessmentStatus: "NOT_ASSESSABLE",
    leftValue: null,
    rightValue: null,
    difference: null,
    leftEvidencePages: [],
    rightEvidencePages: [],
    leftReviewState: "model_not_reviewed",
    rightReviewState: "model_not_reviewed",
    leftScoreSource: "model_original",
    rightScoreSource: "model_original",
    leftAdjudicationEventId: null,
    rightAdjudicationEventId: null,
  });
  assert.ok(
    outcome.gapCards.every(
      ({ dimension }) =>
        dimension !== "factual_accuracy_and_content_quality",
    ),
  );
  assert.match(outcome.report.markdown, /NOT_ASSESSABLE/);
});

test("one-sided no-reference-pack NOT_ASSESSABLE is not directly comparable to a scored Reference Pack side", async () => {
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
  const projection = withComparisonSourceOverride(feishu, (source) => {
    const protocolSnapshot = source.job.protocolSnapshot;
    assert.ok(protocolSnapshot);
    return {
      ...source,
      artifactScores: source.artifactScores.map((record) => {
        if (record.runId !== "MOCK-run-doubao-volcano-v1") {
          return record;
        }
        const scorecard = {
          ...record.scorecard,
          evaluationInputManifest: {
            ...record.scorecard.evaluationInputManifest,
            referencePackHash: null,
          },
          dimensions: record.scorecard.dimensions.map(
            (dimension) =>
              dimension.dimension !==
              "factual_accuracy_and_content_quality"
                ? dimension
                : {
                    ...dimension,
                    assessmentStatus:
                      "NOT_ASSESSABLE" as const,
                    value: null,
                    deductionBasis:
                      "not_assessable_no_reference_pack" as const,
                    evidencePages: [],
                    rationale: "该侧没有可用事实判断证据。",
                  },
          ),
        };
        return {
          ...record,
          scorecard,
          comparisonCompatibilityFingerprint:
            expectedComparisonCompatibilityFingerprint(
              scorecard,
              protocolSnapshot,
              source.evaluationCase,
              record.renderManifest,
            ),
        };
      }),
    };
  });

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    }),
    /not compatible for direct comparison/i,
  );
});

test("a partial default report keeps every selected vendor delivery outcome beside scored comparisons", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter({ scenario: "quota_blocked" }),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  assert.equal(outcome.job.status, "partial");
  assert.match(outcome.report.markdown, /Mock WPS AI PPT/);
  assert.match(outcome.report.markdown, /Mock Qwen PPT/);
  assert.match(outcome.report.markdown, /Mock Doubao PPT/);
  assert.match(outcome.report.markdown, /partial/);
  assert.match(outcome.report.markdown, /quota/);
  assert.deepEqual(outcome.report.runIds, [
    "MOCK-run-wps-volcano-v1",
    "MOCK-run-qwen-volcano-v1",
    "MOCK-run-doubao-volcano-v1",
  ]);
});

test("a partial Bakeoff automatically compares Qwen and Doubao when WPS has no assessable Artifact", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter({ scenario: "quota_blocked" }),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  assert.equal(outcome.job.status, "partial");
  assert.match(outcome.report.markdown, /Mock WPS AI PPT/);
  assert.match(
    outcome.report.markdown,
    /^## Mock Qwen PPT–Mock Doubao PPT$/m,
  );
  assert.deepEqual(
    feishu.snapshot().productGapCardTable.flatMap((record) =>
      record.recordType === "comparison"
        ? [[record.leftRunId, record.rightRunId]]
        : [],
    ),
    [
      [
        "MOCK-run-qwen-volcano-v1",
        "MOCK-run-doubao-volcano-v1",
      ],
    ],
  );
});

test("default all-pairs views follow stable vendor identity across adapter order", async () => {
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
    report.comparisons.map(
      ({ leftProduct, rightProduct }) => [
        leftProduct,
        rightProduct,
      ],
    ),
    [
      ["Mock WPS AI PPT", "Mock Qwen PPT"],
      ["Mock WPS AI PPT", "Mock Doubao PPT"],
      ["Mock Qwen PPT", "Mock Doubao PPT"],
    ],
  );
});

test("both-side static evidence identifies the product that produced each rendered page", async () => {
  const outcome = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  const [wps, qwen, doubao] = outcome.renderManifests;
  const slideText = (content: string | Uint8Array | undefined) =>
    typeof content === "string" ? content : "";
  assert.match(slideText(wps?.slides[0]?.content), /MOCK WPS AI PPT/);
  assert.match(slideText(qwen?.slides[0]?.content), /MOCK Qwen PPT/);
  assert.doesNotMatch(slideText(qwen?.slides[0]?.content), /MOCK WPS AI PPT/);
  assert.match(slideText(doubao?.slides[0]?.content), /MOCK Doubao PPT/);
  assert.doesNotMatch(
    slideText(doubao?.slides[0]?.content),
    /MOCK WPS AI PPT/,
  );
});

test("comparison rejects mismatched persisted compatibility fingerprints before writing projections", async () => {
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
  type ScoreWithFingerprint = ArtifactScoreTableRecord & {
    readonly comparisonCompatibilityFingerprint: {
      readonly referencePackHash: `sha256:${string}` | null;
    };
  };
  const projection = withComparisonSourceOverride(feishu, (source) => ({
    ...source,
    artifactScores: source.artifactScores.map((record) =>
      record.runId !== "MOCK-run-doubao-volcano-v1"
        ? record
        : {
            ...record,
            comparisonCompatibilityFingerprint: {
              ...(record as ScoreWithFingerprint)
                .comparisonCompatibilityFingerprint,
              referencePackHash:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
    ),
  }));
  const before = feishu.snapshot();

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    }),
    /compatible|compatibility fingerprint/i,
  );
  const after = feishu.snapshot();
  assert.equal(
    after.productGapCardTable.length,
    before.productGapCardTable.length,
  );
  assert.equal(after.reports.length, before.reports.length);
});

test("comparison rejects a copied compatibility fingerprint that no longer matches the persisted Scorecard inputs", async () => {
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
  const projection = withComparisonSourceOverride(feishu, (source) => ({
    ...source,
    artifactScores: source.artifactScores.map((record) =>
      record.runId !== "MOCK-run-qwen-volcano-v1"
        ? record
        : {
            ...record,
            scorecard: {
              ...record.scorecard,
              evaluationInputManifest: {
                ...record.scorecard.evaluationInputManifest,
                referencePackHash:
                  "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              },
            },
          },
    ),
  }));

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    }),
    /fingerprint|Scorecard|evaluation input|lineage/i,
  );
});

test("comparison rejects a Scorecard that omits one of the six scoring dimensions even when its copied fingerprint matches", async () => {
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
  const projection = withComparisonSourceOverride(feishu, (source) => ({
    ...source,
    artifactScores: source.artifactScores.map((record) =>
      record.runId !== "MOCK-run-qwen-volcano-v1"
        ? record
        : {
            ...record,
            scorecard: {
              ...record.scorecard,
              dimensions: record.scorecard.dimensions.slice(0, -1),
            },
          },
    ),
  }));

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    }),
    /six unique scoring dimensions|incompatible dimensions/i,
  );
});

test("comparison rejects production-shaped LIVE_PRODUCTION and PRODUCTION_REPLAY scorecards when their outer projection provenance is the same", async () => {
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
  const captureProvenanceForRun = (runId: string) =>
    runId === "MOCK-run-qwen-volcano-v1"
      ? ("LIVE_PRODUCTION" as const)
      : runId === "MOCK-run-doubao-volcano-v1"
        ? ("PRODUCTION_REPLAY" as const)
        : ("MOCK" as const);
  const projection = withComparisonSourceOverride(feishu, (source) => ({
    ...source,
    vendorRuns: source.vendorRuns.map((run) => ({
      ...run,
      provenance:
        run.recordId === "MOCK-run-wps-volcano-v1"
          ? run.provenance
          : ("PRODUCTION" as const),
    })),
    artifactScores: source.artifactScores.map((record) => ({
      ...record,
      provenance:
        record.runId === "MOCK-run-wps-volcano-v1"
          ? record.provenance
          : ("PRODUCTION" as const),
      artifact: {
        ...record.artifact,
        provenance: captureProvenanceForRun(record.runId),
      },
      renderManifest: {
        ...record.renderManifest,
        provenance: captureProvenanceForRun(record.runId),
      },
      scorecard: {
        ...record.scorecard,
        provenance: captureProvenanceForRun(record.runId),
      },
    })),
  }));

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    }),
    /provenance|compatible for direct comparison/i,
  );
});

test("Artifact Score projection rejects inconsistent capture execution provenance before persistence", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const score = source.snapshot().artifactScoreTable[0]!;
  const target = new InMemoryFeishuProjection();
  const replayRenderManifest = rehashRenderManifest(
    score.artifact.contentHash,
    {
      ...score.renderManifest,
      provenance: "PRODUCTION_REPLAY",
    },
  );

  await assert.rejects(
    target.appendArtifactScore({
      ...score,
      renderManifest: replayRenderManifest,
    }),
    /provenance|lineage/i,
  );
  const liveArtifact = {
    ...score.artifact,
    provenance: "LIVE_PRODUCTION" as const,
  };
  const liveRenderManifest = rehashRenderManifest(
    liveArtifact.contentHash,
    {
      ...score.renderManifest,
      provenance: "LIVE_PRODUCTION",
    },
  );
  await assert.rejects(
    target.appendArtifactScore({
      ...score,
      artifact: liveArtifact,
      renderManifest: liveRenderManifest,
      scorecard: {
        ...score.scorecard,
        provenance: "LIVE_PRODUCTION",
      },
    }),
    /provenance|lineage/i,
  );
  assert.equal(target.snapshot().artifactScoreTable.length, 0);
});

test("Artifact Score projection rejects evaluation input hashes that do not match the persisted Artifact and Render Manifest", async () => {
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockQwenProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const score = feishu.snapshot().artifactScoreTable[0];
  assert.ok(score);

  await assert.rejects(
    feishu.appendArtifactScore({
      ...score,
      scorecard: {
        ...score.scorecard,
        evaluationInputManifest: {
          ...score.scorecard.evaluationInputManifest,
          artifactHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      },
    }),
    /evaluation input|Artifact|lineage/i,
  );
  await assert.rejects(
    feishu.appendArtifactScore({
      ...score,
      scorecard: {
        ...score.scorecard,
        evaluationInputManifest: {
          ...score.scorecard.evaluationInputManifest,
          renderManifestHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      },
    }),
    /evaluation input|Render Manifest|lineage/i,
  );
});

test("Artifact Score projection rejects a production-shaped score whose persisted capture has different execution provenance", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapters: [
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const qwenCapture = snapshot.capturedArtifactTable.find(
    ({ runId }) => runId === "MOCK-run-qwen-volcano-v1",
  );
  const qwenScore = snapshot.artifactScoreTable.find(
    ({ runId }) => runId === "MOCK-run-qwen-volcano-v1",
  );
  assert.ok(qwenCapture);
  assert.ok(qwenScore);

  const target = new InMemoryFeishuProjection();
  const productionCase = {
    ...snapshot.caseTable[0]!,
    provenance: "PRODUCTION" as const,
  };
  for (const evaluationCase of snapshot.caseTable) {
    await target.upsertCase({
      ...evaluationCase,
      provenance: "PRODUCTION",
    });
  }
  for (const run of snapshot.runRecordTable) {
    await target.appendRunRecord({
      ...run,
      provenance: "PRODUCTION",
    });
  }
  const productionRenderManifest = {
    ...qwenCapture.renderManifest,
    provenance: "LIVE_PRODUCTION" as const,
  };
  const {
    contentHash: _previousProductionRenderManifestHash,
    ...productionRenderManifestHashInput
  } = productionRenderManifest;
  await target.appendCapturedArtifact({
    ...qwenCapture,
    provenance: "PRODUCTION",
    artifact: {
      ...qwenCapture.artifact,
      provenance: "LIVE_PRODUCTION",
    },
    renderManifest: {
      ...productionRenderManifest,
      contentHash: calculateRenderManifestHash(
        qwenCapture.artifact.contentHash,
        productionRenderManifestHashInput,
      ),
    },
  });
  const productionJob = target.snapshot().runRecordTable.find(
    (record) => record.recordType === "bakeoff_job",
  );
  assert.ok(productionJob?.protocolSnapshot);
  const productionScoreWithoutRehashedManifest = {
    ...qwenScore,
    provenance: "PRODUCTION" as const,
    artifact: {
      ...qwenScore.artifact,
      provenance: "PRODUCTION_REPLAY" as const,
    },
    renderManifest: {
      ...qwenScore.renderManifest,
      provenance: "PRODUCTION_REPLAY" as const,
    },
    scorecard: {
      ...qwenScore.scorecard,
      provenance: "PRODUCTION_REPLAY" as const,
    },
  };
  const productionScore = {
    ...productionScoreWithoutRehashedManifest,
    renderManifest: rehashRenderManifest(
      productionScoreWithoutRehashedManifest.artifact.contentHash,
      productionScoreWithoutRehashedManifest.renderManifest,
    ),
  };

  await assert.rejects(
    target.appendArtifactScore({
      ...productionScore,
      comparisonCompatibilityFingerprint:
        expectedComparisonCompatibilityFingerprint(
          productionScore.scorecard,
          productionJob.protocolSnapshot,
          productionCase,
          productionScore.renderManifest,
        ),
    }),
    /captured artifact|cross-table|lineage/i,
  );
  assert.equal(target.snapshot().artifactScoreTable.length, 0);
});

test("comparison source readback fails closed when Captured Artifact and Artifact Score payloads diverge", async () => {
  const source = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu: source,
    productAdapters: [
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const corrupted = {
    ...snapshot,
    artifactScoreTable: snapshot.artifactScoreTable.map((record, index) =>
      index !== 0
        ? record
        : {
            ...record,
            artifact: {
              ...record.artifact,
              filename: "cross-table-conflict.pptx",
            },
          },
    ),
  };
  const readback = source.forkForStaging(corrupted);

  await assert.rejects(
    readback.loadComparisonReportSource(bakeoff.job.jobId),
    /captured artifact|cross-table|lineage/i,
  );
});

test("comparison source readback rejects a shared but internally inconsistent Render Manifest", async () => {
  const { feishu, jobId } = await seededThreeVendorProjection();
  const snapshot = feishu.snapshot();
  const capture = snapshot.capturedArtifactTable[0];
  assert.ok(capture);
  const invalidRenderManifest = {
    ...capture.renderManifest,
    pageCount: capture.renderManifest.pageCount - 1,
    slides: capture.renderManifest.slides.slice(0, -1),
  };
  const corrupted = {
    ...snapshot,
    capturedArtifactTable: snapshot.capturedArtifactTable.map(
      (record) =>
        record.artifactId === capture.artifactId
          ? {
              ...record,
              renderManifest: invalidRenderManifest,
            }
          : record,
    ),
    artifactScoreTable: snapshot.artifactScoreTable.map(
      (record) =>
        record.artifactId === capture.artifactId
          ? {
              ...record,
              renderManifest: invalidRenderManifest,
            }
          : record,
    ),
  };

  await assert.rejects(
    feishu
      .forkForStaging(corrupted)
      .loadComparisonReportSource(jobId),
    /Render Manifest.*page|page inventory|content hash|Scorecard.*evidence page/i,
  );
});

test("Run append rejects a vendor Run cross-wired outside its selected Job parent", async () => {
  const { feishu: source } = await seededThreeVendorProjection();
  const snapshot = source.snapshot();
  const evaluationCase = snapshot.caseTable[0];
  const job = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const vendorRun = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "vendor_run",
  );
  assert.ok(evaluationCase);
  assert.ok(job);
  assert.ok(vendorRun);
  const target = new InMemoryFeishuProjection();
  await target.upsertCase(evaluationCase);
  await target.appendRunRecord(job);

  await assert.rejects(
    target.appendRunRecord({
      ...vendorRun,
      parentRecordId: "missing-job-record",
    }),
    /Run.*parent|selected Job|relational lineage/i,
  );
});

test("Captured Artifact projection rejects a record outside its persisted Job, Case, and Run lineage", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapters: [new MockQwenProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    executionMode: "capture_only",
  });
  const snapshot = source.snapshot();
  const capture = snapshot.capturedArtifactTable[0];
  assert.ok(capture);
  const feishu = new InMemoryFeishuProjection();
  for (const evaluationCase of snapshot.caseTable) {
    await feishu.upsertCase(evaluationCase);
  }
  for (const run of snapshot.runRecordTable) {
    await feishu.appendRunRecord(run);
  }

  await assert.rejects(
    feishu.appendCapturedArtifact({
      ...capture,
      caseId: "unrelated-case",
    }),
    /Job|Case|Run|relational lineage/i,
  );
});

test("comparison rejects Codex Judge scorecards produced by different stable execution identities", async () => {
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
  const hash = (value: string) =>
    `sha256:${value.repeat(64)}` as `sha256:${string}`;
  const lineage = (
    binaryHash: `sha256:${string}`,
  ): NonNullable<
    ArtifactScoreTableRecord["scorecard"]["judgeLineage"]
  > =>
    ({
      provider: "codex_cli",
      adapterVersion: "codex-cli-judge@1",
      requestedModel: "gpt-5.6-sol",
      responseModel: "gpt-5.6-sol",
      responseId: "codex_cli_test",
      promptVersion: "query-six-dimension-judge-prompt-v1",
      promptHash: hash("1"),
      configHash: hash("2"),
      schemaHash: hash("3"),
      contextHash: hash("4"),
      payloadHash: hash("5"),
      egressAuthorizationHash: hash("6"),
      egressAuthorization: {},
      egressAttemptId: "judge-egress-test",
      egressAttempt: {},
      inputHash: hash("7"),
      idempotencyKey: "judge_test",
      rasterizerVersion: "static-render-rasterizer@1",
      rasterizedImagesHash: hash("8"),
      rasterizedImageHashes: [],
      imageDetail: "high",
      store: false,
      executionEvidence: {
        schemaVersion: "codex-cli-judge-execution-v1",
        binaryPath:
          "/Applications/ChatGPT.app/Contents/Resources/codex",
        binaryHash,
        fixedArgumentsHash: hash("a"),
        sandboxBinaryPath: "/usr/bin/sandbox-exec",
        sandboxBinaryHash: hash("b"),
        sandboxProfileHash: hash("c"),
        isolationAttestationHash: hash("d"),
        invocationHash: hash("e"),
        transcriptHash: hash("f"),
        resultHash: hash("0"),
      },
    }) as unknown as NonNullable<
      ArtifactScoreTableRecord["scorecard"]["judgeLineage"]
    >;
  const projection = withComparisonSourceOverride(feishu, (source) => ({
    ...source,
    artifactScores: source.artifactScores.map((record) => ({
      ...record,
      scorecard: {
        ...record.scorecard,
        judgeLineage: lineage(
          record.runId === "MOCK-run-doubao-volcano-v1"
            ? hash("9")
            : hash("1"),
        ),
      },
    })),
  }));

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    }),
    /judge|execution|fingerprint|compatible for direct comparison/i,
  );
});

test("append-only reevaluations require explicit scorecard selection and bind comparison identity to it", async () => {
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
  const qwenReevaluationId =
    "MOCK-scorecard-qwen-volcano-v1-reevaluation";
  const qwen = feishu
    .snapshot()
    .artifactScoreTable.find(
      ({ runId }) => runId === "MOCK-run-qwen-volcano-v1",
    );
  assert.ok(qwen);
  await feishu.appendArtifactScore({
    ...qwen,
    recordId: qwenReevaluationId,
    scorecard: {
      ...qwen.scorecard,
      scorecardId: qwenReevaluationId,
    },
  });

  await assert.rejects(
    createComparisonReportService({
      feishu,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs: [
        {
          leftRunId: "MOCK-run-qwen-volcano-v1",
          rightRunId: "MOCK-run-doubao-volcano-v1",
        },
      ],
    }),
    /multiple.*scorecard|explicit.*scorecard/i,
  );

  const outcome = await createComparisonReportService({
    feishu,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        leftScorecardId: qwenReevaluationId,
        rightRunId: "MOCK-run-doubao-volcano-v1",
        rightScorecardId: "MOCK-scorecard-doubao-volcano-v1",
      },
    ],
  });

  assert.equal(
    outcome.comparisons[0]?.leftScorecardId,
    qwenReevaluationId,
  );
  assert.match(
    outcome.comparisons[0]?.comparisonId ?? "",
    /^comparison-[a-f0-9]{16}$/,
  );
});

test("replaying the same stable Bakeoff IDs is idempotent while conflicting audit or capture payloads are rejected", async () => {
  const feishu = new InMemoryFeishuProjection();
  let adapterExecutions = 0;
  const attemptDeadline: AttemptDeadlinePort = {
    async run(operation) {
      adapterExecutions += 1;
      return {
        timedOut: false,
        value: await operation(new AbortController().signal),
        elapsedMs: 0,
      };
    },
  };
  const adapters: readonly ProductAdapterPort[] = [
    new MockWpsProductAdapter(),
    new MockQwenProductAdapter(),
    new MockDoubaoProductAdapter(),
  ];
  const harness = createBakeoffHarness({
    feishu,
    productAdapters: adapters,
    attemptDeadline,
  });
  const command = {
    environment: "test" as const,
    caseId: VOLCANO_CASE_ID,
  };
  await harness.startBakeoffJob(command);
  const first = feishu.snapshot();

  await harness.startBakeoffJob(command);
  const replayed = feishu.snapshot();

  assert.equal(adapterExecutions, 3);
  assert.equal(replayed.runRecordTable.length, first.runRecordTable.length);
  assert.equal(
    replayed.capturedArtifactTable.length,
    first.capturedArtifactTable.length,
  );
  assert.equal(
    replayed.artifactScoreTable.length,
    first.artifactScoreTable.length,
  );
  assert.equal(
    replayed.productGapCardTable.length,
    first.productGapCardTable.length,
  );
  assert.equal(replayed.reports.length, first.reports.length);

  const attempt = first.runRecordTable.find(
    ({ recordType }) => recordType === "evaluation_attempt",
  );
  assert.ok(attempt);
  await assert.rejects(
    feishu.appendRunRecord({
      ...attempt,
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      elapsedMs: (attempt.elapsedMs ?? 0) + 1,
      vendorGenerationMs: (attempt.vendorGenerationMs ?? 0) + 1,
    }),
    /identity conflict/i,
  );

  assert.ok(attempt.observableEvents?.[0]);
  await assert.rejects(
    feishu.appendRunRecord({
      ...attempt,
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      observableEvents: attempt.observableEvents.map((event, index) =>
        index === 0
          ? {
              ...event,
              observedAt: new Date(
                Date.parse(event.observedAt) + 1,
              ).toISOString(),
            }
          : event,
      ),
    }),
    /identity conflict/i,
  );

  const capture = first.capturedArtifactTable[0];
  assert.ok(capture);
  await assert.rejects(
    feishu.appendCapturedArtifact({
      ...capture,
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      artifact: {
        ...capture.artifact,
        environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
        filename: "conflicting-replay.pptx",
      },
      renderManifest: {
        ...capture.renderManifest,
        environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      },
    }),
    /identity conflict/i,
  );
});

test("Artifact Score projection rejects a second row for the same logical Scorecard ID", async () => {
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockQwenProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const score = feishu.snapshot().artifactScoreTable[0];
  assert.ok(score);

  await assert.rejects(
    feishu.appendArtifactScore({
      ...score,
      recordId: `${score.recordId}:duplicate`,
    }),
    /recordId|Scorecard ID|identity conflict/i,
  );
  assert.equal(feishu.snapshot().artifactScoreTable.length, 1);
});

test("Artifact Score readback fails closed when recovery contains duplicate logical Scorecard IDs", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapters: [new MockQwenProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const score = snapshot.artifactScoreTable[0];
  assert.ok(score);
  const readback = source.forkForStaging({
    ...snapshot,
    artifactScoreTable: [
      score,
      {
        ...score,
        recordId: `${score.recordId}:duplicate`,
      },
    ],
  });

  await assert.rejects(
    readback.loadArtifactScoreByScorecardId(
      score.scorecard.scorecardId,
    ),
    /duplicate|multiple|identity/i,
  );
  await assert.rejects(
    readback.loadComparisonReportSource(score.jobId),
    /duplicate|multiple|identity|recordId/i,
  );
});

test("concurrent starts for one stable Bakeoff Job share one vendor execution", async () => {
  const feishu = new InMemoryFeishuProjection();
  let adapterExecutions = 0;
  const attemptDeadline: AttemptDeadlinePort = {
    async run(operation) {
      adapterExecutions += 1;
      return {
        timedOut: false,
        value: await operation(new AbortController().signal),
        elapsedMs: 0,
      };
    },
  };
  const adapters: readonly ProductAdapterPort[] = [
    new MockWpsProductAdapter(),
    new MockQwenProductAdapter(),
    new MockDoubaoProductAdapter(),
  ];
  const firstHarness = createBakeoffHarness({
    feishu,
    productAdapters: adapters,
    attemptDeadline,
  });
  const secondHarness = createBakeoffHarness({
    feishu,
    productAdapters: adapters,
    attemptDeadline,
  });
  const command = {
    environment: "test" as const,
    caseId: VOLCANO_CASE_ID,
  };

  const [first, second] = await Promise.all([
    firstHarness.startBakeoffJob(command),
    secondHarness.startBakeoffJob(command),
  ]);

  assert.equal(adapterExecutions, 3);
  assert.equal(first.job.jobId, second.job.jobId);
  assert.equal(first.report.reportId, second.report.reportId);
  assert.equal(feishu.snapshot().runRecordTable.length, 7);
});

test("concurrent starts reject a conflicting selected Product Package set", async () => {
  const feishu = new InMemoryFeishuProjection();
  const fullHarness = createBakeoffHarness({
    feishu,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  });
  const wpsOnlyHarness = createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
  });
  const command = {
    environment: "test" as const,
    caseId: VOLCANO_CASE_ID,
  };

  const [full, conflict] = await Promise.allSettled([
    fullHarness.startBakeoffJob(command),
    wpsOnlyHarness.startBakeoffJob(command),
  ]);

  assert.equal(full.status, "fulfilled");
  assert.equal(conflict.status, "rejected");
  if (conflict.status === "rejected") {
    assert.match(String(conflict.reason), /identity conflict/i);
  }
  assert.equal(feishu.snapshot().runRecordTable.length, 7);
});

test("an in-flight Bakeoff uses one frozen normalized command snapshot", async () => {
  const feishu = new InMemoryFeishuProjection();
  const adapters: readonly ProductAdapterPort[] = [
    new MockWpsProductAdapter(),
    new MockQwenProductAdapter(),
    new MockDoubaoProductAdapter(),
  ];
  const harness = createBakeoffHarness({
    feishu,
    productAdapters: adapters,
  });
  const mutableCommand: {
    environment: "test";
    caseId: typeof VOLCANO_CASE_ID;
    referencePackMode: "automatic" | "off";
  } = {
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    referencePackMode: "automatic",
  };

  const firstStart = harness.startBakeoffJob(mutableCommand);
  mutableCommand.referencePackMode = "off";
  const secondStart = harness.startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    referencePackMode: "automatic",
  });
  const [first, second] = await Promise.all([firstStart, secondStart]);

  assert.equal(first.report.reportId, second.report.reportId);
  for (const scorecard of first.scorecards) {
    const factual = scorecard.dimensions.find(
      ({ dimension }) =>
        dimension === "factual_accuracy_and_content_quality",
    );
    assert.equal(factual?.assessmentStatus, "ASSESSED");
    assert.notEqual(
      scorecard.evaluationInputManifest.referencePackHash,
      null,
    );
  }
});

test("a settled Bakeoff rejects a mismatched Reference Pack mode", async () => {
  const feishu = new InMemoryFeishuProjection();
  const adapters: readonly ProductAdapterPort[] = [
    new MockWpsProductAdapter(),
    new MockQwenProductAdapter(),
    new MockDoubaoProductAdapter(),
  ];
  await createBakeoffHarness({
    feishu,
    productAdapters: adapters,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    referencePackMode: "off",
  });
  let generatorCalls = 0;
  const noPackGenerator: ReferencePackGeneratorPort = {
    generate() {
      generatorCalls += 1;
      return null;
    },
  };

  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: adapters,
      referencePackGenerator: noPackGenerator,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
      referencePackMode: "force",
    }),
    /identity conflict|protocol.*mismatch/i,
  );
  assert.equal(generatorCalls, 0);
});

test("compatibility fingerprint equality is independent of object key insertion order", async () => {
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
  const projection = withComparisonSourceOverride(feishu, (source) => ({
    ...source,
    artifactScores: source.artifactScores.map((record) =>
      record.runId !== "MOCK-run-doubao-volcano-v1"
        ? record
        : {
            ...record,
            comparisonCompatibilityFingerprint: Object.fromEntries(
              Object.entries(
                record.comparisonCompatibilityFingerprint,
              ).reverse(),
            ) as ArtifactScoreTableRecord["comparisonCompatibilityFingerprint"],
          },
    ),
  }));

  const outcome = await createComparisonReportService({
    feishu: projection,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-doubao-volcano-v1",
      },
    ],
  });

  assert.equal(outcome.comparisons.length, 1);
});
