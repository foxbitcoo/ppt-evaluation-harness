import type {
  AdjudicationEventRecord,
  ReviewEventRecord,
  ScoreDimension,
} from "./domain.ts";

const REVIEWABLE_SCORE_DIMENSIONS = new Set<ScoreDimension>([
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
]);

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const lastDay =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  return (
    day >= 1 &&
    day <= lastDay &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

export function assertValidAdjudicationEventFields(
  event: AdjudicationEventRecord,
): void {
  if (
    event.recordType !== "adjudication_event" ||
    event.schemaVersion !== "adjudication-event-v1"
  ) {
    throw new Error("Adjudication Event has an invalid schema");
  }
  for (const [label, value] of [
    ["adjudicationEventId", event.adjudicationEventId],
    ["scorecardId", event.scorecardId],
    ["artifactId", event.artifactId],
    ["runId", event.runId],
    ["jobId", event.jobId],
    ["actor", event.actorId],
    ["reason", event.reason],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Adjudication Event ${label} must not be blank`);
    }
  }
  if (
    event.priorAdjudicationEventId !== null &&
    (typeof event.priorAdjudicationEventId !== "string" ||
      event.priorAdjudicationEventId.trim().length === 0)
  ) {
    throw new Error(
      "Adjudication Event prior reference must be null or a non-blank ID",
    );
  }
  if (!REVIEWABLE_SCORE_DIMENSIONS.has(event.dimension)) {
    throw new Error("Adjudication Event has an invalid score dimension");
  }
  if (
    event.modelOriginalAssessmentStatus !== "ASSESSED" ||
    event.modelOriginalScore === null
  ) {
    throw new Error(
      "Invalid adjudication for NOT_ASSESSABLE: human adjudication cannot invent assessability",
    );
  }
  if (
    !Number.isInteger(event.modelOriginalScore) ||
    event.modelOriginalScore < 1 ||
    event.modelOriginalScore > 5
  ) {
    throw new Error(
      "Adjudication Event has an invalid model-original score",
    );
  }
  if (
    event.humanFinalAssessmentStatus !== "ASSESSED" ||
    !Number.isInteger(event.humanFinalScore) ||
    event.humanFinalScore < 1 ||
    event.humanFinalScore > 5
  ) {
    throw new Error(
      "Adjudication Event has an invalid human-final assessment status or score",
    );
  }
  if (
    !isIsoTimestamp(event.occurredAt) ||
    !isIsoTimestamp(event.createdAt) ||
    !isIsoTimestamp(event.lastSyncedAt) ||
    Date.parse(event.createdAt) < Date.parse(event.occurredAt) ||
    Date.parse(event.lastSyncedAt) < Date.parse(event.createdAt)
  ) {
    throw new Error(
      "Adjudication Event timestamps must be causal ISO timestamps",
    );
  }
}

export function assertValidReviewEventFields(
  event: ReviewEventRecord,
): void {
  if (
    event.recordType !== "review_event" ||
    event.schemaVersion !== "review-event-v1" ||
    event.decision !== "accepted_model_scores"
  ) {
    throw new Error(
      "Review Event has an invalid schema or decision",
    );
  }
  for (const [label, value] of [
    ["reviewEventId", event.reviewEventId],
    ["scorecardId", event.scorecardId],
    ["artifactId", event.artifactId],
    ["runId", event.runId],
    ["jobId", event.jobId],
    ["actor", event.actorId],
    ["reason", event.reason],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Review Event ${label} must not be blank`);
    }
  }
  if (
    event.priorReviewEventId !== null &&
    (typeof event.priorReviewEventId !== "string" ||
      event.priorReviewEventId.trim().length === 0)
  ) {
    throw new Error(
      "Review Event prior reference must be null or a non-blank ID",
    );
  }
  if (
    !Array.isArray(event.reviewedDimensions) ||
    event.reviewedDimensions.length === 0 ||
    new Set(event.reviewedDimensions).size !==
      event.reviewedDimensions.length ||
    event.reviewedDimensions.some(
      (dimension) => !REVIEWABLE_SCORE_DIMENSIONS.has(dimension),
    )
  ) {
    throw new Error(
      "Review Event must contain unique reviewed dimensions",
    );
  }
  if (
    !isIsoTimestamp(event.occurredAt) ||
    !isIsoTimestamp(event.createdAt) ||
    !isIsoTimestamp(event.lastSyncedAt) ||
    Date.parse(event.createdAt) < Date.parse(event.occurredAt) ||
    Date.parse(event.lastSyncedAt) < Date.parse(event.createdAt)
  ) {
    throw new Error(
      "Review Event timestamps must be causal ISO timestamps",
    );
  }
}
