import type {
  EnvironmentOrigin,
  TestEnvironmentOrigin,
} from "./environment-origin.ts";
import type {
  ArtifactPackageManifest,
} from "./artifact-vault.ts";
import type {
  ApprovedEgressAuthorization,
} from "./egress-authorization.ts";
import type {
  RunSpecificationReference,
} from "./run-specification.ts";
import type {
  ObservedProductConfiguration,
} from "./product-adapter.ts";

export const MOCK_PROVENANCE = "MOCK" as const;

export type MockProvenance = typeof MOCK_PROVENANCE;
export type ProvenanceLabel = MockProvenance | "PRODUCTION";

export type RunStatus =
  | "active"
  | "completed"
  | "partial"
  | "failed"
  | "timed_out"
  | "blocked"
  | "waiting_for_human";

export type TerminalReason =
  | "success"
  | "vendor_timeout"
  | "technical_failure"
  | "payment"
  | "quota"
  | "authentication"
  | "human_wait";

export type BlockReason = "payment" | "quota" | "authentication";

export type SubmissionEvidence = "not_submitted" | "submitted" | "unknown";

export interface BakeoffProtocolSnapshot {
  readonly protocolId: string;
  readonly referencePackMode: "automatic" | "force" | "off";
  readonly timeoutMs: number;
  readonly retryPolicy: "one_if_provably_not_submitted";
  readonly resultSelectionPolicy: "first_policy_compliant_artifact";
  readonly cancellationPolicy: "independent_vendor_runs_continue";
}

export interface ObservableAttemptEvent {
  readonly eventId: string;
  readonly jobId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly eventType: string;
  readonly sourceAt: string;
  readonly observedAt: string;
  readonly writerId: string;
  readonly evidenceRef: string;
}

export interface CostEvidence {
  readonly classification: "unknown";
  readonly amount: null;
  readonly currency: null;
}

export interface EvaluationCaseRecord {
  readonly recordId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly track: "query_generation";
  readonly title: string;
  readonly targetPageCount: number;
  readonly audience: string;
  readonly readingMode: "self_reading";
  readonly vendorPrompt: string;
}

export interface RunRecord {
  readonly recordId: string;
  readonly recordType: "bakeoff_job" | "vendor_run" | "evaluation_attempt";
  readonly jobId: string;
  readonly parentRecordId: string | null;
  readonly caseId: string;
  readonly product: string | null;
  readonly productVendorId: string | null;
  readonly productPackageId: string | null;
  readonly adapterVersion: string | null;
  readonly status: RunStatus;
  readonly attemptSeq: number | null;
  readonly elapsedMs: number | null;
  readonly submissionEvidence: SubmissionEvidence | null;
  readonly terminalReason: Exclude<TerminalReason, "human_wait"> | null;
  readonly waitingReason: "human_intervention" | null;
  readonly blockReason: BlockReason | null;
  readonly retryOfAttemptId: string | null;
  readonly selectedRunIds: readonly string[] | null;
  readonly protocolSnapshot: BakeoffProtocolSnapshot | null;
  readonly deadlineAt: string | null;
  readonly vendorGenerationMs: number | null;
  readonly vendorReportedElapsedMs: number | null;
  readonly humanWaitMs: number | null;
  readonly timingPausedAt: string | null;
  readonly observableEvents: readonly ObservableAttemptEvent[] | null;
  readonly manualActions: readonly string[] | null;
  readonly productConfigurationEvidence?: ObservedProductConfiguration | null;
  readonly costEvidence: CostEvidence | null;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly createdAt: string;
  readonly lastSyncedAt: string;
  readonly reportUrl: string | null;
  readonly auxiliaryReportUrls: readonly string[] | null;
  readonly artifactId: string | null;
  readonly renderManifestId: string | null;
  readonly scorecardId: string | null;
  readonly judgeEgressAttempt?: JudgeEgressAttemptAudit | null;
  readonly judgeFailure?: JudgeFailureLineage | null;
  readonly specificationReference?: RunSpecificationReference | null;
  readonly artifactPackageManifest?: ArtifactPackageManifest | null;
  readonly egressAuthorizations?: readonly ApprovedEgressAuthorization[] | null;
  readonly securityContextHash?: `sha256:${string}` | null;
}

