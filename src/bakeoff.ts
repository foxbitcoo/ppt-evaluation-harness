import type {
  Artifact,
  ArtifactScorecard,
  BakeoffJobOutcome,
  BlockReason,
  RenderManifest,
  RunRecord,
  RunStatus,
  StartBakeoffJobCommand,
  SubmissionEvidence,
  TerminalReason,
} from "./domain.ts";
import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  assertEnvironmentOriginAllowed,
} from "./environment-origin.ts";
import type { FeishuProjectionPort } from "./feishu.ts";
import {
  VOLCANO_CASE_ID,
  VOLCANO_EVALUATION_CASE,
} from "./fixtures/volcano-case.ts";
import { renderStaticArtifact } from "./mock-wps.ts";
import { createMockReportDraft } from "./mock-report.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";
import { scoreRenderedArtifact } from "./mock-score.ts";
import type {
  ProductAdapterPort,
  ProductAttemptResult,
} from "./product-adapter.ts";

export const VENDOR_GENERATION_TIMEOUT_MS = 30 * 60 * 1_000;

export interface BakeoffHarness {
  startBakeoffJob(command: StartBakeoffJobCommand): Promise<BakeoffJobOutcome>;
}

export interface BakeoffHarnessDependencies {
  readonly feishu: FeishuProjectionPort;
  readonly productAdapter?: ProductAdapterPort;
  readonly productAdapters?: readonly ProductAdapterPort[];
}

interface CapturedVendorResult {
  readonly adapter: ProductAdapterPort;
  readonly runId: string;
  readonly status: RunStatus;
  readonly terminalReason: TerminalReason;
  readonly blockReason: BlockReason | null;
  readonly artifact: Artifact | null;
  readonly renderManifest: RenderManifest | null;
  readonly scorecard: ArtifactScorecard | null;
  readonly attemptRecords: readonly RunRecord[];
}

function isArtifact(
  execution: Artifact | ProductAttemptResult,
): execution is Artifact {
  return "content" in execution;
}

function normalizeExecution(
  execution: Artifact | ProductAttemptResult,
): ProductAttemptResult {
  if (!isArtifact(execution)) {
    return execution;
  }
  return {
    terminalReason: "success",
    blockReason: null,
    submissionEvidence: "submitted",
    elapsedMs: 1,
    artifactCandidates: [{ artifact: execution, policyCompliant: true }],
  };
}

function statusFromTerminalReason(reason: TerminalReason): RunStatus {
  if (reason === "success") return "completed";
  if (reason === "vendor_timeout") return "timed_out";
  if (
    reason === "payment" ||
    reason === "quota" ||
    reason === "authentication"
  ) {
    return "blocked";
  }
  if (reason === "human_wait") return "waiting_for_human";
  return "failed";
}

function attemptRecord(input: {
  readonly adapter: ProductAdapterPort;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly result: ProductAttemptResult;
  readonly terminalReason: TerminalReason;
  readonly status: RunStatus;
  readonly retryOfAttemptId: string | null;
  readonly caseId: string;
}): RunRecord {
  return {
    recordId: input.attemptId,
    recordType: "evaluation_attempt",
    jobId: MOCK_SCENARIO.jobId,
    parentRecordId: input.runId,
    caseId: input.caseId,
    product: input.adapter.productPackage.displayName,
    productPackageId: input.adapter.productPackage.packageId,
    adapterVersion: input.adapter.productPackage.adapterVersion,
    status: input.status,
    attemptSeq: input.attemptSeq,
    elapsedMs: input.result.elapsedMs,
    submissionEvidence: input.result.submissionEvidence,
    terminalReason: input.terminalReason,
    blockReason: input.result.blockReason,
    retryOfAttemptId: input.retryOfAttemptId,
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    createdAt: MOCK_SCENARIO.fixedTime,
    lastSyncedAt: MOCK_SCENARIO.fixedTime,
    reportUrl: null,
    artifactId: null,
    renderManifestId: null,
    scorecardId: null,
  };
}

