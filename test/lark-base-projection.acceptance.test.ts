import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  ProjectionStaleBaselineError,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createHarnessOwnedLarkBaseProjection,
  createLarkReportCollectionMarkdown,
  createLarkBaseProjectionForTest,
  createComparisonReportService,
  createLarkCliTransportForMutationBoundaryTest,
  createVerifiedLarkCliTransport,
  assertFrozenLarkCliInstallation,
  FROZEN_LARK_CLI_BINARY,
  FROZEN_LARK_CLI_SHA256,
  FROZEN_LARK_CLI_SCRIPT,
  FROZEN_LARK_CLI_SCRIPT_SHA256,
  FROZEN_LARK_CLI_VERSION,
  FROZEN_LARK_CLI_WRAPPER,
  FROZEN_LARK_CLI_WRAPPER_TARGET,
  InMemoryEgressAuthorizationAudit,
  parseLarkDocumentReadback,
  parseLarkRecordShareLinkEnvelope,
  parseLarkRecordSearchEnvelope,
  parseLarkRecordUpsertEnvelope,
  requireEgressAuthorization,
  sha256Bytes,
  canonicalJsonBytes,
  type LarkBaseProjectionTransportPort,
  type LarkCommitMarker,
  type EgressAuthorizationPort,
} from "../src/index.ts";

const FIXED_TIME = "2020-01-01T00:00:00.000Z";
const LARK_TEST_CONFIGURATION = {
  concurrencyBoundary: "single_workstation_durable_mutex",
  lockRootPath: "/tmp/ppt-evaluation-lark-projection-test-locks",
  baseTokenEnvironmentVariable: "PPT_EVAL_TEST_BASE_TOKEN",
  reportDocumentTokenEnvironmentVariable:
    "PPT_EVAL_TEST_REPORT_DOC_TOKEN",
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
} as const;

