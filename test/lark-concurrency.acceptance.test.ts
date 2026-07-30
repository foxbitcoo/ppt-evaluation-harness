import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  readFileSync,
} from "node:fs";
import {
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireLarkSingleWorkstationMutexForTest,
  createLarkExecutionLeaseForTest,
  createLarkCliTransportForMutationBoundaryTest,
  createVerifiedLarkCliTransport,
  type LarkCliProjectionConfiguration,
} from "../src/lark-base-projection.ts";
import {
  InMemoryEgressAuthorizationAudit,
  requireEgressAuthorization,
  type EgressAuthorizationPort,
} from "../src/egress-authorization.ts";
import {
  canonicalJsonBytes,
  sha256Bytes,
} from "../src/run-specification.ts";

const FIXED_TIME = "2020-01-01T00:00:00.000Z";
const LARK_TEST_CONFIGURATION = {
  concurrencyBoundary: "single_workstation_durable_mutex",
  lockRootPath: "/tmp/ppt-evaluation-lark-concurrency-test-locks",
  baseTokenEnvironmentVariable: "PPT_EVAL_CONCURRENCY_BASE_TOKEN",
  reportDocumentTokenEnvironmentVariable:
    "PPT_EVAL_CONCURRENCY_REPORT_TOKEN",
  tables: {
    cases: "tblCases0001",
    runs: "tblRuns00001",
    artifacts: "tblRuns00001",
    scores: "tblScores0001",
    workflow_events: "tblGaps00001",
    comparisons: "tblGaps00001",
    commit_markers: "tblRuns00001",
  },
  stableIdField: "稳定ID",
  payloadField: "载荷",
  payloadHashField: "载荷哈希",
  artifactAttachmentField: "产物附件",
  baseWebUrl: "https://example.feishu.cn/base/ppt-evaluation",
  pageEvidenceBaseUrl:
    "https://evidence.example.test/ppt-evaluation",
  reportDocumentExpectedOrigin: "https://example.feishu.cn",
  targetAccount: "test-account",
  targetRegion: "cn",
} as const satisfies LarkCliProjectionConfiguration;

