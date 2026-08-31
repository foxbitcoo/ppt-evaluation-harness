export const PRESENTATION_REPORT_INDEX_VERSION =
  "report-index@0.2.0" as const;

export const PRESENTATION_REPORT_CALIBRATION_STATUS =
  "PROVISIONAL_SCORE_NOT_CALIBRATED" as const;

export const PRESENTATION_REPORT_DIMENSIONS = [
  { dimension: "content_accuracy_coverage", maxScore: 25 },
  { dimension: "narrative_plain_language", maxScore: 20 },
  { dimension: "visual_hierarchy_consistency", maxScore: 10 },
  { dimension: "visual_use", maxScore: 10 },
  { dimension: "readability_static_finish", maxScore: 15 },
] as const;

export type PresentationReportDimension =
  (typeof PRESENTATION_REPORT_DIMENSIONS)[number]["dimension"];

export type PresentationReportAssessmentStatus = "SCORED" | "UNKNOWN";

export interface PresentationDimensionAssessment {
  readonly dimension: PresentationReportDimension;
  readonly status: PresentationReportAssessmentStatus;
  readonly score: number | null;
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
}

export interface PresentationEffectivenessAssessment {
  readonly status: PresentationReportAssessmentStatus;
  readonly score: number | null;
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
}

export interface PresentationPageSelection {
  readonly pageNumber: number;
  readonly evidenceIds: readonly string[];
  readonly reason: string;
}

export type PresentationFindingKind =
  | "CONTENT_ERROR"
  | "CONTENT_OMISSION"
  | "LAYOUT_READABILITY"
  | "OTHER";

export interface PresentationReportFinding {
  readonly findingId: string;
  readonly kind: PresentationFindingKind;
  readonly deductionOwner: PresentationReportDimension;
  readonly evidenceIds: readonly string[];
  readonly pageNumbers: readonly number[];
  readonly description: string;
}

export type OperationalCapabilityStatus =
  | "VERIFIED"
  | "FAILED"
  | "UNVERIFIED";

export interface OperationalCapabilityAssessment {
  readonly capability: string;
  readonly status: OperationalCapabilityStatus;
  readonly evidenceIds: readonly string[];
  readonly note: string;
}

export interface PresentationReportInput {
  readonly reportIndexVersion: typeof PRESENTATION_REPORT_INDEX_VERSION;
  readonly rubricVersion: string;
  readonly artifactId: string;
  readonly dimensions: readonly PresentationDimensionAssessment[];
  readonly presentationEffectiveness: PresentationEffectivenessAssessment;
  readonly strongestPage: PresentationPageSelection;
  readonly weakestPage: PresentationPageSelection;
  readonly findings: readonly PresentationReportFinding[];
  readonly operationalCapabilities: readonly OperationalCapabilityAssessment[];
  readonly scenarioRecommendations: readonly string[];
}

export interface AggregatedPresentationReport
  extends PresentationReportInput {
  readonly calibrationStatus: typeof PRESENTATION_REPORT_CALIBRATION_STATUS;
  readonly staticAssessmentStatus: "SCORED" | "NOT_ASSESSABLE";
  readonly staticTotal: number | null;
  readonly staticMaxScore: 80;
  readonly presentationEffectivenessIncludedInStaticTotal: false;
  readonly contentErrors: readonly PresentationReportFinding[];
  readonly contentOmissions: readonly PresentationReportFinding[];
  readonly layoutAndReadabilityIssues: readonly PresentationReportFinding[];
  readonly unverifiedCapabilities: readonly string[];
}

const DIMENSION_MAX = new Map<PresentationReportDimension, number>(
  PRESENTATION_REPORT_DIMENSIONS.map(({ dimension, maxScore }) => [
    dimension,
    maxScore,
  ]),
);

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function assertEvidenceIds(
  evidenceIds: readonly string[],
  label: string,
): void {
  if (evidenceIds.length === 0 || evidenceIds.some((id) => id.trim() === "")) {
    throw new Error(`${label} requires evidence`);
  }
}

function assertScore(
  status: PresentationReportAssessmentStatus,
  score: number | null,
  maxScore: number,
  evidenceIds: readonly string[],
  label: string,
): void {
  if (status === "UNKNOWN") {
    if (score !== null) throw new Error(`${label} UNKNOWN assessment must have a null score`);
    return;
  }
  if (score === null || !Number.isInteger(score) || score < 0 || score > maxScore) {
    throw new Error(`${label} score must be an integer from 0 to ${maxScore}`);
  }
  assertEvidenceIds(evidenceIds, label);
}

