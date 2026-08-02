import { isDeepStrictEqual } from "node:util";

import { assertCompleteScoreDimensions } from "./comparison-compatibility.ts";
import type { BakeoffJobOutcome } from "./domain.ts";
import { assertEnvironmentOriginAllowed } from "./environment-origin.ts";
import type { ComparisonReportSource } from "./feishu.ts";

export const T10_TRUSTED_FEISHU_REPORT_ORIGIN =
  "https://my.feishu.cn" as const;

const T10_VENDOR_IDS = new Set(["wps", "qwen", "doubao"]);

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

function assertTrustedReportUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "T10 production acceptance requires the trusted Feishu report origin",
    );
  }
  if (
    parsed.origin !== T10_TRUSTED_FEISHU_REPORT_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\/docx\/[a-zA-Z0-9_-]{8,128}$/.test(parsed.pathname)
  ) {
    throw new Error(
      "T10 production acceptance requires the trusted Feishu report origin and one exact Docx URL",
    );
  }
}

function failExactLineage(): never {
  throw new Error(
    "T10 production acceptance requires one exact persisted LIVE Job, WPS-Qwen-Doubao Run set, Artifact, Render, Scorecard, and Report lineage",
  );
}

/**
 * Final T10 release gate. The source must be a post-commit readback from the
 * harness-owned production projection; an arbitrary outcome object is not
 * independently sufficient evidence.
 */
