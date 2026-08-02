import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSystemArtifactCaptureJournal,
  FileSystemEgressAuthorizationAudit,
  FileSystemJudgeEgressAudit,
  FileSystemReferencePackStore,
} from "../src/file-system-operational-durability.ts";
import type { JudgeEgressAttemptAudit } from "../src/domain.ts";
import type { ApprovedEgressAuthorization } from "../src/egress-authorization.ts";
import { VOLCANO_EVALUATION_CASE } from "../src/fixtures/volcano-case.ts";
import { resolveReferencePackForCase } from "../src/reference-pack.ts";

const FIXED_TIME = "2026-07-30T00:00:00.000Z";

async function temporaryDirectory(
  prefix: string,
): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

function approvedDecision(): ApprovedEgressAuthorization {
  return {
    status: "approved",
    decisionId: "decision-production-volcano-v1",
    policyVersion: "production-policy-v1",
    request: {
      requestId: "request-production-volcano-v1",
      jobId: "production-job-volcano-v1",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "wps-ai-ppt-evaluation",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "lora_chen",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["operational_ledger"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
      requestedAt: FIXED_TIME,
    },
    legalSecurityBasis: "authorized product evaluation",
    approvedAt: FIXED_TIME,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

test("filesystem egress audit survives restart, accepts exact replay, and rejects a conflicting decision", async () => {
  const root = await temporaryDirectory("ppt-egress-audit-");
  try {
    const first = new FileSystemEgressAuthorizationAudit({
      auditId: "production-egress-audit-v1",
      rootPath: root,
    });
    const decision = approvedDecision();
    await first.append(decision);

    const restarted = new FileSystemEgressAuthorizationAudit({
      auditId: "production-egress-audit-v1",
      rootPath: root,
    });
    await restarted.assertRecorded(decision);
    await restarted.append(decision);
    await assert.rejects(
      restarted.append({
        ...decision,
        policyVersion: "conflicting-policy",
      }),
      /immutable JSON conflict/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem Judge egress attempt audit is immutable across process restarts", async () => {
  const root = await temporaryDirectory("ppt-judge-egress-audit-");
  try {
    const audit: JudgeEgressAttemptAudit = {
      attemptId: "judge-attempt-wps-v1",
      jobId: "production-job-volcano-v1",
      runId: "run-wps-v1",
      artifactId: "artifact-wps-v1",
      scorecardId: "scorecard-wps-v1",
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      idempotencyKey:
        "judge_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
      egressAuthorizationHash:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      egressAuthorization: {
        decisionId: "judge-egress-approved-v1",
        decision: "approved" as const,
        policyVersion: "judge-policy-v1",
        dataClassification: "public_or_synthetic" as const,
        sourceOwner: "test",
        processingPurpose:
          "presentation_artifact_evaluation" as const,
        targetService: "openai" as const,
        targetAccount: "chatgpt-codex-session",
        targetRegion: "global",
        subprocessors: [],
        allowedContentFields: [
          "evaluation_case" as const,
          "reference_pack" as const,
          "extracted_slide_text" as const,
          "static_slide_images" as const,
        ],
        requiredRedactions: [],
        legalSecurityBasis: "test",
        approvedAt: FIXED_TIME,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      recordedAt: FIXED_TIME,
    };
    await new FileSystemJudgeEgressAudit({
      auditId: "production-judge-egress-audit-v1",
      rootPath: root,
    }).recordAuthorizedAttempt(audit);

    const restarted = new FileSystemJudgeEgressAudit({
      auditId: "production-judge-egress-audit-v1",
      rootPath: root,
    });
    await restarted.recordAuthorizedAttempt(audit);
    await assert.rejects(
      restarted.recordAuthorizedAttempt({
        ...audit,
        payloadHash:
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      }),
      /immutable JSON conflict/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem Reference Pack retention resumes idempotently after restart and rejects changed causal lineage", async () => {
  const root = await temporaryDirectory("ppt-reference-pack-");
  try {
    const pack = resolveReferencePackForCase({
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }).pack;
    assert.ok(pack);
    const first = new FileSystemReferencePackStore({
      rootPath: root,
      now: () => FIXED_TIME,
    });
    const staged = first.stage(pack, {
      jobId: "production-job-volcano-v1",
    });
    const usage = first.retainUsed(staged.stagingId, {
      jobId: "production-job-volcano-v1",
      scorecardIds: ["scorecard-wps-v1"],
      evaluationAttemptIds: ["judge-attempt-wps-v1"],
    });

    const restarted = new FileSystemReferencePackStore({
      rootPath: root,
      now: () => "2099-01-01T00:00:00.000Z",
    });
    const replayedStage = restarted.stage(pack, {
      jobId: "production-job-volcano-v1",
    });
    const replayedUsage = restarted.retainUsed(
      replayedStage.stagingId,
      {
        jobId: "production-job-volcano-v1",
        scorecardIds: ["scorecard-wps-v1"],
        evaluationAttemptIds: ["judge-attempt-wps-v1"],
      },
    );
    assert.deepEqual(replayedUsage, usage);
    assert.equal(
      restarted.deleteUnused(replayedStage.stagingId),
      false,
    );

    restarted.stage(pack, {
      jobId: "production-job-volcano-v1",
    });
    assert.throws(
      () =>
        restarted.retainUsed(replayedStage.stagingId, {
          jobId: "production-job-volcano-v1",
          scorecardIds: ["scorecard-changed"],
          evaluationAttemptIds: ["judge-attempt-wps-v1"],
        }),
      /usage conflict/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem Artifact capture journal can verify a completed immutable write after restart", async () => {
  const root = await temporaryDirectory("ppt-capture-journal-");
  try {
    const first = new FileSystemArtifactCaptureJournal({
      journalId: "production-capture-journal-v1",
      rootPath: root,
    });
    const captureAttemptId = await first.beginAttempt({
      jobId: "production-job-volcano-v1",
      artifactId: "artifact-wps-volcano-v1",
      detail: "planned:1",
    });
    await first.append({
      eventId: `${captureAttemptId}:write:primary`,
      captureAttemptId,
      jobId: "production-job-volcano-v1",
      artifactId: "artifact-wps-volcano-v1",
      eventType: "write_verified",
      storeId: "artifact-primary-v1",
      key: "artifacts/wps-volcano-v1.pptx",
      detail:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    await first.append({
      eventId: `${captureAttemptId}:completed`,
      captureAttemptId,
      jobId: "production-job-volcano-v1",
      artifactId: "artifact-wps-volcano-v1",
      eventType: "completed",
      storeId: null,
      key: null,
      detail: "verified:1",
    });

    const restarted = new FileSystemArtifactCaptureJournal({
      journalId: "production-capture-journal-v1",
      rootPath: root,
    });
    await restarted.verifyCompletedAttempt({
      captureAttemptId,
      jobId: "production-job-volcano-v1",
      artifactId: "artifact-wps-volcano-v1",
      expectedWrites: [
        {
          storeId: "artifact-primary-v1",
          key: "artifacts/wps-volcano-v1.pptx",
          contentHash:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
