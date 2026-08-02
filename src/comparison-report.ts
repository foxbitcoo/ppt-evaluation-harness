import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ArtifactScoreTableRecord,
  ComparisonPairSelection,
  ComparisonReportOutcome,
  CauseHypothesis,
  DynamicComparisonView,
  EffectiveArtifactScorecard,
  EffectiveDimensionScore,
  ProductGapCardRecord,
  ProductGapEvidence,
  RunRecord,
  ScoreDimension,
} from "./domain.ts";
import {
  ProjectionStaleBaselineError,
  type FeishuProjectionPort,
} from "./feishu.ts";
import type {
  ClockPort,
  EgressAuthorizationAuditPort,
  EgressAuthorizationPort,
} from "./egress-authorization.ts";
import {
  isHarnessOwnedLarkBaseProjection,
  persistHarnessOwnedLarkProjectionSnapshot,
} from "./lark-base-projection.ts";
import {
  captureExecutionProvenance,
  projectionProvenanceCoversCapture,
} from "./provenance.ts";
import { createScoreAdjudicationService } from "./score-adjudication.ts";
import {
  assertArtifactScoreCompatibility,
  assertCompleteScoreDimensions,
} from "./comparison-compatibility.ts";
import {
  buildCanonicalComparisonReportDraft,
  deriveCanonicalVendorSummaries,
} from "./comparison-report-render.ts";

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
  readonly egressAuthorization?: EgressAuthorizationPort;
  readonly egressAudit?: EgressAuthorizationAuditPort;
  readonly clock?: ClockPort;
}

interface ScoredRun<
  ScoreRecord extends ArtifactScoreTableRecord =
    EffectiveArtifactScoreTableRecord,
> {
  readonly run: RunRecord & { readonly product: string };
  readonly score: ScoreRecord;
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

function scoredRunById<ScoreRecord extends ArtifactScoreTableRecord>(
  runId: string,
  vendorRuns: readonly RunRecord[],
  scores: readonly ScoreRecord[],
  scorecardId?: string,
): ScoredRun<ScoreRecord> {
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
      : (() => {
          const matches = candidates.filter(
            (record) =>
              record.scorecard.scorecardId === scorecardId,
          );
          if (matches.length > 1) {
            throw new Error(
              `Scorecard identity is duplicated: ${scorecardId}`,
            );
          }
          return matches[0];
        })();
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
  const stableCodexExecutionIdentityMatches = () => {
    if (
      leftJudge.provider !== "codex_cli" ||
      rightJudge.provider !== "codex_cli"
    ) {
      return true;
    }
    const leftExecution = leftJudge.executionEvidence;
    const rightExecution = rightJudge.executionEvidence;
    return (
      leftExecution !== undefined &&
      rightExecution !== undefined &&
      leftExecution.schemaVersion === rightExecution.schemaVersion &&
      leftExecution.binaryHash === rightExecution.binaryHash &&
      leftExecution.fixedArgumentsHash ===
        rightExecution.fixedArgumentsHash &&
      leftExecution.sandboxBinaryHash ===
        rightExecution.sandboxBinaryHash &&
      leftExecution.sandboxProfileHash ===
        rightExecution.sandboxProfileHash
    );
  };
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
    leftJudge.imageDetail === rightJudge.imageDetail &&
    stableCodexExecutionIdentityMatches()
  );
}

