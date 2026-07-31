import { isDeepStrictEqual } from "node:util";
import type {
  AdjudicationEventRecord,
  ArtifactScoreTableRecord,
  EffectiveArtifactScorecard,
  EffectiveDimensionScore,
  ReviewEventRecord,
  ScoreDimension,
  ScoreValue,
} from "./domain.ts";
import type {
  AdjudicationEventTablePort,
  ReviewEventTablePort,
} from "./feishu.ts";
import { assertValidAdjudicationEventFields } from "./adjudication-validation.ts";
import { renderedPageNumbers } from "./artifact-projection-validation.ts";

export interface AdjudicateDimensionCommand {
  readonly adjudicationEventId: string;
  readonly scorecardId: string;
  readonly dimension: ScoreDimension;
  readonly humanFinalScore: ScoreValue;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly priorAdjudicationEventId: string | null;
  readonly evidencePages?: readonly number[];
}

export interface RecordScoreReviewCommand {
  readonly reviewEventId: string;
  readonly scorecardId: string;
  readonly reviewedDimensions: readonly ScoreDimension[];
  readonly actorId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly priorReviewEventId: string | null;
}

export interface ScoreAdjudicationService {
  adjudicateDimension(
    command: AdjudicateDimensionCommand,
  ): Promise<AdjudicationEventRecord>;
  recordReview(
    command: RecordScoreReviewCommand,
  ): Promise<ReviewEventRecord>;
  getEffectiveScorecard(
    scorecardId: string,
  ): Promise<EffectiveArtifactScorecard>;
  getEffectiveScorecardForRecord(
    score: ArtifactScoreTableRecord,
  ): Promise<EffectiveArtifactScorecard>;
}

export interface ScoreAdjudicationServiceDependencies {
  readonly feishu: AdjudicationEventTablePort & ReviewEventTablePort;
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
}

function assertModelScoreAdjudicable(
  assessmentStatus: "ASSESSED" | "NOT_ASSESSABLE",
  value: ScoreValue | null,
): asserts value is ScoreValue {
  if (assessmentStatus !== "ASSESSED" || value === null) {
    throw new Error(
      "Invalid adjudication for NOT_ASSESSABLE: human adjudication cannot invent assessability without an allowed domain rule; create a new Scorecard that freezes the reviewed Reference Pack",
    );
  }
}

function causalAdjudicationHead(
  events: readonly AdjudicationEventRecord[],
): AdjudicationEventRecord | undefined {
  if (events.length === 0) {
    return undefined;
  }
  const byId = new Map(
    events.map((event) => [event.adjudicationEventId, event]),
  );
  if (byId.size !== events.length) {
    throw new Error(
      "Invalid adjudication causal history: duplicate event ID",
    );
  }
  const referencedParents = new Set<string>();
  for (const event of events) {
    const prior = event.priorAdjudicationEventId;
    if (prior === null) {
      continue;
    }
    if (!byId.has(prior)) {
      throw new Error(
        `Invalid adjudication causal history: missing parent ${prior}`,
      );
    }
    if (referencedParents.has(prior)) {
      throw new Error(
        `Invalid adjudication causal history: fork at ${prior}`,
      );
    }
    referencedParents.add(prior);
  }
  const heads = events.filter(
    (event) => !referencedParents.has(event.adjudicationEventId),
  );
  if (heads.length !== 1) {
    throw new Error(
      "Invalid adjudication causal history: expected one causal head",
    );
  }
  const head = heads[0];
  if (head === undefined) {
    throw new Error(
      "Invalid adjudication causal history: missing causal head",
    );
  }
  const visited = new Set<string>();
  let current: AdjudicationEventRecord | undefined = head;
  while (current !== undefined) {
    if (visited.has(current.adjudicationEventId)) {
      throw new Error(
        "Invalid adjudication causal history: cycle detected",
      );
    }
    visited.add(current.adjudicationEventId);
    current =
      current.priorAdjudicationEventId === null
        ? undefined
        : byId.get(current.priorAdjudicationEventId);
  }
  if (visited.size !== events.length) {
    throw new Error(
      "Invalid adjudication causal history: disconnected events",
    );
  }
  return head;
}

