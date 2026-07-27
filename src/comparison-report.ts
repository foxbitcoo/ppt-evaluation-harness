import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ArtifactScoreTableRecord,
  ComparisonPairSelection,
  ComparisonReportOutcome,
  CauseHypothesis,
  CapturedArtifactTableRecord,
  DynamicComparisonView,
  EffectiveArtifactScorecard,
  EffectiveDimensionScore,
  FeishuReportDraft,
  PageEvidenceLink,
  ProductGapCardRecord,
  ProductGapEvidence,
  RunRecord,
  ScoreDimension,
  VendorComparisonSummary,
  VendorFinding,
} from "./domain.ts";
import type { FeishuProjectionPort } from "./feishu.ts";
import { createScoreAdjudicationService } from "./score-adjudication.ts";

export interface CreateComparisonReportCommand {
  readonly jobId: string;
  readonly pairs?: readonly ComparisonPairSelection[];
}

export interface ComparisonReportService {
  createReport(
    command: CreateComparisonReportCommand,
  ): Promise<ComparisonReportOutcome>;
}

export interface ComparisonReportServiceDependencies {
  readonly feishu: FeishuProjectionPort;
}

interface ScoredRun {
  readonly run: RunRecord & { readonly product: string };
  readonly score: EffectiveArtifactScoreTableRecord;
}

type EffectiveArtifactScoreTableRecord = ArtifactScoreTableRecord & {
  readonly effectiveScorecard: EffectiveArtifactScorecard;
};

function shortHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function scoredRunById(
  runId: string,
  vendorRuns: readonly RunRecord[],
  scores: readonly EffectiveArtifactScoreTableRecord[],
  scorecardId?: string,
): ScoredRun {
  const run = vendorRuns.find(({ recordId }) => recordId === runId);
  const candidates = scores.filter((record) => record.runId === runId);
  if (scorecardId === undefined && candidates.length > 1) {
    throw new Error(
      `Run ${runId} has multiple Scorecards; select an explicit Scorecard ID`,
    );
  }
  const score =
    scorecardId === undefined
      ? candidates[0]
      : candidates.find(
          (record) => record.scorecard.scorecardId === scorecardId,
        );
  if (run === undefined || score === undefined || run.product === null) {
    throw new Error(`Scored vendor Run not found: ${runId}`);
  }
  return {
    run: run as RunRecord & { readonly product: string },
    score,
  };
}

function dimensionsByName(
  dimensions: readonly EffectiveDimensionScore[],
): ReadonlyMap<ScoreDimension, EffectiveDimensionScore> {
  return new Map(
    dimensions.map((dimension) => [dimension.dimension, dimension]),
  );
}

function compatibleJudgeConfiguration(
  left: ArtifactScoreTableRecord,
  right: ArtifactScoreTableRecord,
): boolean {
  const leftJudge = left.scorecard.judgeLineage;
  const rightJudge = right.scorecard.judgeLineage;
  if (leftJudge === null || rightJudge === null) {
    return leftJudge === rightJudge;
  }
  return (
    leftJudge.provider === rightJudge.provider &&
    leftJudge.adapterVersion === rightJudge.adapterVersion &&
    leftJudge.requestedModel === rightJudge.requestedModel &&
    leftJudge.responseModel === rightJudge.responseModel &&
    leftJudge.promptVersion === rightJudge.promptVersion &&
    leftJudge.promptHash === rightJudge.promptHash &&
    leftJudge.configHash === rightJudge.configHash &&
    leftJudge.schemaHash === rightJudge.schemaHash &&
    leftJudge.rasterizerVersion === rightJudge.rasterizerVersion &&
    leftJudge.imageDetail === rightJudge.imageDetail
  );
}

