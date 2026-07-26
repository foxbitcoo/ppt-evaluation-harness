import type {
  Artifact,
  ArtifactScorecard,
  FeishuReportDraft,
  ScoreDimension,
} from "./domain.ts";

const REPORT_ID = "MOCK-report-volcano-v1";
const JOB_ID = "MOCK-job-volcano-v1";
const RUN_ID = "MOCK-run-wps-volcano-v1";
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

const DIMENSION_LABELS: Readonly<Record<ScoreDimension, string>> = {
  requirement_understanding_and_content_coverage: "需求理解与内容覆盖",
  factual_accuracy_and_content_quality: "事实准确与内容质量",
  narrative_and_audience_fit: "叙事与受众适配",
  visual_aesthetics_and_professional_finish: "视觉美感与专业完成度",
  layout_hierarchy_and_readability: "版式层级与可读性",
  imagery_chart_and_information_expression: "配图、图表与信息表达",
};

export function createMockReportDraft(
  artifact: Artifact,
  scorecard: ArtifactScorecard,
): FeishuReportDraft {
  const scoreRows = scorecard.dimensions
    .map(
      ({ dimension, value, evidencePages, rationale }) =>
        `| ${DIMENSION_LABELS[dimension]} | ${value} | ${evidencePages.join("、")} | ${rationale} |`,
    )
    .join("\n");
  const markdown = `# MOCK｜火山 Case Sample 最小评测报告

> **MOCK 测试数据，禁止作为真实厂商结论。**

- Bakeoff Job：\`${JOB_ID}\`
- Run：\`${RUN_ID}\`
- Artifact：\`${artifact.artifactId}\`
- Artifact SHA-256：\`${artifact.contentHash}\`
- 页数：${artifact.pageCount}
- 证据等级：Case Sample（仅适用于当前固定 Mock 火山 Case）

| 六维评分 | 1–5 整数分 | 页码证据 | 简短理由 |
|---|---:|---|---|
${scoreRows}

本报告展示独立维度，不生成总分或总冠军，也不外推为稳定厂商排名。
`;
  return {
    reportId: REPORT_ID,
    provenance: "MOCK",
    title: "MOCK｜火山 Case Sample 最小评测报告",
    jobId: JOB_ID,
    runIds: [RUN_ID],
    artifactIds: [artifact.artifactId],
    claimLevel: "case_sample",
    markdown,
    createdAt: FIXED_TIME,
  };
}