function effectiveScorecard(
  score: Awaited<
    ReturnType<AdjudicationEventTablePort["loadArtifactScoreByScorecardId"]>
  >,
  events: readonly AdjudicationEventRecord[],
  reviews: readonly ReviewEventRecord[],
): EffectiveArtifactScorecard {
  events.forEach(assertValidAdjudicationEventFields);
  if (
    events.some(
      (event) =>
        event.scorecardId !== score.scorecard.scorecardId ||
        event.artifactId !== score.artifactId ||
        event.runId !== score.runId ||
        event.jobId !== score.jobId ||
        event.provenance !== score.provenance ||
        !isDeepStrictEqual(
          event.environmentOrigin,
          score.environmentOrigin,
        ),
    )
  ) {
    throw new Error(
      "Invalid adjudication causal history: score lineage mismatch",
    );
  }
  if (
    reviews.some(
      (review) =>
        review.scorecardId !== score.scorecard.scorecardId ||
        review.artifactId !== score.artifactId ||
        review.runId !== score.runId ||
        review.jobId !== score.jobId ||
        review.provenance !== score.provenance ||
        !isDeepStrictEqual(
          review.environmentOrigin,
          score.environmentOrigin,
        ),
    )
  ) {
    throw new Error(
      "Invalid review causal history: score lineage mismatch",
    );
  }
  const availablePages = renderedPageNumbers(
    score.renderManifest,
  );
  if (
    events.some(
      (event) =>
        event.evidencePages.length === 0 ||
        new Set(event.evidencePages).size !==
          event.evidencePages.length ||
        event.evidencePages.some(
          (pageNumber) =>
            !Number.isSafeInteger(pageNumber) ||
            !availablePages.has(pageNumber),
        ),
    )
  ) {
    throw new Error(
      "Invalid adjudication causal history: page evidence does not exist in the persisted Render Manifest",
    );
  }
  const scoreDimensions = new Set(
    score.scorecard.dimensions.map(({ dimension }) => dimension),
  );
  if (events.some((event) => !scoreDimensions.has(event.dimension))) {
    throw new Error(
      "Invalid adjudication causal history: unknown score dimension",
    );
  }
  const dimensions: EffectiveDimensionScore[] =
    score.scorecard.dimensions.map((modelOriginal) => {
      const matching = events.filter(
        (event) => event.dimension === modelOriginal.dimension,
      );
      if (
        matching.some(
          (event) =>
            event.modelOriginalAssessmentStatus !==
              modelOriginal.assessmentStatus ||
            event.modelOriginalScore !== modelOriginal.value,
        )
      ) {
        throw new Error(
          "Invalid adjudication causal history: model-original lineage mismatch",
        );
      }
      if (matching.length > 0) {
        assertModelScoreAdjudicable(
          modelOriginal.assessmentStatus,
          modelOriginal.value,
        );
      }
      const latest = causalAdjudicationHead(matching);
      const acceptedByHuman = reviews.some((review) =>
        review.reviewedDimensions.includes(modelOriginal.dimension),
      );
      return latest === undefined
        ? {
            dimension: modelOriginal.dimension,
            modelOriginalAssessmentStatus:
              modelOriginal.assessmentStatus,
            modelOriginalValue: modelOriginal.value,
            effectiveAssessmentStatus: modelOriginal.assessmentStatus,
            effectiveValue: modelOriginal.value,
            evidencePages: modelOriginal.evidencePages,
            rationale: modelOriginal.rationale,
            reviewState: acceptedByHuman
              ? "human_reviewed"
              : "model_not_reviewed",
            source: "model_original",
            adjudicationEventId: null,
          }
        : {
            dimension: modelOriginal.dimension,
            modelOriginalAssessmentStatus:
              modelOriginal.assessmentStatus,
            modelOriginalValue: modelOriginal.value,
            effectiveAssessmentStatus:
              latest.humanFinalAssessmentStatus,
            effectiveValue: latest.humanFinalScore,
            evidencePages: latest.evidencePages,
            rationale: latest.reason,
            reviewState: "human_reviewed",
            source: "human_adjudication",
            adjudicationEventId: latest.adjudicationEventId,
          };
    });
  const reviewed = dimensions.filter(
    ({ reviewState }) => reviewState === "human_reviewed",
  ).length;
  return {
    scorecardId: score.scorecard.scorecardId,
    artifactId: score.artifactId,
    runId: score.runId,
    jobId: score.jobId,
    originalScorecard: score.scorecard,
    dimensions,
    reviewState:
      reviewed === 0
        ? "model_not_reviewed"
        : reviewed === dimensions.length
          ? "human_reviewed"
          : "partially_human_reviewed",
  };
}