async function executeVendor(
  adapter: ProductAdapterPort,
  caseId: string,
): Promise<CapturedVendorResult> {
  const scenario =
    MOCK_SCENARIO.vendors[
      adapter.productPackage.packageId as keyof typeof MOCK_SCENARIO.vendors
    ];
  const runId = scenario?.runId ?? MOCK_SCENARIO.runId;
  const attempts: RunRecord[] = [];
  let retryOfAttemptId: string | null = null;
  let attemptSeq = 1;
  let result: ProductAttemptResult;
  let terminalReason: TerminalReason;
  let status: RunStatus;

  while (true) {
    const attemptId = `${runId}-attempt-${attemptSeq}`;
    const rawExecution = await adapter.execute({
      jobId: MOCK_SCENARIO.jobId,
      runId,
      attemptId,
      attemptSeq,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    });
    result = normalizeExecution(rawExecution);
    terminalReason =
      result.elapsedMs >= VENDOR_GENERATION_TIMEOUT_MS
        ? "vendor_timeout"
        : result.terminalReason;
    status = statusFromTerminalReason(terminalReason);
    attempts.push(
      attemptRecord({
        adapter,
        runId,
        attemptId,
        attemptSeq,
        result,
        terminalReason,
        status,
        retryOfAttemptId,
        caseId,
      }),
    );
    const mayRetry =
      attemptSeq === 1 &&
      terminalReason === "technical_failure" &&
      result.submissionEvidence === "not_submitted";
    if (!mayRetry) break;
    retryOfAttemptId = attemptId;
    attemptSeq += 1;
  }

  if (status !== "completed") {
    return {
      adapter,
      runId,
      status,
      terminalReason,
      blockReason: result.blockReason,
      artifact: null,
      renderManifest: null,
      scorecard: null,
      attemptRecords: attempts,
    };
  }

  const artifact = result.artifactCandidates.find(
    ({ policyCompliant }) => policyCompliant,
  )?.artifact;
  if (artifact === undefined) {
    return {
      adapter,
      runId,
      status: "failed",
      terminalReason: "technical_failure",
      blockReason: null,
      artifact: null,
      renderManifest: null,
      scorecard: null,
      attemptRecords: attempts.map((attempt, index) =>
        index === attempts.length - 1
          ? {
              ...attempt,
              status: "failed",
              terminalReason: "technical_failure",
            }
          : attempt,
      ),
    };
  }
  if (artifact.runId !== runId || artifact.provenance !== "MOCK") {
    throw new Error("Test Bakeoff Job requires MOCK Artifact lineage");
  }
  const renderManifest = renderStaticArtifact(
    artifact,
    scenario?.renderManifestId,
  );
  const scorecard = scoreRenderedArtifact(artifact, renderManifest, {
    jobId: MOCK_SCENARIO.jobId,
    runId,
    scorecardId: scenario?.scorecardId,
  });
  return {
    adapter,
    runId,
    status,
    terminalReason,
    blockReason: null,
    artifact,
    renderManifest,
    scorecard,
    attemptRecords: attempts.map((attempt, index) =>
      index === attempts.length - 1
        ? { ...attempt, artifactId: artifact.artifactId }
        : attempt,
    ),
  };
}

function sharedRunFields(caseId: string) {
  return {
    jobId: MOCK_SCENARIO.jobId,
    caseId,
    provenance: "MOCK" as const,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    createdAt: MOCK_SCENARIO.fixedTime,
    lastSyncedAt: MOCK_SCENARIO.fixedTime,
    reportUrl: null,
  };
}

