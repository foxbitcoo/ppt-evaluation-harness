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
  createProductGapCardWorkflowService,
  createScoreAdjudicationService,
  type AdjudicationEventRecord,
  type FeishuProjectionPort,
  type GitHubIssueCreateCommand,
  type GitHubIssuePort,
  type ReviewEventRecord,
} from "../src/index.ts";

function withAdjudicationEvents(
  feishu: InMemoryFeishuProjection,
  transform: (
    events: readonly AdjudicationEventRecord[],
  ) => readonly AdjudicationEventRecord[],
): FeishuProjectionPort {
  return new Proxy(feishu, {
    get(target, property, receiver) {
      if (property === "listAdjudicationEvents") {
        return async (scorecardId: string) =>
          transform(
            await target.listAdjudicationEvents(scorecardId),
          );
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? value.bind(target)
        : value;
    },
  });
}

function withReviewEvents(
  feishu: InMemoryFeishuProjection,
  transform: (
    events: readonly ReviewEventRecord[],
  ) => readonly ReviewEventRecord[],
): FeishuProjectionPort {
  return new Proxy(feishu, {
    get(target, property, receiver) {
      if (property === "listReviewEvents") {
        return async (scorecardId: string) =>
          transform(
            await target.listReviewEvents(scorecardId),
          );
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? value.bind(target)
        : value;
    },
  });
}

async function createScoredWpsProjection(): Promise<{
  readonly feishu: InMemoryFeishuProjection;
  readonly scorecardId: string;
  readonly jobId: string;
}> {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const scorecardId = outcome.scorecard?.scorecardId;
  assert.ok(scorecardId);
  return { feishu, scorecardId, jobId: outcome.job.jobId };
}

test("effective Scorecard readback fails closed on duplicate logical Scorecard identities", async () => {
  const { feishu, scorecardId } =
    await createScoredWpsProjection();
  const snapshot = feishu.snapshot();
  const score = snapshot.artifactScoreTable[0];
  assert.ok(score);
  const readback = feishu.forkForStaging({
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
    createScoreAdjudicationService({
      feishu: readback,
    }).getEffectiveScorecard(scorecardId),
    /duplicate|multiple|identity/i,
  );
});

test("effective Scorecard readback fails closed when its Artifact payload diverges from the Captured Artifact", async () => {
  const { feishu, scorecardId } =
    await createScoredWpsProjection();
  const snapshot = feishu.snapshot();
  const readback = feishu.forkForStaging({
    ...snapshot,
    artifactScoreTable: snapshot.artifactScoreTable.map(
      (score) => ({
        ...score,
        artifact: {
          ...score.artifact,
          filename: "effective-score-cross-table-conflict.pptx",
        },
      }),
    ),
  });

  await assert.rejects(
    createScoreAdjudicationService({
      feishu: readback,
    }).getEffectiveScorecard(scorecardId),
    /Captured Artifact|cross-table|lineage/i,
  );
});

test("adjudication append and readback reject invalid human-final fields", async (t) => {
  const { feishu, scorecardId } =
    await createScoredWpsProjection();
  const score = feishu.snapshot().artifactScoreTable[0];
  const modelOriginal = score?.scorecard.dimensions.find(
    ({ dimension }) =>
      dimension === "narrative_and_audience_fit",
  );
  assert.ok(score);
  assert.ok(modelOriginal);
  assert.equal(modelOriginal.assessmentStatus, "ASSESSED");
  assert.notEqual(modelOriginal.value, null);
  const validEvent: AdjudicationEventRecord = {
    recordType: "adjudication_event",
    schemaVersion: "adjudication-event-v1",
    adjudicationEventId: "adj-runtime-validation",
    scorecardId,
    artifactId: score.artifactId,
    runId: score.runId,
    jobId: score.jobId,
    dimension: modelOriginal.dimension,
    modelOriginalAssessmentStatus: modelOriginal.assessmentStatus,
    modelOriginalScore: modelOriginal.value,
    humanFinalAssessmentStatus: "ASSESSED",
    humanFinalScore: 4,
    evidencePages: modelOriginal.evidencePages,
    actorId: "pm-runtime-reviewer",
    occurredAt: "2026-07-31T00:00:00.000Z",
    createdAt: "2026-07-31T00:00:00.000Z",
    lastSyncedAt: "2026-07-31T00:00:00.000Z",
    reason: "Runtime validation fixture.",
    priorAdjudicationEventId: null,
    provenance: score.provenance,
    environmentOrigin: score.environmentOrigin,
  };
  const invalidEvents = [
    {
      label: "invalid record type",
      event: { ...validEvent, recordType: "review_event" },
    },
    {
      label: "invalid schema",
      event: {
        ...validEvent,
        schemaVersion: "adjudication-event-v0",
      },
    },
    {
      label: "blank event ID",
      event: { ...validEvent, adjudicationEventId: " " },
    },
    {
      label: "out-of-range human score",
      event: { ...validEvent, humanFinalScore: 99 },
    },
    {
      label: "contradictory assessment status",
      event: {
        ...validEvent,
        humanFinalAssessmentStatus: "NOT_ASSESSABLE",
      },
    },
    {
      label: "blank actor",
      event: { ...validEvent, actorId: " " },
    },
    {
      label: "blank reason",
      event: { ...validEvent, reason: "" },
    },
    {
      label: "invalid occurrence timestamp",
      event: { ...validEvent, occurredAt: "not-a-date" },
    },
    {
      label: "invalid creation timestamp",
      event: { ...validEvent, createdAt: "not-a-date" },
    },
    {
      label: "invalid sync timestamp",
      event: { ...validEvent, lastSyncedAt: "not-a-date" },
    },
    {
      label: "creation precedes occurrence",
      event: {
        ...validEvent,
        createdAt: "2026-07-30T23:59:59.000Z",
      },
    },
    {
      label: "sync precedes creation",
      event: {
        ...validEvent,
        lastSyncedAt: "2026-07-30T23:59:59.000Z",
      },
    },
  ] as const;

  for (const { label, event } of invalidEvents) {
    await t.test(label, async () => {
      await assert.rejects(
        feishu.appendAdjudicationEvent(
          event as unknown as AdjudicationEventRecord,
        ),
        /Adjudication Event.*(?:invalid|schema|ID|score|actor|reason|timestamp)/i,
      );
      await assert.rejects(
        createScoreAdjudicationService({
          feishu: withAdjudicationEvents(
            feishu,
            () => [
              event as unknown as AdjudicationEventRecord,
            ],
          ),
        }).getEffectiveScorecard(scorecardId),
        /Adjudication Event.*(?:invalid|schema|ID|score|actor|reason|timestamp)/i,
      );
    });
  }
  assert.deepEqual(feishu.snapshot().adjudicationEventTable, []);
});

test("adjudication append rejects a causal child that predates its parent", async () => {
  const { feishu, scorecardId } = await createScoredWpsProjection();
  const service = createScoreAdjudicationService({ feishu });
  const score = feishu.snapshot().artifactScoreTable[0];
  const dimension = score?.scorecard.dimensions.find(
    ({ assessmentStatus }) => assessmentStatus === "ASSESSED",
  );
  assert.ok(dimension);
  const parent = await service.adjudicateDimension({
    adjudicationEventId: "adj-causal-parent",
    scorecardId,
    dimension: dimension.dimension,
    humanFinalScore: 4,
    actorId: "pm-causal-reviewer",
    occurredAt: "2026-08-02T10:00:00.000Z",
    reason: "Causal parent fixture.",
    priorAdjudicationEventId: null,
  });

  await assert.rejects(
    service.adjudicateDimension({
      adjudicationEventId: "adj-causal-child",
      scorecardId,
      dimension: dimension.dimension,
      humanFinalScore: 1,
      actorId: "pm-causal-reviewer",
      occurredAt: "2026-08-02T09:59:59.000Z",
      reason: "This child predates its causal parent.",
      priorAdjudicationEventId: parent.adjudicationEventId,
    }),
    /Adjudication Event.*(?:precedes|causal parent)/i,
  );
  assert.deepEqual(
    feishu.snapshot().adjudicationEventTable.map(
      ({ adjudicationEventId }) => adjudicationEventId,
    ),
    [parent.adjudicationEventId],
  );
});

test("effective Scorecard readback rejects an adjudication child that predates its parent", async () => {
  const { feishu, scorecardId } = await createScoredWpsProjection();
  const service = createScoreAdjudicationService({ feishu });
  const score = feishu.snapshot().artifactScoreTable[0];
  const dimension = score?.scorecard.dimensions.find(
    ({ assessmentStatus }) => assessmentStatus === "ASSESSED",
  );
  assert.ok(dimension);
  const parent = await service.adjudicateDimension({
    adjudicationEventId: "adj-readback-causal-parent",
    scorecardId,
    dimension: dimension.dimension,
    humanFinalScore: 4,
    actorId: "pm-causal-reviewer",
    occurredAt: "2026-08-02T10:00:00.000Z",
    reason: "Causal parent fixture.",
    priorAdjudicationEventId: null,
  });
  const child: AdjudicationEventRecord = {
    ...parent,
    adjudicationEventId: "adj-readback-causal-child",
    humanFinalScore: 1,
    occurredAt: "2026-08-02T09:59:59.000Z",
    createdAt: "2026-08-02T09:59:59.000Z",
    lastSyncedAt: "2026-08-02T09:59:59.000Z",
    reason: "This persisted child predates its causal parent.",
    priorAdjudicationEventId: parent.adjudicationEventId,
  };

  await assert.rejects(
    createScoreAdjudicationService({
      feishu: withAdjudicationEvents(feishu, () => [parent, child]),
    }).getEffectiveScorecard(scorecardId),
    /adjudication causal history.*child precedes parent/i,
  );
});

test("review append and readback accept only causal human acceptance events", async (t) => {
  const { feishu, scorecardId } = await createScoredWpsProjection();
  const score = feishu.snapshot().artifactScoreTable[0];
  const modelOriginal = score?.scorecard.dimensions[0];
  assert.ok(score);
  assert.ok(modelOriginal);
  const validReview: ReviewEventRecord = {
    recordType: "review_event",
    schemaVersion: "review-event-v1",
    reviewEventId: "review-runtime-validation",
    scorecardId,
    artifactId: score.artifactId,
    runId: score.runId,
    jobId: score.jobId,
    reviewedDimensions: [modelOriginal.dimension],
    decision: "accepted_model_scores",
    actorId: "pm-runtime-reviewer",
    occurredAt: "2026-08-02T00:00:00.000Z",
    createdAt: "2026-08-02T00:00:00.000Z",
    lastSyncedAt: "2026-08-02T00:00:00.000Z",
    reason: "Runtime review validation fixture.",
    priorReviewEventId: null,
    provenance: score.provenance,
    environmentOrigin: score.environmentOrigin,
  };
  const invalidReviews = [
    {
      label: "rejected decision",
      event: {
        ...validReview,
        decision: "rejected_model_scores",
      },
    },
    {
      label: "blank actor",
      event: { ...validReview, actorId: " " },
    },
    {
      label: "blank reason",
      event: { ...validReview, reason: "" },
    },
    {
      label: "invalid timestamp",
      event: { ...validReview, occurredAt: "not-a-date" },
    },
    {
      label: "impossible calendar timestamp",
      event: {
        ...validReview,
        occurredAt: "2026-02-30T00:00:00.000Z",
      },
    },
    {
      label: "unknown reviewed dimension",
      event: {
        ...validReview,
        reviewedDimensions: ["invented_dimension"],
      },
    },
    {
      label: "non-causal sync timestamp",
      event: {
        ...validReview,
        lastSyncedAt: "2026-07-31T23:59:59.000Z",
      },
    },
    {
      label: "invalid schema",
      event: { ...validReview, schemaVersion: "review-event-v0" },
    },
  ] as const;

  for (const { label, event } of invalidReviews) {
    await t.test(label, async () => {
      const invalid = event as unknown as ReviewEventRecord;
      await assert.rejects(
        feishu.appendReviewEvent(invalid),
        /Review Event.*(?:schema|decision|actor|reason|timestamp|dimension)/i,
      );
      await assert.rejects(
        createScoreAdjudicationService({
          feishu: withReviewEvents(feishu, () => [invalid]),
        }).getEffectiveScorecard(scorecardId),
        /Review Event.*(?:schema|decision|actor|reason|timestamp|dimension)/i,
      );
    });
  }
  assert.deepEqual(feishu.snapshot().reviewEventTable, []);
});

test("effective Scorecard readback rejects foreign adjudication and review lineage", async (t) => {
  const { feishu, scorecardId } =
    await createScoredWpsProjection();
  const service = createScoreAdjudicationService({ feishu });
  const score = feishu.snapshot().artifactScoreTable[0];
  const dimension = score?.scorecard.dimensions.find(
    ({ assessmentStatus }) => assessmentStatus === "ASSESSED",
  );
  assert.ok(score);
  assert.ok(dimension);
  assert.notEqual(dimension.value, null);
  const adjudication = await service.adjudicateDimension({
    adjudicationEventId: "adj-readback-lineage",
    scorecardId,
    dimension: dimension.dimension,
    humanFinalScore: dimension.value === 1 ? 2 : 1,
    actorId: "pm-lineage-reviewer",
    occurredAt: "2026-07-31T00:00:00.000Z",
    reason: "Readback lineage fixture.",
    priorAdjudicationEventId: null,
  });
  const review = await service.recordReview({
    reviewEventId: "review-readback-lineage",
    scorecardId,
    reviewedDimensions: [dimension.dimension],
    actorId: "pm-lineage-reviewer",
    occurredAt: "2026-07-31T00:01:00.000Z",
    reason: "Readback lineage fixture.",
    priorReviewEventId: null,
  });
  const foreignOrigin = {
    originId: "test:foreign-readback",
    environment: "test",
  } as unknown as typeof score.environmentOrigin;
  const adjudicationDrifts = [
    {
      label: "foreign Scorecard",
      event: { ...adjudication, scorecardId: "foreign-scorecard" },
    },
    {
      label: "foreign Artifact",
      event: { ...adjudication, artifactId: "foreign-artifact" },
    },
    {
      label: "foreign Run",
      event: { ...adjudication, runId: "foreign-run" },
    },
    {
      label: "foreign Job",
      event: { ...adjudication, jobId: "foreign-job" },
    },
    {
      label: "foreign provenance",
      event: { ...adjudication, provenance: "PRODUCTION" as const },
    },
    {
      label: "foreign environment",
      event: { ...adjudication, environmentOrigin: foreignOrigin },
    },
  ] as const;
  for (const { label, event } of adjudicationDrifts) {
    await t.test(`adjudication ${label}`, async () => {
      await assert.rejects(
        createScoreAdjudicationService({
          feishu: withAdjudicationEvents(
            feishu,
            () => [event],
          ),
        }).getEffectiveScorecard(scorecardId),
        /adjudication.*lineage|score.*lineage/i,
      );
    });
  }
  const reviewDrifts = [
    {
      label: "foreign Scorecard",
      event: { ...review, scorecardId: "foreign-scorecard" },
    },
    {
      label: "foreign Artifact",
      event: { ...review, artifactId: "foreign-artifact" },
    },
    {
      label: "foreign Run",
      event: { ...review, runId: "foreign-run" },
    },
    {
      label: "foreign Job",
      event: { ...review, jobId: "foreign-job" },
    },
    {
      label: "foreign provenance",
      event: { ...review, provenance: "PRODUCTION" as const },
    },
    {
      label: "foreign environment",
      event: { ...review, environmentOrigin: foreignOrigin },
    },
  ] as const;
  for (const { label, event } of reviewDrifts) {
    await t.test(`review ${label}`, async () => {
      await assert.rejects(
        createScoreAdjudicationService({
          feishu: withReviewEvents(
            feishu,
            () => [event],
          ),
        }).getEffectiveScorecard(scorecardId),
        /review.*lineage|score.*lineage/i,
      );
    });
  }
});

test("a PM adjudication is append-only and exposes the latest human score without overwriting the model score", async () => {
  const { feishu, scorecardId } = await createScoredWpsProjection();
  const service = createScoreAdjudicationService({ feishu });

  const before = await service.getEffectiveScorecard(scorecardId);
  const original = before.dimensions.find(
    ({ dimension }) => dimension === "narrative_and_audience_fit",
  );
  assert.deepEqual(
    {
      modelOriginalValue: original?.modelOriginalValue,
      effectiveValue: original?.effectiveValue,
      reviewState: original?.reviewState,
    },
    {
      modelOriginalValue: 4,
      effectiveValue: 4,
      reviewState: "model_not_reviewed",
    },
  );

  const first = await service.adjudicateDimension({
    adjudicationEventId: "adj-wps-narrative-001",
    scorecardId,
    dimension: "narrative_and_audience_fit",
    humanFinalScore: 2,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:00:00.000Z",
    reason: "第 9 页到第 16 页的转场不足，模型高估了叙事连贯性。",
    priorAdjudicationEventId: null,
  });
  const second = await service.adjudicateDimension({
    adjudicationEventId: "adj-wps-narrative-002",
    scorecardId,
    dimension: "narrative_and_audience_fit",
    humanFinalScore: 3,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:05:00.000Z",
    reason: "复看页级证据后，最终按 3 分记录。",
    priorAdjudicationEventId: first.adjudicationEventId,
  });
  await service.adjudicateDimension({
    adjudicationEventId: "adj-wps-narrative-002",
    scorecardId,
    dimension: "narrative_and_audience_fit",
    humanFinalScore: 3,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:05:00.000Z",
    reason: "复看页级证据后，最终按 3 分记录。",
    priorAdjudicationEventId: first.adjudicationEventId,
  });
  await assert.rejects(
    service.adjudicateDimension({
      adjudicationEventId: "adj-wps-narrative-stale",
      scorecardId,
      dimension: "narrative_and_audience_fit",
      humanFinalScore: 1,
      actorId: "pm-other",
      occurredAt: "2026-07-27T05:06:00.000Z",
      reason: "基于过期分支提交的冲突决定。",
      priorAdjudicationEventId: first.adjudicationEventId,
    }),
    /prior reference conflict/i,
  );

  const effective = await service.getEffectiveScorecard(scorecardId);
  const narrative = effective.dimensions.find(
    ({ dimension }) => dimension === "narrative_and_audience_fit",
  );
  assert.deepEqual(
    {
      modelOriginalValue: narrative?.modelOriginalValue,
      effectiveValue: narrative?.effectiveValue,
      reviewState: narrative?.reviewState,
      source: narrative?.source,
      adjudicationEventId: narrative?.adjudicationEventId,
    },
    {
      modelOriginalValue: 4,
      effectiveValue: 3,
      reviewState: "human_reviewed",
      source: "human_adjudication",
      adjudicationEventId: second.adjudicationEventId,
    },
  );
  assert.deepEqual(
    feishu.snapshot().adjudicationEventTable.map((event) => ({
      adjudicationEventId: event.adjudicationEventId,
      modelOriginalScore: event.modelOriginalScore,
      humanFinalScore: event.humanFinalScore,
      actorId: event.actorId,
      occurredAt: event.occurredAt,
      reason: event.reason,
      priorAdjudicationEventId: event.priorAdjudicationEventId,
    })),
    [
      {
        adjudicationEventId: "adj-wps-narrative-001",
        modelOriginalScore: 4,
        humanFinalScore: 2,
        actorId: "pm-chen",
        occurredAt: "2026-07-27T05:00:00.000Z",
        reason: "第 9 页到第 16 页的转场不足，模型高估了叙事连贯性。",
        priorAdjudicationEventId: null,
      },
      {
        adjudicationEventId: "adj-wps-narrative-002",
        modelOriginalScore: 4,
        humanFinalScore: 3,
        actorId: "pm-chen",
        occurredAt: "2026-07-27T05:05:00.000Z",
        reason: "复看页级证据后，最终按 3 分记录。",
        priorAdjudicationEventId: "adj-wps-narrative-001",
      },
    ],
  );
  assert.equal(
    feishu
      .snapshot()
      .artifactScoreTable[0]?.scorecard.dimensions.find(
        ({ dimension }) => dimension === "narrative_and_audience_fit",
      )?.value,
    4,
  );
});

test("effective scores resolve the unique causal adjudication head independent of Feishu row order and reject broken histories", async () => {
  const { feishu, scorecardId } = await createScoredWpsProjection();
  const service = createScoreAdjudicationService({ feishu });
  const first = await service.adjudicateDimension({
    adjudicationEventId: "adj-causal-001",
    scorecardId,
    dimension: "narrative_and_audience_fit",
    humanFinalScore: 2,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:00:00.000Z",
    reason: "首次复核。",
    priorAdjudicationEventId: null,
  });
  const second = await service.adjudicateDimension({
    adjudicationEventId: "adj-causal-002",
    scorecardId,
    dimension: "narrative_and_audience_fit",
    humanFinalScore: 3,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:05:00.000Z",
    reason: "基于首次复核的最终决定。",
    priorAdjudicationEventId: first.adjudicationEventId,
  });
  const stored = await feishu.listAdjudicationEvents(scorecardId);

  const shuffled = await createScoreAdjudicationService({
    feishu: withAdjudicationEvents(feishu, (events) =>
      [...events].reverse(),
    ),
  }).getEffectiveScorecard(scorecardId);
  assert.equal(
    shuffled.dimensions.find(
      ({ dimension }) => dimension === "narrative_and_audience_fit",
    )?.effectiveValue,
    3,
  );

  const histories: readonly {
    readonly label: string;
    readonly events: readonly AdjudicationEventRecord[];
  }[] = [
    {
      label: "missing parent",
      events: [
        {
          ...second,
          priorAdjudicationEventId: "adj-causal-missing",
        },
      ],
    },
    {
      label: "fork",
      events: [
        ...stored,
        {
          ...second,
          adjudicationEventId: "adj-causal-fork",
          humanFinalScore: 1,
          priorAdjudicationEventId: first.adjudicationEventId,
        },
      ],
    },
    {
      label: "cycle",
      events: [
        {
          ...first,
          priorAdjudicationEventId: second.adjudicationEventId,
        },
        second,
      ],
    },
  ];
  for (const history of histories) {
    await assert.rejects(
      createScoreAdjudicationService({
        feishu: withAdjudicationEvents(
          feishu,
          () => history.events,
        ),
      }).getEffectiveScorecard(scorecardId),
      /invalid adjudication causal history/i,
      history.label,
    );
  }
});

test("a no-change ReviewEvent makes human review visible while keeping the model value effective", async () => {
  const { feishu, scorecardId } = await createScoredWpsProjection();
  const service = createScoreAdjudicationService({ feishu });

  await service.recordReview({
    reviewEventId: "review-wps-layout-001",
    scorecardId,
    reviewedDimensions: ["layout_hierarchy_and_readability"],
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:10:00.000Z",
    reason: "页级证据与 4 分锚点一致，无需调整。",
    priorReviewEventId: null,
  });

  const effective = await service.getEffectiveScorecard(scorecardId);
  const layout = effective.dimensions.find(
    ({ dimension }) => dimension === "layout_hierarchy_and_readability",
  );
  assert.deepEqual(
    {
      modelOriginalValue: layout?.modelOriginalValue,
      effectiveValue: layout?.effectiveValue,
      reviewState: layout?.reviewState,
      source: layout?.source,
      scorecardReviewState: effective.reviewState,
    },
    {
      modelOriginalValue: 4,
      effectiveValue: 4,
      reviewState: "human_reviewed",
      source: "model_original",
      scorecardReviewState: "partially_human_reviewed",
    },
  );
  assert.deepEqual(feishu.snapshot().reviewEventTable, [
    {
      recordType: "review_event",
      schemaVersion: "review-event-v1",
      reviewEventId: "review-wps-layout-001",
      scorecardId,
      artifactId: "MOCK-artifact-wps-volcano-v1",
      runId: "MOCK-run-wps-volcano-v1",
      jobId: "MOCK-job-volcano-v1",
      reviewedDimensions: ["layout_hierarchy_and_readability"],
      decision: "accepted_model_scores",
      actorId: "pm-chen",
      occurredAt: "2026-07-27T05:10:00.000Z",
      createdAt: "2026-07-27T05:10:00.000Z",
      lastSyncedAt: "2026-07-27T05:10:00.000Z",
      reason: "页级证据与 4 分锚点一致，无需调整。",
      priorReviewEventId: null,
      provenance: "MOCK",
      environmentOrigin: {
        originId: "test:mock-bakeoff-v1",
        environment: "test",
      },
    },
  ]);
});

test("human adjudication preserves NOT_ASSESSABLE until a new scorecard freezes the reviewed Reference Pack", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    referencePackMode: "off",
  });
  const scorecardId = outcome.scorecard?.scorecardId;
  assert.ok(scorecardId);
  const service = createScoreAdjudicationService({ feishu });
  const command = {
    adjudicationEventId: "adj-wps-factual-001",
    scorecardId,
    dimension: "factual_accuracy_and_content_quality" as const,
    humanFinalScore: 4 as const,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:20:00.000Z",
    reason: "补充已复核参考包后，事实维度可以按 4 分记录。",
    priorAdjudicationEventId: null,
  };

  await assert.rejects(
    service.adjudicateDimension(command),
    /cannot invent assessability.*new scorecard.*reference pack/i,
  );
  assert.deepEqual(feishu.snapshot().adjudicationEventTable, []);
  const storedScore = feishu.snapshot().artifactScoreTable[0];
  assert.ok(storedScore);
  const legacyEvent: AdjudicationEventRecord = {
    recordType: "adjudication_event",
    schemaVersion: "adjudication-event-v1",
    adjudicationEventId: "legacy-factual-adjudication",
    scorecardId,
    artifactId: storedScore.artifactId,
    runId: storedScore.runId,
    jobId: storedScore.jobId,
    dimension: "factual_accuracy_and_content_quality",
    modelOriginalAssessmentStatus: "NOT_ASSESSABLE",
    modelOriginalScore: null,
    humanFinalAssessmentStatus: "ASSESSED",
    humanFinalScore: 4,
    evidencePages: [3, 5, 9],
    actorId: "legacy-pm",
    occurredAt: "2026-07-27T05:19:00.000Z",
    createdAt: "2026-07-27T05:19:00.000Z",
    lastSyncedAt: "2026-07-27T05:19:00.000Z",
    reason: "旧实现遗留的非法可评估化记录。",
    priorAdjudicationEventId: null,
    provenance: storedScore.provenance,
    environmentOrigin: storedScore.environmentOrigin,
  };
  await assert.rejects(
    createScoreAdjudicationService({
      feishu: withAdjudicationEvents(
        feishu,
        () => [legacyEvent],
      ),
    }).getEffectiveScorecard(scorecardId),
    /invalid adjudication.*NOT_ASSESSABLE/i,
  );

  const effective = await service.getEffectiveScorecard(scorecardId);
  const factual = effective.dimensions.find(
    ({ dimension }) =>
      dimension === "factual_accuracy_and_content_quality",
  );
  assert.deepEqual(
    {
      modelOriginalAssessmentStatus:
        factual?.modelOriginalAssessmentStatus,
      modelOriginalValue: factual?.modelOriginalValue,
      effectiveAssessmentStatus: factual?.effectiveAssessmentStatus,
      effectiveValue: factual?.effectiveValue,
      evidencePages: factual?.evidencePages,
      reviewState: factual?.reviewState,
    },
    {
      modelOriginalAssessmentStatus: "NOT_ASSESSABLE",
      modelOriginalValue: null,
      effectiveAssessmentStatus: "NOT_ASSESSABLE",
      effectiveValue: null,
      evidencePages: [],
      reviewState: "model_not_reviewed",
    },
  );
  assert.deepEqual(feishu.snapshot().adjudicationEventTable, []);
});