function comparePair(
  jobId: string,
  pair: ComparisonPairSelection,
  vendorRuns: readonly RunRecord[],
  scores: readonly EffectiveArtifactScoreTableRecord[],
): DynamicComparisonView {
  if (pair.leftRunId === pair.rightRunId) {
    throw new Error("A Comparison View requires two distinct Runs");
  }
  const left = scoredRunById(
    pair.leftRunId,
    vendorRuns,
    scores,
    pair.leftScorecardId,
  );
  const right = scoredRunById(
    pair.rightRunId,
    vendorRuns,
    scores,
    pair.rightScorecardId,
  );
  if (
    left.score.jobId !== jobId ||
    right.score.jobId !== jobId ||
    left.score.caseId !== right.score.caseId ||
    left.score.scorecard.rubricVersion !==
      right.score.scorecard.rubricVersion ||
    left.score.renderManifest.renderer !==
      right.score.renderManifest.renderer ||
    left.score.environmentOrigin !== right.score.environmentOrigin ||
    !isDeepStrictEqual(
      left.score.comparisonCompatibilityFingerprint,
      right.score.comparisonCompatibilityFingerprint,
    ) ||
    !compatibleJudgeConfiguration(left.score, right.score)
  ) {
    throw new Error("Selected Runs are not compatible for direct comparison");
  }

  const rightDimensions = dimensionsByName(
    right.score.effectiveScorecard.dimensions,
  );
  const dimensions = left.score.effectiveScorecard.dimensions.map(
    (leftDimension) => {
      const rightDimension = rightDimensions.get(
        leftDimension.dimension,
      );
      if (rightDimension === undefined) {
        throw new Error(
          "Selected Scorecards use incompatible dimensions",
        );
      }
      const leftAssessable =
        leftDimension.effectiveAssessmentStatus === "ASSESSED" &&
        leftDimension.effectiveValue !== null;
      const rightAssessable =
        rightDimension.effectiveAssessmentStatus === "ASSESSED" &&
        rightDimension.effectiveValue !== null;
      const assessable = leftAssessable && rightAssessable;
      return {
        dimension: leftDimension.dimension,
        assessmentStatus: assessable
          ? ("ASSESSED" as const)
          : ("NOT_ASSESSABLE" as const),
        leftAssessmentStatus: leftAssessable
          ? ("ASSESSED" as const)
          : ("NOT_ASSESSABLE" as const),
        rightAssessmentStatus: rightAssessable
          ? ("ASSESSED" as const)
          : ("NOT_ASSESSABLE" as const),
        leftValue: leftAssessable
          ? leftDimension.effectiveValue
          : null,
        rightValue: rightAssessable
          ? rightDimension.effectiveValue
          : null,
        difference: assessable
          ? leftDimension.effectiveValue -
            rightDimension.effectiveValue
          : null,
        leftEvidencePages: leftDimension.evidencePages,
        rightEvidencePages: rightDimension.evidencePages,
        leftReviewState: leftDimension.reviewState,
        rightReviewState: rightDimension.reviewState,
        leftScoreSource: leftDimension.source,
        rightScoreSource: rightDimension.source,
        leftAdjudicationEventId:
          leftDimension.adjudicationEventId,
        rightAdjudicationEventId:
          rightDimension.adjudicationEventId,
      };
    },
  );
  const knownComparisonIds = new Map<string, string>([
    [
      "MOCK-run-wps-volcano-v1|MOCK-run-qwen-volcano-v1",
      "MOCK-comparison-wps-qwen-volcano-v1",
    ],
    [
      "MOCK-run-wps-volcano-v1|MOCK-run-doubao-volcano-v1",
      "MOCK-comparison-wps-doubao-volcano-v1",
    ],
    [
      "MOCK-run-qwen-volcano-v1|MOCK-run-doubao-volcano-v1",
      "MOCK-comparison-qwen-doubao-volcano-v1",
    ],
  ]);
  const knownComparisonId = knownComparisonIds.get(
    `${pair.leftRunId}|${pair.rightRunId}`,
  );
  const knownScorecardPair =
    (pair.leftRunId === "MOCK-run-wps-volcano-v1"
      ? "MOCK-scorecard-wps-volcano-v1"
      : pair.leftRunId === "MOCK-run-qwen-volcano-v1"
        ? "MOCK-scorecard-qwen-volcano-v1"
        : null) === left.score.scorecard.scorecardId &&
    (pair.rightRunId === "MOCK-run-qwen-volcano-v1"
      ? "MOCK-scorecard-qwen-volcano-v1"
      : pair.rightRunId === "MOCK-run-doubao-volcano-v1"
        ? "MOCK-scorecard-doubao-volcano-v1"
        : null) === right.score.scorecard.scorecardId;
  const comparisonId =
    knownComparisonId !== undefined && knownScorecardPair
      ? knownComparisonId
      : `comparison-${shortHash([
          pair.leftRunId,
          left.score.scorecard.scorecardId,
          pair.rightRunId,
          right.score.scorecard.scorecardId,
        ])}`;
  return {
    recordType: "comparison",
    comparisonId,
    caseId: left.score.caseId,
    jobId,
    leftRunId: pair.leftRunId,
    rightRunId: pair.rightRunId,
    leftScorecardId: left.score.scorecard.scorecardId,
    rightScorecardId: right.score.scorecard.scorecardId,
    provenance: left.score.provenance,
    environmentOrigin: left.score.environmentOrigin,
    leftProduct: left.run.product,
    rightProduct: right.run.product,
    dimensions,
  };
}

