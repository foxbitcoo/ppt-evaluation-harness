import type {
  Artifact,
  ArtifactScorecard,
  RunStatus,
  FeishuReportDraft,
  JudgeFailureLineage,
  RenderManifest,
  ScoreDimension,
  TerminalReason,
} from "./domain.ts";
import { MOCK_TEST_ENVIRONMENT_ORIGIN } from "./environment-origin.ts";
import type { EnvironmentOrigin } from "./environment-origin.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";

export interface MockReportVendorResult {
  readonly product: string;
  readonly runId: string;
  readonly status: RunStatus;
  readonly stateReason: TerminalReason;
  readonly artifact: Artifact | null;
  readonly scorecard: ArtifactScorecard | null;
  readonly judgeFailure: JudgeFailureLineage | null;
  readonly renderManifest?: RenderManifest | null;
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
  lineage: {
    readonly provenance: "MOCK" | "PRODUCTION";
    readonly environmentOrigin: EnvironmentOrigin;
    readonly createdAt: string;
  } = {
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    createdAt: MOCK_SCENARIO.fixedTime,
  },
): FeishuReportDraft {
  const firstResult = results[0];
  if (firstResult === undefined) {
    throw new Error("A Case Sample report requires at least one vendor Run");
  }
  const vendorSections = results
    .map(
      ({
        product,
        runId,
        status,
        stateReason,
        artifact,
        scorecard,
        judgeFailure,
        renderManifest,
      }) => {
        if (artifact === null) {
          return `## ${product}

- Run：\`${runId}\`
- 状态：\`${status}\`
- 状态原因：\`${stateReason}\`
- Artifact：无`;
        }
        if (scorecard === null) {
          const degradedRender =
            renderManifest !== null &&
            renderManifest !== undefined &&
            renderManifest.renderOutcome !== "faithful";
          return `## ${product}

- Run：\`${runId}\`
- 状态：\`${status}\`
- 状态原因：\`${stateReason}\`
- Artifact：\`${artifact.artifactId}\`
- Artifact SHA-256：\`${artifact.contentHash}\`
- 页数：${artifact.pageCount}
${
  degradedRender && judgeFailure === null
    ? `- 静态渲染：\`${renderManifest.renderOutcome}\`（Artifact 已留存）
- 视觉评估：\`NOT_ASSESSABLE\`（渲染保真门禁未通过，Judge 未调用）`
    : `- Judge：失败（\`${judgeFailure?.submissionStatus ?? "unknown"}\`），Artifact 与静态渲染已独立留存`
}`;
        }
        const scoreRows = scorecard.dimensions
          .map(
            ({ dimension, value, evidencePages, rationale }) =>
              `| ${DIMENSION_LABELS[dimension]} | ${value ?? "NOT_ASSESSABLE"} | ${evidencePages.join("、") || "—"} | ${rationale} |`,
          )
          .join("\n");
        return `## ${product}

- Run：\`${scorecard.runId}\`
- 状态：\`${status}\`
- 状态原因：\`${stateReason}\`
- Artifact：\`${artifact.artifactId}\`
- Artifact SHA-256：\`${artifact.contentHash}\`
- 页数：${artifact.pageCount}

| 六维评分 | 1–5 整数分 / NOT_ASSESSABLE | 页码证据 | 简短理由 |
|---|---:|---|---|
${scoreRows}`;
      },
    )
    .join("\n\n");
  const reportPrefix = lineage.provenance === "MOCK" ? "MOCK｜" : "";
  const markdown = `# ${reportPrefix}火山 Case Sample 三厂商评测报告

${lineage.provenance === "MOCK" ? "> **MOCK 测试数据，禁止作为真实厂商结论。**" : "> **真实单次 Case Sample，仅记录当前运行，不外推为稳定厂商结论。**"}

- Bakeoff Job：\`${jobId}\`
- Job 状态：\`${jobStatus}\`
- 证据等级：Case Sample（${
    lineage.provenance === "MOCK"
      ? "仅适用于当前固定 Mock 火山 Case"
      : "仅适用于当前真实火山 Case 的单次样本"
  }）

${vendorSections}

本次未生成兼容的直接对比；相对比较为 \`NOT_ASSESSABLE\`。

Delivery Quality 仅作为自动门禁另行记录，不进入六维主观评分。本报告展示独立维度，不生成总分或总冠军，也不外推为稳定厂商排名。
`;
  return {
    reportId:
      lineage.provenance === "MOCK"
        ? MOCK_SCENARIO.reportId
        : `${jobId}-report`,
    provenance: lineage.provenance,
    environmentOrigin: lineage.environmentOrigin,
    title: `${reportPrefix}火山 Case Sample 三厂商评测报告`,
    jobId,
    runIds: results.map(({ runId }) => runId),
    artifactIds: results.flatMap(({ artifact }) =>
      artifact === null ? [] : [artifact.artifactId],
    ),
    claimLevel: "case_sample",
    markdown,
    createdAt: lineage.createdAt,
  };
}