const allowLarkMutation = {
  async authorize(request) {
    return {
      status: "approved" as const,
      decisionId: `lark-concurrency:${request.requestId}`,
      policyVersion: "test-policy-v1",
      request,
      legalSecurityBasis: "test",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
} satisfies EgressAuthorizationPort;

test("the single-workstation advisory mutex is released after its owner crashes", async () => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-crash-mutex-test-"),
  );
  const moduleUrl = new URL(
    "../src/lark-base-projection.ts",
    import.meta.url,
  ).href;
  const childScript = [
    `import { acquireLarkSingleWorkstationMutexForTest } from ${JSON.stringify(moduleUrl)};`,
    `await acquireLarkSingleWorkstationMutexForTest({ lockRoot: ${JSON.stringify(lockRoot)}, scope: "crash-recovery" });`,
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      childScript,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once("error", rejectReady);
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", (value) => {
        if (value !== "ready\n") {
          rejectReady(new Error("mutex child returned unexpected output"));
          return;
        }
        resolveReady();
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolveClose) => {
      child.once("close", () => resolveClose());
    });

    const release =
      await acquireLarkSingleWorkstationMutexForTest({
        lockRoot,
        scope: "crash-recovery",
        waitTimeoutMs: 3_000,
      });
    await release();
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The expected crash path already terminated it.
    }
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("an acquired mutex fail-stops its owner when the lock holder crashes", async () => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-holder-crash-test-"),
  );
  const moduleUrl = new URL(
    "../src/lark-base-projection.ts",
    import.meta.url,
  ).href;
  const childScript = [
    `import { acquireLarkSingleWorkstationMutexForTest } from ${JSON.stringify(moduleUrl)};`,
    `await acquireLarkSingleWorkstationMutexForTest({ lockRoot: ${JSON.stringify(lockRoot)}, scope: "holder-crash", waitTimeoutMs: 3_000 });`,
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const owner = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      childScript,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let ownerOutput = "";
  let ownerError = "";
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", (value: string) => {
    ownerOutput += value;
  });
  owner.stderr.setEncoding("utf8");
  owner.stderr.on("data", (value: string) => {
    ownerError += value;
  });
  const ownerExit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    owner.once("error", rejectExit);
    owner.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  const processRows = (): readonly {
    readonly processId: number;
    readonly parentProcessId: number;
    readonly command: string;
  }[] =>
    execFileSync(
      "/bin/ps",
      ["-axo", "pid=,ppid=,comm="],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 3))
      .map(([processId, parentProcessId, command]) => ({
        processId: Number(processId),
        parentProcessId: Number(parentProcessId),
        command: command ?? "",
      }));
  const waitForOutput = async (
    expected: string,
    timeoutMs: number,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!ownerOutput.includes(expected) && Date.now() < deadline) {
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 10);
      });
    }
    if (!ownerOutput.includes(expected)) {
      throw new Error(
        `mutex owner output timed out: ${ownerOutput}\n${ownerError}`,
      );
    }
  };
  try {
    await waitForOutput("ready\n", 5_000);
    const lockfProcess = processRows().find(
      ({ parentProcessId, command }) =>
        parentProcessId === owner.pid &&
        command === "/usr/bin/lockf",
    );
    assert.ok(lockfProcess, "the owner must have one lockf child");
    let holderProcess:
      | {
          readonly processId: number;
          readonly parentProcessId: number;
          readonly command: string;
        }
      | undefined;
    const holderDeadline = Date.now() + 2_000;
    while (holderProcess === undefined && Date.now() < holderDeadline) {
      holderProcess = processRows().find(
        ({ parentProcessId }) =>
          parentProcessId === lockfProcess.processId,
      );
      if (holderProcess === undefined) {
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, 10);
        });
      }
    }
    assert.ok(holderProcess, "lockf must have one holder child");
    process.kill(holderProcess.processId, "SIGKILL");

    const exitResult = await Promise.race([
      ownerExit.then((result) => ({
        kind: "exit" as const,
        result,
      })),
      new Promise<{ readonly kind: "timeout" }>((resolveTimeout) => {
        const timeout = setTimeout(
          () => resolveTimeout({ kind: "timeout" }),
          2_000,
        );
        timeout.unref();
      }),
    ]);
    assert.notEqual(
      exitResult.kind,
      "timeout",
      "the old owner must fail-stop instead of continuing without its lock",
    );
    assert.deepEqual(
      exitResult.kind === "exit" ? exitResult.result : null,
      { code: null, signal: "SIGKILL" },
    );

    const releaseReplacement =
      await acquireLarkSingleWorkstationMutexForTest({
        lockRoot,
        scope: "holder-crash",
        waitTimeoutMs: 3_000,
      });
    await releaseReplacement();
  } finally {
    try {
      owner.kill("SIGKILL");
    } catch {
      // The expected fail-stop path already terminated it.
    }
    await ownerExit.catch(() => undefined);
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("two synchronized contenders serialize on one stale advisory lock file", async () => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-synchronized-contenders-test-"),
  );
  const scope = "synchronized-contenders";
  const staleLock = await open(
    join(
      lockRoot,
      `${createHash("sha256").update(scope).digest("hex")}.lock`,
    ),
    "wx",
    0o600,
  );
  await staleLock.close();
  const moduleUrl = new URL(
    "../src/lark-base-projection.ts",
    import.meta.url,
  ).href;
  const workerScript = [
    'import { createInterface } from "node:readline";',
    `import { acquireLarkSingleWorkstationMutexForTest } from ${JSON.stringify(moduleUrl)};`,
    "const workerId = process.argv[1];",
    "const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "const lines = lineReader[Symbol.asyncIterator]();",
    "await lines.next();",
    "try {",
    `  const release = await acquireLarkSingleWorkstationMutexForTest({ lockRoot: ${JSON.stringify(lockRoot)}, scope: ${JSON.stringify(scope)}, waitTimeoutMs: 3_000 });`,
    '  process.stdout.write(`acquired:${workerId}\\n`);',
    "  await lines.next();",
    "  await release();",
    "  lineReader.close();",
    '  process.stdout.write(`released:${workerId}\\n`);',
    "} catch (error) {",
    "  lineReader.close();",
    '  process.stdout.write(`error:${workerId}:${error instanceof Error ? error.message : String(error)}\\n`);',
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const workers = ["a", "b"].map((workerId) =>
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        workerScript,
        workerId,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  const outputs = workers.map((worker) => {
    let output = "";
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (value: string) => {
      output += value;
    });
    return () => output;
  });
  const workerClosures = workers.map(
    (worker) =>
      new Promise<void>((resolveClose, rejectClose) => {
        worker.once("error", rejectClose);
        worker.once("close", (code) => {
          if (code !== 0) {
            rejectClose(
              new Error(`mutex contender exited with ${String(code)}`),
            );
            return;
          }
          resolveClose();
        });
      }),
  );
  try {
    workers.forEach((worker) => worker.stdin.write("start\n"));
    const waitForAcquired = async (
      indexes: readonly number[],
      timeoutMs: number,
    ): Promise<number> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const index of indexes) {
          const output = outputs[index]!();
          if (output.includes("error:")) {
            throw new Error(output.trim());
          }
          if (output.includes("acquired:")) return index;
        }
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, 10);
        });
      }
      throw new Error("mutex contender acquisition timed out");
    };
    const firstIndex = await waitForAcquired([0, 1], 5_000);
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 150);
    });
    assert.equal(
      outputs.filter((readOutput) =>
        readOutput().startsWith("acquired:"),
      ).length,
      1,
      "only one cross-process contender may enter before release",
    );
    workers[firstIndex]!.stdin.write("release\n");
    const secondIndex = firstIndex === 0 ? 1 : 0;
    assert.equal(
      await waitForAcquired([secondIndex], 5_000),
      secondIndex,
    );
    workers[secondIndex]!.stdin.write("release\n");
    await Promise.all(workerClosures);
  } finally {
    workers.forEach((worker) => {
      try {
        worker.kill("SIGKILL");
      } catch {
        // The expected path already exited.
      }
    });
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("an advisory lease sentinel distinguishes PID reuse within one start-time second", async () => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-lease-sentinel-test-"),
  );
  const moduleUrl = new URL(
    "../src/lark-base-projection.ts",
    import.meta.url,
  ).href;
  const ownerScript = [
    `import { createLarkExecutionLeaseForTest } from ${JSON.stringify(moduleUrl)};`,
    `const lease = createLarkExecutionLeaseForTest({ lockRoot: ${JSON.stringify(lockRoot)}, leaseId: "lease-owner", processId: 4242, processStartIdentity: "same-second-start" });`,
    'if (!await lease.isActive("lease-owner", 4242, "same-second-start")) throw new Error("owner sentinel was not acquired");',
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const owner = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      ownerScript,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      owner.once("error", rejectReady);
      owner.stdout.setEncoding("utf8");
      owner.stdout.once("data", (value) => {
        if (value !== "ready\n") {
          rejectReady(
            new Error(`lease owner returned ${JSON.stringify(value)}`),
          );
          return;
        }
        resolveReady();
      });
    });
    const verifier = createLarkExecutionLeaseForTest({
      lockRoot,
      leaseId: "lease-verifier",
      processId: 4242,
      processStartIdentity: "same-second-start",
    });
    assert.equal(
      await verifier.isActive(
        "lease-owner",
        4242,
        "same-second-start",
      ),
      true,
      "the held sentinel, not the reused PID timestamp, proves liveness",
    );
    owner.kill("SIGKILL");
    await new Promise<void>((resolveClose) => {
      owner.once("close", () => resolveClose());
    });
    const deadline = Date.now() + 3_000;
    let active = true;
    while (active && Date.now() < deadline) {
      active = await verifier.isActive(
        "lease-owner",
        4242,
        "same-second-start",
      );
      if (active) {
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, 10);
        });
      }
    }
    assert.equal(active, false);
  } finally {
    try {
      owner.kill("SIGKILL");
    } catch {
      // The expected crash path already terminated it.
    }
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("terminal leases reclaim every holder process across multiple Jobs", async () => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-lease-reclaim-test-"),
  );
  const moduleUrl = new URL(
    "../src/lark-base-projection.ts",
    import.meta.url,
  ).href;
  const workerScript = [
    'import { execFileSync } from "node:child_process";',
    `import { createLarkExecutionLeaseForTest } from ${JSON.stringify(moduleUrl)};`,
    "for (let index = 1; index <= 3; index += 1) {",
    `  const lease = createLarkExecutionLeaseForTest({ lockRoot: ${JSON.stringify(lockRoot)}, leaseId: \`lease-job-\${index}\`, processId: process.pid, processStartIdentity: "multi-job-worker" });`,
    '  if (!await lease.isActive(lease.leaseId, lease.processId, lease.processStartIdentity)) throw new Error("lease did not activate");',
    '  if (!("release" in lease) || typeof lease.release !== "function") throw new Error("lease has no terminal release");',
    "  await lease.release();",
    '  const lockfChildren = execFileSync("/bin/ps", ["-axo", "ppid=,comm="], { encoding: "utf8" }).split("\\n").map((line) => line.trim().split(/\\s+/, 2)).filter(([parentProcessId, command]) => Number(parentProcessId) === process.pid && command === "/usr/bin/lockf");',
    '  if (lockfChildren.length !== 0) throw new Error(`Job ${index} retained ${lockfChildren.length} lockf child`);',
    "}",
    'process.stdout.write("three-jobs-reclaimed\\n");',
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
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errorOutput = "";
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (value: string) => {
    output += value;
  });
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (value: string) => {
    errorOutput += value;
  });
  try {
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
      { code: 0, signal: null },
      errorOutput,
    );
    assert.equal(output, "three-jobs-reclaimed\n");
  } finally {
    try {
      worker.kill("SIGKILL");
    } catch {
      // The expected path already exited.
    }
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("a durably committed marker releases its execution lease", async (context) => {
  const baseTokenVariable = "PPT_EVAL_COMMIT_RELEASE_BASE_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basCommitReleaseToken";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
  });
  const clock = {
    clockId: "commit-release-clock",
    now: () => FIXED_TIME,
  };
  let storedFields: Record<string, unknown> | null = null;
  let releaseCount = 0;
  const transport =
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      clock,
      claimLeaseForTest: {
        leaseId: "commit-release-lease",
        processId: 7001,
        processStartIdentity: "commit-release-process",
        async isActive() {
          return true;
        },
        async release() {
          releaseCount += 1;
        },
      },
      async run(args) {
        const command = args[1] ?? "";
        if (command === "+record-search") {
          return storedFields === null
            ? {
                ok: true,
                data: {
                  data: [],
                  field_id_list: [
                    "fldStable",
                    "fldPayload",
                    "fldHash",
                  ],
                  fields: ["稳定ID", "载荷", "载荷哈希"],
                  has_more: false,
                  record_id_list: [],
                },
              }
            : {
                ok: true,
                data: {
                  data: [[
                    storedFields["稳定ID"],
                    storedFields["载荷"],
                    storedFields["载荷哈希"],
                  ]],
                  field_id_list: [
                    "fldStable",
                    "fldPayload",
                    "fldHash",
                  ],
                  fields: ["稳定ID", "载荷", "载荷哈希"],
                  has_more: false,
                  record_id_list: ["recCommitRelease"],
                },
              };
        }
        if (command === "+record-upsert") {
          storedFields = JSON.parse(
            args[args.indexOf("--json") + 1]!,
          ) as Record<string, unknown>;
          return {
            ok: true,
            data: {
              created: true,
              record: { record_id: "recCommitRelease" },
            },
          };
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "commit-release-parent",
      jobId: "job-commit-release",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["commit_marker"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
    },
    clock,
  );
  await transport.commitBatch({
    schemaVersion: "lark-projection-commit-v2",
    jobId: "job-commit-release",
    batchHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    authorizationDecisionId: authorization.decisionId,
    recordCount: 1,
    attachmentCount: 0,
    reportUrls: [],
    reportCollectionHash: null,
    reportDocumentRevision: null,
    pageEvidenceUrls: [],
    attachments: [],
    committedAt: FIXED_TIME,
    previousBatchHash: null,
    revision: 1,
    authorization,
  });
  assert.equal(
    releaseCount,
    1,
    "the durable terminal marker must release the lease holder",
  );
  const publicState = await transport.readProductionJobState!({
    jobId: "job-commit-release",
    runIds: [],
  });
  assert.equal(
    publicState.state,
    "commit_marker_present_unverified",
    "a marker alone is not public proof that every committed artifact and report still verifies",
  );
});