export function createBakeoffHarness({
  feishu,
  productAdapter,
  productAdapters,
}: BakeoffHarnessDependencies): BakeoffHarness {
  const selectedProductAdapters =
    productAdapters ?? (productAdapter === undefined ? [] : [productAdapter]);
  if (selectedProductAdapters.length === 0) {
    throw new Error("A Bakeoff Job requires at least one Product Adapter");
  }

  return {
    async startBakeoffJob(command) {
      if (command.caseId !== VOLCANO_CASE_ID) {
        throw new Error(`Unknown Evaluation Case: ${command.caseId}`);
      }
      for (const adapter of selectedProductAdapters) {
        assertEnvironmentOriginAllowed(
          adapter.productPackage.environmentOrigin,
          command.environment,
          `Product Package ${adapter.productPackage.packageId}`,
        );
      }

      const results: CapturedVendorResult[] = [];
      for (const adapter of selectedProductAdapters) {
        results.push(await executeVendor(adapter, command.caseId));
      }
      const successful = results.filter(
        (
          result,
        ): result is CapturedVendorResult & {
          readonly artifact: Artifact;
          readonly renderManifest: RenderManifest;
          readonly scorecard: ArtifactScorecard;
        } =>
          result.status === "completed" &&
          result.artifact !== null &&
          result.renderManifest !== null &&
          result.scorecard !== null,
      );
      const jobStatus =
        successful.length === results.length
          ? "completed"
          : successful.length === 0
            ? "failed"
            : "partial";
      const firstSuccessful = successful[0];
      if (firstSuccessful === undefined) {
        throw new Error("Bakeoff Job produced no captured Artifact");
      }

      await feishu.upsertCase(VOLCANO_EVALUATION_CASE);
      await feishu.appendRunRecord({
        recordId: MOCK_SCENARIO.jobId,
        recordType: "bakeoff_job",
        parentRecordId: null,
        product: null,
        productPackageId: null,
        adapterVersion: null,
        status: jobStatus,
        attemptSeq: null,
        elapsedMs: null,
        submissionEvidence: null,
        terminalReason: null,
        blockReason: null,
        retryOfAttemptId: null,
        artifactId: null,
        renderManifestId: null,
        scorecardId: null,
        ...sharedRunFields(command.caseId),
      });
      for (const result of results) {
        await feishu.appendRunRecord({
          recordId: result.runId,
          recordType: "vendor_run",
          parentRecordId: MOCK_SCENARIO.jobId,
          product: result.adapter.productPackage.displayName,
          productPackageId: result.adapter.productPackage.packageId,
          adapterVersion: result.adapter.productPackage.adapterVersion,
          status: result.status,
          attemptSeq: null,
          elapsedMs: null,
          submissionEvidence: null,
          terminalReason: result.terminalReason,
          blockReason: result.blockReason,
          retryOfAttemptId: null,
          artifactId: result.artifact?.artifactId ?? null,
          renderManifestId: result.renderManifest?.renderManifestId ?? null,
          scorecardId: result.scorecard?.scorecardId ?? null,
          ...sharedRunFields(command.caseId),
        });
        for (const attempt of result.attemptRecords) {
          await feishu.appendRunRecord(attempt);
        }
        if (
          result.artifact !== null &&
          result.renderManifest !== null &&
          result.scorecard !== null
        ) {
          await feishu.appendArtifactScore({
            recordId: result.scorecard.scorecardId,
            caseId: command.caseId,
            jobId: MOCK_SCENARIO.jobId,
            runId: result.runId,
            artifactId: result.artifact.artifactId,
            provenance: "MOCK",
            environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
            artifact: result.artifact,
            renderManifest: result.renderManifest,
            scorecard: result.scorecard,
          });
        }
      }

      const wpsResult = successful.find(
        ({ adapter }) =>
          adapter.productPackage.packageId === "MOCK-wps-package-v1",
      );
      for (const result of successful) {
        if (
          wpsResult === undefined ||
          result === wpsResult ||
          (result.adapter.productPackage.packageId !==
            "MOCK-qwen-package-v1" &&
            result.adapter.productPackage.packageId !==
              "MOCK-doubao-package-v1")
        ) {
          continue;
        }
        await feishu.appendProductGapCard({
          gapCardId:
            result.adapter.productPackage.packageId ===
            "MOCK-qwen-package-v1"
              ? MOCK_SCENARIO.gapCards.qwen
              : MOCK_SCENARIO.gapCards.doubao,
          caseId: command.caseId,
          jobId: MOCK_SCENARIO.jobId,
          baselineRunId: wpsResult.runId,
          candidateRunId: result.runId,
          baselineScorecardId: wpsResult.scorecard.scorecardId,
          candidateScorecardId: result.scorecard.scorecardId,
          provenance: "MOCK",
          environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
          workflowState: "draft",
          causeAttribution: "HYPOTHESIS",
        });
      }
      const report = await feishu.createReport(
        createMockReportDraft(
          MOCK_SCENARIO.jobId,
          jobStatus,
          results.map((result) => ({
            product: result.adapter.productPackage.displayName,
            runId: result.runId,
            status: result.status,
            terminalReason: result.terminalReason,
            artifact: result.artifact,
            scorecard: result.scorecard,
          })),
        ),
      );
      await feishu.linkReportToBakeoffJob(MOCK_SCENARIO.jobId, report.url);

      return {
        job: {
          jobId: MOCK_SCENARIO.jobId,
          caseId: command.caseId,
          environment: command.environment,
          status: jobStatus,
          provenance: "MOCK",
          environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
        },
        artifact: firstSuccessful.artifact,
        renderManifest: firstSuccessful.renderManifest,
        scorecard: firstSuccessful.scorecard,
        report,
      };
    },
  };
}
