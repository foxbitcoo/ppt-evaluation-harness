import type {
  Artifact,
  ArtifactScorecard,
  DimensionScore,
  RenderManifest,
} from "./domain.ts";

const SCORECARD_ID = "MOCK-scorecard-wps-volcano-v1";
const JOB_ID = "MOCK-job-volcano-v1";
const RUN_ID = "MOCK-run-wps-volcano-v1";
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

const DIMENSIONS: readonly DimensionScore[] = Object.freeze([
  {
    dimension: "requirement_understanding_and_content_coverage",
    value: 5,
    evidencePages: [1, 2, 3, 15, 16],
    rationale: "封面、目录、13 页正文与第 16 页回顾完整满足显式结构要求。",
  },
  {
    dimension: "factual_accuracy_and_content_quality",
    value: 4,
    evidencePages: [3, 5, 7, 9, 13],
    rationale: "核心解释使用审慎表述，覆盖部分熔融、气体析出、压力与板块分布。",
  },
  {
    dimension: "narrative_and_audience_fit",
    value: 4,
    evidencePages: [2, 3, 9, 16],
    rationale: "从概念到机制、类型、监测和回顾的阅读路径清楚，适合初中生自读。",
  },
  {
    dimension: "visual_aesthetics_and_professional_finish",
    value: 4,
    evidencePages: [1, 10, 16],
    rationale: "固定暖色火山主题完整一致，视觉收束明确但细节仍为测试级。",
  },
  {
    dimension: "layout_hierarchy_and_readability",
    value: 4,
    evidencePages: [2, 8, 14],
    rationale: "页码、标题和正文层级稳定，关键内容在静态页面中可直接阅读。",
  },
  {
    dimension: "imagery_chart_and_information_expression",
    value: 3,
    evidencePages: [4, 7, 13],
    rationale: "信息表达基本可用，但 Mock 产物以文字为主，图解与地图仍可增强。",
  },
]);

export function scoreMockWpsArtifact(
  artifact: Artifact,
  renderManifest: RenderManifest,
): ArtifactScorecard {
  return {
    scorecardId: SCORECARD_ID,
    artifactId: artifact.artifactId,
    runId: RUN_ID,
    jobId: JOB_ID,
    provenance: "MOCK",
    rubricVersion: "query-six-dimension-v1",
    evaluationInputManifest: {
      artifactHash: artifact.contentHash,
      renderManifestHash: renderManifest.contentHash,
      renderer: renderManifest.renderer,
    },
    dimensions: structuredClone(DIMENSIONS),
    createdAt: FIXED_TIME,
  };
}
