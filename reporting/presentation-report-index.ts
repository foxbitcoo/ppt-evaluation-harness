export const PRESENTATION_REPORT_INDEX_VERSION =
  "report-index@0.2.0" as const;

export const PRESENTATION_REPORT_CALIBRATION_STATUS =
  "PROVISIONAL_SCORE_NOT_CALIBRATED" as const;

export const PRESENTATION_REPORT_RUBRIC_VERSION =
  "query-ppt-rubric@1.1.0" as const;

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
  readonly deductionKey: string;
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
  readonly rubricVersion: typeof PRESENTATION_REPORT_RUBRIC_VERSION;
  readonly artifactId: string;
  readonly dimensions: readonly PresentationDimensionAssessment[];
  readonly presentationEffectiveness: PresentationEffectivenessAssessment;
  readonly strongestPage: PresentationPageSelection;
  readonly weakestPage: PresentationPageSelection;
  readonly findings: readonly PresentationReportFinding[];
  readonly summaryParagraphs: readonly string[];
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

const ASSESSMENT_STATUSES = new Set<PresentationReportAssessmentStatus>([
  "SCORED",
  "UNKNOWN",
]);
const FINDING_KINDS = new Set<PresentationFindingKind>([
  "CONTENT_ERROR",
  "CONTENT_OMISSION",
  "LAYOUT_READABILITY",
  "OTHER",
]);
const OPERATIONAL_CAPABILITY_STATUSES =
  new Set<OperationalCapabilityStatus>([
    "VERIFIED",
    "FAILED",
    "UNVERIFIED",
  ]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

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
  if (!ASSESSMENT_STATUSES.has(status)) {
    throw new Error(`${label} has an unknown assessment status`);
  }
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
  const snapshot = structuredClone(input) as PresentationReportInput;
  if (snapshot.reportIndexVersion !== PRESENTATION_REPORT_INDEX_VERSION) {
    throw new Error("Unsupported Presentation report index version");
  }
  if (snapshot.rubricVersion !== PRESENTATION_REPORT_RUBRIC_VERSION) {
    throw new Error("Unsupported Rubric version for Presentation report index");
  }
  assertNonEmpty(snapshot.artifactId, "artifactId");

  const assessments = new Map<PresentationReportDimension, PresentationDimensionAssessment>();
  for (const assessment of snapshot.dimensions) {
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
    snapshot.presentationEffectiveness.status,
    snapshot.presentationEffectiveness.score,
    10,
    snapshot.presentationEffectiveness.evidenceIds,
    "Presentation effectiveness",
  );
  assertNonEmpty(snapshot.presentationEffectiveness.rationale, "Presentation effectiveness rationale");
  assertPageSelection(snapshot.strongestPage, "strongestPage");
  assertPageSelection(snapshot.weakestPage, "weakestPage");

  if (snapshot.summaryParagraphs.length < 1 || snapshot.summaryParagraphs.length > 3) {
    throw new Error("Presentation report requires one to three summary paragraphs");
  }
  snapshot.summaryParagraphs.forEach((paragraph) =>
    assertNonEmpty(paragraph, "summary paragraph"),
  );
  if (snapshot.scenarioRecommendations.length === 0) {
    throw new Error("Presentation report requires at least one scenario recommendation");
  }
  snapshot.scenarioRecommendations.forEach((recommendation) =>
    assertNonEmpty(recommendation, "scenario recommendation"),
  );

  const findingIds = new Set<string>();
  const deductionKeys = new Set<string>();
  for (const finding of snapshot.findings) {
    assertNonEmpty(finding.findingId, "findingId");
    assertNonEmpty(finding.deductionKey, "deductionKey");
    if (findingIds.has(finding.findingId)) {
      throw new Error(`Duplicate findingId: ${finding.findingId}`);
    }
    findingIds.add(finding.findingId);
    if (deductionKeys.has(finding.deductionKey)) {
      throw new Error(`Duplicate deductionKey: ${finding.deductionKey}`);
    }
    deductionKeys.add(finding.deductionKey);
    if (!FINDING_KINDS.has(finding.kind)) {
      throw new Error(`Unknown finding kind: ${finding.kind}`);
    }
    if (!DIMENSION_MAX.has(finding.deductionOwner)) {
      throw new Error(`Unknown deductionOwner: ${finding.deductionOwner}`);
    }
    assertEvidenceIds(finding.evidenceIds, `Finding ${finding.findingId}`);
    assertNonEmpty(finding.description, `Finding ${finding.findingId} description`);
    if (finding.pageNumbers.some((pageNumber) => !Number.isInteger(pageNumber) || pageNumber < 1)) {
      throw new Error(`Finding ${finding.findingId} has an invalid page number`);
    }
  }

  for (const capability of snapshot.operationalCapabilities) {
    assertNonEmpty(capability.capability, "Operational capability");
    assertNonEmpty(capability.note, `${capability.capability} note`);
    if (!OPERATIONAL_CAPABILITY_STATUSES.has(capability.status)) {
      throw new Error(`Unknown operational capability status: ${capability.status}`);
    }
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

  return deepFreeze({
    ...snapshot,
    dimensions: orderedDimensions,
    calibrationStatus: PRESENTATION_REPORT_CALIBRATION_STATUS,
    staticAssessmentStatus: scored ? "SCORED" : "NOT_ASSESSABLE",
    staticTotal: scored
      ? orderedDimensions.reduce((sum, assessment) => sum + (assessment.score ?? 0), 0)
      : null,
    staticMaxScore: 80,
    presentationEffectivenessIncludedInStaticTotal: false as const,
    contentErrors: snapshot.findings.filter(({ kind }) => kind === "CONTENT_ERROR"),
    contentOmissions: snapshot.findings.filter(({ kind }) => kind === "CONTENT_OMISSION"),
    layoutAndReadabilityIssues: snapshot.findings.filter(({ kind }) => kind === "LAYOUT_READABILITY"),
    unverifiedCapabilities: snapshot.operationalCapabilities
      .filter(({ status }) => status === "UNVERIFIED")
      .map(({ capability }) => capability),
  });
}