test("dynamic comparisons and reports use the latest valid human score and expose review state without requiring every score to be reviewed", async () => {
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
  const service = createScoreAdjudicationService({ feishu });
  await service.adjudicateDimension({
    adjudicationEventId: "adj-qwen-narrative-001",
    scorecardId: "MOCK-scorecard-qwen-volcano-v1",
    dimension: "narrative_and_audience_fit",
    humanFinalScore: 5,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T05:30:00.000Z",
    reason: "页级复核确认其叙事衔接达到 5 分锚点。",
    priorAdjudicationEventId: null,
  });

  const outcome = await createComparisonReportService({
    feishu,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-wps-volcano-v1",
        rightRunId: "MOCK-run-qwen-volcano-v1",
      },
    ],
  });
  const narrative = outcome.comparisons[0]?.dimensions.find(
    ({ dimension }) => dimension === "narrative_and_audience_fit",
  );

  assert.deepEqual(
    {
      leftValue: narrative?.leftValue,
      rightValue: narrative?.rightValue,
      difference: narrative?.difference,
      leftReviewState: narrative?.leftReviewState,
      rightReviewState: narrative?.rightReviewState,
      rightAdjudicationEventId:
        narrative?.rightAdjudicationEventId,
    },
    {
      leftValue: 4,
      rightValue: 5,
      difference: -1,
      leftReviewState: "model_not_reviewed",
      rightReviewState: "human_reviewed",
      rightAdjudicationEventId: "adj-qwen-narrative-001",
    },
  );
  assert.match(outcome.report.markdown, /4（模型未复核）/);
  assert.match(outcome.report.markdown, /5（人工已复核）/);
  assert.doesNotMatch(
    outcome.report.markdown,
    /盲评|blind review/i,
    "the frozen MVP protocol is explicitly non-blind",
  );
  assert.equal(
    feishu.snapshot().reviewEventTable.length,
    0,
    "report generation must not require per-item human confirmation",
  );
});