export function createScoreAdjudicationService({
  feishu,
}: ScoreAdjudicationServiceDependencies): ScoreAdjudicationService {
  return {
    async adjudicateDimension(command) {
      requireNonBlank(
        command.adjudicationEventId,
        "adjudicationEventId",
      );
      requireNonBlank(command.actorId, "actorId");
      requireNonBlank(command.reason, "reason");
      if (Number.isNaN(Date.parse(command.occurredAt))) {
        throw new Error("occurredAt must be an ISO timestamp");
      }
      if (
        !Number.isInteger(command.humanFinalScore) ||
        command.humanFinalScore < 1 ||
        command.humanFinalScore > 5
      ) {
        throw new Error("humanFinalScore must be an integer from 1 to 5");
      }
      const score = await feishu.loadArtifactScoreByScorecardId(
        command.scorecardId,
      );
      const modelOriginal = score.scorecard.dimensions.find(
        ({ dimension }) => dimension === command.dimension,
      );
      if (modelOriginal === undefined) {
        throw new Error(
          `Score dimension not found: ${command.dimension}`,
        );
      }
      assertModelScoreAdjudicable(
        modelOriginal.assessmentStatus,
        modelOriginal.value,
      );
      const evidencePages =
        command.evidencePages ?? modelOriginal.evidencePages;
      if (
        evidencePages.length === 0 ||
        new Set(evidencePages).size !== evidencePages.length ||
        evidencePages.some(
          (pageNumber) =>
            !Number.isInteger(pageNumber) ||
            pageNumber < 1 ||
            pageNumber > score.artifact.pageCount,
        )
      ) {
        throw new Error(
          "Human adjudication requires unique positive page evidence",
        );
      }
      const event: AdjudicationEventRecord = {
        recordType: "adjudication_event",
        schemaVersion: "adjudication-event-v1",
        adjudicationEventId: command.adjudicationEventId,
        scorecardId: command.scorecardId,
        artifactId: score.artifactId,
        runId: score.runId,
        jobId: score.jobId,
        dimension: command.dimension,
        modelOriginalAssessmentStatus: modelOriginal.assessmentStatus,
        modelOriginalScore: modelOriginal.value,
        humanFinalAssessmentStatus: "ASSESSED",
        humanFinalScore: command.humanFinalScore,
        evidencePages: [...evidencePages],
        actorId: command.actorId,
        occurredAt: command.occurredAt,
        createdAt: command.occurredAt,
        lastSyncedAt: command.occurredAt,
        reason: command.reason,
        priorAdjudicationEventId:
          command.priorAdjudicationEventId,
        provenance: score.provenance,
        environmentOrigin: score.environmentOrigin,
      };
      assertValidAdjudicationEventFields(event);
      await feishu.appendAdjudicationEvent(event);
      return event;
    },

    async recordReview(command) {
      requireNonBlank(command.reviewEventId, "reviewEventId");
      requireNonBlank(command.actorId, "actorId");
      requireNonBlank(command.reason, "reason");
      if (Number.isNaN(Date.parse(command.occurredAt))) {
        throw new Error("occurredAt must be an ISO timestamp");
      }
      if (
        command.reviewedDimensions.length === 0 ||
        new Set(command.reviewedDimensions).size !==
          command.reviewedDimensions.length
      ) {
        throw new Error(
          "reviewedDimensions must contain unique dimensions",
        );
      }
      const score = await feishu.loadArtifactScoreByScorecardId(
        command.scorecardId,
      );
      const allowed = new Set(
        score.scorecard.dimensions.map(({ dimension }) => dimension),
      );
      if (
        command.reviewedDimensions.some(
          (dimension) => !allowed.has(dimension),
        )
      ) {
        throw new Error("Review Event includes an unknown score dimension");
      }
      const event: ReviewEventRecord = {
        recordType: "review_event",
        schemaVersion: "review-event-v1",
        reviewEventId: command.reviewEventId,
        scorecardId: command.scorecardId,
        artifactId: score.artifactId,
        runId: score.runId,
        jobId: score.jobId,
        reviewedDimensions: [...command.reviewedDimensions],
        decision: "accepted_model_scores",
        actorId: command.actorId,
        occurredAt: command.occurredAt,
        createdAt: command.occurredAt,
        lastSyncedAt: command.occurredAt,
        reason: command.reason,
        priorReviewEventId: command.priorReviewEventId,
        provenance: score.provenance,
        environmentOrigin: score.environmentOrigin,
      };
      await feishu.appendReviewEvent(event);
      return event;
    },

    async getEffectiveScorecard(scorecardId) {
      const [score, events, reviews] = await Promise.all([
        feishu.loadArtifactScoreByScorecardId(scorecardId),
        feishu.listAdjudicationEvents(scorecardId),
        feishu.listReviewEvents(scorecardId),
      ]);
      return effectiveScorecard(score, events, reviews);
    },

    async getEffectiveScorecardForRecord(score) {
      const [events, reviews] = await Promise.all([
        feishu.listAdjudicationEvents(score.scorecard.scorecardId),
        feishu.listReviewEvents(score.scorecard.scorecardId),
      ]);
      return effectiveScorecard(score, events, reviews);
    },
  };
}