function reportDraft(
  feishu: FeishuProjectionPort,
  job: RunRecord,
  vendorRuns: readonly RunRecord[],
  capturedArtifacts: readonly CapturedArtifactTableRecord[],
  comparisons: readonly DynamicComparisonView[],
  gapCards: readonly ProductGapCardRecord[],
  vendorSummaries: readonly VendorComparisonSummary[],
  scores: readonly EffectiveArtifactScoreTableRecord[],
): FeishuReportDraft {
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
              feishu,
              leftScore.artifactId,
              leftEvidencePages,
            )} / ${evidenceMarkdown(
              feishu,
              rightScore.artifactId,
              rightEvidencePages,
            )}`;
      const display = (
        value: number | null,
        reviewState: "model_not_reviewed" | "human_reviewed",
      ) => `${
        value ?? "NOT_ASSESSABLE"
      }（${
        reviewState === "human_reviewed"
          ? "人工已复核"
          : "模型未复核"
      }）`;
      return `| ${DIMENSION_SPECS[dimension].label} | ${display(
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
      return `| ${run.product ?? "—"} | \`${run.recordId}\` | \`${
        run.status
      }\` | \`${
        run.terminalReason ?? run.waitingReason ?? "—"
      }\` | ${artifact?.artifactId ?? "无"} |`;
    })
    .join("\n");
  const gapCardSections =
    gapCards.length === 0
      ? "本次所选维度未形成可评估的分差卡片。"
      : gapCards
          .map(
            (card, index) => `### 产品差距卡 ${index + 1}｜${DIMENSION_SPECS[card.dimension].label}

- 关键页：${evidenceMarkdown(
              feishu,
              card.leftEvidence.artifactId,
              card.keyPages.left,
            )} / ${evidenceMarkdown(
              feishu,
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
  return {
    reportId: `comparison-report-${reportKey}`,
    provenance: job.provenance,
    environmentOrigin: job.environmentOrigin,
    title:
      job.provenance === "MOCK"
        ? "MOCK｜Case Sample 动态 A/B 精简报告"
        : "Case Sample｜动态 A/B 精简报告",
    jobId: job.jobId,
    runIds:
      job.selectedRunIds === null
        ? vendorRuns.map(({ recordId }) => recordId)
        : [...job.selectedRunIds],
    artifactIds: capturedArtifacts.map(({ artifactId }) => artifactId),
    claimLevel: "case_sample",
    markdown: `# ${
      job.provenance === "MOCK" ? "MOCK｜" : ""
    }Case Sample 动态 A/B 精简报告

> **单次 Case Sample：结论仅适用于当前已捕获的静态自读 PPT，不外推到其他场景。**

## 全部所选产品交付结果

