export {
  VENDOR_GENERATION_TIMEOUT_MS,
  createBakeoffHarness,
} from "./bakeoff.ts";
export {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  assertEnvironmentOriginAllowed,
  type EnvironmentOrigin,
  type ProductionEnvironmentOrigin,
  type TestEnvironmentOrigin,
} from "./environment-origin.ts";
export {
  InMemoryFeishuProjection,
  type ArtifactScoreTablePort,
  type EvaluationCaseTablePort,
  type FeishuProjectionPort,
  type FeishuProjectionSnapshot,
  type InMemoryFeishuProjectionOptions,
  type ProductGapCardTablePort,
  type ReportDocumentPort,
  type RunRecordTablePort,
} from "./feishu.ts";
export { VOLCANO_CASE_ID } from "./fixtures/volcano-case.ts";
export {
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  type MockAdapterOptions,
  type MockAdapterScenario,
} from "./mock-wps.ts";
export type {
  ArtifactCandidate,
  ProductAttemptResult,
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
  BlockReason,
  DeliveryQualityGate,
  EvaluationCaseRecord,
  DimensionScore,
  EvaluationInputManifest,
  FeishuReport,
  FeishuReportDraft,
  ProductGapCardRecord,
  RenderManifest,
  RunRecord,
  RunStatus,
  ScoreDimension,
  ScoreValue,
  StartBakeoffJobCommand,
  StaticSlideRender,
  SubmissionEvidence,
  TerminalReason,
} from "./domain.ts";
