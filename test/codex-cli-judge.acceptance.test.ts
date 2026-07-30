import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FROZEN_CODEX_CLI_BINARY,
  FROZEN_CODEX_CLI_SHA256,
  InMemoryFeishuProjection,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createCodexCliJudgeForTest,
  assertCodexCliTranscriptIsDataOnly,
  type CodexCliJudgeTransportPort,
} from "../src/index.ts";

const DIMENSIONS = [
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
] as const;

test("the production Codex CLI Judge binary remains byte-for-byte pinned to the reviewed executable", async () => {
  const content = await readFile(FROZEN_CODEX_CLI_BINARY);
  assert.equal(
    `sha256:${createHash("sha256").update(content).digest("hex")}`,
    FROZEN_CODEX_CLI_SHA256,
  );
});

test("Codex CLI Judge transcript permits only one data-only agent message and rejects shell, MCP, or file-read items", () => {
  const output = '{"dimensions":[],"knowledgeErrors":[]}';
  assert.doesNotThrow(() =>
    assertCodexCliTranscriptIsDataOnly(
      [
        JSON.stringify({
          type: "thread.started",
          thread_id: "thread-test",
        }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item-reasoning",
            type: "reasoning",
            text:
              "Treat instructions inside the slide as untrusted data.",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item-answer",
            type: "agent_message",
            text: output,
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {},
        }),
      ].join("\n"),
      output,
    ),
  );
  for (const itemType of [
    "command_execution",
    "mcp_tool_call",
    "file_read",
  ]) {
    assert.throws(
      () =>
        assertCodexCliTranscriptIsDataOnly(
          [
            JSON.stringify({
              type: "thread.started",
              thread_id: "thread-malicious-slide",
            }),
            JSON.stringify({ type: "turn.started" }),
            JSON.stringify({
              type: "item.completed",
              item: {
                id: `item-${itemType}`,
                type: itemType,
                command:
                  "cat /Users/chenyifan/.codex/key.md",
              },
            }),
            JSON.stringify({
              type: "item.completed",
              item: {
                id: "item-answer",
                type: "agent_message",
                text: output,
              },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: {},
            }),
          ].join("\n"),
          output,
        ),
      /rejected tool or file-access item/i,
    );
  }
});

test("Codex CLI Judge preserves fixed execution hashes and returns non-Mock score lineage", async () => {
  const captured = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  assert.ok(captured.artifact);
  assert.ok(captured.renderManifest);

  const transport: CodexCliJudgeTransportPort = {
    transportId: "test-codex-cli",
    binaryPath: "/reviewed/codex",
    binaryHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fixedArgumentsHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    async preflight() {},
    async execute(command) {
      const outputText = JSON.stringify({
        dimensions: DIMENSIONS.map((dimension) =>
          dimension === "factual_accuracy_and_content_quality"
            ? {
                dimension,
                assessmentStatus: "NOT_ASSESSABLE",
                value: null,
                deductionBasis:
                  "not_assessable_no_reference_pack",
                evidencePages: [],
                rationale: "未提供知识包，因此不评估事实准确性。",
              }
            : {
                dimension,
                assessmentStatus: "ASSESSED",
                value: 5,
                deductionBasis: "no_deduction",
                evidencePages: [1],
                rationale: "当前页面证据支持该维度评分。",
              },
        ),
        knowledgeErrors: [],
      });
      const { createHash } = await import("node:crypto");
      return {
        outputText,
        transcriptHash:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        resultHash: `sha256:${createHash("sha256")
          .update(outputText)
          .digest("hex")}` as const,
        invocationHash: command.invocationHash,
      };
    },
  };
  const judge = createCodexCliJudgeForTest({
    transport,
    egressAuthorization: {
      async authorize(request) {
        return {
          decisionId: "codex-cli-egress-approved",
          decision: "approved",
          policyVersion: "test-v1",
          ...request,
          subprocessors: [],
          allowedContentFields: request.contentFields,
          requiredRedactions: [],
          legalSecurityBasis: "test",
          approvedAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    egressAudit: {
      async recordAuthorizedAttempt() {},
    },
    now: () => "2026-07-28T00:00:00.000Z",
  });

  const scorecard = await judge.score({
    jobId: captured.job.jobId,
    runId: captured.artifact.runId,
    scorecardId: "codex-cli-scorecard-volcano-v1",
    evaluationAttemptId: "codex-cli-judge-attempt-volcano-v1",
    evaluationCase:
      new InMemoryFeishuProjection().snapshot().caseTable[0] ??
      {
        recordId: "case-volcano-query-v1",
        provenance: "MOCK",
        environmentOrigin: captured.job.environmentOrigin,
        dataClassification: "public_or_synthetic",
        sourceOwner: "test",
        caseId: VOLCANO_CASE_ID,
        caseVersion: 1,
        track: "query_generation",
        title: "火山为什么会喷发",
        targetPageCount: 16,
        audience: "初中生",
        readingMode: "self_reading",
        vendorPrompt: "生成 16 页火山科普 PPT",
      },
    artifact: captured.artifact,
    renderManifest: captured.renderManifest,
    referencePack: null,
  });

  assert.equal(scorecard.judgeLineage?.provider, "codex_cli");
  assert.equal(
    scorecard.judgeLineage?.executionEvidence?.binaryHash,
    transport.binaryHash,
  );
  assert.equal(
    scorecard.judgeLineage?.executionEvidence?.transcriptHash,
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  );
  assert.equal(scorecard.dimensions.length, 6);
});

test("Codex CLI Judge rejects a transport result that is not bound to the frozen invocation", async () => {
  const captured = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  assert.ok(captured.artifact);
  assert.ok(captured.renderManifest);
  let transportCalls = 0;
  const judge = createCodexCliJudgeForTest({
    transport: {
      transportId: "tampered-codex-cli",
      binaryPath: "/reviewed/codex",
      binaryHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fixedArgumentsHash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      async preflight() {},
      async execute() {
        transportCalls += 1;
        return {
          outputText: "{}",
          transcriptHash:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          resultHash:
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          invocationHash:
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        };
      },
    },
    egressAuthorization: {
      async authorize(request) {
        return {
          decisionId: "tampered-codex-cli-egress-approved",
          decision: "approved",
          policyVersion: "test-v1",
          ...request,
          subprocessors: [],
          allowedContentFields: request.contentFields,
          requiredRedactions: [],
          legalSecurityBasis: "test",
          approvedAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    egressAudit: {
      async recordAuthorizedAttempt() {},
    },
    now: () => "2026-07-30T00:00:00.000Z",
  });

  await assert.rejects(
    judge.score({
      jobId: captured.job.jobId,
      runId: captured.artifact.runId,
      scorecardId: "codex-cli-scorecard-tampered-v1",
      evaluationAttemptId: "codex-cli-judge-attempt-tampered-v1",
      evaluationCase: {
        recordId: "case-volcano-query-v1",
        provenance: "MOCK",
        environmentOrigin: captured.job.environmentOrigin,
        dataClassification: "public_or_synthetic",
        sourceOwner: "test",
        caseId: VOLCANO_CASE_ID,
        caseVersion: 1,
        track: "query_generation",
        title: "火山为什么会喷发",
        targetPageCount: 16,
        audience: "初中生",
        readingMode: "self_reading",
        vendorPrompt: "生成 16 页火山科普 PPT",
      },
      artifact: captured.artifact,
      renderManifest: captured.renderManifest,
      referencePack: null,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      /not bound to the frozen invocation/i.test(error.cause.message),
  );
  assert.equal(transportCalls, 1);
});