- Bakeoff Job 状态：\`${job.status}\`

| 产品 | Run | 状态 | 状态原因 | Artifact |
|---|---|---|---|---|
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

const DIMENSION_SPECS: Readonly<
  Record<
    ScoreDimension,
    {
      readonly label: string;
      readonly hypothesis: CauseHypothesis["pipelineStage"];
      readonly experiment: string;
      readonly metric: string;
    }
  >
> = {
  requirement_understanding_and_content_coverage: {
    label: "需求理解与内容覆盖",
    hypothesis: "outline_or_content",
    experiment: "冻结输入与模板，A/B 测试大纲规划和覆盖检查策略。",
    metric: "同一 Case 的显式要求覆盖率提升，且无新增关键遗漏。",
  },
  factual_accuracy_and_content_quality: {
    label: "事实准确与内容质量",
    hypothesis: "outline_or_content",
    experiment: "冻结版式，A/B 测试内容生成与事实核验策略。",
    metric: "经同一参考包核验的错误数下降，核心事实覆盖不降低。",
  },
  narrative_and_audience_fit: {
    label: "叙事与受众适配",
    hypothesis: "outline_or_content",
    experiment: "冻结视觉模板，A/B 测试叙事顺序和受众约束注入。",
    metric: "盲评叙事维度提高至少 1 个等级，关键页阅读路径无回退。",
  },
  visual_aesthetics_and_professional_finish: {
    label: "视觉美感与专业完成度",
    hypothesis: "layout_selection",
    experiment: "冻结内容，A/B 测试模板检索与视觉风格选择。",
    metric: "盲评视觉完成度提高至少 1 个等级，静态一致性门禁保持通过。",
  },
  layout_hierarchy_and_readability: {
    label: "版式层级与可读性",
    hypothesis: "layout_execution",
    experiment: "冻结内容和模板，A/B 测试布局执行与密度约束。",
    metric: "关键页静态可读性提高至少 1 个等级，且无新增溢出或遮挡。",
  },
  imagery_chart_and_information_expression: {
    label: "配图、图表与信息表达",
    hypothesis: "imagery",
    experiment: "冻结文字内容，A/B 测试图解选择与信息表达策略。",
    metric: "信息表达维度提高至少 1 个等级，且图示不引入事实误导。",
  },
};

function evidenceMarkdown(
  feishu: FeishuProjectionPort,
  artifactId: string,
  pages: readonly number[],
): string {
  return pages.length === 0
    ? "—"
    : pages
        .slice(0, 3)
        .map(
          (pageNumber) =>
            `[第 ${pageNumber} 页证据](${feishu.artifactPageEvidenceUrl(
              artifactId,
              pageNumber,
            )})`,
        )
        .join("、");
}

function findingMarkdown(findings: readonly VendorFinding[]): string {
  return findings.length === 0
    ? "未观察到可评估的相对项"
    : findings
        .map(
          ({ dimension, comparedWith, evidenceLinks }) =>
            `${DIMENSION_SPECS[dimension].label}（对比 ${comparedWith}；${evidenceLinks
              .slice(0, 1)
              .map(
                ({ pageNumber, url }) =>
                  `[第 ${pageNumber} 页证据](${url})`,
              )
              .join("")}）`,
        )
        .join("；");
}

function evidenceForDimension(
  feishu: FeishuProjectionPort,
  scoredRun: ScoredRun,
  dimension: ScoreDimension,
): ProductGapEvidence {
  const score = scoredRun.score.effectiveScorecard.dimensions.find(
    (candidate) => candidate.dimension === dimension,
  );
  if (
    score === undefined ||
    score.effectiveAssessmentStatus !== "ASSESSED" ||
    score.effectiveValue === null
  ) {
    throw new Error(`Gap evidence is not assessable: ${dimension}`);
  }
  return {
    product: scoredRun.run.product,
    runId: scoredRun.run.recordId,
    artifactId: scoredRun.score.artifactId,
    scorecardId: scoredRun.score.scorecard.scorecardId,
    value: score.effectiveValue,
    rationale: score.rationale,
    links: score.evidencePages
      .slice(0, 3)
      .map((pageNumber) => ({
        pageNumber,
        url: feishu.artifactPageEvidenceUrl(
          scoredRun.score.artifactId,
          pageNumber,
        ),
      })),
  };
}

function createGapCards(
  feishu: FeishuProjectionPort,
  comparisons: readonly DynamicComparisonView[],
  vendorRuns: readonly RunRecord[],
  scores: readonly EffectiveArtifactScoreTableRecord[],
): readonly ProductGapCardRecord[] {
  return comparisons
    .flatMap((comparison, comparisonIndex) =>
      comparison.dimensions.flatMap((dimension, dimensionIndex) =>
        dimension.difference === null || dimension.difference === 0
          ? []
          : [{ comparison, dimension, comparisonIndex, dimensionIndex }],
      ),
    )
    .sort(
      (left, right) =>
        Math.abs(right.dimension.difference ?? 0) -
          Math.abs(left.dimension.difference ?? 0) ||
        left.comparisonIndex - right.comparisonIndex ||
        left.dimensionIndex - right.dimensionIndex,
    )
    .slice(0, 3)
    .map(({ comparison, dimension }) => {
      const left = scoredRunById(
        comparison.leftRunId,
        vendorRuns,
        scores,
        comparison.leftScorecardId,
      );
      const right = scoredRunById(
        comparison.rightRunId,
        vendorRuns,
        scores,
        comparison.rightScorecardId,
      );
      const leftEvidence = evidenceForDimension(
        feishu,
        left,
        dimension.dimension,
      );
      const rightEvidence = evidenceForDimension(
        feishu,
        right,
        dimension.dimension,
      );
      const lowerProduct =
        (dimension.difference ?? 0) > 0
          ? right.run.product
          : left.run.product;
      const spec = DIMENSION_SPECS[dimension.dimension];
      return {
        recordType: "gap_card",
        gapCardId: `gap-${shortHash([
          comparison.comparisonId,
          dimension.dimension,
          dimension.leftAdjudicationEventId,
          dimension.rightAdjudicationEventId,
        ])}`,
        caseId: comparison.caseId,
        jobId: comparison.jobId,
        comparisonId: comparison.comparisonId,
        provenance: comparison.provenance,
        environmentOrigin: comparison.environmentOrigin,
        workflowState: "pending_review",
        causeAttribution: "HYPOTHESIS",
        dimension: dimension.dimension,
        keyPages: {
          left: leftEvidence.links.map(({ pageNumber }) => pageNumber),
          right: rightEvidence.links.map(({ pageNumber }) => pageNumber),
        },
        leftEvidence,
        rightEvidence,
        impact: `${spec.label}的静态自读体验存在 ${
          Math.abs(dimension.difference ?? 0) >= 2 ? "明显" : "可见"
        }差异，可能影响关键页理解效率。`,
        causeHypothesis: {
          label: "HYPOTHESIS",
          pipelineStage: spec.hypothesis,
          statement: `待验证：${lowerProduct}在该维度的差异可能与${spec.label}相关流水线阶段有关；当前输出证据不能证明内部根因。`,
        },
        proposedExperiment: spec.experiment,
        acceptanceMetric: spec.metric,
      };
    });
}

function createVendorSummaries(
  feishu: FeishuProjectionPort,
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
        url: feishu.artifactPageEvidenceUrl(
          score.artifactId,
          pageNumber,
        ),
      })) ?? []
    );
  };
  for (const comparison of comparisons) {
    for (const dimension of comparison.dimensions) {
      if (dimension.difference === null || dimension.difference === 0) {
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
    const run = vendorRuns.find(({ recordId }) => recordId === runId);
    if (run === undefined || run.product === null) {
      throw new Error(`Vendor Run not found for summary: ${runId}`);
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

function defaultViewPairs(
  vendorRuns: readonly RunRecord[],
  scores: readonly EffectiveArtifactScoreTableRecord[],
): readonly ComparisonPairSelection[] {
  const scoredRunIds = new Set(scores.map(({ runId }) => runId));
  const runIdForVendor = (vendorId: string): string | null =>
    vendorRuns.find(
      (run) =>
        run.productVendorId === vendorId &&
        scoredRunIds.has(run.recordId),
    )?.recordId ??
    null;
  const wpsRunId = runIdForVendor("wps");
  if (wpsRunId === null) return [];
  return [
    runIdForVendor("qwen"),
    runIdForVendor("doubao"),
  ].flatMap((rightRunId) =>
    rightRunId === null ? [] : [{ leftRunId: wpsRunId, rightRunId }],
  );
}

export function createComparisonReportService({
  feishu,
}: ComparisonReportServiceDependencies): ComparisonReportService {
  return {
    async createReport(command) {
      const source = await feishu.loadComparisonReportSource(command.jobId);
      const adjudicationService = createScoreAdjudicationService({
        feishu,
      });
      const effectiveScores: readonly EffectiveArtifactScoreTableRecord[] =
        await Promise.all(
          source.artifactScores.map(async (score) => ({
            ...score,
            effectiveScorecard:
              await adjudicationService.getEffectiveScorecardForRecord(
                score,
              ),
          })),
        );
      const pairs =
        command.pairs ??
        defaultViewPairs(source.vendorRuns, effectiveScores);
      if (pairs.length === 0) {
        throw new Error("A comparison report requires at least one pair");
      }
      const comparisons = pairs.map((pair) =>
        comparePair(
          command.jobId,
          pair,
          source.vendorRuns,
          effectiveScores,
        ),
      );
      for (const comparison of comparisons) {
        await feishu.appendComparison({
          recordType: comparison.recordType,
          comparisonId: comparison.comparisonId,
          caseId: comparison.caseId,
          jobId: comparison.jobId,
          leftRunId: comparison.leftRunId,
          rightRunId: comparison.rightRunId,
          leftScorecardId: comparison.leftScorecardId,
          rightScorecardId: comparison.rightScorecardId,
          provenance: comparison.provenance,
          environmentOrigin: comparison.environmentOrigin,
        });
      }
      const gapCards = createGapCards(
        feishu,
        comparisons,
        source.vendorRuns,
        effectiveScores,
      );
      for (const gapCard of gapCards) {
        await feishu.appendProductGapCard(gapCard);
      }
      const vendorSummaries = createVendorSummaries(
        feishu,
        comparisons,
        source.vendorRuns,
        effectiveScores,
      );
      const report = await feishu.createReport(
        reportDraft(
          feishu,
          source.job,
          source.vendorRuns,
          source.capturedArtifacts,
          comparisons,
          gapCards,
          vendorSummaries,
          effectiveScores,
        ),
      );
      await feishu.linkReportToBakeoffJob(
        command.jobId,
        report.url,
        command.pairs === undefined ? "primary" : "auxiliary",
      );
      return {
        comparisons,
        gapCards,
        vendorSummaries,
        report,
      };
    },
  };
}
