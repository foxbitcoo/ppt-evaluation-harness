import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MockWpsProductAdapter,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  DoubaoProductionProductAdapter,
  QwenProductionProductAdapter,
  VOLCANO_CASE_ID,
  WpsAiPptProductAdapter,
  assertHarnessOwnedLarkBaseProjection,
  assertHarnessOwnedDurableEgressAuthorizationAudit,
  assertHarnessOwnedDurableReferencePackStore,
  assertHarnessOwnedProductionJudge,
  assertT10ProductionAcceptanceReady,
  createBakeoffHarness,
  createHarnessOwnedCodexCliJudge,
  createHarnessOwnedProductionOperationalDurability,
  preflightHarnessOwnedProductionJudge,
  type BakeoffJobOutcome,
  type ComparisonReportSource,
} from "../src/index.ts";
import { createMockReportDraft } from "../src/mock-report.ts";

const SIX_DIMENSIONS = [
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
] as const;

function liveAcceptanceFixture(): {
  readonly outcome: BakeoffJobOutcome;
  readonly source: ComparisonReportSource;
} {
  const runIds = ["run-wps", "run-qwen", "run-doubao"];
  const artifactIds = ["artifact-wps", "artifact-qwen", "artifact-doubao"];
  const artifacts = artifactIds.map((artifactId, index) => ({
    artifactId,
    runId: runIds[index],
    jobId: "production-job-volcano-wps-v1",
    caseId: VOLCANO_CASE_ID,
    provenance: "LIVE_PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    pageCount: 16,
  }));
  const renderManifests = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    provenance: "LIVE_PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    renderOutcome: "faithful",
  }));
  const scorecards = artifacts.map((artifact) => ({
    scorecardId: `score-${artifact.artifactId}`,
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    jobId: artifact.jobId,
    provenance: "LIVE_PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    dimensions: SIX_DIMENSIONS.map((dimension) => ({ dimension })),
  }));
  const report = {
    reportId: "production-report",
    jobId: "production-job-volcano-wps-v1",
    provenance: "PRODUCTION",
    executionProvenance: "LIVE_PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    runIds,
    artifactIds,
    comparisonIds: ["comparison-wps-qwen", "comparison-wps-doubao"],
    gapCardIds: [],
    claimLevel: "case_sample",
    title: "LIVE｜Case Sample",
    markdown: "LIVE",
    createdAt: "2026-08-02T00:00:00.000Z",
    url: "https://my.feishu.cn/docx/production-report",
  };
  const vendorRuns = (["wps", "qwen", "doubao"] as const).map(
    (vendor, index) => ({
      recordId: runIds[index],
      recordType: "vendor_run",
      jobId: "production-job-volcano-wps-v1",
      parentRecordId: "production-job-volcano-wps-v1",
      caseId: VOLCANO_CASE_ID,
      productVendorId: vendor,
      status: "completed",
      provenance: "PRODUCTION",
      executionProvenance: "LIVE_PRODUCTION",
      environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    }),
  );
  const job = {
    recordId: "production-job-volcano-wps-v1",
    recordType: "bakeoff_job",
    jobId: "production-job-volcano-wps-v1",
    caseId: VOLCANO_CASE_ID,
    status: "completed",
    selectedRunIds: runIds,
    provenance: "PRODUCTION",
    executionProvenance: "LIVE_PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
  };
  const capturedArtifacts = artifacts.map((artifact, index) => ({
    recordId: artifact.artifactId,
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    jobId: artifact.jobId,
    caseId: VOLCANO_CASE_ID,
    provenance: "PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    artifact,
    renderManifest: renderManifests[index],
  }));
  const artifactScores = artifacts.map((artifact, index) => ({
    recordId: scorecards[index]!.scorecardId,
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    jobId: artifact.jobId,
    caseId: VOLCANO_CASE_ID,
    provenance: "PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    artifact,
    renderManifest: renderManifests[index],
    scorecard: scorecards[index],
  }));
  return {
    outcome: {
      job: {
        jobId: job.jobId,
        caseId: job.caseId,
        environment: "production",
        status: "completed",
        provenance: "PRODUCTION",
        executionProvenance: "LIVE_PRODUCTION",
        environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
      },
      artifact: artifacts[0],
      renderManifest: renderManifests[0],
      scorecard: scorecards[0],
      artifacts,
      renderManifests,
      scorecards,
      report,
    } as unknown as BakeoffJobOutcome,
    source: {
      evaluationCase: {
        caseId: VOLCANO_CASE_ID,
        provenance: "PRODUCTION",
        environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
      },
      job,
      vendorRuns,
      capturedArtifacts,
      artifactScores,
      primaryReport: report,
    } as unknown as ComparisonReportSource,
  };
}