const allowLarkMutation = {
  async authorize(request) {
    return {
      status: "approved" as const,
      decisionId: `lark-mutation:${request.requestId}`,
      policyVersion: "test-policy-v1",
      request,
      legalSecurityBasis: "test",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
} satisfies EgressAuthorizationPort;

interface FakeLarkTransport extends LarkBaseProjectionTransportPort {
  readonly records: Map<string, string>;
  readonly payloads: Map<string, string>;
  readonly reports: Map<string, string>;
  readonly markers: Map<
    string,
    LarkCommitMarker
  >;
  readonly attachmentRoles: string[];
  readonly attachments: Map<string, Uint8Array>;
  readonly mutationOperations: string[];
  readonly reportCollectionMarkdowns: string[];
  corruptDownloadedAttachment: boolean;
  readonly corruptAttachmentTokens: Set<string>;
  corruptReportCollectionReplay: boolean;
}

function fakeTransport(): FakeLarkTransport {
  const records = new Map<string, string>();
  const payloads = new Map<string, string>();
  const reports = new Map<string, string>();
  const markers = new Map<
    string,
    LarkCommitMarker
  >();
  const attachmentRoles: string[] = [];
  const attachments = new Map<string, Uint8Array>();
  const corruptAttachmentTokens = new Set<string>();
  const mutationOperations: string[] = [];
  const reportCollectionMarkdowns: string[] = [];
  const physicalTables = {
    cases: "tblCases",
    runs: "tblShared",
    artifacts: "tblShared",
    scores: "tblScores",
    workflow_events: "tblGaps",
    comparisons: "tblGaps",
    commit_markers: "tblShared",
  } as const;
  const physicalKey = (
    tableKey: keyof typeof physicalTables,
    stableId: string,
  ) => `${physicalTables[tableKey]}:${stableId}`;
  return {
    transportId: "test-lark-transport",
    pageEvidenceBaseUrl: "https://example.feishu.cn/base/ppt-evaluation",
    records,
    payloads,
    reports,
    markers,
    attachmentRoles,
    attachments,
    mutationOperations,
    reportCollectionMarkdowns,
    corruptDownloadedAttachment: false,
    corruptAttachmentTokens,
    corruptReportCollectionReplay: false,
    async preflight() {},
    async upsertRecord(command) {
      mutationOperations.push(`upsert:${command.stableId}`);
      records.set(
        physicalKey(command.tableKey, command.stableId),
        command.payloadHash,
      );
      payloads.set(
        physicalKey(command.tableKey, command.stableId),
        command.payload,
      );
      return {
        remoteRecordId: `rec_${command.stableId}`,
        recordUrl:
          `https://example.feishu.cn/base/ppt-evaluation?record=${encodeURIComponent(command.stableId)}`,
      };
    },
    async verifyRecord(command) {
      assert.equal(
        records.get(physicalKey(command.tableKey, command.stableId)),
        command.payloadHash,
      );
      assert.equal(
        payloads.get(physicalKey(command.tableKey, command.stableId)),
        command.payload,
      );
    },
    async uploadAttachment(command) {
      mutationOperations.push(`upload:${command.attachmentRole}`);
      attachmentRoles.push(command.attachmentRole);
      const fileToken = `file_${command.idempotencyKey}`;
      attachments.set(fileToken, Uint8Array.from(command.content));
      return {
        fileToken,
        remoteHash: command.contentHash,
        attachmentUrl:
          `https://example.feishu.cn/file/${encodeURIComponent(command.idempotencyKey)}`,
      };
    },
    async downloadAttachment(command) {
      if (
        this.corruptDownloadedAttachment ||
        corruptAttachmentTokens.has(command.fileToken)
      ) {
        return Uint8Array.from([0, 1, 2, 3]);
      }
      return attachments.get(command.fileToken) ?? command.expectedContent;
    },
    async createRecordShareLink(command) {
      mutationOperations.push(`share:${command.remoteRecordId}`);
      return `https://example.feishu.cn/record/${encodeURIComponent(
        `share_${command.remoteRecordId}`,
      )}`;
    },
    async verifyPageEvidence(command) {
      const expected =
        `https://example.feishu.cn/record/${encodeURIComponent(
          `share_rec_${command.stableId}`,
        )}`;
      assert.equal(command.expectedUrl, expected);
      assert.ok(records.has(physicalKey("artifacts", command.stableId)));
    },
    async upsertReportCollection(command) {
      mutationOperations.push(`report:${command.jobId}`);
      const url =
        "https://example.feishu.cn/docx/report-collection";
      for (const report of command.reports) {
        reports.set(report.reportId, url);
      }
      const content = createLarkReportCollectionMarkdown(command);
      reportCollectionMarkdowns.push(content);
      return {
        url,
        remoteContentHash:
          `sha256:${createHash("sha256")
            .update(content)
            .digest("hex")}` as const,
        revisionId: reportCollectionMarkdowns.length,
      };
    },
    async verifyReportCollection(command) {
      if (this.corruptReportCollectionReplay) {
        throw new Error("truncated Doc collection replay");
      }
      for (const report of command.reports) {
        assert.equal(
          reports.get(report.reportId),
          command.expectedUrl,
        );
      }
      assert.equal(
        command.collectionHash,
        sha256Bytes(canonicalJsonBytes(command.reports)),
      );
      assert.equal(
        command.expectedRevisionId,
        reportCollectionMarkdowns.length,
      );
    },
    async readCommitMarker(command) {
      return markers.get(command.jobId) ?? null;
    },
    async commitBatch(command) {
      mutationOperations.push(`commit:${command.jobId}`);
      const { authorization: _authorization, ...marker } = command;
      const payload = JSON.stringify(marker);
      records.set(
        physicalKey("commit_markers", `commit:${command.jobId}`),
        `sha256:${createHash("sha256").update(payload).digest("hex")}`,
      );
      payloads.set(
        physicalKey("commit_markers", `commit:${command.jobId}`),
        payload,
      );
      markers.set(command.jobId, structuredClone(marker));
    },
  };
}

async function authorizedSnapshot() {
  const source = new InMemoryFeishuProjection();
  await source.upsertCase({
    recordId: "case-volcano-v1",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    dataClassification: "public_or_synthetic",
    sourceOwner: "test",
    caseId: "case-volcano-v1",
    caseVersion: 1,
    track: "query_generation",
    title: "火山为什么会喷发",
    targetPageCount: 16,
    audience: "初中生",
    readingMode: "self_reading",
    vendorPrompt: "生成 16 页火山科普 PPT",
  });
  await source.appendRunRecord({
    recordId: "job-volcano-v1",
    recordType: "bakeoff_job",
    jobId: "job-volcano-v1",
    parentRecordId: null,
    caseId: "case-volcano-v1",
    product: null,
    productVendorId: null,
    productPackageId: null,
    adapterVersion: null,
    status: "completed",
    attemptSeq: null,
    elapsedMs: null,
    submissionEvidence: null,
    terminalReason: null,
    waitingReason: null,
    blockReason: null,
    retryOfAttemptId: null,
    selectedRunIds: [],
    protocolSnapshot: null,
    deadlineAt: null,
    vendorGenerationMs: null,
    vendorReportedElapsedMs: null,
    humanWaitMs: null,
    timingPausedAt: null,
    observableEvents: null,
    manualActions: null,
    costEvidence: null,
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    createdAt: FIXED_TIME,
    lastSyncedAt: FIXED_TIME,
    reportUrl: null,
    auxiliaryReportUrls: null,
    artifactId: null,
    renderManifestId: null,
    scorecardId: null,
  });
  const report = await source.createReport({
    reportId: "report-volcano-v1",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    title: "火山 Case Sample",
    jobId: "job-volcano-v1",
    runIds: [],
    artifactIds: [],
    claimLevel: "case_sample",
    markdown: "# 火山 Case Sample",
    createdAt: FIXED_TIME,
  });
  await source.linkReportToBakeoffJob(
    "job-volcano-v1",
    report.url,
  );
  const snapshot = source.snapshot();
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({
    transport,
    targetEnvironment: "test",
  });
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  const authorization = await requireEgressAuthorization(
    {
      async authorize(request) {
        return {
          status: "approved" as const,
          decisionId: "lark-projection-approved",
          policyVersion: "test-policy-v1",
          request,
          legalSecurityBasis: "test",
          approvedAt: FIXED_TIME,
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    {
      requestId:
        `operational-ledger-projection:job-volcano-v1:${payloadHash}`,
      jobId: "job-volcano-v1",
      runId: null,
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "test",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: projection.egressDestination.targetService,
      targetAccount: projection.egressDestination.targetAccount,
      targetRegion: projection.egressDestination.targetRegion,
      subprocessors: [],
      contentFields: [
        "case_table",
        "run_record_table",
        "captured_artifact_table",
        "artifact_score_table",
        "adjudication_event_table",
        "review_event_table",
        "gap_card_workflow_event_table",
        "github_issue_delivery_reservation_table",
        "github_issue_link_event_table",
        "comparison_and_product_gap_card_table",
        "reports",
      ],
      payloadHash,
      requiredRedactions: [],
    },
    { clockId: "test-clock", now: () => FIXED_TIME },
  );
  return { projection, snapshot, authorization, transport };
}

async function authorizationForStaleBaselineSnapshot(
  projection: ReturnType<typeof createLarkBaseProjectionForTest>,
  snapshot: ReturnType<
    ReturnType<typeof createLarkBaseProjectionForTest>["snapshot"]
  >,
) {
  const job = snapshot.runRecordTable.find(
    (record) => record.recordType === "bakeoff_job",
  );
  const evaluationCase = snapshot.caseTable[0];
  assert.ok(job);
  assert.ok(evaluationCase);
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  return await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId:
        `operational-ledger-projection:${job.jobId}:${payloadHash}`,
      jobId: job.jobId,
      runId: null,
      attemptId: null,
      dataClassification: evaluationCase.dataClassification,
      sourceOwner: evaluationCase.sourceOwner,
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: projection.egressDestination.targetService,
      targetAccount: projection.egressDestination.targetAccount,
      targetRegion: projection.egressDestination.targetRegion,
      subprocessors: projection.egressDestination.subprocessors,
      contentFields: [
        "case_table",
        "run_record_table",
        "captured_artifact_table",
        "artifact_score_table",
        "adjudication_event_table",
        "review_event_table",
        "gap_card_workflow_event_table",
        "github_issue_delivery_reservation_table",
        "github_issue_link_event_table",
        "comparison_and_product_gap_card_table",
        "reports",
      ],
      payloadHash,
      requiredRedactions: [],
    },
    { clockId: "test-clock", now: () => FIXED_TIME },
  );
}

test("Lark Base projection materializes a transport-verified HTTPS Docx report URL and recovers idempotently", async () => {
  const { projection, snapshot, authorization } =
    await authorizedSnapshot();

  await projection.commitAuthorizedSnapshot(snapshot, authorization);
  await projection.commitAuthorizedSnapshot(snapshot, authorization);

  const committed = projection.snapshot();
  assert.equal(committed.reports.length, 1);
  assert.match(committed.reports[0]?.url ?? "", /^https:\/\//);
  assert.equal(
    committed.runRecordTable[0]?.reportUrl,
    committed.reports[0]?.url,
  );
  assert.match(
    projection.artifactPageEvidenceUrl("artifact-volcano-v1", 1),
    /^https:\/\//,
  );
});

test("a remote commit marker that advanced beyond the captured staging baseline rejects a stale projection", async () => {
  const { projection, snapshot, authorization, transport } =
    await authorizedSnapshot();
  await projection.commitAuthorizedSnapshot(snapshot, authorization);
  const baseline = await projection.captureCommitBaseline(
    "job-volcano-v1",
  );
  const marker = transport.markers.get("job-volcano-v1");
  assert.ok(marker);
  transport.markers.set("job-volcano-v1", {
    ...marker,
    batchHash:
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    previousBatchHash: marker.batchHash,
    revision: marker.revision + 1,
  });
  const staged = projection.forkForStaging(
    baseline.localSnapshot,
  );
  const report = await staged.createReport({
    reportId: "report-stale-baseline-v1",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    title: "stale baseline",
    jobId: "job-volcano-v1",
    runIds: [],
    artifactIds: [],
    claimLevel: "case_sample",
    markdown: "# stale baseline",
    createdAt: FIXED_TIME,
  });
  await staged.linkReportToBakeoffJob(
    "job-volcano-v1",
    report.url,
    "auxiliary",
  );
  const stagedSnapshot = staged.snapshot();

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      stagedSnapshot,
      await authorizationForStaleBaselineSnapshot(
        projection,
        stagedSnapshot,
      ),
      baseline,
    ),
    ProjectionStaleBaselineError,
  );
  assert.equal(
    projection.snapshot().reports.some(
      ({ reportId }) => reportId === report.reportId,
    ),
    false,
  );
});

test("Bakeoff outcome returns the post-commit Docx readback instead of the staged mock-feishu report URL", async () => {
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({
    transport,
  });
  const outcome = await createBakeoffHarness({
    feishu: projection,
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  assert.match(outcome.report.url, /^https:\/\/example\.feishu\.cn\/docx\//);
  assert.doesNotMatch(outcome.report.url, /^mock-feishu:/);
  assert.equal(
    outcome.report.url,
    projection.snapshot().reports[0]?.url,
  );
  assert.ok(
    [...transport.payloads.entries()]
      .filter(([, payload]) => payload.includes('"recordType"'))
      .every(([, payload]) => !payload.includes("mock-feishu:")),
  );
});

async function authorizationForSnapshot(
  projection: InMemoryFeishuProjection,
  snapshot: ReturnType<InMemoryFeishuProjection["snapshot"]>,
  jobId: string,
) {
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  const evaluationCase = snapshot.caseTable.find(
    ({ caseId }) =>
      snapshot.runRecordTable.find(
        ({ recordType }) => recordType === "bakeoff_job",
      )?.caseId === caseId,
  );
  assert.ok(evaluationCase);
  return await requireEgressAuthorization(
    {
      async authorize(request) {
        return {
          status: "approved" as const,
          decisionId: `lark-projection-approved:${jobId}`,
          policyVersion: "test-policy-v1",
          request,
          legalSecurityBasis: "test",
          approvedAt: FIXED_TIME,
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    {
      requestId:
        `operational-ledger-projection:${jobId}:${payloadHash}`,
      jobId,
      runId: null,
      attemptId: null,
      dataClassification: evaluationCase.dataClassification,
      sourceOwner: evaluationCase.sourceOwner,
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: projection.egressDestination.targetService,
      targetAccount: projection.egressDestination.targetAccount,
      targetRegion: projection.egressDestination.targetRegion,
      subprocessors: [],
      contentFields: [
        "case_table",
        "run_record_table",
        "captured_artifact_table",
        "artifact_score_table",
        "adjudication_event_table",
        "review_event_table",
        "gap_card_workflow_event_table",
        "github_issue_delivery_reservation_table",
        "github_issue_link_event_table",
        "comparison_and_product_gap_card_table",
        "reports",
      ],
      payloadHash,
      requiredRedactions: [],
    },
    { clockId: "test-clock", now: () => FIXED_TIME },
  );
}

test("Lark Base projection uploads the original plus every static derivative and verifies each download hash", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({
    transport,
  });
  const authorization = await authorizationForSnapshot(
    projection,
    snapshot,
    snapshot.runRecordTable.find(
      ({ recordType }) => recordType === "bakeoff_job",
    )!.jobId,
  );

  await projection.commitAuthorizedSnapshot(snapshot, authorization);
  await projection.commitAuthorizedSnapshot(snapshot, authorization);

  assert.equal(transport.attachmentRoles.length, 18);
  assert.deepEqual(transport.attachmentRoles, [
    "original",
    "contact-sheet",
    ...Array.from({ length: 16 }, (_, index) => `page-${index + 1}`),
  ]);
  const marker = transport.markers.values().next().value;
  assert.equal(marker?.pageEvidenceUrls.length, 16);
  assert.equal(
    [...transport.records.keys()].filter((key) =>
      /^tblShared:page:.*:\d+$/.test(key),
    ).length,
    16,
  );
  const sharedStableIds = [...transport.records.keys()]
    .filter((key) => key.startsWith("tblShared:"))
    .map((key) => key.slice("tblShared:".length));
  assert.ok(sharedStableIds.some((id) => id.startsWith("job:")));
  assert.ok(sharedStableIds.some((id) => id.startsWith("run:")));
  assert.ok(sharedStableIds.some((id) => id.startsWith("attempt:")));
  assert.ok(sharedStableIds.some((id) => id.startsWith("artifact:")));
  assert.ok(sharedStableIds.some((id) => id.startsWith("page:")));
  assert.ok(sharedStableIds.some((id) => id.startsWith("commit:")));
  assert.equal(
    new Set(sharedStableIds).size,
    sharedStableIds.length,
    "one real shared table must retain every physical entity without collisions",
  );
  const physicalRecordCount = transport.records.size;
  await projection.commitAuthorizedSnapshot(snapshot, authorization);
  assert.equal(
    transport.records.size,
    physicalRecordCount,
    "replay must not duplicate physical records",
  );
});

test("Lark marker binds every attachment token, role, and hash and replay rejects corrupted artifacts or pages", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({ transport });
  const jobId = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  )!.jobId;
  const authorization = await authorizationForSnapshot(
    projection,
    snapshot,
    jobId,
  );

  await projection.commitAuthorizedSnapshot(snapshot, authorization);

  const marker = transport.markers.get(jobId)! as LarkCommitMarker & {
    readonly attachments?: readonly {
      readonly stableId: string;
      readonly remoteRecordId: string;
      readonly fileToken: string;
      readonly role: string;
      readonly contentHash: `sha256:${string}`;
    }[];
  };
  assert.equal(marker.attachments?.length, 18);
  assert.deepEqual(
    marker.attachments?.map(({ role }) => role),
    [
      "original",
      "contact-sheet",
      ...Array.from({ length: 16 }, (_, index) => `page-${index + 1}`),
    ],
  );
  for (const role of ["original", "contact-sheet", "page-1"]) {
    const binding = marker.attachments?.find(
      (attachment) => attachment.role === role,
    );
    assert.ok(binding);
    assert.match(
      binding.stableId,
      role.startsWith("page-") ? /^page:/ : /^artifact:/,
    );
    assert.match(binding.remoteRecordId, /^rec_/);
    assert.match(binding.fileToken, /^file_/);
    assert.match(binding.contentHash, /^sha256:[a-f0-9]{64}$/);
    transport.corruptAttachmentTokens.add(binding.fileToken);
    await assert.rejects(
      projection.commitAuthorizedSnapshot(snapshot, authorization),
      new RegExp(`attachment replay hash mismatch.*${role}`, "i"),
    );
    transport.corruptAttachmentTokens.delete(binding.fileToken);
  }
});

test("a Qwen–Doubao comparison advances the Lark marker and rewrites one complete multi-report Doc collection", async () => {
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({ transport });
  const bakeoff = await createBakeoffHarness({
    feishu: projection,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const comparison = await createComparisonReportService({
    feishu: projection,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-doubao-volcano-v1",
      },
    ],
  });
  const snapshot = projection.snapshot();
  const finalAuthorization = await authorizationForSnapshot(
    projection,
    snapshot,
    bakeoff.job.jobId,
  );
  await projection.commitAuthorizedSnapshot(
    snapshot,
    finalAuthorization,
  );

  assert.equal(
    transport.markers.get(bakeoff.job.jobId)?.revision,
    2,
  );
  assert.ok(
    transport.records.has(
      `tblGaps:comparison:${comparison.comparisons[0]?.comparisonId}`,
    ),
  );
  assert.equal(transport.reports.size, 2);
  const collection = transport.reportCollectionMarkdowns.at(-1) ?? "";
  assert.equal(
    collection.match(/^# /gm)?.length,
    1,
    "the Doc collection must have exactly one H1",
  );
  for (const report of snapshot.reports) {
    assert.match(collection, new RegExp(report.reportId));
    assert.match(collection, new RegExp(report.title));
  }
  assert.match(
    collection,
    /MOCK-run-qwen-volcano-v1[\s\S]*MOCK-run-doubao-volcano-v1/,
  );
  assert.ok(
    [...transport.payloads.values()].every(
      (payload) =>
        !payload.includes(
          "/base/ppt-evaluation/artifacts/",
      ),
    ),
  );
  for (const prefix of [
    ":case:",
    ":job:",
    ":run:",
    ":artifact:",
    ":score:",
    ":comparison:",
    ":gap:",
  ]) {
    const key = [...transport.payloads.keys()].find((candidate) =>
      candidate.includes(prefix),
    );
    assert.ok(key, `missing committed core row ${prefix}`);
    const original = transport.payloads.get(key);
    transport.payloads.set(key, "{}");
    await assert.rejects(
      projection.commitAuthorizedSnapshot(snapshot, finalAuthorization),
    );
    transport.payloads.set(key, original!);
  }
});

test("three-vendor reports and Gap Cards contain no mock-feishu URI after Lark materialization", async () => {
  const source = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu: source,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  await createComparisonReportService({
    feishu: source,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: [
      {
        leftRunId: "MOCK-run-qwen-volcano-v1",
        rightRunId: "MOCK-run-doubao-volcano-v1",
      },
    ],
  });
  const staged = source.snapshot();
  assert.match(
    JSON.stringify({
      runs: staged.runRecordTable,
      reports: staged.reports,
      gaps: staged.productGapCardTable,
    }),
    /mock-feishu:/,
  );
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({ transport });
  const authorization = await authorizationForSnapshot(
    projection,
    staged,
    bakeoff.job.jobId,
  );

  await projection.commitAuthorizedSnapshot(staged, authorization);

  const materialized = projection.snapshot();
  assert.doesNotMatch(
    JSON.stringify({
      runs: materialized.runRecordTable,
      reports: materialized.reports,
      gaps: materialized.productGapCardTable,
    }),
    /mock-feishu:/,
  );
  assert.equal(materialized.reports.length, 2);
  assert.ok(materialized.productGapCardTable.length > 0);
});

test("Lark projection rejects an unrecognized mock-feishu URI before any remote mutation", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const staged = source.snapshot();
  const poisoned = {
    ...staged,
    reports: staged.reports.map((report, index) =>
      index === 0
        ? {
            ...report,
            markdown:
              `${report.markdown}\n\n` +
              "Legacy evidence: mock-feishu://legacy/untrusted",
          }
        : report,
    ),
  };
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({ transport });
  const jobId = poisoned.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  )!.jobId;
  const authorization = await authorizationForSnapshot(
    projection,
    poisoned,
    jobId,
  );

  await assert.rejects(
    projection.commitAuthorizedSnapshot(poisoned, authorization),
    /mock-feishu URI/i,
  );
  assert.deepEqual(transport.mutationOperations, []);
  assert.equal(transport.records.size, 0);
  assert.equal(transport.reportCollectionMarkdowns.length, 0);
});

test("Lark replay rejects a swapped page record share URL even when the marker batch hash still matches", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const transport = fakeTransport();
  const projection = createLarkBaseProjectionForTest({ transport });
  const jobId = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  )!.jobId;
  const authorization = await authorizationForSnapshot(
    projection,
    snapshot,
    jobId,
  );
  await projection.commitAuthorizedSnapshot(snapshot, authorization);
  const marker = transport.markers.get(jobId)!;
  transport.markers.set(jobId, {
    ...marker,
    pageEvidenceUrls: marker.pageEvidenceUrls.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            url: "https://example.feishu.cn/record/swappedRecordToken",
          }
        : entry,
    ),
  });

  await assert.rejects(
    projection.commitAuthorizedSnapshot(snapshot, authorization),
  );
});