test("disposing a transport is terminal for every later read and write", async () => {
  let releaseCount = 0;
  let runnerCalls = 0;
  const transport =
    createLarkCliTransportForMutationBoundaryTest({
      configuration: LARK_TEST_CONFIGURATION,
      egressAuthorization: allowLarkMutation,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      clock: {
        clockId: "transport-dispose-clock",
        now: () => FIXED_TIME,
      },
      claimLeaseForTest: {
        leaseId: "transport-dispose-lease",
        processId: 7002,
        processStartIdentity: "transport-dispose-process",
        async isActive() {
          return true;
        },
        async release() {
          releaseCount += 1;
        },
      },
      async run() {
        runnerCalls += 1;
        throw new Error("disposed transport must not invoke lark-cli");
      },
    });
  assert.equal(
    typeof transport.dispose,
    "function",
    "the transport must expose an explicit terminal lifecycle",
  );
  await transport.dispose!();
  assert.equal(releaseCount, 1);
  await transport.dispose!();
  assert.equal(releaseCount, 1, "dispose remains idempotent");
  const payload = "{}";
  const payloadHash = sha256Bytes(new TextEncoder().encode(payload));
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "disposed-transport-parent",
      jobId: "job-disposed-transport",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["case_table"],
      payloadHash,
      requiredRedactions: [],
    },
    {
      clockId: "transport-dispose-clock",
      now: () => FIXED_TIME,
    },
  );
  const operations = [
    () => transport.preflight(),
    () => transport.acquireProjectionMutex!("job-disposed-transport"),
    () =>
      transport.verifyRecord({
        tableKey: "cases",
        stableId: "case:disposed",
        payload,
        payloadHash,
      }),
    () =>
      transport.upsertRecord({
        tableKey: "cases",
        stableId: "case:disposed",
        payload,
        payloadHash,
        idempotencyKey: "disposed-upsert",
        authorization,
      }),
    () =>
      transport.readProductionJobState!({
        jobId: "job-disposed-transport",
        runIds: ["run-disposed"],
      }),
    () =>
      transport.claimProductionJob!({
        jobId: "job-disposed-transport",
        runIds: ["run-disposed"],
        claimHash: payloadHash,
        claimantId: "claimant-disposed",
        claimAttemptId: "claim-attempt-disposed",
        authorization,
        claimedAt: FIXED_TIME,
      }),
  ];
  for (const operation of operations) {
    await assert.rejects(operation, /disposed/i);
  }
  assert.equal(runnerCalls, 0);
});

test("every Lark egress re-attests the frozen executable before invocation", async (context) => {
  const baseTokenVariable = "PPT_EVAL_CLI_REATTEST_BASE";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basCliReattest";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
  });
  const clock = {
    clockId: "cli-reattest-clock",
    now: () => FIXED_TIME,
  };
  let attestationCount = 0;
  let mutationRunnerCalls = 0;
  const transport =
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      clock,
      async attestExecutableForTest() {
        attestationCount += 1;
        if (attestationCount >= 2) {
          throw new Error("frozen lark-cli executable drifted");
        }
      },
      async run(args) {
        const command = args[1] ?? "";
        if (command === "+record-search") {
          return {
            ok: true,
            data: {
              data: [],
              field_id_list: ["fldStable", "fldPayload", "fldHash"],
              fields: ["稳定ID", "载荷", "载荷哈希"],
              has_more: false,
              record_id_list: [],
            },
          };
        }
        if (command === "+record-upsert") {
          mutationRunnerCalls += 1;
          return {
            ok: true,
            data: {
              created: true,
              record: { record_id: "recCliReattest" },
            },
          };
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
  const payload = '{"caseId":"cli-reattest"}';
  const payloadHash = sha256Bytes(new TextEncoder().encode(payload));
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "cli-reattest-parent",
      jobId: "job-cli-reattest",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["case_table"],
      payloadHash,
      requiredRedactions: [],
    },
    clock,
  );

  await assert.rejects(
    transport.upsertRecord({
      tableKey: "cases",
      stableId: "case:cli-reattest",
      payload,
      payloadHash,
      idempotencyKey: "cli-reattest-upsert",
      authorization,
    }),
    /executable drifted/i,
  );
  assert.ok(attestationCount >= 2);
  assert.equal(
    mutationRunnerCalls,
    0,
    "no mutation may execute after path or byte drift",
  );
});

test("attachment authorization binds the immutable bytes read by the runner", async (context) => {
  const baseTokenVariable = "PPT_EVAL_ATTACHMENT_SNAPSHOT_BASE";
  const reportTokenVariable = "PPT_EVAL_ATTACHMENT_SNAPSHOT_DOC";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basAttachmentSnapshot";
  process.env[reportTokenVariable] = "docAttachmentSnapshot";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
    if (previousReportToken === undefined) {
      delete process.env[reportTokenVariable];
    } else {
      process.env[reportTokenVariable] = previousReportToken;
    }
  });
  const clock = {
    clockId: "attachment-snapshot-clock",
    now: () => FIXED_TIME,
  };
  const original = new TextEncoder().encode("AUTHORIZED-ATTACHMENT-BYTES");
  const originalHash = sha256Bytes(original);
  const filename =
    `original-${originalHash.slice("sha256:".length, "sha256:".length + 16)}-artifact.pptx`;
  const tamperingAuthorization = {
    async authorize(request) {
      for (const directory of await readdir(tmpdir())) {
        if (!directory.startsWith("ppt-lark-upload-")) continue;
        const candidate = join(tmpdir(), directory, filename);
        await writeFile(candidate, "TAMPERED-AFTER-AUTHORIZATION").catch(
          () => undefined,
        );
      }
      return await allowLarkMutation.authorize(request);
    },
  } satisfies EgressAuthorizationPort;
  let runnerBytes = "";
  const transport =
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
        reportDocumentTokenEnvironmentVariable:
          reportTokenVariable,
      },
      egressAuthorization: tamperingAuthorization,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      clock,
      async run(args, options) {
        const command = args[1] ?? "";
        if (command === "+record-search") {
          return {
            ok: true,
            data: {
              data: [[
                "artifact:snapshot",
                "{}",
                sha256Bytes(new TextEncoder().encode("{}")),
                [],
              ]],
              field_id_list: [
                "fldStable",
                "fldPayload",
                "fldHash",
                "fldAttachment",
              ],
              fields: ["稳定ID", "载荷", "载荷哈希", "产物附件"],
              has_more: false,
              record_id_list: ["recAttachmentSnapshot"],
            },
          };
        }
        if (command === "+record-upload-attachment") {
          assert.ok(options?.cwd);
          runnerBytes = readFileSync(
            join(options.cwd, args[args.indexOf("--file") + 1]!),
            "utf8",
          );
          return {
            ok: true,
            data: { file_token: "fileAttachmentSnapshot" },
          };
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
  const parentAuthorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "attachment-snapshot-parent",
      jobId: "job-attachment-snapshot",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["captured_artifact_table"],
      payloadHash: originalHash,
      requiredRedactions: [],
    },
    clock,
  );

  const uploaded = await transport.uploadAttachment({
    tableKey: "artifacts",
    remoteRecordId: "recAttachmentSnapshot",
    stableId: "artifact:snapshot",
    attachmentRole: "original",
    filename: "artifact.pptx",
    content: original,
    contentHash: originalHash,
    idempotencyKey: "attachment-snapshot",
    authorization: parentAuthorization,
  });

  assert.equal(runnerBytes, "AUTHORIZED-ATTACHMENT-BYTES");
  assert.equal(uploaded.remoteHash, originalHash);
});