export function assertT10ProductionAcceptanceReady(
  outcome: BakeoffJobOutcome,
  source: ComparisonReportSource,
): void {
  const report = source.primaryReport;
  const job = source.job;
  if (
    outcome.job.executionProvenance !== "LIVE_PRODUCTION" ||
    outcome.report.executionProvenance !== "LIVE_PRODUCTION" ||
    job.executionProvenance !== "LIVE_PRODUCTION" ||
    report?.executionProvenance !== "LIVE_PRODUCTION"
  ) {
    throw new Error(
      `T10 production acceptance requires LIVE_PRODUCTION Job and Report lineage; received ${outcome.job.executionProvenance}/${outcome.report.executionProvenance}`,
    );
  }
  if (
    outcome.job.environment !== "production" ||
    outcome.job.provenance !== "PRODUCTION" ||
    outcome.job.status !== "completed" ||
    outcome.report.provenance !== "PRODUCTION" ||
    job.recordType !== "bakeoff_job" ||
    job.recordId !== job.jobId ||
    job.jobId !== outcome.job.jobId ||
    job.caseId !== outcome.job.caseId ||
    job.status !== "completed" ||
    job.provenance !== "PRODUCTION" ||
    report === null ||
    !isDeepStrictEqual(report, outcome.report) ||
    report.jobId !== job.jobId ||
    report.provenance !== "PRODUCTION" ||
    source.evaluationCase.caseId !== job.caseId ||
    source.evaluationCase.provenance !== "PRODUCTION"
  ) {
    failExactLineage();
  }

  assertEnvironmentOriginAllowed(
    outcome.job.environmentOrigin,
    "production",
    "T10 outcome Job",
  );
  assertEnvironmentOriginAllowed(
    source.evaluationCase.environmentOrigin,
    "production",
    "T10 Evaluation Case",
  );
  assertEnvironmentOriginAllowed(
    job.environmentOrigin,
    "production",
    "T10 persisted Job",
  );
  assertEnvironmentOriginAllowed(
    report.environmentOrigin,
    "production",
    "T10 persisted Report",
  );
  assertTrustedReportUrl(report.url);

  const selectedRunIds = job.selectedRunIds;
  if (
    selectedRunIds === null ||
    selectedRunIds.length !== 3 ||
    new Set(selectedRunIds).size !== 3 ||
    source.vendorRuns.length !== 3 ||
    source.capturedArtifacts.length !== 3 ||
    source.artifactScores.length !== 3
  ) {
    failExactLineage();
  }
  const vendorIds = source.vendorRuns.map(
    ({ productVendorId }) => productVendorId,
  );
  if (
    vendorIds.some((vendorId) => vendorId === null) ||
    new Set(vendorIds).size !== T10_VENDOR_IDS.size ||
    !vendorIds.every(
      (vendorId) => vendorId !== null && T10_VENDOR_IDS.has(vendorId),
    )
  ) {
    failExactLineage();
  }

  const capturesByRun = new Map(
    source.capturedArtifacts.map((capture) => [capture.runId, capture]),
  );
  const scoresByRun = new Map(
    source.artifactScores.map((score) => [score.runId, score]),
  );
  if (
    capturesByRun.size !== 3 ||
    scoresByRun.size !== 3 ||
    !sameStringSet(
      outcome.report.runIds,
      selectedRunIds,
    )
  ) {
    failExactLineage();
  }

  for (const run of source.vendorRuns) {
    const capture = capturesByRun.get(run.recordId);
    const score = scoresByRun.get(run.recordId);
    if (
      !selectedRunIds.includes(run.recordId) ||
      run.recordType !== "vendor_run" ||
      run.parentRecordId !== job.recordId ||
      run.jobId !== job.jobId ||
      run.caseId !== job.caseId ||
      run.status !== "completed" ||
      run.provenance !== "PRODUCTION" ||
      run.executionProvenance !== "LIVE_PRODUCTION" ||
      capture === undefined ||
      score === undefined ||
      capture.jobId !== job.jobId ||
      capture.caseId !== job.caseId ||
      capture.provenance !== "PRODUCTION" ||
      capture.artifact.runId !== run.recordId ||
      capture.artifact.provenance !== "LIVE_PRODUCTION" ||
      capture.artifact.pageCount !== 16 ||
      capture.renderManifest.artifactId !== capture.artifactId ||
      capture.renderManifest.provenance !== "LIVE_PRODUCTION" ||
      capture.renderManifest.renderOutcome !== "faithful" ||
      score.jobId !== job.jobId ||
      score.caseId !== job.caseId ||
      score.artifactId !== capture.artifactId ||
      score.provenance !== "PRODUCTION" ||
      !isDeepStrictEqual(score.artifact, capture.artifact) ||
      !isDeepStrictEqual(score.renderManifest, capture.renderManifest) ||
      score.scorecard.jobId !== job.jobId ||
      score.scorecard.runId !== run.recordId ||
      score.scorecard.artifactId !== capture.artifactId ||
      score.scorecard.provenance !== "LIVE_PRODUCTION"
    ) {
      failExactLineage();
    }
    assertEnvironmentOriginAllowed(
      run.environmentOrigin,
      "production",
      `T10 Run ${run.recordId}`,
    );
    assertEnvironmentOriginAllowed(
      capture.environmentOrigin,
      "production",
      `T10 capture ${capture.artifactId}`,
    );
    assertEnvironmentOriginAllowed(
      capture.artifact.environmentOrigin,
      "production",
      `T10 Artifact ${capture.artifactId}`,
    );
    assertEnvironmentOriginAllowed(
      capture.renderManifest.environmentOrigin,
      "production",
      `T10 Render ${capture.renderManifest.renderManifestId}`,
    );
    assertEnvironmentOriginAllowed(
      score.environmentOrigin,
      "production",
      `T10 Score ${score.recordId}`,
    );
    assertEnvironmentOriginAllowed(
      score.scorecard.environmentOrigin,
      "production",
      `T10 Scorecard ${score.scorecard.scorecardId}`,
    );
    assertCompleteScoreDimensions(
      score.scorecard.dimensions,
      `T10 Scorecard ${score.scorecard.scorecardId}`,
    );
  }

  const artifacts = source.capturedArtifacts.map(({ artifact }) => artifact);
  const renders = source.capturedArtifacts.map(
    ({ renderManifest }) => renderManifest,
  );
  const scores = source.artifactScores.map(({ scorecard }) => scorecard);
  if (
    !sameStringSet(
      report.artifactIds,
      artifacts.map(({ artifactId }) => artifactId),
    ) ||
    !sameStringSet(
      outcome.artifacts.map(({ artifactId }) => artifactId),
      artifacts.map(({ artifactId }) => artifactId),
    ) ||
    outcome.artifacts.some(
      (artifact) =>
        !artifacts.some((persisted) =>
          isDeepStrictEqual(persisted, artifact),
        ),
    ) ||
    outcome.renderManifests.some(
      (renderManifest) =>
        !renders.some((persisted) =>
          isDeepStrictEqual(persisted, renderManifest),
        ),
    ) ||
    outcome.scorecards.some(
      (scorecard) =>
        !scores.some((persisted) =>
          isDeepStrictEqual(persisted, scorecard),
        ),
    ) ||
    outcome.artifacts.length !== 3 ||
    outcome.renderManifests.length !== 3 ||
    outcome.scorecards.length !== 3 ||
    outcome.report.claimLevel !== "case_sample"
  ) {
    failExactLineage();
  }
}
