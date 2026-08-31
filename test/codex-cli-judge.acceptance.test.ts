import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FROZEN_CODEX_CLI_BINARY,
  FROZEN_CODEX_CLI_SHA256,
  FROZEN_SANDBOX_EXEC_BINARY,
  FROZEN_SANDBOX_EXEC_SHA256,
  InMemoryFeishuProjection,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createCodexCliJudgeForTest,
  assertCodexCliTranscriptIsDataOnly,
  type CodexCliJudgeTransportPort,
} from "../src/index.ts";
import {
  createCodexCliJudgeExecutableVerifierForTest,
  readBoundedCodexCliJudgeResultForTest,
  runCodexCliJudgeProcessForTest,
} from "../src/codex-cli-judge.ts";

const DIMENSIONS = [
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
] as const;

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("the production Codex CLI Judge binary remains byte-for-byte pinned to the reviewed executable", async () => {
  const [content, sandbox] = await Promise.all([
    readFile(FROZEN_CODEX_CLI_BINARY),
    readFile(FROZEN_SANDBOX_EXEC_BINARY),
  ]);
  assert.equal(
    `sha256:${createHash("sha256").update(content).digest("hex")}`,
    FROZEN_CODEX_CLI_SHA256,
  );
  assert.equal(
    `sha256:${createHash("sha256").update(sandbox).digest("hex")}`,
    FROZEN_SANDBOX_EXEC_SHA256,
  );
});

test("Codex CLI Judge rejects binary drift after verifier construction before creating an executable snapshot", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ppt-codex-executable-drift-test-"),
  );
  try {
    const binaryPath = join(directory, "codex");
    const sandboxBinaryPath = join(directory, "sandbox-exec");
    const invocationRoot = join(directory, "invocation");
    await Promise.all([
      writeFile(binaryPath, "reviewed-codex", { mode: 0o700 }),
      writeFile(sandboxBinaryPath, "reviewed-sandbox", {
        mode: 0o700,
      }),
      mkdir(invocationRoot, { mode: 0o700 }),
    ]);
    const verifier = createCodexCliJudgeExecutableVerifierForTest({
      binaryPath,
      binaryHash: sha256Text("reviewed-codex"),
      sandboxBinaryPath,
      sandboxBinaryHash: sha256Text("reviewed-sandbox"),
    });
    await writeFile(binaryPath, "drifted-codex");

    await assert.rejects(
      verifier.snapshotInto(invocationRoot),
      /Codex CLI executable identity drifted before spawn/i,
    );
    assert.deepEqual(await readdir(invocationRoot), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex CLI Judge rejects sandbox binary drift after verifier construction", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ppt-sandbox-executable-drift-test-"),
  );
  try {
    const binaryPath = join(directory, "codex");
    const sandboxBinaryPath = join(directory, "sandbox-exec");
    const invocationRoot = join(directory, "invocation");
    await Promise.all([
      writeFile(binaryPath, "reviewed-codex", { mode: 0o700 }),
      writeFile(sandboxBinaryPath, "reviewed-sandbox", {
        mode: 0o700,
      }),
      mkdir(invocationRoot, { mode: 0o700 }),
    ]);
    const verifier = createCodexCliJudgeExecutableVerifierForTest({
      binaryPath,
      binaryHash: sha256Text("reviewed-codex"),
      sandboxBinaryPath,
      sandboxBinaryHash: sha256Text("reviewed-sandbox"),
    });
    await writeFile(sandboxBinaryPath, "drifted-sandbox");

    await assert.rejects(
      verifier.snapshotInto(invocationRoot),
      /Codex CLI executable identity drifted before spawn/i,
    );
    assert.deepEqual(await readdir(invocationRoot), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    sandboxBinaryPath: "/usr/bin/sandbox-exec",
    sandboxBinaryHash:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    sandboxProfileHash:
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
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
        isolationAttestationHash:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
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
      sandboxBinaryPath: "/usr/bin/sandbox-exec",
      sandboxBinaryHash:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      sandboxProfileHash:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
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
          isolationAttestationHash:
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
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

const TEST_PROCESS_LIMITS = Object.freeze({
  deadlineMs: 100,
  stdoutByteLimit: 1_024,
  stderrByteLimit: 1_024,
  terminationGraceMs: 50,
});

test("Codex CLI Judge executes a verified private Codex snapshot through the protected system sandbox binary", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ppt-codex-executable-snapshot-test-"),
  );
  try {
    const verifier = createCodexCliJudgeExecutableVerifierForTest({
      binaryPath: FROZEN_CODEX_CLI_BINARY,
      binaryHash: FROZEN_CODEX_CLI_SHA256,
      sandboxBinaryPath: FROZEN_SANDBOX_EXEC_BINARY,
      sandboxBinaryHash: FROZEN_SANDBOX_EXEC_SHA256,
      requireProtectedSandboxPath: true,
    });
    const snapshot = await verifier.snapshotInto(directory);
    assert.notEqual(snapshot.binaryPath, FROZEN_CODEX_CLI_BINARY);
    assert.equal(
      snapshot.sandboxBinaryPath,
      FROZEN_SANDBOX_EXEC_BINARY,
    );

    const result = await runCodexCliJudgeProcessForTest({
      executable: snapshot.sandboxBinaryPath,
      args: [
        "-p",
        "(version 1) (allow default)",
        snapshot.binaryPath,
        "--version",
      ],
      stdin: null,
      cwd: directory,
      env: { PATH: "/usr/bin:/bin" },
      // The full acceptance suite runs several native renderer and Lark
      // subprocess tests concurrently. Keep this success-path smoke test well
      // above observed scheduler contention; hard-deadline behavior is covered
      // separately with the deterministic 100 ms fixture below.
      deadlineMs: 15_000,
      stdoutByteLimit: 4_096,
      stderrByteLimit: 4_096,
      terminationGraceMs: 250,
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^codex-cli /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex CLI Judge rejects result.json by raw bytes without reading an unbounded result", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ppt-codex-result-limit-test-"),
  );
  try {
    const resultPath = join(directory, "result.json");
    await writeFile(resultPath, Buffer.alloc(1_025, 0x61));

    await assert.rejects(
      readBoundedCodexCliJudgeResultForTest(resultPath, 1_024),
      /result\.json exceeded byte limit/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex CLI Judge enforces a hard subprocess deadline and waits for termination", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runCodexCliJudgeProcessForTest({
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      stdin: null,
      cwd: process.cwd(),
      env: process.env,
      ...TEST_PROCESS_LIMITS,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Codex CLI Judge subprocess exceeded hard deadline",
  );
  assert.ok(
    Date.now() - startedAt < 2_000,
    "deadline termination must not leave the caller hanging",
  );
});

test("Codex CLI Judge fail-stops its owner when process-group absence cannot be confirmed", async () => {
  const moduleUrl = new URL(
    "../src/codex-cli-judge.ts",
    import.meta.url,
  ).href;
  const workerScript = [
    `import { runCodexCliJudgeProcessForTest } from ${JSON.stringify(moduleUrl)};`,
    "await runCodexCliJudgeProcessForTest({",
    `  executable: ${JSON.stringify(process.execPath)},`,
    '  args: ["-e", "setInterval(() => {}, 1_000)"],',
    "  stdin: null,",
    `  cwd: ${JSON.stringify(process.cwd())},`,
    "  env: process.env,",
    "  deadlineMs: 50,",
    "  stdoutByteLimit: 1_024,",
    "  stderrByteLimit: 1_024,",
    "  terminationGraceMs: 25,",
    "  forceTerminationConfirmationFailureForTest: true,",
    "});",
    'process.stdout.write("unexpected-return\\n");',
  ].join("\n");
  const worker = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      workerScript,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (value: string) => {
    stdout += value;
  });
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (value: string) => {
    stderr += value;
  });
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    worker.once("error", rejectExit);
    worker.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(
    exit,
    { code: null, signal: "SIGKILL" },
    `Codex cleanup-confirmation worker did not fail-stop; stderr=${stderr}`,
  );
  assert.equal(stdout, "");
});

