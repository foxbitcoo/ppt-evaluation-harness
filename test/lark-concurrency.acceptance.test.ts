import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  readFileSync,
} from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
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
    options?: { readonly cwd?: string },
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
      const contentReference = args[args.indexOf("--content") + 1]!;
      assert.ok(options?.cwd);
      reportContent = readFileSync(
        `${options.cwd}/${contentReference.slice(1)}`,
        "utf8",
      );
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
    options?: { readonly cwd?: string },
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
      const contentReference = args[args.indexOf("--content") + 1]!;
      assert.ok(options?.cwd);
      reportContent = readFileSync(
        `${options.cwd}/${contentReference.slice(1)}`,
        "utf8",
      );
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
    options?: { readonly cwd?: string },
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
      const contentReference = args[args.indexOf("--content") + 1]!;
      assert.ok(options?.cwd);
      reportContent = readFileSync(
        `${options.cwd}/${contentReference.slice(1)}`,
        "utf8",
      );
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
