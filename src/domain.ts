export const MOCK_PROVENANCE = "MOCK" as const;

export type MockProvenance = typeof MOCK_PROVENANCE;

export interface EvaluationCaseRecord {
  readonly recordId: string;
  readonly provenance: MockProvenance;
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
  readonly recordType: "bakeoff_job" | "vendor_run";
  readonly jobId: string;
  readonly parentRecordId: string | null;
  readonly caseId: string;
  readonly product: string | null;
  readonly productPackageId: string | null;
  readonly adapterVersion: string | null;
  readonly status: "completed";
  readonly provenance: MockProvenance;
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
  readonly provenance: MockProvenance;
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
  readonly provenance: MockProvenance;
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

export interface ArtifactScorecard {
  readonly scorecardId: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly provenance: MockProvenance;
  readonly rubricVersion: "query-six-dimension-v1";
  readonly evaluationInputManifest: EvaluationInputManifest;
  readonly dimensions: readonly DimensionScore[];
  readonly createdAt: string;
}

export interface ArtifactScoreTableRecord {
  readonly recordId: string;
  readonly provenance: MockProvenance;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
  readonly scorecard: ArtifactScorecard;
}

export interface ProductGapCardRecord {
  readonly gapCardId: string;
  readonly jobId: string;
  readonly provenance: MockProvenance;
  readonly workflowState: "draft";
  readonly causeAttribution: "HYPOTHESIS";
}

export interface FeishuReportDraft {
  readonly reportId: string;
  readonly provenance: MockProvenance;
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
  readonly environment: "test";
  readonly status: "completed";
  readonly provenance: MockProvenance;
}

export interface BakeoffJobOutcome {
  readonly job: BakeoffJobSummary;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
  readonly scorecard: ArtifactScorecard;
  readonly report: FeishuReport;
}

export interface StartBakeoffJobCommand {
  readonly environment: "test";
  readonly caseId: string;
}