test("Lark replay rejects a recomputed marker collection claim or a truncated Doc readback", async () => {
  const { projection, snapshot, authorization, transport } =
    await authorizedSnapshot();
  await projection.commitAuthorizedSnapshot(snapshot, authorization);
  const jobId = "job-volcano-v1";
  const marker = transport.markers.get(jobId)!;
  transport.markers.set(jobId, {
    ...marker,
    reportCollectionHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  await assert.rejects(
    projection.commitAuthorizedSnapshot(snapshot, authorization),
    /collection hash conflicts/i,
  );
  transport.markers.set(jobId, marker);
  transport.corruptReportCollectionReplay = true;
  await assert.rejects(
    projection.commitAuthorizedSnapshot(snapshot, authorization),
    /truncated Doc collection replay/i,
  );
});

test("Lark projection rechecks authorization immediately after each awaited remote write", async () => {
  const prepared = await authorizedSnapshot();
  const transport = fakeTransport();
  let now = FIXED_TIME;
  const originalUpsert = transport.upsertRecord.bind(transport);
  transport.upsertRecord = async (command) => {
    const result = await originalUpsert(command);
    now = "2020-01-01T00:00:02.000Z";
    return result;
  };
  const projection = createLarkBaseProjectionForTest({
    transport,
    clock: { clockId: "expiring-clock", now: () => now },
  });
  const authorization = {
    ...prepared.authorization,
    expiresAt: "2020-01-01T00:00:01.000Z",
  };

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      prepared.snapshot,
      authorization,
    ),
    /authorization.*expired/i,
  );
  assert.equal(transport.records.size, 1);
  assert.equal(transport.markers.size, 0);
});