test("Docx authorization binds the immutable Markdown read by the runner", async (context) => {
  const baseTokenVariable = "PPT_EVAL_DOCX_SNAPSHOT_BASE";
  const reportTokenVariable = "PPT_EVAL_DOCX_SNAPSHOT_DOC";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basDocxSnapshot";
  process.env[reportTokenVariable] = "DocDocxSnapshot";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
    if (previousReportToken === undefined) {
      delete process.env[reportTokenVariable];
    } else {
      process.env[reportTokenVariable] = previousReportToken;
    }
  });
  const clock = {
    clockId: "docx-snapshot-clock",
    now: () => FIXED_TIME,
  };
  const tamperingAuthorization = {
    async authorize(request) {
      for (const directory of await readdir(tmpdir())) {
        if (!directory.startsWith("ppt-lark-report-")) continue;
        await writeFile(
          join(tmpdir(), directory, "report.md"),
          "# TAMPERED-AFTER-AUTHORIZATION",
        ).catch(() => undefined);
      }
      return await allowLarkMutation.authorize(request);
    },
  } satisfies EgressAuthorizationPort;
  let reportRevision = 1;
  let reportContent =
    "# Claimed report\n\n" +
    "Owner schema: `lark-report-owner-v1`\n\n" +
    "Owner Job: `job-docx-snapshot`\n";
  let runnerBytes = "";
  const transport =
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
        reportDocumentTokenEnvironmentVariable:
          reportTokenVariable,
      },
      egressAuthorization: tamperingAuthorization,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      clock,
      async run(args, options) {
        const command = args[1] ?? "";
        if (command === "+fetch") {
          return {
            ok: true,
            data: {
              document: {
                document_id: "DocDocxSnapshot",
                revision_id: reportRevision,
                content: reportContent,
                url: "https://example.feishu.cn/docx/DocDocxSnapshot",
              },
            },
          };
        }
        if (command === "+update") {
          const contentReference =
            args[args.indexOf("--content") + 1]!;
          assert.equal(contentReference, "-");
          runnerBytes =
            typeof options?.stdin === "string"
              ? options.stdin
              : new TextDecoder().decode(options?.stdin);
          reportContent = runnerBytes;
          reportRevision += 1;
          return {
            ok: true,
            data: {
              result: "success",
              warnings: [],
              document: {
                revision_id: reportRevision,
                url:
                  "https://example.feishu.cn/docx/DocDocxSnapshot",
              },
            },
          };
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
  const reports = [{
    reportId: "report-docx-snapshot",
    title: "Docx Snapshot",
    markdown: "# Docx Snapshot\n\nAuthorized report body.",
    payloadHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
  }];
  const collectionHash = sha256Bytes(canonicalJsonBytes(reports));
  const parentAuthorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "docx-snapshot-parent",
      jobId: "job-docx-snapshot",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["reports"],
      payloadHash: collectionHash,
      requiredRedactions: [],
    },
    clock,
  );

  const projected = await transport.upsertReportCollection({
    jobId: "job-docx-snapshot",
    reports,
    collectionHash,
    idempotencyKey: `docx-snapshot:${collectionHash}`,
    authorization: parentAuthorization,
  });

  assert.match(runnerBytes, /Authorized report body/);
  assert.doesNotMatch(runnerBytes, /TAMPERED/);
  assert.equal(projected.revisionId, 2);
});

test("verified Lark production rejects a configuration without one fixed machine lock root", async () => {
  const {
    lockRootPath: _lockRootPath,
    ...configurationWithoutLockRoot
  } = LARK_TEST_CONFIGURATION;
  await assert.rejects(
    createVerifiedLarkCliTransport({
      configuration:
        configurationWithoutLockRoot as unknown as LarkCliProjectionConfiguration,
      egressAuthorization: allowLarkMutation,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
    }),
    /fixed machine lock root/i,
  );
});

test("verified Lark production rejects non-canonical or aliased Base URLs", async () => {
  for (const baseWebUrl of [
    `${LARK_TEST_CONFIGURATION.baseWebUrl}/`,
    `${LARK_TEST_CONFIGURATION.baseWebUrl}?view=grid`,
    `${LARK_TEST_CONFIGURATION.baseWebUrl}#record`,
    "https://alias.feishu.cn/base/ppt-evaluation",
  ]) {
    await assert.rejects(
      createVerifiedLarkCliTransport({
        configuration: {
          ...LARK_TEST_CONFIGURATION,
          baseWebUrl,
        },
        egressAuthorization: allowLarkMutation,
        egressAudit: new InMemoryEgressAuthorizationAudit(),
      }),
      /canonical Base URL/i,
      baseWebUrl,
    );
  }
});

test("preflight binds the configured account and region to the actual lark-cli identity", async (context) => {
  const baseTokenVariable = "PPT_EVAL_IDENTITY_BOUND_BASE";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basIdentityBound";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
  });
  let fieldListCalls = 0;
  const transport =
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
        baseWebUrl:
          "https://example.feishu.cn/base/basIdentityBound",
        targetAccount: "ou_expected_user",
        targetRegion: "cn",
        cliIdentityBinding: {
          profile: "production-profile",
          appId: "cli_app_expected",
          brand: "feishu",
          defaultAs: "auto",
          identitySource: "auto_detect",
          userOpenId: "ou_expected_user",
          tenantKey: "tenant_expected",
        },
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      clock: {
        clockId: "identity-bound-clock",
        now: () => FIXED_TIME,
      },
      async run(args) {
        if (args[0] === "whoami") {
          return {
            profile: "production-profile",
            appId: "cli_app_expected",
            brand: "feishu",
            defaultAs: "auto",
            identity: "user",
            identitySource: "auto_detect",
            available: true,
            tokenStatus: "ready",
            onBehalfOf: {
              userName: "test",
              openId: "ou_expected_user",
            },
          };
        }
        if (args[0] === "contact" && args[1] === "+get-user") {
          return {
            ok: true,
            data: {
              user: {
                open_id: "ou_expected_user",
                tenant_key: "tenant_different",
              },
            },
          };
        }
        if (args[1] === "+field-list") {
          fieldListCalls += 1;
          return {
            ok: true,
            data: [
              { field_id: "稳定ID" },
              { field_id: "载荷" },
              { field_id: "载荷哈希" },
              { field_id: "产物附件" },
            ],
          };
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });

  await assert.rejects(
    transport.preflight(),
    /user and tenant.*identity binding/i,
  );
  assert.equal(
    fieldListCalls,
    0,
    "identity mismatch must stop before touching the configured Base",
  );
});

test("workers with different TMPDIR values still share the configured machine lock root", async () => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-fixed-root-test-"),
  );
  const workerTmp = await mkdtemp(
    join(tmpdir(), "ppt-lark-worker-tmp-"),
  );
  const releaseFirst =
    await acquireLarkSingleWorkstationMutexForTest({
      lockRoot,
      scope: "fixed-root-across-tmpdir",
    });
  const moduleUrl = new URL(
    "../src/lark-base-projection.ts",
    import.meta.url,
  ).href;
  const childScript = [
    `import { acquireLarkSingleWorkstationMutexForTest } from ${JSON.stringify(moduleUrl)};`,
    `const release = await acquireLarkSingleWorkstationMutexForTest({ lockRoot: ${JSON.stringify(lockRoot)}, scope: "fixed-root-across-tmpdir" });`,
    'process.stdout.write("acquired\\n");',
    "await release();",
  ].join("\n");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      childScript,
    ],
    {
      env: { ...process.env, TMPDIR: workerTmp },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    let childOutput = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      childOutput += value;
    });
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 100);
    });
    assert.equal(childOutput, "");
    await releaseFirst();
    await new Promise<void>((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code) => {
        if (code !== 0) {
          rejectClose(
            new Error(`fixed-root worker exited with code ${String(code)}`),
          );
          return;
        }
        resolveClose();
      });
    });
    assert.equal(childOutput, "acquired\n");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The expected path already exited.
    }
    await releaseFirst();
    await rm(lockRoot, { recursive: true, force: true });
    await rm(workerTmp, { recursive: true, force: true });
  }
});

