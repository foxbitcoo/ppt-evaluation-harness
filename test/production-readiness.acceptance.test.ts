import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSystemJudgeEgressAudit,
  InMemoryFeishuProjection,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  assertHarnessOwnedLarkBaseProjection,
  assertHarnessOwnedDurableEgressAuthorizationAudit,
  assertHarnessOwnedDurableReferencePackStore,
  assertHarnessOwnedProductionJudge,
  createBakeoffHarness,
  createHarnessOwnedCodexCliJudge,
  preflightHarnessOwnedProductionJudge,
} from "../src/index.ts";
import { createMockReportDraft } from "../src/mock-report.ts";

test("production preflight fails closed on a missing real Judge before any adapter or browser execution", () => {
  assert.throws(
    () => assertHarnessOwnedProductionJudge(undefined),
    /requires an explicit harness-owned real Judge.*Mock scoring is forbidden/i,
  );
});

test("production preflight rejects an in-memory Feishu projection even when a real Codex CLI Judge is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-judge-audit-"));
  try {
    const judge = await createHarnessOwnedCodexCliJudge({
      targetAccount: "chatgpt-codex-session",
      targetRegion: "global",
      egressAuthorization: {
        async authorize() {
          throw new Error("projection preflight must run first");
        },
      },
      egressAudit: new FileSystemJudgeEgressAudit({
        auditId: "production-judge-egress-audit-v1",
        rootPath: root,
      }),
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