function assertPageSelection(
  selection: PresentationPageSelection,
  label: string,
): void {
  if (!Number.isInteger(selection.pageNumber) || selection.pageNumber < 1) {
    throw new Error(`${label} pageNumber must be a positive integer`);
  }
  assertEvidenceIds(selection.evidenceIds, label);
  assertNonEmpty(selection.reason, `${label} reason`);
}

export function aggregatePresentationReport(
  input: PresentationReportInput,
): AggregatedPresentationReport {
  if (input.reportIndexVersion !== PRESENTATION_REPORT_INDEX_VERSION) {
    throw new Error("Unsupported Presentation report index version");
  }
  assertNonEmpty(input.rubricVersion, "rubricVersion");
  assertNonEmpty(input.artifactId, "artifactId");

  const assessments = new Map<PresentationReportDimension, PresentationDimensionAssessment>();
  for (const assessment of input.dimensions) {
    const maxScore = DIMENSION_MAX.get(assessment.dimension);
    if (maxScore === undefined) {
      throw new Error(`Unknown Presentation report dimension: ${assessment.dimension}`);
    }
    if (assessments.has(assessment.dimension)) {
      throw new Error(`Duplicate Presentation report dimension: ${assessment.dimension}`);
    }
    assertScore(assessment.status, assessment.score, maxScore, assessment.evidenceIds, assessment.dimension);
    assertNonEmpty(assessment.rationale, `${assessment.dimension} rationale`);
    assessments.set(assessment.dimension, assessment);
  }
  if (assessments.size !== PRESENTATION_REPORT_DIMENSIONS.length) {
    throw new Error("Presentation report requires exactly five dimensions");
  }

  assertScore(
    input.presentationEffectiveness.status,
    input.presentationEffectiveness.score,
    10,
    input.presentationEffectiveness.evidenceIds,
    "Presentation effectiveness",
  );
  assertNonEmpty(input.presentationEffectiveness.rationale, "Presentation effectiveness rationale");
  assertPageSelection(input.strongestPage, "strongestPage");
  assertPageSelection(input.weakestPage, "weakestPage");

  const findingIds = new Set<string>();
  for (const finding of input.findings) {
    assertNonEmpty(finding.findingId, "findingId");
    if (findingIds.has(finding.findingId)) {
      throw new Error(`Duplicate findingId: ${finding.findingId}`);
    }
    findingIds.add(finding.findingId);
    if (!DIMENSION_MAX.has(finding.deductionOwner)) {
      throw new Error(`Unknown deductionOwner: ${finding.deductionOwner}`);
    }
    assertEvidenceIds(finding.evidenceIds, `Finding ${finding.findingId}`);
    assertNonEmpty(finding.description, `Finding ${finding.findingId} description`);
    if (finding.pageNumbers.some((pageNumber) => !Number.isInteger(pageNumber) || pageNumber < 1)) {
      throw new Error(`Finding ${finding.findingId} has an invalid page number`);
    }
  }

  for (const capability of input.operationalCapabilities) {
    assertNonEmpty(capability.capability, "Operational capability");
    assertNonEmpty(capability.note, `${capability.capability} note`);
    if (capability.status !== "UNVERIFIED") {
      assertEvidenceIds(capability.evidenceIds, `Operational capability evidence: ${capability.capability}`);
    }
  }

  const orderedDimensions = PRESENTATION_REPORT_DIMENSIONS.map(
    ({ dimension }) => assessments.get(dimension)!,
  );
  const scored = orderedDimensions.every(
    (assessment) => assessment.status === "SCORED" && assessment.score !== null,
  );

  return {
    ...input,
    dimensions: orderedDimensions,
    calibrationStatus: PRESENTATION_REPORT_CALIBRATION_STATUS,
    staticAssessmentStatus: scored ? "SCORED" : "NOT_ASSESSABLE",
    staticTotal: scored
      ? orderedDimensions.reduce((sum, assessment) => sum + (assessment.score ?? 0), 0)
      : null,
    staticMaxScore: 80,
    presentationEffectivenessIncludedInStaticTotal: false,
    contentErrors: input.findings.filter(({ kind }) => kind === "CONTENT_ERROR"),
    contentOmissions: input.findings.filter(({ kind }) => kind === "CONTENT_OMISSION"),
    layoutAndReadabilityIssues: input.findings.filter(({ kind }) => kind === "LAYOUT_READABILITY"),
    unverifiedCapabilities: input.operationalCapabilities
      .filter(({ status }) => status === "UNVERIFIED")
      .map(({ capability }) => capability),
  };
}