export interface Artifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly contentHash: `sha256:${string}`;
  readonly capturedAt: string;
  readonly content: Uint8Array;
}

export interface StaticSlideRender {
  readonly pageNumber: number;
  readonly filename: string;
  readonly mimeType: "image/svg+xml";
  readonly contentHash: `sha256:${string}`;
  readonly content: string;
  readonly extractedText: string;
}

export interface RenderPolicy {
  readonly fontPack: string;
  readonly resolution: string;
  readonly colorProfile: string;
  readonly animationPolicy: "first_frame";
  readonly externalAssetPolicy: "network_disabled";
}

export interface ContactSheetRender {
  readonly filename: string;
  readonly mimeType: "image/svg+xml";
  readonly contentHash: `sha256:${string}`;
  readonly content: string;
}

export interface RenderManifest {
  readonly renderManifestId: string;
  readonly artifactId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly renderer: "mock-static-svg@1";
  readonly pageCount: number;
  readonly renderPolicy: RenderPolicy;
  readonly contactSheet: ContactSheetRender;
  readonly contentHash: `sha256:${string}`;
  readonly slides: readonly StaticSlideRender[];
}

export type ScoreDimension =
  | "requirement_understanding_and_content_coverage"
  | "factual_accuracy_and_content_quality"
  | "narrative_and_audience_fit"
  | "visual_aesthetics_and_professional_finish"
  | "layout_hierarchy_and_readability"
  | "imagery_chart_and_information_expression";

export type ScoreValue = 1 | 2 | 3 | 4 | 5;

export type DimensionAssessmentStatus = "ASSESSED" | "NOT_ASSESSABLE";

export type DimensionDeductionBasis =
  | "no_deduction"
  | "visible_requirement_or_coverage_gap"
  | "validated_reference_pack_errors"
  | "not_assessable_no_reference_pack"
  | "visible_narrative_or_audience_gap"
  | "visible_visual_finish_gap"
  | "visible_layout_or_readability_gap"
  | "visible_information_expression_gap";

export interface DimensionScore {
  readonly dimension: ScoreDimension;
  readonly assessmentStatus: DimensionAssessmentStatus;
  readonly value: ScoreValue | null;
  readonly deductionBasis: DimensionDeductionBasis;
  readonly evidencePages: readonly number[];
  readonly rationale: string;
}

export interface KnowledgeErrorDeduction {
  readonly pageNumber: number;
  readonly claim: string;
  readonly correction: string;
  readonly factId: string;
  readonly sourceIds: readonly string[];
}

export interface RasterizedImageLineage {
  readonly pageNumber: number;
  readonly mimeType: "image/png";
  readonly contentHash: `sha256:${string}`;
}

export type JudgeEgressContentField =
  | "evaluation_case"
  | "reference_pack"
  | "extracted_slide_text"
  | "static_slide_images";