test("production preflight fails closed on a missing real Judge before any adapter or browser execution", () => {
  assert.throws(
    () => assertHarnessOwnedProductionJudge(undefined),
    /requires an explicit harness-owned real Judge.*Mock scoring is forbidden/i,
  );
});

test("production preflight rejects every unavailable LIVE_PRODUCTION executor before provider egress", async () => {
  for (const [adapter, expected] of [
    [
      new WpsAiPptProductAdapter(),
      /trusted WPS live bridge executable is unavailable/i,
    ],
    [
      new QwenProductionProductAdapter(),
      /Qwen live executable is not embedded/i,
    ],
    [
      new DoubaoProductionProductAdapter(),
      /trusted Doubao live bridge executable is unavailable/i,
    ],
  ] as const) {
    let egressCalls = 0;
    await assert.rejects(
      async () =>
        createBakeoffHarness({
          feishu: new InMemoryFeishuProjection({
            targetEnvironment: "production",
          }),
          productAdapter: adapter,
          egressAuthorization: {
            async authorize() {
              egressCalls += 1;
              throw new Error("provider egress must not start");
            },
          },
        }).startBakeoffJob({
          environment: "production",
          caseId: VOLCANO_CASE_ID,
          executionMode: "capture_only",
        }),
      expected,
    );
    assert.equal(egressCalls, 0);
  }
});

test("the T10 completion gate accepts one exact persisted WPS-Qwen-Doubao LIVE lineage", () => {
  const { outcome, source } = liveAcceptanceFixture();
  assert.doesNotThrow(() =>
    assertT10ProductionAcceptanceReady(outcome, source),
  );
});

test("the T10 completion gate rejects a relabeled Frankenstein outcome with unrelated Jobs, renders, scores, and HTTPS origin", () => {
  const { outcome, source } = liveAcceptanceFixture();
  const attackArtifacts = outcome.artifacts.map((artifact, index) => ({
    ...artifact,
    jobId: `unrelated-artifact-job-${index + 1}`,
  }));
  const attackRenders = outcome.renderManifests.map(
    (renderManifest, index) => ({
      ...renderManifest,
      artifactId: `unrelated-render-artifact-${index + 1}`,
    }),
  );
  const attackScores = outcome.scorecards.map((scorecard, index) => ({
    ...scorecard,
    artifactId: `unrelated-score-artifact-${index + 1}`,
    runId: `unrelated-score-run-${index + 1}`,
    jobId: `unrelated-score-job-${index + 1}`,
    dimensions: [],
  }));
  const attack = {
    ...outcome,
    artifact: attackArtifacts[0],
    renderManifest: attackRenders[0],
    scorecard: attackScores[0],
    artifacts: attackArtifacts,
    renderManifests: attackRenders,
    scorecards: attackScores,
    report: {
      ...outcome.report,
      jobId: "unrelated-report-job",
      url: "https://attacker.example/fake",
    },
  } as BakeoffJobOutcome;

  assert.throws(
    () => assertT10ProductionAcceptanceReady(attack, source),
    /exact persisted LIVE|trusted Feishu|lineage/i,
  );
});