test("equivalent Base URL spellings cannot split one stable-record mutex", async (context) => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-resource-scope-test-"),
  );
  const baseTokenVariable = "PPT_EVAL_RESOURCE_SCOPE_BASE_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basResourceScopeToken";
  context.after(async () => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
    await rm(lockRoot, { recursive: true, force: true });
  });
  const clock = {
    clockId: "resource-scope-clock",
    now: () => FIXED_TIME,
  };
  const audit = new InMemoryEgressAuthorizationAudit();
  const payload = '{"caseId":"resource-scope-case"}';
  const payloadHash = sha256Bytes(new TextEncoder().encode(payload));
  let stored:
    | {
        readonly recordId: string;
        readonly fields: Record<string, unknown>;
      }
    | null = null;
  const entered: string[] = [];
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolveRelease) => {
    releaseFirst = resolveRelease;
  });
  const searchEnvelope = () => ({
    ok: true,
    data: {
      data:
        stored === null
          ? []
          : [[
              stored.fields["稳定ID"],
              stored.fields["载荷"],
              stored.fields["载荷哈希"],
            ]],
      field_id_list: ["fldStable", "fldPayload", "fldHash"],
      fields: ["稳定ID", "载荷", "载荷哈希"],
      has_more: false,
      record_id_list: stored === null ? [] : [stored.recordId],
    },
  });
  const createTransport = (
    caller: "first" | "second",
    baseWebUrl: string,
  ) =>
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        lockRootPath: lockRoot,
        baseTokenEnvironmentVariable: baseTokenVariable,
        baseWebUrl,
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: audit,
      clock,
      async run(args) {
        const command = args[1] ?? "";
        if (command === "+record-search") return searchEnvelope();
        if (command === "+record-upsert") {
          entered.push(caller);
          if (caller === "first") await firstRelease;
          const recordIdIndex = args.indexOf("--record-id");
          const fields = JSON.parse(
            args[args.indexOf("--json") + 1]!,
          ) as Record<string, unknown>;
          const recordId =
            recordIdIndex === -1
              ? "recResourceScope1"
              : args[recordIdIndex + 1]!;
          stored = { recordId, fields };
          return {
            ok: true,
            data: {
              ...(recordIdIndex === -1
                ? { created: true }
                : { updated: true }),
              record: { record_id: recordId },
            },
          };
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "resource-scope-parent",
      jobId: "job-resource-scope",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["case_table"],
      payloadHash,
      requiredRedactions: [],
    },
    clock,
  );
  const command = {
    tableKey: "cases" as const,
    stableId: "case:resource-scope-case",
    payload,
    payloadHash,
    idempotencyKey: "resource-scope-upsert",
    authorization,
  };
  const first = createTransport(
    "first",
    "https://example.feishu.cn/base/basResourceScopeToken",
  ).upsertRecord(command);
  const firstDeadline = Date.now() + 3_000;
  while (!entered.includes("first") && Date.now() < firstDeadline) {
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 10);
    });
  }
  assert.deepEqual(entered, ["first"]);
  const second = createTransport(
    "second",
    "https://example.feishu.cn/base/basResourceScopeToken/",
  ).upsertRecord(command);
  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, 150);
  });
  const enteredBeforeRelease = [...entered];
  releaseFirst();
  await Promise.allSettled([first, second]);
  assert.deepEqual(
    enteredBeforeRelease,
    ["first"],
    "the equivalent remote Base must still have one critical section",
  );
  assert.deepEqual(entered, ["first", "second"]);
});

test("partially overlapping physical table mappings share the table mutex", async (context) => {
  const lockRoot = await mkdtemp(
    join(tmpdir(), "ppt-lark-overlapping-table-scope-test-"),
  );
  const baseTokenVariable =
    "PPT_EVAL_OVERLAPPING_TABLE_SCOPE_BASE_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basOverlappingTableScope";
  context.after(async () => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
    await rm(lockRoot, { recursive: true, force: true });
  });
  const clock = {
    clockId: "overlapping-table-scope-clock",
    now: () => FIXED_TIME,
  };
  const audit = new InMemoryEgressAuthorizationAudit();
  const payload = '{"caseId":"overlapping-table-case"}';
  const payloadHash = sha256Bytes(new TextEncoder().encode(payload));
  const entered: string[] = [];
  let finishMutations!: () => void;
  const mutationFinish = new Promise<void>((resolveFinish) => {
    finishMutations = resolveFinish;
  });
  const emptySearch = {
    ok: true,
    data: {
      data: [],
      field_id_list: ["fldStable", "fldPayload", "fldHash"],
      fields: ["稳定ID", "载荷", "载荷哈希"],
      has_more: false,
      record_id_list: [],
    },
  };
  const createTransport = (
    caller: "first" | "second",
    scoresTableId: string,
  ) =>
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        lockRootPath: lockRoot,
        baseTokenEnvironmentVariable: baseTokenVariable,
        tables: {
          ...LARK_TEST_CONFIGURATION.tables,
          scores: scoresTableId,
        },
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: audit,
      clock,
      async run(args) {
        const command = args[1] ?? "";
        if (command === "+record-search") return emptySearch;
        if (command === "+record-upsert") {
          entered.push(caller);
          await mutationFinish;
          throw new Error(`intentional-${caller}`);
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "overlapping-table-scope-parent",
      jobId: "job-overlapping-table-scope",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["case_table"],
      payloadHash,
      requiredRedactions: [],
    },
    clock,
  );
  const command = {
    tableKey: "cases" as const,
    stableId: "case:overlapping-table-case",
    payload,
    payloadHash,
    idempotencyKey: "overlapping-table-upsert",
    authorization,
  };
  const first = createTransport(
    "first",
    "tblScoresOnlyA",
  ).upsertRecord(command);
  const firstDeadline = Date.now() + 3_000;
  while (!entered.includes("first") && Date.now() < firstDeadline) {
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 10);
    });
  }
  assert.deepEqual(entered, ["first"]);
  const second = createTransport(
    "second",
    "tblScoresOnlyB",
  ).upsertRecord(command);
  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, 150);
  });
  const enteredBeforeRelease = [...entered];
  finishMutations();
  await Promise.allSettled([first, second]);
  assert.deepEqual(
    enteredBeforeRelease,
    ["first"],
    "the shared physical cases table must have one critical section",
  );
  assert.deepEqual(entered, ["first", "second"]);
});

