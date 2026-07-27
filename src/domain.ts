import type {
  EnvironmentOrigin,
  TestEnvironmentOrigin,
} from "./environment-origin.ts";

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
  readonly recordType:
    | "bakeoff_job"
    | "vendor_run"
    | "evaluation_attempt";
  readonly jobId: string;
  readonly parentRecordId: string | null;
  readonly caseId: string;
  readonly product: string | null;
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
  readonly costEvidence: CostEvidence | null;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly createdAt: string;
  readonly lastSyncedAt: string;
  readonly reportUrl: string | null;
  readonly artifactId: string | null;
  readonly renderManifestId: string | null;
  readonly scorecardId: string | null;
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

export interface RenderManifest {
  readonly renderManifestId: string;
  readonly artifactId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly renderer: "mock-static-svg@1";
  readonly pageCount: number;
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

export interface DimensionScore {
  readonly dimension: ScoreDimension;
  readonly value: ScoreValue;
  readonly evidencePages: readonly number[];
  readonly rationale: string;
}

export interface EvaluationInputManifest {
  readonly artifactHash: `sha256:${string}`;
  readonly renderManifestHash: `sha256:${string}`;
  readonly renderer: "mock-static-svg@1";
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

export interface ProductGapCardRecord {
  readonly recordType: "gap_card";
  readonly gapCardId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly comparisonId: string;
  readonly provenance: ProvenanceLabel;
  readonly environmentOrigin: EnvironmentOrigin;
  readonly workflowState: "draft";
  readonly causeAttribution: "HYPOTHESIS";
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
}
