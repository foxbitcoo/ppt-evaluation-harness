import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ArtifactScoreTableRecord,
  ArtifactScorecard,
  BakeoffProtocolSnapshot,
  ComparisonCompatibilityFingerprint,
  EvaluationCaseRecord,
  ScoreDimension,
} from "./domain.ts";

export const REQUIRED_SCORE_DIMENSIONS = Object.freeze([
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
] as const satisfies readonly ScoreDimension[]);

function sha256Json(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

export function expectedComparisonCompatibilityFingerprint(
  scorecard: ArtifactScorecard,
  protocolSnapshot: BakeoffProtocolSnapshot,
  evaluationCase: EvaluationCaseRecord,
): ComparisonCompatibilityFingerprint {
  const judge = scorecard.judgeLineage;
  return Object.freeze({
    caseManifestHash: sha256Json(evaluationCase),
    caseInputHash: sha256Json({
      vendorPrompt: evaluationCase.vendorPrompt,
    }),
    track: evaluationCase.track,
    protocolHash: sha256Json(protocolSnapshot),
    rubricVersion: scorecard.rubricVersion,
    scenarioWeightProfile: null,
    judgeConfigurationHash:
      judge === null
        ? sha256Json({ scorer: "mock-score@1" })
        : sha256Json({
            provider: judge.provider,
            adapterVersion: judge.adapterVersion,
            requestedModel: judge.requestedModel,
            responseModel: judge.responseModel,
            promptVersion: judge.promptVersion,
            promptHash: judge.promptHash,
            configHash: judge.configHash,
            schemaHash: judge.schemaHash,
            executionIdentity:
              judge.provider === "codex_cli" &&
              judge.executionEvidence !== undefined
                ? {
                    schemaVersion:
                      judge.executionEvidence.schemaVersion,
                    binaryHash: judge.executionEvidence.binaryHash,
                    fixedArgumentsHash:
                      judge.executionEvidence.fixedArgumentsHash,
                    sandboxBinaryHash:
                      judge.executionEvidence.sandboxBinaryHash,
                    sandboxProfileHash:
                      judge.executionEvidence.sandboxProfileHash,
                  }
                : null,
          }),
    renderPipelineHash: sha256Json({
      renderer: scorecard.evaluationInputManifest.renderer,
      renderOutcome:
        scorecard.deliveryQualityGates.find(
          ({ gate }) => gate === "sufficient_faithful_visual_input",
        )?.status ?? "NOT_ASSESSABLE",
    }),
    designJudgmentSurfaceHash: sha256Json({
      surfaceClass: "canonical",
      renderer: scorecard.evaluationInputManifest.renderer,
      compatibilityStatus:
        scorecard.deliveryQualityGates.find(
          ({ gate }) => gate === "sufficient_faithful_visual_input",
        )?.status === "PASS"
          ? "compatible"
          : "visual_comparison_prohibited",
    }),
    referencePackHash:
      scorecard.evaluationInputManifest.referencePackHash,
  });
}

export function assertCompleteScoreDimensions(
  dimensions: readonly { readonly dimension: ScoreDimension }[],
  entityName = "Scorecard",
): void {
  const observed = dimensions.map(({ dimension }) => dimension);
  const observedSet = new Set(observed);
  if (
    observed.length !== REQUIRED_SCORE_DIMENSIONS.length ||
    observedSet.size !== REQUIRED_SCORE_DIMENSIONS.length ||
    REQUIRED_SCORE_DIMENSIONS.some(
      (dimension) => !observedSet.has(dimension),
    )
  ) {
    throw new Error(
      `${entityName} must contain exactly the six unique scoring dimensions`,
    );
  }
}

export function assertArtifactScoreCompatibility(
  record: ArtifactScoreTableRecord,
  evaluationCase: EvaluationCaseRecord,
  protocolSnapshot: BakeoffProtocolSnapshot | null,
): void {
  const input = record.scorecard.evaluationInputManifest;
  if (
    protocolSnapshot === null ||
    input.artifactHash !== record.artifact.contentHash ||
    input.renderManifestHash !== record.renderManifest.contentHash ||
    input.renderer !== record.renderManifest.renderer
  ) {
    throw new Error(
      "Artifact Score evaluation input lineage does not match its Artifact, Render Manifest, Case, and Protocol",
    );
  }
  assertCompleteScoreDimensions(record.scorecard.dimensions);
  const expected = expectedComparisonCompatibilityFingerprint(
    record.scorecard,
    protocolSnapshot,
    evaluationCase,
  );
  if (
    !isDeepStrictEqual(
      record.comparisonCompatibilityFingerprint,
      expected,
    )
  ) {
    throw new Error(
      "Artifact Score compatibility fingerprint does not match its persisted Case, Protocol, Scorecard, and evaluation inputs",
    );
  }
}