test("a late concurrent stable-ID create cannot delete a record already returned to a caller", async (context) => {
  const baseTokenVariable = "PPT_EVAL_UPSERT_LATE_RACE_BASE_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basUpsertLateRaceToken";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
  });
  const clock = {
    clockId: "upsert-late-race-clock",
    now: () => FIXED_TIME,
  };
  const audit = new InMemoryEgressAuthorizationAudit();
  const payload = '{"caseId":"late-shared-case"}';
  const payloadHash = sha256Bytes(new TextEncoder().encode(payload));
  let records: {
    readonly recordId: string;
    readonly fields: Record<string, unknown>;
  }[] = [];
  let releaseLateCreate!: () => void;
  let markLateCreateEntered!: () => void;
  const lateCreateRelease = new Promise<void>((resolve) => {
    releaseLateCreate = resolve;
  });
  const lateCreateEntered = new Promise<void>((resolve) => {
    markLateCreateEntered = resolve;
  });
  const searchEnvelope = () => ({
    ok: true,
    data: {
      data: records.map(({ fields }) => [
        fields["稳定ID"],
        fields["载荷"],
        fields["载荷哈希"],
      ]),
      field_id_list: ["fldStable", "fldPayload", "fldHash"],
      fields: ["稳定ID", "载荷", "载荷哈希"],
      has_more: false,
      record_id_list: records.map(({ recordId }) => recordId),
    },
  });
  const createTransport = (
    caller: "early" | "late",
    recordId: string,
  ) =>
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: audit,
      clock,
      async run(args) {
        const command = args[1] ?? "";
        if (command === "+record-search") return searchEnvelope();
        if (command === "+record-upsert") {
          const recordIdIndex = args.indexOf("--record-id");
          if (caller === "late" && recordIdIndex === -1) {
            markLateCreateEntered();
            await lateCreateRelease;
          }
          const fields = JSON.parse(
            args[args.indexOf("--json") + 1]!,
          ) as Record<string, unknown>;
          const updatedRecordId =
            recordIdIndex === -1 ? recordId : args[recordIdIndex + 1]!;
          const existingIndex = records.findIndex(
            ({ recordId: candidate }) => candidate === updatedRecordId,
          );
          if (existingIndex === -1) {
            records.push({ recordId: updatedRecordId, fields });
          } else {
            records[existingIndex] = {
              recordId: updatedRecordId,
              fields,
            };
          }
          return {
            ok: true,
            data: {
              ...(recordIdIndex === -1
                ? { created: true }
                : { updated: true }),
              record: { record_id: updatedRecordId },
            },
          };
        }
        if (command === "+record-delete") {
          const deleted = new Set<string>();
          for (let index = 0; index < args.length; index += 1) {
            if (args[index] === "--record-id") {
              deleted.add(args[index + 1]!);
            }
          }
          records = records.filter(
            ({ recordId: candidate }) => !deleted.has(candidate),
          );
          return { ok: true, data: { deleted: true } };
        }
        throw new Error(`Unexpected command ${args.join(" ")}`);
      },
    });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "upsert-late-race-parent",
      jobId: "job-upsert-late-race",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["case_table"],
      payloadHash,
      requiredRedactions: [],
    },
    clock,
  );
  const command = {
    tableKey: "cases" as const,
    stableId: "case:late-shared-case",
    payload,
    payloadHash,
    idempotencyKey: "case-late-shared-race",
    authorization,
  };
  const late = createTransport("late", "recA");
  const early = createTransport("early", "recZ");

  const pendingLate = late.upsertRecord(command);
  await lateCreateEntered;
  let earlySettled = false;
  const pendingEarly = early.upsertRecord(command).finally(() => {
    earlySettled = true;
  });
  await new Promise<void>((resolveTurn) => {
    setImmediate(resolveTurn);
  });
  assert.equal(
    earlySettled,
    false,
    "the later caller must wait before it can return a transient record ID",
  );
  releaseLateCreate();
  const [lateResult, earlyResult] = await Promise.all([
    pendingLate,
    pendingEarly,
  ]);

  assert.equal(earlyResult.remoteRecordId, "recA");
  assert.equal(lateResult.remoteRecordId, "recA");
  assert.deepEqual(
    records.map(({ recordId }) => recordId),
    ["recA"],
  );
});

test("a concurrent recovery during the Docx-owner-only window has exactly one runnable claim", async (context) => {
  const baseTokenVariable = "PPT_EVAL_CLAIM_OWNER_WINDOW_BASE_TOKEN";
  const reportTokenVariable =
    "PPT_EVAL_CLAIM_OWNER_WINDOW_REPORT_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basClaimOwnerWindowToken";
  process.env[reportTokenVariable] = "DocClaimOwnerWindow";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
    if (previousReportToken === undefined) {
      delete process.env[reportTokenVariable];
    } else {
      process.env[reportTokenVariable] = previousReportToken;
    }
  });
  const clock = {
    clockId: "claim-owner-window-clock",
    now: () => FIXED_TIME,
  };
  const audit = new InMemoryEgressAuthorizationAudit();
  let reportRevision = 0;
  let reportContent = "";
  let storedFields: Record<string, unknown> | null = null;
  let claimUpsertCount = 0;
  let markFirstClaimUpsertEntered!: () => void;
  let releaseFirstClaimUpsert!: () => void;
  const firstClaimUpsertEntered = new Promise<void>((resolve) => {
    markFirstClaimUpsertEntered = resolve;
  });
  const firstClaimUpsertRelease = new Promise<void>((resolve) => {
    releaseFirstClaimUpsert = resolve;
  });
  const emptySearch = () => ({
    ok: true,
    data: {
      data: [],
      field_id_list: ["fldStable", "fldPayload", "fldHash"],
      fields: ["稳定ID", "载荷", "载荷哈希"],
      has_more: false,
      record_id_list: [],
    },
  });
  const populatedSearch = () => {
    assert.ok(storedFields);
    return {
      ok: true,
      data: {
        data: [[
          storedFields["稳定ID"],
          storedFields["载荷"],
          storedFields["载荷哈希"],
        ]],
        field_id_list: ["fldStable", "fldPayload", "fldHash"],
        fields: ["稳定ID", "载荷", "载荷哈希"],
        has_more: false,
        record_id_list: ["recClaimOwnerWindow"],
      },
    };
  };
  const run = async (
    args: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly stdin?: string | Uint8Array;
    },
  ): Promise<unknown> => {
    const service = args[0] ?? "";
    const command = args[1] ?? "";
    if (service === "docs" && command === "+fetch") {
      return {
        ok: true,
        data: {
          document: {
            document_id: "DocClaimOwnerWindow",
            revision_id: reportRevision,
            content: reportContent,
            url:
              "https://example.feishu.cn/docx/DocClaimOwnerWindow",
          },
        },
      };
    }
    if (service === "docs" && command === "+update") {
      const expectedRevision = Number(
        args[args.indexOf("--revision-id") + 1],
      );
      if (expectedRevision !== reportRevision) {
        throw new Error("document revision conflict");
      }
      reportRevision += 1;
      assert.equal(args[args.indexOf("--content") + 1], "-");
      reportContent =
        typeof options?.stdin === "string"
          ? options.stdin
          : new TextDecoder().decode(options?.stdin);
      return {
        ok: true,
        data: {
          result: "success",
          warnings: [],
          document: {
            revision_id: reportRevision,
            url:
              "https://example.feishu.cn/docx/DocClaimOwnerWindow",
          },
        },
      };
    }
    if (service === "base" && command === "+record-search") {
      return storedFields === null ? emptySearch() : populatedSearch();
    }
    if (service === "base" && command === "+record-upsert") {
      claimUpsertCount += 1;
      if (claimUpsertCount === 1) {
        markFirstClaimUpsertEntered();
        await firstClaimUpsertRelease;
      }
      storedFields = JSON.parse(
        args[args.indexOf("--json") + 1]!,
      ) as Record<string, unknown>;
      return {
        ok: true,
        data: {
          ...(args.includes("--record-id")
            ? { updated: true }
            : { created: true }),
          record: { record_id: "recClaimOwnerWindow" },
        },
      };
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  const createTransport = () =>
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
        reportDocumentTokenEnvironmentVariable: reportTokenVariable,
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: audit,
      clock,
      run,
    });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "claim-owner-window-parent",
      jobId: "job-claim-owner-window",
      runId: null,
      attemptId: "attempt-claim-owner-window",
      dataClassification: "public_or_synthetic",
      sourceOwner: "claimant-owner-window",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["production_job_claim"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
    },
    clock,
  );
  const claim = {
    jobId: "job-claim-owner-window",
    runIds: ["run-claim-owner-window"],
    claimHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
    claimantId: "claimant-owner-window",
    claimAttemptId: "attempt-claim-owner-window",
    authorization,
    claimedAt: FIXED_TIME,
  };
  const first = createTransport().claimProductionJob!(claim);
  await firstClaimUpsertEntered;
  let secondSettled = false;
  const second = createTransport().claimProductionJob!(claim).finally(
    () => {
      secondSettled = true;
    },
  );
  await new Promise<void>((resolveTurn) => {
    setImmediate(resolveTurn);
  });
  assert.equal(
    secondSettled,
    false,
    "the second claimant must wait while the first owner is live",
  );
  releaseFirstClaimUpsert();

  assert.deepEqual(
    (await Promise.all([first, second])).sort(),
    ["already_claimed", "claimed"],
  );
  assert.equal(claimUpsertCount, 1);
  assert.equal(reportRevision, 1);
});

