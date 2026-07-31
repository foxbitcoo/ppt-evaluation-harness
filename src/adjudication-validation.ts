import type { AdjudicationEventRecord } from "./domain.ts";

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function assertValidAdjudicationEventFields(
  event: AdjudicationEventRecord,
): void {
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
    typeof event.actorId !== "string" ||
    event.actorId.trim().length === 0
  ) {
    throw new Error("Adjudication Event actor must not be blank");
  }
  if (
    typeof event.reason !== "string" ||
    event.reason.trim().length === 0
  ) {
    throw new Error("Adjudication Event reason must not be blank");
  }
  if (
    !isIsoTimestamp(event.occurredAt) ||
    !isIsoTimestamp(event.createdAt) ||
    !isIsoTimestamp(event.lastSyncedAt)
  ) {
    throw new Error(
      "Adjudication Event timestamp must be an ISO timestamp",
    );
  }
}