test("Lark Base projection fails closed before the batch marker when attachment readback changes", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapter: new MockWpsProductAdapter(),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const transport = fakeTransport();
  transport.corruptDownloadedAttachment = true;
  const projection = createLarkBaseProjectionForTest({
    transport,
  });
  const jobId = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  )!.jobId;
  const authorization = await authorizationForSnapshot(
    projection,
    snapshot,
    jobId,
  );

  await assert.rejects(
    projection.commitAuthorizedSnapshot(snapshot, authorization),
    /attachment download hash mismatch/i,
  );
  assert.equal(transport.markers.has(jobId), false);
});

test("lark-cli 1.0.72 record-search columnar envelope is reconstructed exactly and rejects pagination or length drift", () => {
  const envelope = {
    ok: true,
    identity: "user",
    data: {
      data: [["stable-job-001", ["Doubao"]]],
      field_id_list: ["fldStable", "fldVendor"],
      fields: ["稳定ID", "厂商"],
      has_more: false,
      record_id_list: ["rec001"],
    },
  };
  assert.deepEqual(parseLarkRecordSearchEnvelope(envelope), [
    {
      record_id: "rec001",
      fields: {
        稳定ID: "stable-job-001",
        厂商: ["Doubao"],
      },
      field_ids: {
        fldStable: "stable-job-001",
        fldVendor: ["Doubao"],
      },
    },
  ]);
  assert.throws(
    () =>
      parseLarkRecordSearchEnvelope({
        ...envelope,
        data: { ...envelope.data, has_more: true },
      }),
    /paginated columnar envelope/i,
  );
  assert.throws(
    () =>
      parseLarkRecordSearchEnvelope({
        ...envelope,
        data: { ...envelope.data, record_id_list: [] },
      }),
    /columnar envelope/i,
  );
  assert.throws(
    () =>
      parseLarkRecordSearchEnvelope({
        ...envelope,
        data: { ...envelope.data, data: [["stable-job-001"]] },
      }),
    /row length/i,
  );
});