export interface JudgeEgressAuthorizationLineage {
  readonly decisionId: string;
  readonly decision: "approved";
  readonly policyVersion: string;
  readonly dataClassification: "public_or_synthetic";
  readonly sourceOwner: string;
  readonly processingPurpose: "presentation_artifact_evaluation";
  readonly targetService: "openai";
  readonly targetAccount: string;
  readonly targetRegion: string;
  readonly subprocessors: readonly string[];
  readonly allowedContentFields: readonly JudgeEgressContentField[];
  readonly requiredRedactions: readonly string[];
  readonly legalSecurityBasis: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface JudgeEgressAttemptAudit {
  readonly attemptId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly scorecardId: string;
  readonly payloadHash: `sha256:${string}`;
  readonly idempotencyKey: `judge_${string}`;
  readonly egressAuthorizationHash: `sha256:${string}`;
  readonly egressAuthorization: JudgeEgressAuthorizationLineage;
  readonly recordedAt: string;
}

export interface JudgeFailureLineage {
  readonly failureClass: "judge_failure";
  readonly submissionStatus: "submitted" | "unknown";
  readonly message: string;
  readonly egressAttempt: JudgeEgressAttemptAudit | null;
}

export interface JudgeLineage {
  readonly provider: "openai";
  readonly adapterVersion: "openai-responses-judge@1";
  readonly requestedModel: "gpt-5.6-sol";
  readonly responseModel: string;
  readonly responseId: string;
  readonly promptVersion: "query-six-dimension-judge-prompt-v1";
  readonly promptHash: `sha256:${string}`;
  readonly configHash: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly contextHash: `sha256:${string}`;
  readonly payloadHash: `sha256:${string}`;
  readonly egressAuthorizationHash: `sha256:${string}`;
  readonly egressAuthorization: JudgeEgressAuthorizationLineage;
  readonly egressAttemptId: string;
  readonly egressAttempt: JudgeEgressAttemptAudit;
  readonly inputHash: `sha256:${string}`;
  readonly idempotencyKey: `judge_${string}`;
  readonly rasterizerVersion: string;
  readonly rasterizedImagesHash: `sha256:${string}`;
  readonly rasterizedImageHashes: readonly RasterizedImageLineage[];
  readonly imageDetail: "high";
  readonly store: false;
}

export interface EvaluationInputManifest {
  readonly artifactHash: `sha256:${string}`;
  readonly renderManifestHash: `sha256:${string}`;
  readonly renderer: "mock-static-svg@1";
  readonly referencePackHash: `sha256:${string}` | null;
}

export interface DeliveryQualityGate {
  readonly gate:
    | "artifact_captured_and_openable"
    | "sufficient_faithful_visual_input"
    | "required_delivery_export_format";
  readonly status: "PASS" | "CONDITIONAL" | "FAIL" | "NOT_ASSESSABLE";
  readonly effect: "exclude_from_quality" | "score_normally_with_flag";
}

export interface ArtifactScorecard {
  readonly scorecardId: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly rubricVersion: "query-six-dimension-v1";
  readonly evaluationInputManifest: EvaluationInputManifest;
  readonly dimensions: readonly DimensionScore[];
  readonly knowledgeErrors: readonly KnowledgeErrorDeduction[];
  readonly judgeLineage: JudgeLineage | null;
  readonly deliveryQualityGates: readonly DeliveryQualityGate[];
  readonly createdAt: string;
}

export interface ArtifactScoreTableRecord {
  readonly recordId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
  readonly scorecard: ArtifactScorecard;
  readonly comparisonCompatibilityFingerprint: ComparisonCompatibilityFingerprint;
}

export type DimensionReviewState =
  | "model_not_reviewed"
  | "human_reviewed";

export type EffectiveScoreSource = "model_original" | "human_adjudication";

export interface ReviewEventRecord {
  readonly recordType: "review_event";
  readonly schemaVersion: "review-event-v1";
  readonly reviewEventId: string;
  readonly scorecardId: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly reviewedDimensions: readonly ScoreDimension[];
  readonly decision: "accepted_model_scores";
  readonly actorId: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly lastSyncedAt: string;
  readonly reason: string;
  readonly priorReviewEventId: string | null;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
}

export interface AdjudicationEventRecord {
  readonly recordType: "adjudication_event";
  readonly schemaVersion: "adjudication-event-v1";
  readonly adjudicationEventId: string;
  readonly scorecardId: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly dimension: ScoreDimension;
  readonly modelOriginalAssessmentStatus: DimensionAssessmentStatus;
  readonly modelOriginalScore: ScoreValue | null;
  readonly humanFinalAssessmentStatus: "ASSESSED";
  readonly humanFinalScore: ScoreValue;
  readonly evidencePages: readonly number[];
  readonly actorId: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly lastSyncedAt: string;
  readonly reason: string;
  readonly priorAdjudicationEventId: string | null;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
}

export interface EffectiveDimensionScore {
  readonly dimension: ScoreDimension;
  readonly modelOriginalAssessmentStatus: DimensionAssessmentStatus;
  readonly modelOriginalValue: ScoreValue | null;
  readonly effectiveAssessmentStatus: DimensionAssessmentStatus;
  readonly effectiveValue: ScoreValue | null;
  readonly evidencePages: readonly number[];
  readonly rationale: string;
  readonly reviewState: DimensionReviewState;
  readonly source: EffectiveScoreSource;
  readonly adjudicationEventId: string | null;
}

export type ScorecardReviewState =
  | "model_not_reviewed"
  | "partially_human_reviewed"
  | "human_reviewed";

export interface EffectiveArtifactScorecard {
  readonly scorecardId: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly originalScorecard: ArtifactScorecard;
  readonly dimensions: readonly EffectiveDimensionScore[];
  readonly reviewState: ScorecardReviewState;
}

export interface ComparisonCompatibilityFingerprint {
  readonly caseManifestHash: `sha256:${string}`;
  readonly caseInputHash: `sha256:${string}`;
  readonly track: EvaluationCaseRecord["track"];
  readonly protocolHash: `sha256:${string}`;
  readonly rubricVersion: ArtifactScorecard["rubricVersion"];
  readonly scenarioWeightProfile: null;
  readonly judgeConfigurationHash: `sha256:${string}`;
  readonly renderPipelineHash: `sha256:${string}`;
  readonly designJudgmentSurfaceHash: `sha256:${string}`;
  readonly referencePackHash: `sha256:${string}` | null;
}

export interface CapturedArtifactTableRecord {
  readonly recordId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
}

export interface ComparisonRecord {
  readonly recordType: "comparison";
  readonly comparisonId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly leftRunId: string;
  readonly rightRunId: string;
  readonly leftScorecardId: string;
  readonly rightScorecardId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
}

export interface ComparisonDimensionResult {
  readonly dimension: ScoreDimension;
  readonly assessmentStatus: DimensionAssessmentStatus;
  readonly leftAssessmentStatus: DimensionAssessmentStatus;
  readonly rightAssessmentStatus: DimensionAssessmentStatus;
  readonly leftValue: ScoreValue | null;
  readonly rightValue: ScoreValue | null;
  readonly difference: number | null;
  readonly leftEvidencePages: readonly number[];
  readonly rightEvidencePages: readonly number[];
  readonly leftReviewState: DimensionReviewState;
  readonly rightReviewState: DimensionReviewState;
  readonly leftScoreSource: EffectiveScoreSource;
  readonly rightScoreSource: EffectiveScoreSource;
  readonly leftAdjudicationEventId: string | null;
  readonly rightAdjudicationEventId: string | null;
}

export interface DynamicComparisonView extends ComparisonRecord {
  readonly leftProduct: string;
  readonly rightProduct: string;
  readonly dimensions: readonly ComparisonDimensionResult[];
}

export interface ComparisonPairSelection {
  readonly leftRunId: string;
  readonly leftScorecardId?: string;
  readonly rightRunId: string;
  readonly rightScorecardId?: string;
}

export interface PageEvidenceLink {
  readonly pageNumber: number;
  readonly url: string;
}

export interface ProductGapEvidence {
  readonly product: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly scorecardId: string;
  readonly value: ScoreValue;
  readonly rationale: string;
  readonly links: readonly PageEvidenceLink[];
}

export type PipelineCauseHypothesis =
  | "outline_or_content"
  | "layout_selection"
  | "layout_execution"
  | "imagery"
  | "charting"
  | "rendering_or_export";

export interface CauseHypothesis {
  readonly label: "HYPOTHESIS";
  readonly pipelineStage: PipelineCauseHypothesis;
  readonly statement: string;
}

export interface ProductGapCardRecord {
  readonly recordType: "gap_card";
  readonly gapCardId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly comparisonId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly workflowState: "pending_review";
  readonly causeAttribution: "HYPOTHESIS";
  readonly dimension: ScoreDimension;
  readonly keyPages: {
    readonly left: readonly number[];
    readonly right: readonly number[];
  };
  readonly leftEvidence: ProductGapEvidence;
  readonly rightEvidence: ProductGapEvidence;
  readonly impact: string;
  readonly causeHypothesis: CauseHypothesis;
  readonly proposedExperiment: string;
  readonly acceptanceMetric: string;
}

export type ProductGapCardWorkflowState =
  | "pending_review"
  | "confirmed_for_delivery"
  | "rejected";

export interface ProductGapCardWorkflowEventRecord {
  readonly recordType: "gap_card_workflow_event";
  readonly schemaVersion: "gap-card-workflow-event-v1";
  readonly workflowEventId: string;
  readonly gapCardId: string;
  readonly decision: Exclude<
    ProductGapCardWorkflowState,
    "pending_review"
  >;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly lastSyncedAt: string;
  readonly reason: string;
  readonly priorWorkflowEventId: string | null;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
}

export interface GitHubIssueLinkEventRecord {
  readonly recordType: "github_issue_link_event";
  readonly schemaVersion: "github-issue-link-event-v1";
  readonly linkEventId: string;
  readonly gapCardId: string;
  readonly idempotencyKey: string;
  readonly confirmedByWorkflowEventId: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly lastSyncedAt: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
}

export interface GitHubIssueDeliveryReservationRecord {
  readonly recordType: "github_issue_delivery_reservation";
  readonly schemaVersion: "github-issue-delivery-reservation-v1";
  readonly reservationId: string;
  readonly gapCardId: string;
  readonly idempotencyKey: string;
  readonly confirmedByWorkflowEventId: string;
  readonly requestedByActorId: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly lastSyncedAt: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
}

export interface LinkedGitHubIssue {
  readonly issueNumber: number;
  readonly issueUrl: string;
}

export interface ProductGapCardWorkflowView {
  readonly gapCard: ProductGapCardRecord;
  readonly workflowState: ProductGapCardWorkflowState;
  readonly latestWorkflowEventId: string | null;
  readonly githubIssue: LinkedGitHubIssue | null;
}

export interface VendorFinding {
  readonly dimension: ScoreDimension;
  readonly comparedWith: string;
  readonly difference: number;
  readonly evidenceLinks: readonly PageEvidenceLink[];
}

export interface VendorComparisonSummary {
  readonly product: string;
  readonly runId: string;
  readonly majorStrengths: readonly VendorFinding[];
  readonly majorIssues: readonly VendorFinding[];
}

export interface FeishuReportDraft {
  readonly reportId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly title: string;
  readonly jobId: string;
  readonly runIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly claimLevel: "case_sample";
  readonly markdown: string;
  readonly createdAt: string;
}

export interface FeishuReport extends FeishuReportDraft {
  readonly url: string;
}

export interface ComparisonReportOutcome {
  readonly comparisons: readonly DynamicComparisonView[];
  readonly gapCards: readonly ProductGapCardRecord[];
  readonly vendorSummaries: readonly VendorComparisonSummary[];
  readonly report: FeishuReport;
}

export interface BakeoffJobSummary {
  readonly jobId: string;
  readonly caseId: string;
  readonly environment: "test" | "production";
  readonly status: "active" | "completed" | "partial" | "failed";
  readonly provenance: MockProvenance;
  readonly environmentOrigin: TestEnvironmentOrigin;
}

export interface BakeoffJobOutcome {
  readonly job: BakeoffJobSummary;
  readonly artifact: Artifact | null;
  readonly renderManifest: RenderManifest | null;
  readonly scorecard: ArtifactScorecard | null;
  readonly artifacts: readonly Artifact[];
  readonly renderManifests: readonly RenderManifest[];
  readonly scorecards: readonly ArtifactScorecard[];
  readonly report: FeishuReport;
}

export interface StartBakeoffJobCommand {
  readonly environment: "test" | "production";
  readonly caseId: string;
  readonly referencePackMode?: "automatic" | "force" | "off";
}
