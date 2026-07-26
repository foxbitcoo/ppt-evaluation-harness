import type {
  Artifact,
  ArtifactScorecard,
  DimensionScore,
  RenderManifest,
  ScoreValue,
} from "./domain.ts";
import { MOCK_TEST_ENVIRONMENT_ORIGIN } from "./environment-origin.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";

export interface ScoreContext {
  readonly jobId: string;
  readonly runId: string;
  readonly scorecardId?: string;
}

function boundedScore(passedChecks: number, totalChecks: number): ScoreValue {
  if (passedChecks === totalChecks) return 5;
  if (passedChecks >= totalChecks - 1) return 4;
  if (passedChecks >= Math.ceil(totalChecks / 2)) return 3;
  if (passedChecks > 0) return 2;
  return 1;
}

function scoreDimensions(
  renderManifest: RenderManifest,
): readonly DimensionScore[] {
  const pages = renderManifest.slides;
  const pageText = (pageNumber: number): string =>
    pages[pageNumber - 1]?.extractedText ?? "";
  const allText = pages.map(({ extractedText }) => extractedText).join("\n");
  const requirementChecks = [
    pages.length === 16,
    pageText(1).includes("火山为什么会喷发"),
    pageText(2).includes("目录"),
    pages.slice(2, 15).length === 13,
    pageText(16).includes("知识回顾"),
  ];
  const requirementValue = boundedScore(
    requirementChecks.filter(Boolean).length,
    requirementChecks.length,
  );
  const factualTerms = ["部分熔融", "岩浆", "气体", "压力", "板块", "监测"];
  const factualCoverage = factualTerms.filter((term) =>
    allText.includes(term),
  ).length;
  const factualValue: ScoreValue =
    factualCoverage >= 5
      ? 4
      : factualCoverage >= 3
        ? 3
        : factualCoverage > 0
          ? 2
          : 1;
  const narrativeValue: ScoreValue =
    pageText(2).includes("认识火山") &&
    pageText(9).includes("压力") &&
    pageText(16).includes("回顾")
      ? 4
      : 3;
  const consistentTheme = pages.every(
    ({ content }) =>
      content.includes('fill="#211314"') &&
      content.includes('fill="#ff6b35"'),
  );
  const aestheticsValue: ScoreValue = consistentTheme ? 4 : 2;
  const readableLayout = pages.every(
    ({ content, extractedText }) =>
      content.includes('font-size="64"') &&
      content.includes('font-size="30"') &&
      extractedText.length <= 120,
  );
  const readabilityValue: ScoreValue = readableLayout ? 4 : 2;
  const hasRichVisualExpression = pages.some(({ content }) =>
    /<(?:image|path|circle)\b/.test(content),
  );
  const expressionValue: ScoreValue = hasRichVisualExpression ? 4 : 3;

  return [
    {
      dimension: "requirement_understanding_and_content_coverage",
      value: requirementValue,
      evidencePages: [1, 2, 3, 15, 16],
      rationale:
        requirementValue === 5
          ? "封面、目录、13 页正文与第 16 页回顾完整满足显式结构要求。"
          : "静态页面证据未完整满足封面、目录、13 页正文和第 16 页回顾结构。",
    },
    {
      dimension: "factual_accuracy_and_content_quality",
      value: factualValue,
      evidencePages: [3, 5, 7, 9, 13],
      rationale: `静态文本覆盖 ${factualCoverage}/${factualTerms.length} 个核心机制证据词，表述保持测试级审慎。`,
    },
    {
      dimension: "narrative_and_audience_fit",
      value: narrativeValue,
      evidencePages: [2, 3, 9, 16],
      rationale:
        narrativeValue === 4
          ? "从目录到压力机制和知识回顾的阅读路径清楚，适合初中生自读。"
          : "静态文本的目录、机制展开或知识回顾链路不完整。",
    },
    {
      dimension: "visual_aesthetics_and_professional_finish",
      value: aestheticsValue,
      evidencePages: [1, 10, 16],
      rationale: consistentTheme
        ? "所有静态渲染使用一致的暖色火山主题，完成度稳定但仍为测试级。"
        : "静态渲染未保持统一的主题色与视觉完成度。",
    },
    {
      dimension: "layout_hierarchy_and_readability",
      value: readabilityValue,
      evidencePages: [2, 8, 14],
      rationale: readableLayout
        ? "标题、正文与页码字号层级稳定，静态文本长度适合直接阅读。"
        : "部分静态页面缺少稳定字号层级或文本密度过高。",
    },
    {
      dimension: "imagery_chart_and_information_expression",
      value: expressionValue,
      evidencePages: [4, 7, 13],
      rationale: hasRichVisualExpression
        ? "静态渲染包含文字之外的图形表达，信息呈现较完整。"
        : "信息表达基本可用，但 Mock 产物以文字为主，图解与地图仍可增强。",
    },
  ];
}

export function scoreRenderedArtifact(
  artifact: Artifact,
  renderManifest: RenderManifest,
  context: ScoreContext,
): ArtifactScorecard {
  if (renderManifest.artifactId !== artifact.artifactId) {
    throw new Error("Render manifest does not belong to the captured Artifact");
  }
  return {
    scorecardId: context.scorecardId ?? MOCK_SCENARIO.scorecardId,
    artifactId: artifact.artifactId,
    runId: context.runId,
    jobId: context.jobId,
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    rubricVersion: "query-six-dimension-v1",
    evaluationInputManifest: {
      artifactHash: artifact.contentHash,
      renderManifestHash: renderManifest.contentHash,
      renderer: renderManifest.renderer,
    },
    dimensions: scoreDimensions(renderManifest),
    deliveryQualityGates: [
      {
        gate: "artifact_captured_and_openable",
        status: "PASS",
        effect: "exclude_from_quality",
      },
      {
        gate: "sufficient_faithful_visual_input",
        status: "PASS",
        effect: "exclude_from_quality",
      },
      {
        gate: "required_delivery_export_format",
        status: "PASS",
        effect: "score_normally_with_flag",
      },
    ],
    createdAt: MOCK_SCENARIO.fixedTime,
  };
}
