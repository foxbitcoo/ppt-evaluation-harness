import { createHash } from "node:crypto";

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
import type { OpenAiJudgePort } from "./openai-judge.ts";
import type {
  ProductAdapterPort,
  ProductAttemptResult,
  ProductPackageSnapshot,
} from "./product-adapter.ts";
import {
  InMemoryReferencePackStore,
  ReviewedReferencePackGenerator,
  resolveReferencePackForCase,
  type ReferencePack,
  type ReferencePackGeneratorPort,
  type ReferencePackStorePort,
} from "./reference-pack.ts";

export const VENDOR_GENERATION_TIMEOUT_MS = 30 * 60 * 1_000;

export type AttemptDeadlineResult<T> =
  | {
      readonly timedOut: false;
      readonly value: T;
      readonly elapsedMs: number;
    }
  | {
      readonly timedOut: true;
      readonly elapsedMs: number;
    };

export interface AttemptDeadlinePort {
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<AttemptDeadlineResult<T>>;
}

const WALL_CLOCK_ATTEMPT_DEADLINE: AttemptDeadlinePort = {
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<AttemptDeadlineResult<T>> {
    const controller = new AbortController();
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        controller.abort();
        resolve({ timedOut: true, elapsedMs: timeoutMs });
      }, timeoutMs);
      void operation(controller.signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            timedOut: false,
            value,
            elapsedMs: Math.max(0, Date.now() - startedAt),
          });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  },
};

export interface BakeoffHarness {
  startBakeoffJob(command: StartBakeoffJobCommand): Promise<BakeoffJobOutcome>;
}

export interface BakeoffHarnessDependencies {
  readonly feishu: FeishuProjectionPort;
  readonly productAdapter?: ProductAdapterPort;
  readonly productAdapters?: readonly ProductAdapterPort[];
  readonly attemptDeadline?: AttemptDeadlinePort;
  readonly referencePackStore?: ReferencePackStorePort;
  readonly referencePackGenerator?: ReferencePackGeneratorPort;
  readonly judge?: OpenAiJudgePort;
}

interface CapturedVendorResult {
  readonly productPackage: ProductPackageSnapshot;
  readonly runId: string;
  readonly status: RunStatus;
  readonly terminalReason: TerminalReason;
  readonly blockReason: BlockReason | null;
  readonly artifact: Artifact | null;
  readonly renderManifest: RenderManifest | null;
  readonly scorecard: ArtifactScorecard | null;
  readonly attemptRecords: readonly RunRecord[];
}

interface SelectedProductAdapter {
  readonly adapter: ProductAdapterPort;
  readonly productPackage: ProductPackageSnapshot;
  readonly runId: string;
}

const KNOWN_VENDOR_SLUGS = new Map<string, string>([
  ["MOCK-wps-package-v1", "wps"],
  ["MOCK-qwen-package-v1", "qwen"],
  ["MOCK-doubao-package-v1", "doubao"],
]);

type KnownVendorScenario =
  (typeof MOCK_SCENARIO.vendors)[keyof typeof MOCK_SCENARIO.vendors];

const KNOWN_VENDOR_SCENARIOS = new Map<string, KnownVendorScenario>(
  Object.entries(MOCK_SCENARIO.vendors),
);

function vendorSlug(packageId: string): string {
  const knownSlug = KNOWN_VENDOR_SLUGS.get(packageId);
  if (knownSlug !== undefined) return knownSlug;
  const readableSlug =
    packageId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "package";
  const hash = createHash("sha256")
    .update(packageId)
    .digest("hex")
    .slice(0, 32);
  return `${readableSlug}-${hash}`;
}

