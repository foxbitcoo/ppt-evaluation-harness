import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ArtifactScoreTableRecord,
  ArtifactScorecard,
  BakeoffProtocolSnapshot,
  ComparisonCompatibilityFingerprint,
  EvaluationCaseRecord,
  RenderManifest,
  ScoreDimension,
} from "./domain.ts";
import { renderedPageNumbers } from "./artifact-projection-validation.ts";

export const REQUIRED_SCORE_DIMENSIONS = Object.freeze([
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
] as const satisfies readonly ScoreDimension[]);

const DEDUCTION_BASES = new Set([
  "no_deduction",
  "visible_requirement_or_coverage_gap",
  "validated_reference_pack_errors",
  "not_assessable_no_reference_pack",
  "not_assessable_degraded_render",
  "visible_narrative_or_audience_gap",
  "visible_visual_finish_gap",
  "visible_layout_or_readability_gap",
  "visible_information_expression_gap",
]);

const NOT_ASSESSABLE_DEDUCTION_BASES = new Set([
  "not_assessable_no_reference_pack",
  "not_assessable_degraded_render",
]);

const DEGRADED_RENDER_NOT_ASSESSABLE_DIMENSIONS =
  new Set<ScoreDimension>([
    "visual_aesthetics_and_professional_finish",
    "layout_hierarchy_and_readability",
    "imagery_chart_and_information_expression",
  ]);

const SCORE_DIMENSION_FIELDS = new Set([
  "dimension",
  "assessmentStatus",
  "value",
  "deductionBasis",
  "evidencePages",
  "rationale",
]);

const OWNED_DEDUCTION_BASIS: Readonly<
  Record<ScoreDimension, string>
> = {
  requirement_understanding_and_content_coverage:
    "visible_requirement_or_coverage_gap",
  factual_accuracy_and_content_quality:
    "validated_reference_pack_errors",
  narrative_and_audience_fit:
    "visible_narrative_or_audience_gap",
  visual_aesthetics_and_professional_finish:
    "visible_visual_finish_gap",
  layout_hierarchy_and_readability:
    "visible_layout_or_readability_gap",
  imagery_chart_and_information_expression:
    "visible_information_expression_gap",
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function sha256Json(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

export function expectedComparisonCompatibilityFingerprint(
  scorecard: ArtifactScorecard,
  protocolSnapshot: BakeoffProtocolSnapshot,
  evaluationCase: EvaluationCaseRecord,
  renderManifest: RenderManifest,
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
      renderPolicy: renderManifest.renderPolicy,
      renderOutcome:
        scorecard.deliveryQualityGates.find(
          ({ gate }) => gate === "sufficient_faithful_visual_input",
        )?.status ?? "NOT_ASSESSABLE",
    }),
    designJudgmentSurfaceHash: sha256Json({
      surfaceClass: "canonical",
      renderer: scorecard.evaluationInputManifest.renderer,
      renderPolicy: renderManifest.renderPolicy,
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

function assertScoreDimensionValues(
  scorecard: ArtifactScorecard,
  renderManifest: RenderManifest,
): void {
  const availablePages = renderedPageNumbers(renderManifest);
  const faithfulVisualGate = scorecard.deliveryQualityGates.find(
    ({ gate }) => gate === "sufficient_faithful_visual_input",
  );
  for (const dimension of scorecard.dimensions) {
    const dimensionFields = Object.keys(dimension);
    if (
      dimensionFields.length !== SCORE_DIMENSION_FIELDS.size ||
      dimensionFields.some(
        (field) => !SCORE_DIMENSION_FIELDS.has(field),
      )
    ) {
      throw new Error(
        "Scorecard dimension violates the strict six-dimension schema",
      );
    }
    const validAssessedValue =
      dimension.assessmentStatus === "ASSESSED" &&
      Number.isInteger(dimension.value) &&
      dimension.value !== null &&
      dimension.value >= 1 &&
      dimension.value <= 5;
    const validNotAssessableValue =
      dimension.assessmentStatus === "NOT_ASSESSABLE" &&
      dimension.value === null;
    if (!validAssessedValue && !validNotAssessableValue) {
      throw new Error(
        "Scorecard dimension value must be an integer from 1–5 when ASSESSED and null when NOT_ASSESSABLE",
      );
    }
    const deductionIsNotAssessable =
      NOT_ASSESSABLE_DEDUCTION_BASES.has(
        dimension.deductionBasis,
      );
    if (
      !DEDUCTION_BASES.has(dimension.deductionBasis) ||
      (dimension.assessmentStatus === "ASSESSED" &&
        deductionIsNotAssessable) ||
      (dimension.assessmentStatus === "NOT_ASSESSABLE" &&
        !deductionIsNotAssessable)
    ) {
      throw new Error(
        "Scorecard deduction basis does not match its assessment status field combination",
      );
    }
    const invalidNoReferencePackOwnership =
      dimension.assessmentStatus === "NOT_ASSESSABLE" &&
      dimension.deductionBasis ===
        "not_assessable_no_reference_pack" &&
      dimension.dimension !==
        "factual_accuracy_and_content_quality";
    const invalidDegradedRenderOwnership =
      dimension.assessmentStatus === "NOT_ASSESSABLE" &&
      dimension.deductionBasis ===
        "not_assessable_degraded_render" &&
      (!DEGRADED_RENDER_NOT_ASSESSABLE_DIMENSIONS.has(
        dimension.dimension,
      ) ||
        renderManifest.renderOutcome === "faithful" ||
        faithfulVisualGate?.status === "PASS");
    if (
      invalidNoReferencePackOwnership ||
      invalidDegradedRenderOwnership
    ) {
      throw new Error(
        "Scorecard NOT_ASSESSABLE ownership does not match its Reference Pack or persisted degraded render gate",
      );
    }
    if (
      dimension.assessmentStatus === "ASSESSED" &&
      dimension.deductionBasis !==
        (dimension.value === 5
          ? "no_deduction"
          : OWNED_DEDUCTION_BASIS[dimension.dimension])
    ) {
      throw new Error(
        "Scorecard dimension uses an unowned deduction basis",
      );
    }
    if (
      !Array.isArray(dimension.evidencePages) ||
      new Set(dimension.evidencePages).size !==
        dimension.evidencePages.length
    ) {
      throw new Error(
        "Scorecard dimension evidence pages must be unique",
      );
    }
    if (
      dimension.evidencePages.some(
        (pageNumber) =>
          !Number.isInteger(pageNumber) ||
          pageNumber < 1 ||
          !availablePages.has(pageNumber),
      )
    ) {
      throw new Error(
        "Scorecard dimension evidence page is outside the Artifact page range",
      );
    }
    if (
      (dimension.assessmentStatus === "ASSESSED" &&
        dimension.evidencePages.length === 0) ||
      (dimension.assessmentStatus === "NOT_ASSESSABLE" &&
        dimension.evidencePages.length !== 0)
    ) {
      throw new Error(
        "Scorecard ASSESSED dimensions require evidence while NOT_ASSESSABLE dimensions must not claim evidence",
      );
    }
    if (
      typeof dimension.rationale !== "string" ||
      dimension.rationale.trim().length === 0 ||
      dimension.rationale.length > 240
    ) {
      throw new Error(
        "Scorecard dimension rationale must be non-empty and at most 240 characters",
      );
    }
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
  assertScoreDimensionValues(
    record.scorecard,
    record.renderManifest,
  );
  const expected = expectedComparisonCompatibilityFingerprint(
    record.scorecard,
    protocolSnapshot,
    evaluationCase,
    record.renderManifest,
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
