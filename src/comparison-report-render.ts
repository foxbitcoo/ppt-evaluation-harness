import { createHash } from "node:crypto";

import type {
  ArtifactScoreTableRecord,
  CapturedArtifactTableRecord,
  DynamicComparisonView,
  EffectiveArtifactScorecard,
  ExecutionProvenance,
  FeishuReportDraft,
  PageEvidenceLink,
  ProductGapCardRecord,
  RunRecord,
  ScoreDimension,
  VendorComparisonSummary,
  VendorFinding,
} from "./domain.ts";
import {
  conciseTimingMarkdown,
  timingFromRun,
} from "./report-timing.ts";

export type EffectiveArtifactScoreTableRecord =
  ArtifactScoreTableRecord & {
    readonly effectiveScorecard: EffectiveArtifactScorecard;
  };

export type PageEvidenceUrlResolver = (
  artifactId: string,
  pageNumber: number,
) => string;

const DIMENSION_LABELS: Readonly<Record<ScoreDimension, string>> = {
  requirement_understanding_and_content_coverage:
    "需求理解与内容覆盖",
  factual_accuracy_and_content_quality: "事实准确与内容质量",
  narrative_and_audience_fit: "叙事与受众适配",
  visual_aesthetics_and_professional_finish:
    "视觉美感与专业完成度",
  layout_hierarchy_and_readability: "版式层级与可读性",
  imagery_chart_and_information_expression:
    "配图、图表与信息表达",
};

function shortHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function evidenceMarkdown(
  resolveEvidenceUrl: PageEvidenceUrlResolver,
  artifactId: string,
  pages: readonly number[],
): string {
  return pages.length === 0
    ? "—"
    : pages
        .slice(0, 3)
        .map(
          (pageNumber) =>
            `[第 ${pageNumber} 页证据](${resolveEvidenceUrl(
              artifactId,
              pageNumber,
            )})`,
        )
        .join("、");
}

function findingMarkdown(
  findings: readonly VendorFinding[],
): string {
  return findings.length === 0
    ? "未观察到可评估的相对项"
    : findings
        .map(
          ({ dimension, comparedWith, evidenceLinks }) =>
            `${DIMENSION_LABELS[dimension]}（对比 ${comparedWith}；${evidenceLinks
              .slice(0, 1)
              .map(
                ({ pageNumber, url }) =>
                  `[第 ${pageNumber} 页证据](${url})`,
              )
              .join("")}）`,
        )
        .join("；");
}

export function deriveCanonicalVendorSummaries(
  resolveEvidenceUrl: PageEvidenceUrlResolver,
  comparisons: readonly DynamicComparisonView[],
  vendorRuns: readonly RunRecord[],
  scores: readonly EffectiveArtifactScoreTableRecord[],
): readonly VendorComparisonSummary[] {
  const summaries = new Map<
    string,
    {
      product: string;
      strengths: VendorFinding[];
      issues: VendorFinding[];
    }
  >();
  const addFinding = (
    runId: string,
    product: string,
    target: "strengths" | "issues",
    finding: VendorFinding,
  ) => {
    const summary = summaries.get(runId) ?? {
      product,
      strengths: [],
      issues: [],
    };
    const findings = summary[target];
    if (
      !findings.some(
        (existing) =>
          existing.dimension === finding.dimension &&
          existing.comparedWith === finding.comparedWith,
      )
    ) {
      findings.push(finding);
    }
    summaries.set(runId, summary);
  };
  const linksFor = (
    runId: string,
    scorecardId: string,
    dimension: ScoreDimension,
  ): readonly PageEvidenceLink[] => {
    const score = scores.find(
      (record) =>
        record.runId === runId &&
        record.scorecard.scorecardId === scorecardId,
    );
    if (score === undefined) {
      throw new Error(
        `Artifact Scorecard not found for selection: ${scorecardId}`,
      );
    }
    const assessment = score.effectiveScorecard.dimensions.find(
      (candidate) => candidate.dimension === dimension,
    );
    return (
      assessment?.evidencePages.slice(0, 3).map((pageNumber) => ({
        pageNumber,
        url: resolveEvidenceUrl(score.artifactId, pageNumber),
      })) ?? []
    );
  };
  for (const comparison of comparisons) {
    for (const dimension of comparison.dimensions) {
      if (
        dimension.difference === null ||
        dimension.difference === 0
      ) {
        continue;
      }
      const leftTarget =
        dimension.difference > 0 ? "strengths" : "issues";
      const rightTarget =
        dimension.difference > 0 ? "issues" : "strengths";
      addFinding(
        comparison.leftRunId,
        comparison.leftProduct,
        leftTarget,
        {
          dimension: dimension.dimension,
          comparedWith: comparison.rightProduct,
          difference: Math.abs(dimension.difference),
          evidenceLinks: linksFor(
            comparison.leftRunId,
            comparison.leftScorecardId,
            dimension.dimension,
          ),
        },
      );
      addFinding(
        comparison.rightRunId,
        comparison.rightProduct,
        rightTarget,
        {
          dimension: dimension.dimension,
          comparedWith: comparison.leftProduct,
          difference: Math.abs(dimension.difference),
          evidenceLinks: linksFor(
            comparison.rightRunId,
            comparison.rightScorecardId,
            dimension.dimension,
          ),
        },
      );
    }
  }
  const selectedRunIds = [
    ...new Set(
      comparisons.flatMap(({ leftRunId, rightRunId }) => [
        leftRunId,
        rightRunId,
      ]),
    ),
  ];
  return selectedRunIds.map((runId) => {
    const run = vendorRuns.find(
      ({ recordId }) => recordId === runId,
    );
    if (run === undefined || run.product === null) {
      throw new Error(
        `Vendor Run not found for summary: ${runId}`,
      );
    }
    const summary = summaries.get(runId) ?? {
      product: run.product,
      strengths: [],
      issues: [],
    };
    const rank = (findings: readonly VendorFinding[]) =>
      [...findings]
        .sort(
          (left, right) =>
            right.difference - left.difference ||
            left.dimension.localeCompare(right.dimension),
        )
        .slice(0, 3);
    return {
      product: summary.product,
      runId,
      majorStrengths: rank(summary.strengths),
      majorIssues: rank(summary.issues),
    };
  });
}

