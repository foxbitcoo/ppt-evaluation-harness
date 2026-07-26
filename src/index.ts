export { createBakeoffHarness } from "./bakeoff.ts";
export {
  InMemoryFeishuProjection,
  type ArtifactScoreTablePort,
  type EvaluationCaseTablePort,
  type FeishuProjectionPort,
  type FeishuProjectionSnapshot,
  type ProductGapCardTablePort,
  type ReportDocumentPort,
  type RunRecordTablePort,
} from "./feishu.ts";
export { VOLCANO_CASE_ID } from "./fixtures/volcano-case.ts";
export { MockWpsProductAdapter } from "./mock-wps.ts";
export type {
  ProductAdapterPort,
  ProductPackageSnapshot,
  ProductRunCommand,
} from "./product-adapter.ts";
export type {
  Artifact,
  ArtifactScorecard,
  ArtifactScoreTableRecord,
  BakeoffJobOutcome,
  BakeoffJobSummary,
  EvaluationCaseRecord,
  DimensionScore,
  EvaluationInputManifest,
  FeishuReport,
  FeishuReportDraft,
  ProductGapCardRecord,
  RenderManifest,
  RunRecord,
  ScoreDimension,
  ScoreValue,
  StartBakeoffJobCommand,
  StaticSlideRender,
} from "./domain.ts";