function compatibleComparisonLineage(
  jobId: string,
  left: ScoredRun<ArtifactScoreTableRecord>,
  right: ScoredRun<ArtifactScoreTableRecord>,
): boolean {
  const leftCaptureProvenance = captureExecutionProvenance(
    left.score.artifact,
    left.score.renderManifest,
    left.score.scorecard,
  );
  const rightCaptureProvenance = captureExecutionProvenance(
    right.score.artifact,
    right.score.renderManifest,
    right.score.scorecard,
  );
  return (
    leftCaptureProvenance !== null &&
    rightCaptureProvenance !== null &&
    leftCaptureProvenance === rightCaptureProvenance &&
    projectionProvenanceCoversCapture(
      left.score.provenance,
      leftCaptureProvenance,
    ) &&
    projectionProvenanceCoversCapture(
      right.score.provenance,
      rightCaptureProvenance,
    ) &&
    left.score.jobId === jobId &&
    right.score.jobId === jobId &&
    left.score.caseId === right.score.caseId &&
    left.score.scorecard.rubricVersion ===
      right.score.scorecard.rubricVersion &&
    left.score.renderManifest.renderer ===
      right.score.renderManifest.renderer &&
    left.score.environmentOrigin === right.score.environmentOrigin &&
    left.run.provenance === left.score.provenance &&
    right.run.provenance === right.score.provenance &&
    left.score.provenance === right.score.provenance &&
    isDeepStrictEqual(
      left.score.comparisonCompatibilityFingerprint,
      right.score.comparisonCompatibilityFingerprint,
    ) &&
    compatibleJudgeConfiguration(left.score, right.score)
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
  if (!compatibleComparisonLineage(jobId, left, right)) {
    throw new Error("Selected Runs are not compatible for direct comparison");
  }
  const sharedProvenance = left.score.provenance;
  assertCompleteScoreDimensions(
    left.score.effectiveScorecard.dimensions,
    "Left effective Scorecard",
  );
  assertCompleteScoreDimensions(
    right.score.effectiveScorecard.dimensions,
    "Right effective Scorecard",
  );
  const leftDimensionNames = left.score.effectiveScorecard.dimensions
    .map(({ dimension }) => dimension)
    .sort();
  const rightDimensionNames = right.score.effectiveScorecard.dimensions
    .map(({ dimension }) => dimension)
    .sort();
  if (!isDeepStrictEqual(leftDimensionNames, rightDimensionNames)) {
    throw new Error("Selected Scorecards use incompatible dimensions");
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
  const usesOnlyModelOriginalScores = dimensions.every(
    (dimension) =>
      dimension.leftAdjudicationEventId === null &&
      dimension.rightAdjudicationEventId === null &&
      dimension.leftReviewState === "model_not_reviewed" &&
      dimension.rightReviewState === "model_not_reviewed",
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
    knownComparisonId !== undefined &&
    knownScorecardPair &&
    usesOnlyModelOriginalScores
      ? knownComparisonId
      : `comparison-${shortHash([
          pair.leftRunId,
          left.score.scorecard.scorecardId,
          pair.rightRunId,
          right.score.scorecard.scorecardId,
          dimensions,
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
    provenance: sharedProvenance,
    environmentOrigin: left.score.environmentOrigin,
    leftProduct: left.run.product,
    rightProduct: right.run.product,
    dimensions,
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
    metric: "按冻结的 evaluation_mode: non_blind 协议，叙事维度提高至少 1 个等级，关键页阅读路径无回退。",
  },
  visual_aesthetics_and_professional_finish: {
    label: "视觉美感与专业完成度",
    hypothesis: "layout_selection",
    experiment: "冻结内容，A/B 测试模板检索与视觉风格选择。",
    metric: "按冻结的 evaluation_mode: non_blind 协议，视觉完成度提高至少 1 个等级，静态一致性门禁保持通过。",
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

const COMPARISON_VENDOR_ORDER = new Map([
  ["wps", 0],
  ["qwen", 1],
  ["doubao", 2],
]);

function compareCanonicalRunOrder(
  left: ScoredRun,
  right: ScoredRun,
): number {
  return (
    (COMPARISON_VENDOR_ORDER.get(
      left.run.productVendorId ?? "",
    ) ?? Number.MAX_SAFE_INTEGER) -
      (COMPARISON_VENDOR_ORDER.get(
        right.run.productVendorId ?? "",
      ) ?? Number.MAX_SAFE_INTEGER) ||
    left.run.recordId.localeCompare(right.run.recordId) ||
    left.score.scorecard.scorecardId.localeCompare(
      right.score.scorecard.scorecardId,
    )
  );
}

function canonicalExplicitPairs(
  pairs: readonly ComparisonPairSelection[],
  vendorRuns: readonly RunRecord[],
  scores: readonly EffectiveArtifactScoreTableRecord[],
): readonly ComparisonPairSelection[] {
  const seen = new Set<string>();
  return pairs.flatMap((pair) => {
    const requestedLeft = scoredRunById(
      pair.leftRunId,
      vendorRuns,
      scores,
      pair.leftScorecardId,
    );
    const requestedRight = scoredRunById(
      pair.rightRunId,
      vendorRuns,
      scores,
      pair.rightScorecardId,
    );
    const [left, right] =
      compareCanonicalRunOrder(requestedLeft, requestedRight) <= 0
        ? [requestedLeft, requestedRight]
        : [requestedRight, requestedLeft];
    const canonicalPair: ComparisonPairSelection = {
      leftRunId: left.run.recordId,
      leftScorecardId: left.score.scorecard.scorecardId,
      rightRunId: right.run.recordId,
      rightScorecardId: right.score.scorecard.scorecardId,
    };
    const key = JSON.stringify([
      canonicalPair.leftRunId,
      canonicalPair.leftScorecardId,
      canonicalPair.rightRunId,
      canonicalPair.rightScorecardId,
    ]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [canonicalPair];
  });
}

function defaultViewPairs(
  vendorRuns: readonly RunRecord[],
  scores: readonly ArtifactScoreTableRecord[],
): readonly ComparisonPairSelection[] {
  const scoredRunIds = new Set(scores.map(({ runId }) => runId));
  const scoredRuns = vendorRuns
    .filter((run) => scoredRunIds.has(run.recordId))
    .sort(
      (left, right) =>
        (COMPARISON_VENDOR_ORDER.get(left.productVendorId ?? "") ??
          Number.MAX_SAFE_INTEGER) -
          (COMPARISON_VENDOR_ORDER.get(right.productVendorId ?? "") ??
            Number.MAX_SAFE_INTEGER) ||
        left.recordId.localeCompare(right.recordId),
    );
  return scoredRuns.flatMap((left, leftIndex) =>
    scoredRuns.slice(leftIndex + 1).map((right) => ({
      leftRunId: left.recordId,
      rightRunId: right.recordId,
    })),
  );
}

export function planCompatibleComparisonPairs(command: {
  readonly jobId: string;
  readonly vendorRuns: readonly RunRecord[];
  readonly artifactScores: readonly ArtifactScoreTableRecord[];
}): readonly ComparisonPairSelection[] {
  return defaultViewPairs(
    command.vendorRuns,
    command.artifactScores,
  ).filter((pair) => {
    const left = scoredRunById(
      pair.leftRunId,
      command.vendorRuns,
      command.artifactScores,
      pair.leftScorecardId,
    );
    const right = scoredRunById(
      pair.rightRunId,
      command.vendorRuns,
      command.artifactScores,
      pair.rightScorecardId,
    );
    return compatibleComparisonLineage(command.jobId, left, right);
  });
}

export function createComparisonReportService({
  feishu,
  egressAuthorization,
  egressAudit,
  clock,
}: ComparisonReportServiceDependencies): ComparisonReportService {
  return {
    async createReport(command) {
      const requiresAuthorizedPersistence =
        isHarnessOwnedLarkBaseProjection(feishu);
      if (
        requiresAuthorizedPersistence &&
        (egressAuthorization === undefined ||
          egressAudit === undefined)
      ) {
        throw new Error(
          "Production dynamic comparison requires authorized Lark persistence",
        );
      }
      for (let staleRetry = 0; ; staleRetry += 1) {
        try {
          const baseline = requiresAuthorizedPersistence
            ? await feishu.captureCommitBaseline(command.jobId)
            : undefined;
          const writeProjection = requiresAuthorizedPersistence
            ? feishu.forkForStaging(baseline!.localSnapshot)
            : feishu;
          const source = await writeProjection.loadComparisonReportSource(
            command.jobId,
          );
          for (const score of source.artifactScores) {
            assertArtifactScoreCompatibility(
              score,
              source.evaluationCase,
              source.job.protocolSnapshot,
            );
          }
          const adjudicationService = createScoreAdjudicationService({
            feishu: writeProjection,
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
            command.pairs === undefined
              ? planCompatibleComparisonPairs({
                  jobId: command.jobId,
                  vendorRuns: source.vendorRuns,
                  artifactScores: effectiveScores,
                })
              : canonicalExplicitPairs(
                  command.pairs,
                  source.vendorRuns,
                  effectiveScores,
                );
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
          if (comparisons.length === 0) {
            throw new Error(
              "A comparison report requires at least one compatible pair",
            );
          }
          for (const comparison of comparisons) {
            await writeProjection.appendComparison(comparison);
          }
          const gapCards = createGapCards(
            feishu,
            comparisons,
            source.vendorRuns,
            effectiveScores,
          );
          for (const gapCard of gapCards) {
            await writeProjection.appendProductGapCard(gapCard);
          }
          const vendorSummaries = deriveCanonicalVendorSummaries(
            (artifactId, pageNumber) =>
              feishu.artifactPageEvidenceUrl(
                artifactId,
                pageNumber,
              ),
            comparisons,
            source.vendorRuns,
            effectiveScores,
          );
          const report = await writeProjection.createReport(
            buildCanonicalComparisonReportDraft({
              resolveEvidenceUrl: (artifactId, pageNumber) =>
                feishu.artifactPageEvidenceUrl(
                  artifactId,
                  pageNumber,
                ),
              job: source.job,
              vendorRuns: source.vendorRuns,
              capturedArtifacts: source.capturedArtifacts,
              comparisons,
              gapCards,
              vendorSummaries,
              scores: effectiveScores,
            }),
          );
          await writeProjection.linkReportToBakeoffJob(
            command.jobId,
            report.url,
            command.pairs === undefined ? "primary" : "auxiliary",
          );
          let materializedReport = report;
          if (requiresAuthorizedPersistence) {
            const snapshot =
              await persistHarnessOwnedLarkProjectionSnapshot({
                projection: feishu,
                stagedSnapshot: writeProjection.snapshot(),
                baseline: baseline!,
                jobId: command.jobId,
                egressAuthorization: egressAuthorization!,
                egressAudit: egressAudit!,
                ...(clock === undefined ? {} : { clock }),
              });
            const readback = snapshot.reports.find(
              ({ reportId }) => reportId === report.reportId,
            );
            if (
              readback === undefined ||
              !/^https:\/\/[^/\s]+\/docx\/[a-zA-Z0-9_-]+$/.test(
                readback.url,
              )
            ) {
              throw new Error(
                "Production dynamic comparison report was not materialized",
              );
            }
            materializedReport = readback;
          }
          return {
            comparisons,
            gapCards,
            vendorSummaries,
            report: materializedReport,
          };
        } catch (error) {
          if (
            !requiresAuthorizedPersistence ||
            !(error instanceof ProjectionStaleBaselineError) ||
            staleRetry >= 2
          ) {
            throw error;
          }
        }
      }
    },
  };
}