export function buildCanonicalComparisonReportDraft(command: {
  readonly resolveEvidenceUrl: PageEvidenceUrlResolver;
  readonly job: RunRecord;
  readonly vendorRuns: readonly RunRecord[];
  readonly capturedArtifacts: readonly CapturedArtifactTableRecord[];
  readonly comparisons: readonly DynamicComparisonView[];
  readonly gapCards: readonly ProductGapCardRecord[];
  readonly vendorSummaries: readonly VendorComparisonSummary[];
  readonly scores: readonly EffectiveArtifactScoreTableRecord[];
}): FeishuReportDraft {
  const {
    resolveEvidenceUrl,
    job,
    vendorRuns,
    capturedArtifacts,
    comparisons,
    gapCards,
    vendorSummaries,
    scores,
  } = command;
  const executionProvenance: ExecutionProvenance =
    job.executionProvenance ??
    (job.provenance === "MOCK"
      ? "MOCK"
      : (() => {
          throw new Error(
            "Production comparison report requires explicit LIVE_PRODUCTION or PRODUCTION_REPLAY execution provenance",
          );
        })());
  const reportKey = shortHash(
    comparisons.map(({ comparisonId, dimensions }) => ({
      comparisonId,
      dimensions: dimensions.map(
        ({
          dimension,
          leftValue,
          rightValue,
          leftReviewState,
          rightReviewState,
          leftAdjudicationEventId,
          rightAdjudicationEventId,
        }) => ({
          dimension,
          leftValue,
          rightValue,
          leftReviewState,
          rightReviewState,
          leftAdjudicationEventId,
          rightAdjudicationEventId,
        }),
      ),
    })),
  );
  const comparisonSections = comparisons
    .map(
      (comparison) => `## ${comparison.leftProduct}–${comparison.rightProduct}

| 维度 | 左侧 | 右侧 | 双方页级证据 |
|---|---:|---:|---|
${comparison.dimensions
  .map(
    ({
      dimension,
      leftValue,
      rightValue,
      leftEvidencePages,
      rightEvidencePages,
      leftReviewState,
      rightReviewState,
    }) => {
      const leftScore = scores.find(
        ({ scorecard }) =>
          scorecard.scorecardId === comparison.leftScorecardId,
      );
      const rightScore = scores.find(
        ({ scorecard }) =>
          scorecard.scorecardId === comparison.rightScorecardId,
      );
      const evidence =
        leftScore === undefined || rightScore === undefined
          ? "—"
          : `${evidenceMarkdown(
              resolveEvidenceUrl,
              leftScore.artifactId,
              leftEvidencePages,
            )} / ${evidenceMarkdown(
              resolveEvidenceUrl,
              rightScore.artifactId,
              rightEvidencePages,
            )}`;
      const display = (
        value: number | null,
        reviewState:
          | "model_not_reviewed"
          | "human_reviewed",
      ) => `${
        value ?? "NOT_ASSESSABLE"
      }（${
        reviewState === "human_reviewed"
          ? "人工已复核"
          : "模型未复核"
      }）`;
      return `| ${DIMENSION_LABELS[dimension]} | ${display(
        leftValue,
        leftReviewState,
      )} | ${display(
        rightValue,
        rightReviewState,
      )} | ${evidence} |`;
    },
  )
  .join("\n")}`,
    )
    .join("\n\n");
  const deliveryRows = vendorRuns
    .map((run) => {
      const artifact = capturedArtifacts.find(
        (record) => record.runId === run.recordId,
      );
      const judgeStatus =
        run.scorecardId !== null
          ? "已完成"
          : run.judgeFailure !== null &&
              run.judgeFailure !== undefined
            ? `Judge：失败（\`${run.judgeFailure.submissionStatus}\`）；\`NOT_ASSESSABLE\``
            : artifact === undefined
              ? "Judge 未调用；`NOT_ASSESSABLE`"
              : artifact.renderManifest.renderOutcome !== "faithful"
                ? "Judge 未调用（渲染保真门禁未通过）；`NOT_ASSESSABLE`"
                : "`NOT_ASSESSABLE`";
      return `| ${run.product ?? "—"} | \`${run.recordId}\` | \`${
        run.status
      }\` | \`${
        run.terminalReason ?? run.waitingReason ?? "—"
      }\` | ${conciseTimingMarkdown(timingFromRun(run))} | ${artifact?.artifactId ?? "无"} | ${judgeStatus} |`;
    })
    .join("\n");
  const gapCardSections =
    gapCards.length === 0
      ? "本次所选维度未形成可评估的分差卡片。"
      : gapCards
          .map(
            (card, index) => `### 产品差距卡 ${index + 1}｜${DIMENSION_LABELS[card.dimension]}

- 关键页：${evidenceMarkdown(
              resolveEvidenceUrl,
              card.leftEvidence.artifactId,
              card.keyPages.left,
            )} / ${evidenceMarkdown(
              resolveEvidenceUrl,
              card.rightEvidence.artifactId,
              card.keyPages.right,
            )}
- 双方证据：${card.leftEvidence.product} ${card.leftEvidence.value} 分；${card.rightEvidence.product} ${card.rightEvidence.value} 分
- 影响：${card.impact}
- 原因标记：**${card.causeHypothesis.label}** — ${card.causeHypothesis.statement}
- 建议实验：${card.proposedExperiment}
- 验收指标：${card.acceptanceMetric}`,
          )
          .join("\n\n");
  const summarySections = vendorSummaries
    .map(
      (summary) => `### ${summary.product}

- 主要优点：${findingMarkdown(summary.majorStrengths)}
- 主要问题：${findingMarkdown(summary.majorIssues)}`,
    )
    .join("\n\n");
  const title =
    executionProvenance === "MOCK"
      ? "MOCK｜Case Sample 动态 A/B 精简报告"
      : executionProvenance === "PRODUCTION_REPLAY"
        ? "历史真实产物回放｜Case Sample 动态 A/B 精简报告"
        : "LIVE｜Case Sample 动态 A/B 精简报告";
  const executionNotice =
    executionProvenance === "MOCK"
      ? "> **单次 Case Sample：MOCK 测试数据，禁止作为真实厂商结论。**"
      : executionProvenance === "PRODUCTION_REPLAY"
        ? "> **历史真实产物回放，非本次 LIVE 生产验收；报告仅验证已留存真实产物的当前评测与投影链路。**"
        : "> **LIVE 真实单次 Case Sample：结论仅适用于本次已捕获的静态自读 PPT，不外推到其他场景。**";
  return {
    reportId: `comparison-report-${reportKey}`,
    provenance: job.provenance,
    executionProvenance,
    environmentOrigin: job.environmentOrigin,
    title,
    jobId: job.jobId,
    runIds:
      job.selectedRunIds === null
        ? vendorRuns.map(({ recordId }) => recordId)
        : [...job.selectedRunIds],
    artifactIds: capturedArtifacts.map(
      ({ artifactId }) => artifactId,
    ),
    comparisonIds: comparisons.map(
      ({ comparisonId }) => comparisonId,
    ),
    gapCardIds: gapCards.map(({ gapCardId }) => gapCardId),
    claimLevel: "case_sample",
    markdown: `# ${title}

${executionNotice}

## 全部所选产品交付结果

- Bakeoff Job 状态：\`${job.status}\`
- 执行血缘：\`${executionProvenance}\`

| 产品 | Run | 状态 | 状态原因 | 耗时（分钟） | Artifact | Judge / 视觉评估 |
|---|---|---|---|---|---|---|
${deliveryRows}

${comparisonSections}

## 产品差距卡

${gapCardSections}

## 各产品主要优点与主要问题

${summarySections}
`,
    createdAt: job.createdAt,
  };
}

export function normalizeReportEvidenceUrls(
  markdown: string,
): string {
  return markdown.replace(
    /(\]\()([^) \n]+)(\))/g,
    "$1<page-evidence-url>$3",
  );
}