function runIdForPackage(packageId: string): string {
  const scenario = KNOWN_VENDOR_SCENARIOS.get(packageId);
  return (
    scenario?.runId ?? `MOCK-run-${vendorSlug(packageId)}-volcano-v1`
  );
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

function fixedTimestampAfter(elapsedMs: number): string {
  return new Date(
    Date.parse(MOCK_SCENARIO.fixedTime) + elapsedMs,
  ).toISOString();
}

function attemptRecord(input: {
  readonly productPackage: ProductPackageSnapshot;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly result: ProductAttemptResult;
  readonly measuredElapsedMs: number;
  readonly vendorReportedElapsedMs: number | null;
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
    product: input.productPackage.displayName,
    productPackageId: input.productPackage.packageId,
    adapterVersion: input.productPackage.adapterVersion,
    status: input.status,
    attemptSeq: input.attemptSeq,
    elapsedMs: input.measuredElapsedMs,
    submissionEvidence: input.result.submissionEvidence,
    terminalReason:
      input.terminalReason === "human_wait" ? null : input.terminalReason,
    waitingReason:
      input.terminalReason === "human_wait" ? "human_intervention" : null,
    blockReason: input.result.blockReason,
    retryOfAttemptId: input.retryOfAttemptId,
    selectedRunIds: null,
    protocolSnapshot: null,
    deadlineAt: null,
    vendorGenerationMs: input.measuredElapsedMs,
    vendorReportedElapsedMs: input.vendorReportedElapsedMs,
    humanWaitMs: null,
    timingPausedAt:
      input.terminalReason === "human_wait"
        ? fixedTimestampAfter(input.measuredElapsedMs)
        : null,
    observableEvents: [
      {
        eventId: `${input.attemptId}-event-1`,
        jobId: MOCK_SCENARIO.jobId,
        caseId: input.caseId,
        runId: input.runId,
        attemptId: input.attemptId,
        attemptSeq: input.attemptSeq,
        eventType:
          input.terminalReason === "human_wait"
            ? "waiting_for_human"
            : `terminal:${input.terminalReason}`,
        sourceAt: fixedTimestampAfter(input.measuredElapsedMs),
        observedAt: fixedTimestampAfter(input.measuredElapsedMs),
        writerId: "mock-runner@1",
        evidenceRef: `mock://${vendorSlug(
          input.productPackage.packageId,
        )}/attempt-${input.attemptSeq}`,
      },
    ],
    manualActions: [],
    costEvidence: {
      classification: "unknown",
      amount: null,
      currency: null,
    },
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
  selection: SelectedProductAdapter,
  caseId: string,
  attemptDeadline: AttemptDeadlinePort,
  jobDeadlineAtEpochMs: number,
  referencePack: ReferencePack | null,
  judge: OpenAiJudgePort | undefined,
  onReferencePackUse: (scorecardId: string) => void,
): Promise<CapturedVendorResult> {
  const { adapter, productPackage, runId } = selection;
  const scenario = KNOWN_VENDOR_SCENARIOS.get(
    productPackage.packageId,
  );
  const attempts: RunRecord[] = [];
  let retryOfAttemptId: string | null = null;
  let attemptSeq = 1;
  let observedBudgetRemainingMs = VENDOR_GENERATION_TIMEOUT_MS;
  let result: ProductAttemptResult;
  let terminalReason: TerminalReason;
  let status: RunStatus;

  while (true) {
    const attemptId = `${runId}-attempt-${attemptSeq}`;
    let measuredElapsedMs = 0;
    let vendorReportedElapsedMs: number | null = null;
    const attemptTimeoutMs = Math.max(
      0,
      Math.min(
        observedBudgetRemainingMs,
        jobDeadlineAtEpochMs - Date.now(),
      ),
    );
    if (attemptTimeoutMs === 0) {
      result = {
        terminalReason: "vendor_timeout",
        blockReason: null,
        submissionEvidence: "unknown",
        elapsedMs: 0,
        artifactCandidates: [],
      };
    } else {
      const startedAt = Date.now();
      try {
        const deadlineResult = await attemptDeadline.run(
          (signal) =>
            adapter.execute({
              jobId: MOCK_SCENARIO.jobId,
              runId,
              attemptId,
              attemptSeq,
              timeoutMs: attemptTimeoutMs,
              signal,
              evaluationCase: VOLCANO_EVALUATION_CASE,
            }),
          attemptTimeoutMs,
        );
        observedBudgetRemainingMs = Math.max(
          0,
          observedBudgetRemainingMs - deadlineResult.elapsedMs,
        );
        measuredElapsedMs = deadlineResult.elapsedMs;
        result = deadlineResult.timedOut
          ? {
              terminalReason: "vendor_timeout",
              blockReason: null,
              submissionEvidence: "unknown",
              elapsedMs: deadlineResult.elapsedMs,
              artifactCandidates: [],
            }
          : normalizeExecution(deadlineResult.value);
        if (!deadlineResult.timedOut) {
          vendorReportedElapsedMs = result.elapsedMs;
        }
      } catch {
        measuredElapsedMs = Math.max(0, Date.now() - startedAt);
        observedBudgetRemainingMs = Math.max(
          0,
          observedBudgetRemainingMs - measuredElapsedMs,
        );
        result = {
          terminalReason: "technical_failure",
          blockReason: null,
          submissionEvidence: "unknown",
          elapsedMs: measuredElapsedMs,
          artifactCandidates: [],
        };
      }
    }
    terminalReason = result.terminalReason;
    status = statusFromTerminalReason(terminalReason);
    attempts.push(
      attemptRecord({
        productPackage,
        runId,
        attemptId,
        attemptSeq,
        result,
        measuredElapsedMs,
        vendorReportedElapsedMs,
        terminalReason,
        status,
        retryOfAttemptId,
        caseId,
      }),
    );
    const mayRetry =
      attemptSeq === 1 &&
      terminalReason === "technical_failure" &&
      result.submissionEvidence === "not_submitted" &&
      observedBudgetRemainingMs > 0 &&
      jobDeadlineAtEpochMs > Date.now();
    if (!mayRetry) break;
    retryOfAttemptId = attemptId;
    attemptSeq += 1;
  }

  if (status !== "completed") {
    return {
      productPackage,
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
      productPackage,
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
    scenario?.renderManifestId ??
      runId.replace(/^MOCK-run-/, "MOCK-render-"),
  );
  const scorecardId =
    scenario?.scorecardId ??
    runId.replace(/^MOCK-run-/, "MOCK-scorecard-");
  if (referencePack !== null) {
    onReferencePackUse(scorecardId);
  }
  const scorecard =
    judge === undefined
      ? scoreRenderedArtifact(artifact, renderManifest, {
          jobId: MOCK_SCENARIO.jobId,
          runId,
          referencePack,
          scorecardId,
        })
      : await judge.score({
          jobId: MOCK_SCENARIO.jobId,
          runId,
          scorecardId,
          evaluationCase: VOLCANO_EVALUATION_CASE,
          artifact,
          renderManifest,
          referencePack,
        });
  if (
    scorecard.scorecardId !== scorecardId ||
    scorecard.jobId !== MOCK_SCENARIO.jobId ||
    scorecard.runId !== runId ||
    scorecard.artifactId !== artifact.artifactId ||
    scorecard.provenance !== artifact.provenance ||
    scorecard.environmentOrigin !== artifact.environmentOrigin ||
    scorecard.evaluationInputManifest.artifactHash !==
      artifact.contentHash ||
    scorecard.evaluationInputManifest.renderManifestHash !==
      renderManifest.contentHash ||
    scorecard.evaluationInputManifest.referencePackHash !==
      (referencePack?.contentHash ?? null)
  ) {
    throw new Error("Judge returned an inconsistent Scorecard lineage");
  }
  return {
    productPackage,
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
  attemptDeadline = WALL_CLOCK_ATTEMPT_DEADLINE,
  referencePackStore = new InMemoryReferencePackStore(
    () => MOCK_SCENARIO.fixedTime,
  ),
  referencePackGenerator = new ReviewedReferencePackGenerator(),
  judge,
}: BakeoffHarnessDependencies): BakeoffHarness {
  const selectedProductAdapters = Object.freeze([
    ...(productAdapters ??
      (productAdapter === undefined ? [] : [productAdapter])),
  ]);
  if (selectedProductAdapters.length === 0) {
    throw new Error("A Bakeoff Job requires at least one Product Adapter");
  }

  return {
    async startBakeoffJob(command) {
      if (command.caseId !== VOLCANO_CASE_ID) {
        throw new Error(`Unknown Evaluation Case: ${command.caseId}`);
      }
      if (command.environment !== feishu.targetEnvironment) {
        throw new Error(
          `${command.environment} command cannot use ${feishu.targetEnvironment} projection environment`,
        );
      }
      const selections = Object.freeze(
        selectedProductAdapters.map((adapter) => {
          const productPackage = Object.freeze({
            ...adapter.productPackage,
          });
          return Object.freeze({
            adapter,
            productPackage,
            runId: runIdForPackage(productPackage.packageId),
          });
        }),
      );
      const packageIds = selections.map(
        ({ productPackage }) => productPackage.packageId,
      );
      if (new Set(packageIds).size !== packageIds.length) {
        throw new Error("Bakeoff Job contains duplicate Product Package IDs");
      }
      const selectedRunIds = selections.map(({ runId }) => runId);
      if (new Set(selectedRunIds).size !== selectedRunIds.length) {
        throw new Error("Bakeoff Job contains duplicate derived Run IDs");
      }
      for (const { productPackage } of selections) {
        assertEnvironmentOriginAllowed(
          productPackage.environmentOrigin,
          command.environment,
          `Product Package ${productPackage.packageId}`,
        );
      }

      const referencePackSelection = resolveReferencePackForCase({
        evaluationCase: VOLCANO_EVALUATION_CASE,
        ...(command.referencePackMode === undefined
          ? {}
          : { mode: command.referencePackMode }),
        generator: referencePackGenerator,
      });
      const stagedReferencePack =
        referencePackSelection.pack === null
          ? null
          : referencePackStore.stage(referencePackSelection.pack, {
              jobId: MOCK_SCENARIO.jobId,
            });
      const jobDeadlineAtEpochMs =
        Date.now() + VENDOR_GENERATION_TIMEOUT_MS;
      const scorecardIdsThatUsedPack = new Set<string>();
      const settledResults = await Promise.allSettled(
        selections.map((selection) =>
          executeVendor(
            selection,
            command.caseId,
            attemptDeadline,
            jobDeadlineAtEpochMs,
            referencePackSelection.pack,
            judge,
            (scorecardId) => {
              scorecardIdsThatUsedPack.add(scorecardId);
            },
          ),
        ),
      );
      const completedResults = settledResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (stagedReferencePack !== null) {
        if (scorecardIdsThatUsedPack.size === 0) {
          referencePackStore.deleteUnused(stagedReferencePack.stagingId);
        } else {
          referencePackStore.retainUsed(stagedReferencePack.stagingId, {
            jobId: MOCK_SCENARIO.jobId,
            scorecardIds: [...scorecardIdsThatUsedPack],
          });
        }
      }
      const rejectedResult = settledResults.find(
        (result) => result.status === "rejected",
      );
      if (rejectedResult?.status === "rejected") {
        throw rejectedResult.reason;
      }
      const results = completedResults;
      const artifactIds = results.flatMap(({ artifact }) =>
        artifact === null ? [] : [artifact.artifactId],
      );
      if (new Set(artifactIds).size !== artifactIds.length) {
        throw new Error("Bakeoff Job contains duplicate Artifact IDs");
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
        results.some(({ status }) => status === "waiting_for_human")
          ? "active"
          : successful.length === results.length
          ? "completed"
          : successful.length === 0
            ? "failed"
            : "partial";
      const firstSuccessful = successful[0];
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
        waitingReason: null,
        blockReason: null,
        retryOfAttemptId: null,
        selectedRunIds: results.map(({ runId }) => runId),
        protocolSnapshot: {
          protocolId: "MOCK-query-default-cost-v1",
          timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
          retryPolicy: "one_if_provably_not_submitted",
          resultSelectionPolicy: "first_policy_compliant_artifact",
          cancellationPolicy: "independent_vendor_runs_continue",
        },
        deadlineAt: fixedTimestampAfter(VENDOR_GENERATION_TIMEOUT_MS),
        vendorGenerationMs: null,
        vendorReportedElapsedMs: null,
        humanWaitMs: null,
        timingPausedAt: null,
        observableEvents: null,
        manualActions: null,
        costEvidence: null,
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
          product: result.productPackage.displayName,
          productPackageId: result.productPackage.packageId,
          adapterVersion: result.productPackage.adapterVersion,
          status: result.status,
          attemptSeq: null,
          elapsedMs: null,
          submissionEvidence: null,
          terminalReason:
            result.terminalReason === "human_wait"
              ? null
              : result.terminalReason,
          waitingReason:
            result.terminalReason === "human_wait"
              ? "human_intervention"
              : null,
          blockReason: result.blockReason,
          retryOfAttemptId: null,
          selectedRunIds: null,
          protocolSnapshot: null,
          deadlineAt: null,
          vendorGenerationMs: null,
          vendorReportedElapsedMs: null,
          humanWaitMs: null,
          timingPausedAt: null,
          observableEvents: null,
          manualActions: null,
          costEvidence: null,
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

      const leftResult = successful[0];
      for (const rightResult of successful.slice(1)) {
        if (leftResult === undefined) break;
        const leftSlug = vendorSlug(
          leftResult.productPackage.packageId,
        );
        const rightSlug = vendorSlug(
          rightResult.productPackage.packageId,
        );
        const comparisonId = `MOCK-comparison-${leftSlug}-${rightSlug}-volcano-v1`;
        await feishu.appendComparison({
          recordType: "comparison",
          comparisonId,
          caseId: command.caseId,
          jobId: MOCK_SCENARIO.jobId,
          leftRunId: leftResult.runId,
          rightRunId: rightResult.runId,
          leftScorecardId: leftResult.scorecard.scorecardId,
          rightScorecardId: rightResult.scorecard.scorecardId,
          provenance: "MOCK",
          environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
        });
        await feishu.appendProductGapCard({
          recordType: "gap_card",
          gapCardId: `MOCK-gap-${leftSlug}-${rightSlug}-volcano-v1`,
          caseId: command.caseId,
          jobId: MOCK_SCENARIO.jobId,
          comparisonId,
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
            product: result.productPackage.displayName,
            runId: result.runId,
            status: result.status,
            stateReason: result.terminalReason,
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
        artifact: firstSuccessful?.artifact ?? null,
        renderManifest: firstSuccessful?.renderManifest ?? null,
        scorecard: firstSuccessful?.scorecard ?? null,
        artifacts: successful.map(({ artifact }) => artifact),
        renderManifests: successful.map(
          ({ renderManifest }) => renderManifest,
        ),
        scorecards: successful.map(({ scorecard }) => scorecard),
        report,
      };
    },
  };
}