test("lark-cli record-upsert binds the exact create or update result", () => {
  assert.equal(
    parseLarkRecordUpsertEnvelope(
      {
        ok: true,
        data: {
          created: true,
          ignored_fields: [],
          record: { record_id: "recCreated" },
        },
      },
      null,
    ),
    "recCreated",
  );
  assert.equal(
    parseLarkRecordUpsertEnvelope(
      {
        ok: true,
        data: {
          updated: true,
          record: { record_id: "recExisting" },
        },
      },
      "recExisting",
    ),
    "recExisting",
  );
  assert.throws(
    () =>
      parseLarkRecordUpsertEnvelope(
        {
          ok: true,
          data: { record: { record_id: "recCreated" } },
        },
        null,
      ),
    /record-upsert/i,
  );
  assert.throws(
    () =>
      parseLarkRecordUpsertEnvelope(
        {
          ok: true,
          data: {
            created: true,
            ignored_fields: ["载荷哈希"],
            record: { record_id: "recCreated" },
          },
        },
        null,
      ),
    /record-upsert/i,
  );
  assert.throws(
    () =>
      parseLarkRecordUpsertEnvelope(
        {
          ok: true,
          data: {
            updated: true,
            record: { record_id: "recWrong" },
          },
        },
        "recExisting",
      ),
    /record-upsert/i,
  );
});

test("production record upsert fails closed on a conflicting post-write readback", async (context) => {
  const baseTokenVariable = "PPT_EVAL_UPSERT_READBACK_BASE_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basReadbackToken";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
  });
  const clock = { clockId: "upsert-readback-clock", now: () => FIXED_TIME };
  const audit = new InMemoryEgressAuthorizationAudit();
  const payload = '{"x":1}';
  const payloadHash =
    `sha256:${createHash("sha256").update(payload).digest("hex")}` as const;
  let searchCount = 0;
  const transport = createLarkCliTransportForMutationBoundaryTest({
    configuration: {
      ...LARK_TEST_CONFIGURATION,
      baseTokenEnvironmentVariable: baseTokenVariable,
    },
    egressAuthorization: allowLarkMutation,
    egressAudit: audit,
    clock,
    async run(args) {
      if (args[1] === "+record-search") {
        searchCount += 1;
        return {
          ok: true,
          data: {
            data:
              searchCount === 1
                ? []
                : [["job:readback", "{}", payloadHash]],
            field_id_list: ["fldStable", "fldPayload", "fldHash"],
            fields: ["稳定ID", "载荷", "载荷哈希"],
            has_more: false,
            record_id_list:
              searchCount === 1 ? [] : ["recReadback"],
          },
        };
      }
      if (args[1] === "+record-upsert") {
        return {
          ok: true,
          data: {
            created: true,
            record: { record_id: "recReadback" },
          },
        };
      }
      throw new Error(`Unexpected command ${args.join(" ")}`);
    },
  });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "upsert-readback-parent",
      jobId: "job-readback",
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
      contentFields: ["run_record_table"],
      payloadHash,
      requiredRedactions: [],
    },
    clock,
  );

  await assert.rejects(
    transport.upsertRecord({
      tableKey: "runs",
      stableId: "job:readback",
      payload,
      payloadHash,
      idempotencyKey: "upsert-readback",
      authorization,
    }),
    /readback.*conflicting/i,
  );
});