test("production preflight rejects an in-memory Feishu projection even when a real Codex CLI Judge is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-judge-audit-"));
  try {
    const operationalDurability =
      createHarnessOwnedProductionOperationalDurability({ rootPath: root });
    const judge = await createHarnessOwnedCodexCliJudge({
      targetAccount: "chatgpt-codex-session",
      targetRegion: "global",
      egressAuthorization: {
        async authorize() {
          throw new Error("projection preflight must run first");
        },
      },
      egressAudit: operationalDurability.judgeEgressAudit,
    });
    assert.doesNotThrow(() => assertHarnessOwnedProductionJudge(judge));
    await assert.doesNotReject(
      preflightHarnessOwnedProductionJudge(judge),
    );
    assert.throws(
      () =>
        assertHarnessOwnedLarkBaseProjection(
          new InMemoryFeishuProjection({
            targetEnvironment: "production",
          }),
        ),
      /harness-owned verified Lark\/Feishu Base projection/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production Codex CLI Judge rejects a caller-supplied no-op egress audit", async () => {
  await assert.rejects(
    createHarnessOwnedCodexCliJudge({
      targetAccount: "chatgpt-codex-session",
      targetRegion: "global",
      egressAuthorization: {
        async authorize() {
          throw new Error("must not authorize");
        },
      },
      egressAudit: {
        async recordAuthorizedAttempt() {},
      },
    }),
    /harness-owned durable egress attempt audit/i,
  );
});

test("production operational egress audit rejects a caller object that only self-reports durable", () => {
  assert.throws(
    () =>
      assertHarnessOwnedDurableEgressAuthorizationAudit({
        auditId: "caller-fake-durable-audit",
        durability: "durable",
        async append() {},
        async assertRecorded() {},
      }),
    /harness-owned durable egress authorization audit/i,
  );
});

test("production Reference Pack persistence rejects a caller object that only self-reports durable", () => {
  assert.throws(
    () =>
      assertHarnessOwnedDurableReferencePackStore({
        durability: "durable",
        stage() {
          throw new Error("must not stage");
        },
        retainUsed() {
          throw new Error("must not retain");
        },
        deleteUnused() {
          return false;
        },
      }),
    /harness-owned durable Reference Pack store/i,
  );
});

test("capture_only persists captured Artifacts without producing scores, comparisons, gap cards, or reports", async () => {
  let judgeCalls = 0;
  const projection = new InMemoryFeishuProjection();
  const harness = createBakeoffHarness({
    feishu: projection,
    productAdapter: new MockWpsProductAdapter(),
    judge: {
      async score() {
        judgeCalls += 1;
        throw new Error("capture_only must not call a Judge");
      },
    },
  });

  const outcome = await harness.startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    executionMode: "capture_only",
  });
  const replay = await harness.startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
    executionMode: "capture_only",
  });

  assert.equal(outcome.report, null);
  assert.equal(replay.report, null);
  assert.deepEqual(
    replay.artifacts.map(({ artifactId }) => artifactId),
    outcome.artifacts.map(({ artifactId }) => artifactId),
  );
  assert.equal(outcome.scorecard, null);
  assert.deepEqual(outcome.scorecards, []);
  assert.equal(outcome.artifacts.length, 1);
  assert.equal(judgeCalls, 0);
  assert.equal(projection.snapshot().capturedArtifactTable.length, 1);
  assert.deepEqual(projection.snapshot().artifactScoreTable, []);
  assert.deepEqual(projection.snapshot().productGapCardTable, []);
  assert.deepEqual(projection.snapshot().reports, []);

  const retainedArtifact = outcome.artifacts[0]!;
  const retainedRender = outcome.renderManifests[0]!;
  const degradedReport = createMockReportDraft(
    "degraded-production-report-test",
    "partial",
    [
      {
        product: "WPS AI PPT",
        runId: retainedArtifact.runId,
        status: "completed",
        stateReason: "success",
        artifact: retainedArtifact,
        scorecard: null,
        judgeFailure: null,
        renderManifest: {
          ...retainedRender,
          renderOutcome: "degraded",
          fidelity: {
            status: "degraded",
            notes: ["static render fidelity gate"],
          },
        },
      },
    ],
  );
  assert.match(
    degradedReport.markdown,
    /静态渲染：`degraded`[\s\S]*视觉评估：`NOT_ASSESSABLE`[\s\S]*Judge 未调用/,
  );
  assert.doesNotMatch(degradedReport.markdown, /Judge：失败/);
});