test("only confirmed Product Gap Cards create one traceable GitHub Issue while pending and rejected cards never call GitHub", async () => {
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
  const gapCardIds = feishu
    .snapshot()
    .productGapCardTable.filter(
      (record) => record.recordType === "gap_card",
    )
    .map(({ gapCardId }) => gapCardId);
  assert.equal(gapCardIds.length, 3);
  const [pendingId, rejectedId, confirmedId] = gapCardIds;
  assert.ok(pendingId && rejectedId && confirmedId);

  const githubCalls: GitHubIssueCreateCommand[] = [];
  const issuesByKey = new Map<
    string,
    { readonly issueNumber: number; readonly issueUrl: string }
  >();
  let createdIssues = 0;
  const githubIssues: GitHubIssuePort = {
    async createOrGetIssue(command) {
      githubCalls.push(command);
      const existing = issuesByKey.get(command.idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      createdIssues += 1;
      const created = {
        issueNumber: 41 + createdIssues,
        issueUrl: `https://github.example/ppt-evaluation/issues/${
          41 + createdIssues
        }`,
      };
      issuesByKey.set(command.idempotencyKey, created);
      return created;
    },
  };
  const workflow = createProductGapCardWorkflowService({
    feishu,
    githubIssues,
  });

  assert.equal(
    (await workflow.getGapCard(pendingId)).workflowState,
    "pending_review",
  );
  await assert.rejects(
    workflow.createLinkedIssue({
      gapCardId: pendingId,
      actorId: "pm-chen",
      occurredAt: "2026-07-27T06:00:00.000Z",
    }),
    /must be confirmed_for_delivery/i,
  );
  assert.equal(githubCalls.length, 0);
  await workflow.recordDecision({
    workflowEventId: "gap-decision-rejected-001",
    gapCardId: rejectedId,
    decision: "rejected",
    actorId: "pm-chen",
    occurredAt: "2026-07-27T06:01:00.000Z",
    reason: "当前证据只出现一次，不进入产品任务。",
    priorWorkflowEventId: null,
  });
  await assert.rejects(
    workflow.createLinkedIssue({
      gapCardId: rejectedId,
      actorId: "pm-chen",
      occurredAt: "2026-07-27T06:02:00.000Z",
    }),
    /must be confirmed_for_delivery/i,
  );
  assert.equal(githubCalls.length, 0);
  const confirmation = await workflow.recordDecision({
    workflowEventId: "gap-decision-confirmed-001",
    gapCardId: confirmedId,
    decision: "confirmed_for_delivery",
    actorId: "pm-chen",
    occurredAt: "2026-07-27T06:03:00.000Z",
    reason: "证据明确，进入产品任务池继续拆解。",
    priorWorkflowEventId: null,
  });

  const concurrentWorkflow =
    createProductGapCardWorkflowService({
      feishu,
      githubIssues,
    });
  const [firstLink, replayedLink] = await Promise.all([
    workflow.createLinkedIssue({
      gapCardId: confirmedId,
      actorId: "pm-chen",
      occurredAt: "2026-07-27T06:04:00.000Z",
    }),
    concurrentWorkflow.createLinkedIssue({
      gapCardId: confirmedId,
      actorId: "pm-chen",
      occurredAt: "2026-07-27T06:05:00.000Z",
    }),
  ]);
  const laterReplay = await workflow.createLinkedIssue({
    gapCardId: confirmedId,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T06:06:00.000Z",
  });

  assert.equal(createdIssues, 1);
  assert.ok(githubCalls.length >= 1 && githubCalls.length <= 2);
  assert.deepEqual(githubCalls[0]?.labels, ["needs-triage"]);
  assert.equal(
    githubCalls[0]?.idempotencyKey,
    `product-gap-card:${confirmedId}`,
  );
  assert.match(githubCalls[0]?.body ?? "", new RegExp(confirmedId));
  assert.deepEqual(firstLink, replayedLink);
  assert.deepEqual(firstLink, laterReplay);
  assert.deepEqual(firstLink.githubIssue, {
    issueNumber: 42,
    issueUrl: "https://github.example/ppt-evaluation/issues/42",
  });
  assert.equal(firstLink.workflowState, "confirmed_for_delivery");
  assert.deepEqual(
    feishu.snapshot().githubIssueDeliveryReservationTable.map(
      (reservation) => ({
        gapCardId: reservation.gapCardId,
        idempotencyKey: reservation.idempotencyKey,
        confirmedByWorkflowEventId:
          reservation.confirmedByWorkflowEventId,
      }),
    ),
    [
      {
        gapCardId: confirmedId,
        idempotencyKey: `product-gap-card:${confirmedId}`,
        confirmedByWorkflowEventId: confirmation.workflowEventId,
      },
    ],
  );
  assert.deepEqual(
    feishu.snapshot().githubIssueLinkEventTable.map((event) => ({
      gapCardId: event.gapCardId,
      confirmedByWorkflowEventId:
        event.confirmedByWorkflowEventId,
      issueNumber: event.issueNumber,
      issueUrl: event.issueUrl,
    })),
    [
      {
        gapCardId: confirmedId,
        confirmedByWorkflowEventId: confirmation.workflowEventId,
        issueNumber: 42,
        issueUrl: "https://github.example/ppt-evaluation/issues/42",
      },
    ],
  );
  assert.equal(
    (await workflow.getGapCard(pendingId)).workflowState,
    "pending_review",
  );
  assert.equal(
    (await workflow.getGapCard(rejectedId)).workflowState,
    "rejected",
  );

  await workflow.recordDecision({
    workflowEventId: "gap-decision-recovery-001",
    gapCardId: pendingId,
    decision: "confirmed_for_delivery",
    actorId: "pm-chen",
    occurredAt: "2026-07-27T06:10:00.000Z",
    reason: "用于验证外部创建成功、投影暂时失败后的恢复。",
    priorWorkflowEventId: null,
  });
  let failFirstLinkWrite = true;
  const flakyFeishu = new Proxy(feishu, {
    get(target, property, receiver) {
      if (
        property === "appendGitHubIssueLinkEvent" &&
        failFirstLinkWrite
      ) {
        return async () => {
          failFirstLinkWrite = false;
          throw new Error("simulated Feishu link write outage");
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? value.bind(target)
        : value;
    },
  });
  const interrupted = createProductGapCardWorkflowService({
    feishu: flakyFeishu,
    githubIssues,
  });
  await assert.rejects(
    interrupted.createLinkedIssue({
      gapCardId: pendingId,
      actorId: "pm-chen",
      occurredAt: "2026-07-27T06:11:00.000Z",
    }),
    /simulated Feishu link write outage/,
  );
  assert.equal(createdIssues, 2);
  assert.equal(
    feishu.snapshot().githubIssueDeliveryReservationTable.length,
    2,
  );
  assert.equal(
    feishu
      .snapshot()
      .githubIssueLinkEventTable.filter(
        (event) => event.gapCardId === pendingId,
      ).length,
    0,
  );

  const recovered = await createProductGapCardWorkflowService({
    feishu,
    githubIssues,
  }).createLinkedIssue({
    gapCardId: pendingId,
    actorId: "pm-chen",
    occurredAt: "2026-07-27T06:12:00.000Z",
  });
  assert.deepEqual(recovered.githubIssue, {
    issueNumber: 43,
    issueUrl: "https://github.example/ppt-evaluation/issues/43",
  });
  assert.equal(
    createdIssues,
    2,
    "restart recovery must reuse the externally created Issue",
  );
});
