import type {
  Artifact,
  ArtifactScorecard,
  RunStatus,
  FeishuReportDraft,
  ScoreDimension,
  TerminalReason,
} from "./domain.ts";
import { MOCK_TEST_ENVIRONMENT_ORIGIN } from "./environment-origin.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";

export interface MockReportVendorResult {
  readonly product: string;
  readonly runId: string;
  readonly status: RunStatus;
  readonly stateReason: TerminalReason;
  readonly artifact: Artifact | null;
  readonly scorecard: ArtifactScorecard | null;
}

const DIMENSION_LABELS: Readonly<Record<ScoreDimension, string>> = {
  requirement_understanding_and_content_coverage: "需求理解与内容覆盖",
  factual_accuracy_and_content_quality: "事实准确与内容质量",
  narrative_and_audience_fit: "叙事与受众适配",
  visual_aesthetics_and_professional_finish: "视觉美感与专业完成度",
  layout_hierarchy_and_readability: "版式层级与可读性",
  imagery_chart_and_information_expression: "配图、图表与信息表达",
};

export function createMockReportDraft(
  jobId: string,
  jobStatus: "active" | "completed" | "partial" | "failed",
  results: readonly MockReportVendorResult[],
): FeishuReportDraft {
  const firstResult = results[0];
  if (firstResult === undefined) {
    throw new Error("A Mock report requires at least one vendor Run");
  }
  const vendorSections = results
    .map(({ product, runId, status, stateReason, artifact, scorecard }) => {
      if (artifact === null || scorecard === null) {
        return `## ${product}

- Run：\`${runId}\`
- 状态：\`${status}\`
- 状态原因：\`${stateReason}\`
- Artifact：无`;
      }
      const scoreRows = scorecard.dimensions
        .map(
          ({ dimension, value, evidencePages, rationale }) =>
            `| ${DIMENSION_LABELS[dimension]} | ${value} | ${evidencePages.join("、")} | ${rationale} |`,
        )
        .join("\n");
      return `## ${product}

- Run：\`${scorecard.runId}\`
- 状态：\`${status}\`
- 状态原因：\`${stateReason}\`
- Artifact：\`${artifact.artifactId}\`
- Artifact SHA-256：\`${artifact.contentHash}\`
- 页数：${artifact.pageCount}

| 六维评分 | 1–5 整数分 | 页码证据 | 简短理由 |
|---|---:|---|---|
${scoreRows}`;
    })
    .join("\n\n");
  const markdown = `# MOCK｜火山 Case Sample 三厂商评测报告

> **MOCK 测试数据，禁止作为真实厂商结论。**

- Bakeoff Job：\`${jobId}\`
- Job 状态：\`${jobStatus}\`
- 证据等级：Case Sample（仅适用于当前固定 Mock 火山 Case）

${vendorSections}

Delivery Quality 仅作为自动门禁另行记录，不进入六维主观评分。本报告展示独立维度，不生成总分或总冠军，也不外推为稳定厂商排名。
`;
  return {
    reportId: MOCK_SCENARIO.reportId,
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    title: "MOCK｜火山 Case Sample 三厂商评测报告",
    jobId,
    runIds: results.map(({ runId }) => runId),
    artifactIds: results.flatMap(({ artifact }) =>
      artifact === null ? [] : [artifact.artifactId],
    ),
    claimLevel: "case_sample",
    markdown,
    createdAt: MOCK_SCENARIO.fixedTime,
  };
}
