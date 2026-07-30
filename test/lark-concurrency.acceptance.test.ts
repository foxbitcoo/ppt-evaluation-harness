import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireLarkSingleWorkstationMutexForTest,
  createLarkCliTransportForMutationBoundaryTest,
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

test("the single-workstation mutex is recovered after its owning process crashes", async () => {
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

test("a crashed Base-backed claim is recovered by one new lease epoch", async (context) => {
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
  const activeLeases = new Set(["lease-a", "lease-b"]);
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
        isActive: async (candidateLeaseId: string) =>
          activeLeases.has(candidateLeaseId),
      },
    } as Parameters<
      typeof createLarkCliTransportForMutationBoundaryTest
    >[0] & {
      readonly claimLeaseForTest: {
        readonly leaseId: string;
        readonly processId: number;
        readonly isActive: (
          leaseId: string,
          processId: number,
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
  const first = createTransport("lease-a", 1001);
  assert.equal(
    await first.claimProductionJob!(claim),
    "claimed",
  );

  activeLeases.delete("lease-a");
  const replacement = createTransport("lease-b", 1002);
  assert.equal(
    await replacement.claimProductionJob!(claim),
    "claimed",
  );
  assert.equal(
    await createTransport("lease-c", 1003).claimProductionJob!(claim),
    "already_claimed",
  );
  assert.ok(storedFields);
  const storedClaim = JSON.parse(
    storedFields["载荷"] as string,
  ) as Record<string, unknown>;
  assert.equal(storedClaim.schemaVersion, "lark-production-job-claim-v3");
  assert.equal(storedClaim.claimEpoch, 2);
  assert.equal(storedClaim.executionLeaseId, "lease-b");
  assert.equal(storedClaim.executionProcessId, 1002);
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