test("concurrent production creates converge one stable identity without leaving duplicate records", async (context) => {
  const baseTokenVariable = "PPT_EVAL_UPSERT_RACE_BASE_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  process.env[baseTokenVariable] = "basUpsertRaceToken";
  context.after(() => {
    if (previousBaseToken === undefined) {
      delete process.env[baseTokenVariable];
    } else {
      process.env[baseTokenVariable] = previousBaseToken;
    }
  });
  const clock = { clockId: "upsert-race-clock", now: () => FIXED_TIME };
  const audit = new InMemoryEgressAuthorizationAudit();
  const payload = '{"caseId":"shared-case"}';
  const payloadHash = sha256Bytes(new TextEncoder().encode(payload));
  const records = new Map<string, Record<string, unknown>>();
  let createCount = 0;
  let deleteCount = 0;
  const searchEnvelope = () => ({
    ok: true,
    data: {
      data: [...records.values()].map((fields) => [
        fields["稳定ID"],
        fields["载荷"],
        fields["载荷哈希"],
      ]),
      field_id_list: ["fldStable", "fldPayload", "fldHash"],
      fields: ["稳定ID", "载荷", "载荷哈希"],
      has_more: false,
      record_id_list: [...records.keys()],
    },
  });
  const transport = createLarkCliTransportForMutationBoundaryTest({
    configuration: {
      ...LARK_TEST_CONFIGURATION,
      baseTokenEnvironmentVariable: baseTokenVariable,
    },
    egressAuthorization: allowLarkMutation,
    egressAudit: audit,
    clock,
    async run(args) {
      const command = args[1] ?? "";
      if (command === "+record-search") {
        return searchEnvelope();
      }
      if (command === "+record-upsert") {
        const recordIdIndex = args.indexOf("--record-id");
        const isUpdate = recordIdIndex !== -1;
        if (!isUpdate) createCount += 1;
        const recordId = isUpdate
          ? args[recordIdIndex + 1]!
          : `recRace${createCount}`;
        records.set(
          recordId,
          JSON.parse(
            args[args.indexOf("--json") + 1]!,
          ) as Record<string, unknown>,
        );
        return {
          ok: true,
          data: {
            ...(isUpdate ? { updated: true } : { created: true }),
            record: { record_id: recordId },
          },
        };
      }
      if (command === "+record-delete") {
        deleteCount += 1;
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === "--record-id") {
            records.delete(args[index + 1]!);
          }
        }
        return { ok: true, data: { deleted: true } };
      }
      throw new Error(`Unexpected command ${args.join(" ")}`);
    },
  });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "upsert-race-parent",
      jobId: "job-upsert-race",
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
    stableId: "case:shared-case",
    payload,
    payloadHash,
    idempotencyKey: "case-shared-race",
    authorization,
  };

  const results = await Promise.all([
    transport.upsertRecord(command),
    transport.upsertRecord(command),
  ]);

  assert.equal(createCount, 1);
  assert.equal(deleteCount, 0);
  assert.deepEqual([...records.keys()], ["recRace1"]);
  assert.deepEqual(
    results.map(({ remoteRecordId }) => remoteRecordId),
    ["recRace1", "recRace1"],
  );
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

test("lark-cli record-share-link binds one exact record ID to the configured Feishu origin", () => {
  assert.equal(
    parseLarkRecordShareLinkEnvelope(
      {
        ok: true,
        data: {
          record_share_links: {
            recvq4ExpectedRecord:
              "https://my.feishu.cn/record/ObR2ns7KhQ9CPpUayQqLh45vY",
          },
        },
      },
      "recvq4ExpectedRecord",
      "https://my.feishu.cn",
    ),
    "https://my.feishu.cn/record/ObR2ns7KhQ9CPpUayQqLh45vY",
  );
  assert.throws(
    () =>
      parseLarkRecordShareLinkEnvelope(
        {
          ok: true,
          data: {
            record_share_links: {
              different:
                "https://my.feishu.cn/record/ObR2ns7KhQ9CPpUayQqLh45vY",
            },
          },
        },
        "recvq4ExpectedRecord",
        "https://my.feishu.cn",
      ),
    /not bound to the requested record/i,
  );
});

test("lark-cli 1.0.72 Docx fetch without a URL binds full content to the configured token and trusted origin", () => {
  const readback = parseLarkDocumentReadback(
    {
      ok: true,
      identity: "user",
      data: {
        document: {
          document_id: "LgCddKprAo7uauxbUdoczeDinxe",
          revision_id: 5,
          content: "# Harness report\n",
        },
      },
    },
    "LgCddKprAo7uauxbUdoczeDinxe",
    "https://my.feishu.cn",
  );
  assert.equal(
    readback.url,
    "https://my.feishu.cn/docx/LgCddKprAo7uauxbUdoczeDinxe",
  );
  assert.equal(readback.revisionId, 5);
  assert.equal(readback.content, "# Harness report\n");
  assert.throws(
    () =>
      parseLarkDocumentReadback(
        {
          ok: true,
          data: {
            document: {
              document_id: "differentDoc",
              revision_id: 5,
              content: "# Harness report\n",
            },
          },
        },
        "LgCddKprAo7uauxbUdoczeDinxe",
        "https://my.feishu.cn",
      ),
    /not bound to the configured document/i,
  );
});