test("a retained provider replay report is visibly historical and cannot read as a current LIVE acceptance", () => {
  const replayReport = createMockReportDraft(
    "production-replay-job",
    "partial",
    [
      {
        product: "WPS AI PPT retained real-provider replay",
        runId: "production-replay-run-wps",
        status: "failed",
        stateReason: "technical_failure",
        artifact: null,
        scorecard: null,
        judgeFailure: null,
      },
    ],
    {
      provenance: "PRODUCTION",
      executionProvenance: "PRODUCTION_REPLAY",
      environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
      createdAt: "2026-08-02T00:00:00.000Z",
    },
  );

  assert.equal(replayReport.executionProvenance, "PRODUCTION_REPLAY");
  assert.match(replayReport.title, /历史真实产物回放/);
  assert.match(replayReport.markdown, /非本次 LIVE 生产验收/);
  assert.doesNotMatch(replayReport.markdown, /当前真实火山 Case/);
  assert.doesNotMatch(replayReport.markdown, /真实单次 Case Sample，仅记录当前运行/);
  assert.throws(
    () => {
      const { source } = liveAcceptanceFixture();
      assertT10ProductionAcceptanceReady({
        job: {
          jobId: "production-replay-job",
          caseId: VOLCANO_CASE_ID,
          environment: "production",
          status: "completed",
          provenance: "PRODUCTION",
          executionProvenance: "PRODUCTION_REPLAY",
          environmentOrigin: replayReport.environmentOrigin,
        },
        artifact: null,
        renderManifest: null,
        scorecard: null,
        artifacts: [],
        renderManifests: [],
        scorecards: [],
        report: {
          ...replayReport,
          url: "https://my.feishu.cn/docx/replay",
        },
      }, source);
    },
    /requires LIVE_PRODUCTION.*PRODUCTION_REPLAY/i,
  );
});

test("a partial production replay persists its canonical historical delivery report without becoming LIVE", async () => {
  const seed = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: seed,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = seed.snapshot();
  const seedJob = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const seedRun = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "vendor_run",
  );
  assert.ok(seedJob);
  assert.ok(seedRun?.product);

  const projection = new InMemoryFeishuProjection({
    targetEnvironment: "production",
  });
  await projection.upsertCase({
    ...snapshot.caseTable[0]!,
    provenance: "PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
  });
  await projection.appendRunRecord({
    ...seedJob,
    status: "partial",
    provenance: "PRODUCTION",
    executionProvenance: "PRODUCTION_REPLAY",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    reportUrl: null,
    auxiliaryReportUrls: null,
  });
  await projection.appendRunRecord({
    ...seedRun,
    status: "failed",
    terminalReason: "technical_failure",
    provenance: "PRODUCTION",
    executionProvenance: "PRODUCTION_REPLAY",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    artifactId: null,
    renderManifestId: null,
    scorecardId: null,
    elapsedMs: null,
    vendorGenerationMs: null,
    observableEvents: null,
  });
  const draft = createMockReportDraft(
    seedJob.jobId,
    "partial",
    [
      {
        product: seedRun.product,
        runId: seedRun.recordId,
        status: "failed",
        stateReason: "technical_failure",
        artifact: null,
        scorecard: null,
        judgeFailure: null,
      },
    ],
    {
      provenance: "PRODUCTION",
      executionProvenance: "PRODUCTION_REPLAY",
      environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
      createdAt: seedJob.createdAt,
    },
  );

  const report = await projection.createReport(draft);
  assert.equal(report.executionProvenance, "PRODUCTION_REPLAY");
  assert.match(report.title, /历史真实产物回放/);
  assert.match(report.markdown, /非本次 LIVE 生产验收/);
  assert.match(
    report.markdown,
    /总计 UNKNOWN；队列 UNKNOWN；生成 UNKNOWN；导出 UNKNOWN；捕获 UNKNOWN/,
  );
  assert.doesNotMatch(report.title, /^LIVE｜/);
});
