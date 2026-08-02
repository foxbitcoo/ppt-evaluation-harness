import { isDeepStrictEqual } from "node:util";

import type { BakeoffJobOutcome } from "./domain.ts";

/**
 * Final T10 release gate. A retained real-provider replay can validate recovery
 * and reporting code, but it can never satisfy the LIVE production acceptance.
 */
export function assertT10ProductionAcceptanceReady(
  outcome: BakeoffJobOutcome,
): void {
  if (
    outcome.job.executionProvenance !== "LIVE_PRODUCTION" ||
    outcome.report.executionProvenance !== "LIVE_PRODUCTION"
  ) {
    throw new Error(
      `T10 production acceptance requires LIVE_PRODUCTION Job and Report lineage; received ${outcome.job.executionProvenance}/${outcome.report.executionProvenance}`,
    );
  }
  if (
    outcome.job.environment !== "production" ||
    outcome.job.provenance !== "PRODUCTION" ||
    outcome.job.status !== "completed" ||
    outcome.report.provenance !== "PRODUCTION"
  ) {
    throw new Error(
      "T10 production acceptance requires one completed production Job and production Report",
    );
  }
  if (
    outcome.artifacts.length !== 3 ||
    outcome.renderManifests.length !== 3 ||
    outcome.scorecards.length !== 3 ||
    outcome.artifacts.some(
      ({ provenance }) => provenance !== "LIVE_PRODUCTION",
    ) ||
    outcome.renderManifests.some(
      ({ provenance, renderOutcome }) =>
        provenance !== "LIVE_PRODUCTION" || renderOutcome !== "faithful",
    ) ||
    outcome.scorecards.some(
      ({ provenance }) => provenance !== "LIVE_PRODUCTION",
    )
  ) {
    throw new Error(
      "T10 production acceptance requires three LIVE Artifacts, faithful renders, and six-dimension Scorecards",
    );
  }
  const artifactIds = outcome.artifacts.map(({ artifactId }) => artifactId);
  const runIds = outcome.artifacts.map(({ runId }) => runId);
  if (
    new Set(artifactIds).size !== 3 ||
    new Set(runIds).size !== 3 ||
    !isDeepStrictEqual(outcome.report.artifactIds, artifactIds) ||
    outcome.report.runIds.length !== 3 ||
    new Set(outcome.report.runIds).size !== 3 ||
    !runIds.every((runId) => outcome.report.runIds.includes(runId)) ||
    outcome.report.claimLevel !== "case_sample" ||
    !/^https:\/\/[^/\s]+\/.+/.test(outcome.report.url)
  ) {
    throw new Error(
      "T10 production acceptance Report is not bound to the exact three LIVE Runs and Artifacts",
    );
  }
}