test("Codex CLI Judge caps stdout by raw bytes instead of decoded characters", async () => {
  await assert.rejects(
    runCodexCliJudgeProcessForTest({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("😀".repeat(300));'],
      stdin: null,
      cwd: process.cwd(),
      env: process.env,
      ...TEST_PROCESS_LIMITS,
      stdoutByteLimit: 1_023,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Codex CLI Judge subprocess stdout exceeded byte limit",
  );
});

test("Codex CLI Judge caps stderr independently by raw bytes", async () => {
  await assert.rejects(
    runCodexCliJudgeProcessForTest({
      executable: process.execPath,
      args: ["-e", 'process.stderr.write("😀".repeat(300));'],
      stdin: null,
      cwd: process.cwd(),
      env: process.env,
      ...TEST_PROCESS_LIMITS,
      stderrByteLimit: 1_023,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Codex CLI Judge subprocess stderr exceeded byte limit",
  );
});

test("Codex CLI Judge preserves bounded UTF-8 JSONL output exactly", async () => {
  const jsonl =
    `${JSON.stringify({ type: "thread.started", thread_id: "线程-1" })}\n` +
    `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`;
  const result = await runCodexCliJudgeProcessForTest({
    executable: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(jsonl)}); process.stderr.write("diagnostic");`,
    ],
    stdin: null,
    cwd: process.cwd(),
    env: process.env,
    ...TEST_PROCESS_LIMITS,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, jsonl);
  assert.equal(result.stderr, "diagnostic");
});

test("Codex CLI Judge confirms a TERM-ignoring descendant is gone before returning a limit error", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ppt-codex-process-group-test-"),
  );
  const pidPath = join(directory, "grandchild.pid");
  const stoppedPath = join(directory, "grandchild.stopped");
  let grandchildPid: number | null = null;
  try {
    const grandchildScript = [
      'const fs = require("node:fs");',
      `const stoppedPath = ${JSON.stringify(stoppedPath)};`,
      "process.on('SIGTERM', () => {",
      "  fs.writeFileSync(stoppedPath, 'ignored-term');",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const pidPath = ${JSON.stringify(pidPath)};`,
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
      "fs.writeFileSync(pidPath, String(child.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    await assert.rejects(
      runCodexCliJudgeProcessForTest({
        executable: process.execPath,
        args: ["-e", parentScript],
        stdin: null,
        cwd: directory,
        env: process.env,
        ...TEST_PROCESS_LIMITS,
        deadlineMs: 250,
      }),
      /hard deadline/,
    );

    grandchildPid = Number(await readFile(pidPath, "utf8"));
    assert.equal(await readFile(stoppedPath, "utf8"), "ignored-term");
    assert.throws(
      () => process.kill(grandchildPid!, 0),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH",
      "the process-group descendant must be gone before rejection",
    );
  } finally {
    if (grandchildPid !== null) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // The expected cleanup path already terminated it.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