test("a crashed, PID-reused, or safely aborted Base-backed claim is recovered by one new lease epoch", async (context) => {
  const baseTokenVariable = "PPT_EVAL_CLAIM_LEASE_BASE_TOKEN";
  const reportTokenVariable = "PPT_EVAL_CLAIM_LEASE_REPORT_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basClaimLeaseToken";
  process.env[reportTokenVariable] = "DocClaimLease";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
    if (previousReportToken === undefined) {
      delete process.env[reportTokenVariable];
    } else {
      process.env[reportTokenVariable] = previousReportToken;
    }
  });
  const clock = { clockId: "claim-lease-clock", now: () => FIXED_TIME };
  const audit = new InMemoryEgressAuthorizationAudit();
  let reportRevision = 0;
  let reportContent = "";
  let storedFields: Record<string, unknown> | null = null;
  let loseFirstBaseResponse = true;
  const activeLeases = new Set([
    "lease-a",
    "lease-b",
    "lease-c",
    "lease-d",
  ]);
  const releasedLeases = new Set<string>();
  const observedProcessStarts = new Map<number, string>([
    [1001, "process-start-a"],
    [1002, "process-start-b"],
  ]);
  const emptySearch = () => ({
    ok: true,
    data: {
      data: [],
      field_id_list: ["fldStable", "fldPayload", "fldHash"],
      fields: ["稳定ID", "载荷", "载荷哈希"],
      has_more: false,
      record_id_list: [],
    },
  });
  const populatedSearch = () => {
    assert.ok(storedFields);
    return {
      ok: true,
      data: {
        data: [[
          storedFields["稳定ID"],
          storedFields["载荷"],
          storedFields["载荷哈希"],
        ]],
        field_id_list: ["fldStable", "fldPayload", "fldHash"],
        fields: ["稳定ID", "载荷", "载荷哈希"],
        has_more: false,
        record_id_list: ["recClaimLease"],
      },
    };
  };
  const run = async (
    args: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly stdin?: string | Uint8Array;
    },
  ): Promise<unknown> => {
    const service = args[0] ?? "";
    const command = args[1] ?? "";
    if (service === "docs" && command === "+fetch") {
      return {
        ok: true,
        data: {
          document: {
            document_id: "DocClaimLease",
            revision_id: reportRevision,
            content: reportContent,
            url: "https://example.feishu.cn/docx/DocClaimLease",
          },
        },
      };
    }
    if (service === "docs" && command === "+update") {
      const expectedRevision = Number(
        args[args.indexOf("--revision-id") + 1],
      );
      if (expectedRevision !== reportRevision) {
        throw new Error("document revision conflict");
      }
      reportRevision += 1;
      assert.equal(args[args.indexOf("--content") + 1], "-");
      reportContent =
        typeof options?.stdin === "string"
          ? options.stdin
          : new TextDecoder().decode(options?.stdin);
      return {
        ok: true,
        data: {
          result: "success",
          warnings: [],
          document: {
            revision_id: reportRevision,
            url: "https://example.feishu.cn/docx/DocClaimLease",
          },
        },
      };
    }
    if (service === "base" && command === "+record-search") {
      return storedFields === null ? emptySearch() : populatedSearch();
    }
    if (service === "base" && command === "+record-upsert") {
      storedFields = JSON.parse(
        args[args.indexOf("--json") + 1]!,
      ) as Record<string, unknown>;
      if (loseFirstBaseResponse) {
        loseFirstBaseResponse = false;
        throw new Error("simulated lost Base claim response");
      }
      return {
        ok: true,
        data: {
          ...(args.includes("--record-id")
            ? { updated: true }
            : { created: true }),
          record: { record_id: "recClaimLease" },
        },
      };
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  const createTransport = (
    leaseId: string,
    processId: number,
    processStartIdentity: string,
  ) =>
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
        reportDocumentTokenEnvironmentVariable: reportTokenVariable,
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: audit,
      clock,
      run,
      claimLeaseForTest: {
        leaseId,
        processId,
        processStartIdentity,
        isActive: async (
          candidateLeaseId: string,
          candidateProcessId: number,
          candidateProcessStartIdentity?: string,
        ) =>
          (candidateLeaseId === leaseId &&
            candidateProcessId === processId &&
            candidateProcessStartIdentity ===
              processStartIdentity) ||
          (activeLeases.has(candidateLeaseId) &&
            (candidateProcessStartIdentity === undefined ||
              observedProcessStarts.get(candidateProcessId) ===
                candidateProcessStartIdentity)),
        async release() {
          releasedLeases.add(leaseId);
          activeLeases.delete(leaseId);
        },
      },
    } as Parameters<
      typeof createLarkCliTransportForMutationBoundaryTest
    >[0] & {
      readonly claimLeaseForTest: {
        readonly leaseId: string;
        readonly processId: number;
        readonly processStartIdentity: string;
        readonly isActive: (
          leaseId: string,
          processId: number,
          processStartIdentity?: string,
        ) => Promise<boolean>;
        readonly release: () => Promise<void>;
      };
    });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "claim-lease-parent",
      jobId: "job-claim-lease",
      runId: null,
      attemptId: "attempt-claim-lease",
      dataClassification: "public_or_synthetic",
      sourceOwner: "claimant-lease",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["production_job_claim"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
    },
    clock,
  );
  const claim = {
    jobId: "job-claim-lease",
    runIds: ["run-claim-lease"],
    claimHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
    claimantId: "claimant-lease",
    claimAttemptId: "attempt-claim-lease",
    authorization,
    claimedAt: FIXED_TIME,
  };
  const first = createTransport("lease-a", 1001, "process-start-a");
  assert.equal(
    await first.claimProductionJob!(claim),
    "claimed",
  );

  activeLeases.delete("lease-a");
  observedProcessStarts.delete(1001);
  const replacement = createTransport(
    "lease-b",
    1002,
    "process-start-b",
  );
  assert.equal(
    await replacement.claimProductionJob!(claim),
    "claimed",
  );
  observedProcessStarts.set(1002, "process-start-c");
  const pidReuseReplacement = createTransport(
    "lease-c",
    1002,
    "process-start-c",
  );
  assert.equal(
    await pidReuseReplacement.claimProductionJob!(claim),
    "claimed",
  );
  assert.ok(
    pidReuseReplacement.abortProductionJobClaimBeforeSubmission,
  );
  await assert.rejects(
    pidReuseReplacement.abortProductionJobClaimBeforeSubmission({
      ...claim,
      notSubmittedAttemptIds: [],
      abortedAt: "2020-01-01T00:00:01.000Z",
    }),
    /abort proof is incomplete/i,
  );
  assert.equal(
    await createTransport(
      "lease-unproven",
      1005,
      "process-start-unproven",
    ).claimProductionJob!(claim),
    "already_claimed",
  );
  await pidReuseReplacement.abortProductionJobClaimBeforeSubmission({
    ...claim,
    notSubmittedAttemptIds: ["run-claim-lease-attempt-1"],
    abortedAt: "2020-01-01T00:00:01.000Z",
  });
  assert.equal(
    releasedLeases.has("lease-c"),
    true,
    "a durably safe abort must release its lease sentinel",
  );
  observedProcessStarts.set(1003, "process-start-d");
  const safeAbortReplacement = createTransport(
    "lease-d",
    1003,
    "process-start-d",
  );
  assert.equal(
    await safeAbortReplacement.claimProductionJob!(claim),
    "claimed",
  );
  assert.equal(
    await createTransport(
      "lease-e",
      1004,
      "process-start-e",
    ).claimProductionJob!(claim),
    "already_claimed",
  );
  assert.ok(storedFields);
  const storedClaim = JSON.parse(
    storedFields["载荷"] as string,
  ) as Record<string, unknown>;
  assert.equal(storedClaim.schemaVersion, "lark-production-job-claim-v3");
  assert.equal(storedClaim.claimEpoch, 4);
  assert.equal(storedClaim.claimState, "claimed");
  assert.equal(storedClaim.executionLeaseId, "lease-d");
  assert.equal(storedClaim.executionProcessId, 1003);
  assert.equal(
    storedClaim.executionProcessStartIdentity,
    "process-start-d",
  );
});