test("the installed native lark-cli 1.0.72 and its prohibited wrapper remain byte-for-byte frozen", async () => {
  const [native, script, wrapperMetadata, wrapperTarget] = await Promise.all([
    readFile(FROZEN_LARK_CLI_BINARY),
    readFile(FROZEN_LARK_CLI_SCRIPT),
    lstat(FROZEN_LARK_CLI_WRAPPER),
    readlink(FROZEN_LARK_CLI_WRAPPER),
  ]);
  const digest = (value: Uint8Array) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}` as const;
  assert.equal(digest(native), FROZEN_LARK_CLI_SHA256);
  assert.equal(digest(script), FROZEN_LARK_CLI_SCRIPT_SHA256);
  assert.equal(wrapperMetadata.isSymbolicLink(), true);
  assert.equal(wrapperTarget, FROZEN_LARK_CLI_WRAPPER_TARGET);
  assert.doesNotThrow(() =>
    assertFrozenLarkCliInstallation({
      nativeHash: digest(native),
      nativeVersionOutput: `lark-cli version ${FROZEN_LARK_CLI_VERSION}`,
      wrapperIsSymbolicLink: wrapperMetadata.isSymbolicLink(),
      wrapperTarget,
      wrapperScriptHash: digest(script),
    }),
  );
  assert.throws(
    () =>
      assertFrozenLarkCliInstallation({
        nativeHash: digest(native),
        nativeVersionOutput: `lark-cli version ${FROZEN_LARK_CLI_VERSION}`,
        wrapperIsSymbolicLink: true,
        wrapperTarget: "../scripts/download-latest.js",
        wrapperScriptHash: digest(script),
      }),
    /wrapper.*prohibited/i,
  );
  assert.throws(
    () =>
      assertFrozenLarkCliInstallation({
        nativeHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        nativeVersionOutput: `lark-cli version ${FROZEN_LARK_CLI_VERSION}`,
        wrapperIsSymbolicLink: true,
        wrapperTarget: FROZEN_LARK_CLI_WRAPPER_TARGET,
        wrapperScriptHash: digest(script),
      }),
    /native lark-cli/i,
  );
});

test("verified Lark configuration maps seven logical record kinds onto four physical Base tables and a separate Docx report", async () => {
  const egressAudit = new InMemoryEgressAuthorizationAudit();
  const transport = await createVerifiedLarkCliTransport({
    configuration: LARK_TEST_CONFIGURATION,
    egressAuthorization: allowLarkMutation,
    egressAudit,
  });

  assert.doesNotThrow(() =>
    createHarnessOwnedLarkBaseProjection({
      transport,
      targetAccount: "test-account",
      targetRegion: "cn",
    }),
  );
  assert.throws(
    () =>
      createHarnessOwnedLarkBaseProjection({
        transport,
        targetAccount: "different-account",
        targetRegion: "cn",
      }),
    /destination.*verified transport account and region/i,
  );
  assert.throws(
    () =>
      createHarnessOwnedLarkBaseProjection({
        transport,
        targetAccount: "test-account",
        targetRegion: "global",
      }),
    /destination.*verified transport account and region/i,
  );
});

test("a delayed Lark record search that expires authorization makes zero mutation command calls", async () => {
  let now = FIXED_TIME;
  let mutationCalls = 0;
  const clock = { clockId: "search-delay-clock", now: () => now };
  const audit = new InMemoryEgressAuthorizationAudit();
  const parentAuthorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "parent-projection",
      jobId: "job-search-delay",
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
      contentFields: ["run_record_table"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
    },
    clock,
  );
  const expiringParent = {
    ...parentAuthorization,
    expiresAt: "2020-01-01T00:00:01.000Z",
  };
  const commands: string[] = [];
  const transport = createLarkCliTransportForMutationBoundaryTest({
    configuration: {
      ...LARK_TEST_CONFIGURATION,
      baseTokenEnvironmentVariable: "PATH",
    },
    egressAuthorization: allowLarkMutation,
    egressAudit: audit,
    clock,
    async run(args) {
      const command = args[1] ?? args[0] ?? "";
      commands.push(command);
      if (command === "+record-search") {
        now = "2020-01-01T00:00:02.000Z";
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
      mutationCalls += 1;
      return { ok: true, data: {} };
    },
  });

  await assert.rejects(
    transport.upsertRecord({
      tableKey: "runs",
      stableId: "job:job-search-delay",
      payload: "{}",
      payloadHash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      idempotencyKey: "record-search-delay",
      authorization: expiringParent,
    }),
    /authorization.*expired/i,
  );
  assert.deepEqual(commands, ["+record-search"]);
  assert.equal(mutationCalls, 0);
});

test("a production Job claim resumes after the Doc owner CAS succeeds but the Base claim write crashes", async (context) => {
  const baseTokenVariable = "PPT_EVAL_CLAIM_RESUME_BASE_TOKEN";
  const reportTokenVariable = "PPT_EVAL_CLAIM_RESUME_REPORT_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basClaimResumeToken";
  process.env[reportTokenVariable] = "DocTokenClaimResume";
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
  const clock = { clockId: "claim-resume-clock", now: () => FIXED_TIME };
  const audit = new InMemoryEgressAuthorizationAudit();
  let reportRevision = 0;
  let reportContent = "";
  let storedFields: Record<string, unknown> | null = null;
  let failBeforeClaimWrite = true;
  let documentUpdateCount = 0;
  const transport = createLarkCliTransportForMutationBoundaryTest({
    configuration: {
      ...LARK_TEST_CONFIGURATION,
      baseTokenEnvironmentVariable: baseTokenVariable,
      reportDocumentTokenEnvironmentVariable: reportTokenVariable,
    },
    egressAuthorization: allowLarkMutation,
    egressAudit: audit,
    clock,
    async run(args, options) {
      const service = args[0] ?? "";
      const command = args[1] ?? "";
      if (service === "docs" && command === "+fetch") {
        return {
          ok: true,
          data: {
            document: {
              document_id: "DocTokenClaimResume",
              revision_id: reportRevision,
              content: reportContent,
              url: "https://example.feishu.cn/docx/DocTokenClaimResume",
            },
          },
        };
      }
      if (service === "docs" && command === "+update") {
        documentUpdateCount += 1;
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
              url: "https://example.feishu.cn/docx/DocTokenClaimResume",
            },
          },
        };
      }
      if (service === "base" && command === "+record-search") {
        return storedFields === null
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
                  storedFields["稳定ID"],
                  storedFields["载荷"],
                  storedFields["载荷哈希"],
                ]],
                field_id_list: ["fldStable", "fldPayload", "fldHash"],
                fields: ["稳定ID", "载荷", "载荷哈希"],
                has_more: false,
                record_id_list: ["recClaimResume"],
              },
            };
      }
      if (service === "base" && command === "+record-upsert") {
        if (failBeforeClaimWrite) {
          failBeforeClaimWrite = false;
          throw new Error("simulated crash before Base claim write");
        }
        storedFields = JSON.parse(
          args[args.indexOf("--json") + 1]!,
        ) as Record<string, unknown>;
        return {
          ok: true,
          data: {
            created: true,
            record: { record_id: "recClaimResume" },
          },
        };
      }
      throw new Error(`Unexpected lark-cli command: ${service} ${command}`);
    },
  });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "claim-resume-parent",
      jobId: "job-claim-resume",
      runId: null,
      attemptId: "attempt-claim-resume",
      dataClassification: "public_or_synthetic",
      sourceOwner: "claimant-resume",
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
    jobId: "job-claim-resume",
    runIds: ["run-claim-resume"],
    claimHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
    claimantId: "claimant-resume",
    claimAttemptId: "attempt-claim-resume",
    authorization,
    claimedAt: FIXED_TIME,
  };

  await assert.rejects(
    transport.claimProductionJob!(claim),
    /simulated crash before Base claim write/,
  );
  assert.equal(
    await transport.claimProductionJob!(claim),
    "claimed",
  );
  assert.equal(documentUpdateCount, 1);
  assert.ok(storedFields);
  const storedClaim = JSON.parse(
    storedFields["载荷"] as string,
  ) as Record<string, unknown>;
  assert.equal(storedClaim.claimantId, "claimant-resume");
  assert.equal(storedClaim.claimAttemptId, "attempt-claim-resume");
  assert.equal(storedClaim.claimHash, claim.claimHash);
});

test("a production Job claim treats a lost Base mutation response as success only after exact readback", async (context) => {
  const baseTokenVariable = "PPT_EVAL_CLAIM_ACK_BASE_TOKEN";
  const reportTokenVariable = "PPT_EVAL_CLAIM_ACK_REPORT_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basClaimAckToken";
  process.env[reportTokenVariable] = "DocTokenClaimAck";
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
  const clock = { clockId: "claim-ack-clock", now: () => FIXED_TIME };
  const audit = new InMemoryEgressAuthorizationAudit();
  let reportRevision = 0;
  let reportContent = "";
  let storedFields: Record<string, unknown> | null = null;
  let documentUpdateCount = 0;
  let claimMutationCount = 0;
  const transport = createLarkCliTransportForMutationBoundaryTest({
    configuration: {
      ...LARK_TEST_CONFIGURATION,
      baseTokenEnvironmentVariable: baseTokenVariable,
      reportDocumentTokenEnvironmentVariable: reportTokenVariable,
    },
    egressAuthorization: allowLarkMutation,
    egressAudit: audit,
    clock,
    async run(args, options) {
      const service = args[0] ?? "";
      const command = args[1] ?? "";
      if (service === "docs" && command === "+fetch") {
        return {
          ok: true,
          data: {
            document: {
              document_id: "DocTokenClaimAck",
              revision_id: reportRevision,
              content: reportContent,
              url: "https://example.feishu.cn/docx/DocTokenClaimAck",
            },
          },
        };
      }
      if (service === "docs" && command === "+update") {
        documentUpdateCount += 1;
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
              url: "https://example.feishu.cn/docx/DocTokenClaimAck",
            },
          },
        };
      }
      if (service === "base" && command === "+record-search") {
        return storedFields === null
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
                  storedFields["稳定ID"],
                  storedFields["载荷"],
                  storedFields["载荷哈希"],
                ]],
                field_id_list: ["fldStable", "fldPayload", "fldHash"],
                fields: ["稳定ID", "载荷", "载荷哈希"],
                has_more: false,
                record_id_list: ["recClaimAck"],
              },
            };
      }
      if (service === "base" && command === "+record-upsert") {
        claimMutationCount += 1;
        storedFields = JSON.parse(
          args[args.indexOf("--json") + 1]!,
        ) as Record<string, unknown>;
        throw new Error("simulated lost Base mutation response");
      }
      throw new Error(`Unexpected lark-cli command: ${service} ${command}`);
    },
  });
  const authorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "claim-ack-parent",
      jobId: "job-claim-ack",
      runId: null,
      attemptId: "attempt-claim-ack",
      dataClassification: "public_or_synthetic",
      sourceOwner: "claimant-ack",
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

  assert.equal(
    await transport.claimProductionJob!({
      jobId: "job-claim-ack",
      runIds: ["run-claim-ack"],
      claimHash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      claimantId: "claimant-ack",
      claimAttemptId: "attempt-claim-ack",
      authorization,
      claimedAt: FIXED_TIME,
    }),
    "claimed",
  );
  assert.equal(claimMutationCount, 1);
  assert.equal(documentUpdateCount, 1);
});

test("concurrent production Job claims have exactly one winner", async (context) => {
  const baseTokenVariable = "PPT_EVAL_CLAIM_RACE_BASE_TOKEN";
  const reportTokenVariable = "PPT_EVAL_CLAIM_RACE_REPORT_TOKEN";
  const previousBaseToken = process.env[baseTokenVariable];
  const previousReportToken = process.env[reportTokenVariable];
  process.env[baseTokenVariable] = "basClaimRaceToken";
  process.env[reportTokenVariable] = "DocTokenClaimRace";
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
  const clock = { clockId: "claim-race-clock", now: () => FIXED_TIME };
  const audit = new InMemoryEgressAuthorizationAudit();
  let createCount = 0;
  let updateCount = 0;
  let documentUpdateCount = 0;
  let storedFields: Record<string, unknown> | null = null;
  let reportRevision = 0;
  let reportContent = "";
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
        record_id_list: ["recClaimRace"],
      },
    };
  };
  const transport = createLarkCliTransportForMutationBoundaryTest({
    configuration: {
      ...LARK_TEST_CONFIGURATION,
      baseTokenEnvironmentVariable: baseTokenVariable,
      reportDocumentTokenEnvironmentVariable: reportTokenVariable,
    },
    egressAuthorization: allowLarkMutation,
    egressAudit: audit,
    clock,
    async run(args, options) {
      const service = args[0] ?? "";
      const command = args[1] ?? "";
      if (service === "docs" && command === "+fetch") {
        return {
          ok: true,
          data: {
            document: {
              document_id: "DocTokenClaimRace",
              revision_id: reportRevision,
              content: reportContent,
              url: "https://example.feishu.cn/docx/DocTokenClaimRace",
            },
          },
        };
      }
      if (service === "docs" && command === "+update") {
        const revisionIndex = args.indexOf("--revision-id");
        assert.notEqual(revisionIndex, -1);
        const expectedRevision = Number(args[revisionIndex + 1]);
        if (expectedRevision !== reportRevision) {
          throw new Error("document revision conflict");
        }
        documentUpdateCount += 1;
        reportRevision += 1;
        const claimedRevision = reportRevision;
        assert.equal(args[args.indexOf("--content") + 1], "-");
        const claimedContent =
          typeof options?.stdin === "string"
            ? options.stdin
            : new TextDecoder().decode(options?.stdin);
        if (reportRevision === claimedRevision) {
          reportContent = claimedContent;
        }
        return {
          ok: true,
          data: {
            result: "success",
            warnings: [],
            document: {
              revision_id: claimedRevision,
              url: "https://example.feishu.cn/docx/DocTokenClaimRace",
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
        const isUpdate = args.includes("--record-id");
        if (isUpdate) {
          updateCount += 1;
        } else {
          createCount += 1;
        }
        return {
          ok: true,
          data: {
            record: { record_id: "recClaimRace" },
            ...(isUpdate ? { updated: true } : { created: true }),
          },
        };
      }
      throw new Error(`Unexpected lark-cli command: ${service} ${command}`);
    },
  });
  const parentAuthorization = await requireEgressAuthorization(
    allowLarkMutation,
    {
      requestId: "claim-race-parent",
      jobId: "job-claim-race",
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
      contentFields: ["production_job_claim"],
      payloadHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiredRedactions: [],
    },
    clock,
  );
  const claim = {
    jobId: "job-claim-race",
    runIds: ["run-claim-race"],
    claimHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
    claimantId: "test",
    claimAttemptId: "claim-race-parent",
    authorization: parentAuthorization,
    claimedAt: FIXED_TIME,
  };

  const results = await Promise.all([
    transport.claimProductionJob!(claim),
    transport.claimProductionJob!(claim),
  ]);

  assert.deepEqual(results.sort(), ["already_claimed", "claimed"]);
  assert.equal(createCount, 1);
  assert.equal(updateCount, 0);
  assert.equal(documentUpdateCount, 1);
  assert.equal(
    await transport.claimProductionJob!(claim),
    "already_claimed",
  );
  await assert.rejects(
    transport.claimProductionJob!({
      ...claim,
      jobId: "job-claim-other",
      claimHash:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }),
    /owned by another Job/i,
  );
  assert.equal(documentUpdateCount, 1);
  const reports = [
    {
      reportId: "report-claim-race",
      title: "Claim Race Report",
      markdown: "# Claim Race Report\n\nVerified.",
      payloadHash:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const,
    },
  ];
  const collectionHash = sha256Bytes(canonicalJsonBytes(reports));
  const collection = await transport.upsertReportCollection({
    jobId: claim.jobId,
    reports,
    collectionHash,
    idempotencyKey: `report:${collectionHash}`,
    authorization: parentAuthorization,
  });
  assert.equal(collection.revisionId, 2);
  assert.equal(documentUpdateCount, 2);
  await transport.verifyReportCollection({
    jobId: claim.jobId,
    reports,
    collectionHash,
    expectedUrl:
      "https://example.feishu.cn/docx/DocTokenClaimRace",
    expectedRevisionId: 2,
  });
});