test("a late rev1 marker cannot overwrite a concurrent rev2 Docx projection", async (context) => {
  const baseTokenVariable = "PPT_EVAL_MARKER_CAS_BASE_TOKEN";
  const reportTokenVariable = "PPT_EVAL_MARKER_CAS_REPORT_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basMarkerCasToken";
  process.env[reportTokenVariable] = "DocMarkerCas";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
    if (previousReportToken === undefined) {
      delete process.env[reportTokenVariable];
    } else {
      process.env[reportTokenVariable] = previousReportToken;
    }
  });
  const clock = { clockId: "marker-cas-clock", now: () => FIXED_TIME };
  const audit = new InMemoryEgressAuthorizationAudit();
  let reportRevision = 0;
  let reportContent =
    "# PPT 竞品自动评测｜报告槽位\n\n" +
    "Owner schema: `lark-report-owner-v1`\n\n" +
    "Owner Job: `job-marker-cas`\n";
  let markerFields: Record<string, unknown> | null = null;
  let markRev1Written!: () => void;
  let releaseRev1Commit!: () => void;
  const rev1Written = new Promise<void>((resolve) => {
    markRev1Written = resolve;
  });
  const rev1CommitRelease = new Promise<void>((resolve) => {
    releaseRev1Commit = resolve;
  });
  const searchEnvelope = () =>
    markerFields === null
      ? {
          ok: true,
          data: {
            data: [],
            field_id_list: ["fldStable", "fldPayload", "fldHash"],
            fields: ["稳定ID", "载荷", "载荷哈希"],
            has_more: false,
            record_id_list: [],
          },
        }
      : {
          ok: true,
          data: {
            data: [[
              markerFields["稳定ID"],
              markerFields["载荷"],
              markerFields["载荷哈希"],
            ]],
            field_id_list: ["fldStable", "fldPayload", "fldHash"],
            fields: ["稳定ID", "载荷", "载荷哈希"],
            has_more: false,
            record_id_list: ["recMarkerCas"],
          },
        };
  const run = async (
    args: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly stdin?: string | Uint8Array;
    },
  ): Promise<unknown> => {
    const service = args[0] ?? "";
    const command = args[1] ?? "";
    if (service === "docs" && command === "+fetch") {
      return {
        ok: true,
        data: {
          document: {
            document_id: "DocMarkerCas",
            revision_id: reportRevision,
            content: reportContent,
            url: "https://example.feishu.cn/docx/DocMarkerCas",
          },
        },
      };
    }
    if (service === "docs" && command === "+update") {
      const expectedRevision = Number(
        args[args.indexOf("--revision-id") + 1],
      );
      if (expectedRevision !== reportRevision) {
        throw new Error("document revision conflict");
      }
      reportRevision += 1;
      assert.equal(args[args.indexOf("--content") + 1], "-");
      reportContent =
        typeof options?.stdin === "string"
          ? options.stdin
          : new TextDecoder().decode(options?.stdin);
      return {
        ok: true,
        data: {
          result: "success",
          warnings: [],
          document: {
            revision_id: reportRevision,
            url: "https://example.feishu.cn/docx/DocMarkerCas",
          },
        },
      };
    }
    if (service === "base" && command === "+record-search") {
      return searchEnvelope();
    }
    if (service === "base" && command === "+record-upsert") {
      markerFields = JSON.parse(
        args[args.indexOf("--json") + 1]!,
      ) as Record<string, unknown>;
      return {
        ok: true,
        data: {
          ...(args.includes("--record-id")
            ? { updated: true }
            : { created: true }),
          record: { record_id: "recMarkerCas" },
        },
      };
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  const createTransport = () =>
    createLarkCliTransportForMutationBoundaryTest({
      configuration: {
        ...LARK_TEST_CONFIGURATION,
        baseTokenEnvironmentVariable: baseTokenVariable,
        reportDocumentTokenEnvironmentVariable: reportTokenVariable,
      },
      egressAuthorization: allowLarkMutation,
      egressAudit: audit,
      clock,
      run,
    });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "marker-cas-parent",
      jobId: "job-marker-cas",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "owner",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: "lark-base-operational-ledger",
      targetAccount: "test-account",
      targetRegion: "cn",
      subprocessors: [],
      contentFields: ["commit_marker"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
    },
    clock,
  );
  const reportsA = [{
    reportId: "report-a",
    title: "Report A",
    markdown: "# Report A\n\nAlpha.",
    payloadHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
  }];
  const reportsB = [{
    reportId: "report-b",
    title: "Report B",
    markdown: "# Report B\n\nBeta.",
    payloadHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
  }];
  const hashA = sha256Bytes(canonicalJsonBytes(reportsA));
  const hashB = sha256Bytes(canonicalJsonBytes(reportsB));
  const transportA = createTransport();
  const transportB = createTransport();
  const markerBase = {
    schemaVersion: "lark-projection-commit-v2" as const,
    jobId: "job-marker-cas",
    authorizationDecisionId: authorization.decisionId,
    recordCount: 1,
    attachmentCount: 0,
    pageEvidenceUrls: [],
    attachments: [],
    committedAt: FIXED_TIME,
  };
  const first = transportA.withProjectionMutex!(
    "job-marker-cas",
    async () => {
      const doc = await transportA.upsertReportCollection({
        jobId: "job-marker-cas",
        reports: reportsA,
        collectionHash: hashA,
        idempotencyKey: `report-a:${hashA}`,
        authorization,
      });
      markRev1Written();
      await rev1CommitRelease;
      await transportA.commitBatch({
        ...markerBase,
        batchHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        reportUrls: [{ reportId: "report-a", url: doc.url }],
        reportCollectionHash: hashA,
        reportDocumentRevision: doc.revisionId,
        previousBatchHash: null,
        revision: 1,
        authorization,
      });
    },
  );
  await rev1Written;
  let secondDocWritten = false;
  const second = transportB.withProjectionMutex!(
    "job-marker-cas",
    async () => {
      const doc = await transportB.upsertReportCollection({
        jobId: "job-marker-cas",
        reports: reportsB,
        collectionHash: hashB,
        idempotencyKey: `report-b:${hashB}`,
        authorization,
      });
      secondDocWritten = true;
      await transportB.commitBatch({
        ...markerBase,
        batchHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        reportUrls: [{ reportId: "report-b", url: doc.url }],
        reportCollectionHash: hashB,
        reportDocumentRevision: doc.revisionId,
        previousBatchHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        revision: 2,
        authorization,
      });
    },
  );
  await new Promise<void>((resolveTurn) => {
    setImmediate(resolveTurn);
  });
  assert.equal(
    secondDocWritten,
    false,
    "rev2 cannot pass rev1 before rev1 has committed its marker",
  );
  releaseRev1Commit();
  await Promise.all([first, second]);

  const finalMarker = await transportA.readCommitMarker({
    jobId: "job-marker-cas",
  });
  assert.equal(reportRevision, 2);
  assert.equal(
    finalMarker?.batchHash,
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(finalMarker?.reportDocumentRevision, 2);
  await transportA.verifyReportCollection({
    jobId: "job-marker-cas",
    reports: reportsB,
    collectionHash: hashB,
    expectedUrl: finalMarker!.reportUrls[0]!.url,
    expectedRevisionId: 2,
  });
});
