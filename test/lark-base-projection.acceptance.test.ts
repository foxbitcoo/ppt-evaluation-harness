import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createHarnessOwnedLarkBaseProjection,
  createLarkReportCollectionMarkdown,
  createLarkBaseProjectionForTest,
  createComparisonReportService,
  createVerifiedLarkCliTransport,
  FROZEN_LARK_CLI_BINARY,
  FROZEN_LARK_CLI_SHA256,
  FROZEN_LARK_CLI_SCRIPT,
  FROZEN_LARK_NODE_BINARY,
  FROZEN_LARK_NODE_SHA256,
  parseLarkDocumentReadback,
  parseLarkRecordShareLinkEnvelope,
  parseLarkRecordSearchEnvelope,
  requireEgressAuthorization,
  sha256Bytes,
  canonicalJsonBytes,
  type LarkBaseProjectionTransportPort,
  type LarkCommitMarker,
} from "../src/index.ts";

const FIXED_TIME = "2020-01-01T00:00:00.000Z";

interface FakeLarkTransport extends LarkBaseProjectionTransportPort {
  readonly records: Map<string, string>;
  readonly payloads: Map<string, string>;
  readonly reports: Map<string, string>;
  readonly markers: Map<
    string,
    LarkCommitMarker
  >;
  readonly attachmentRoles: string[];
  readonly reportCollectionMarkdowns: string[];
  corruptDownloadedAttachment: boolean;
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
  const reportCollectionMarkdowns: string[] = [];
  return {
    transportId: "test-lark-transport",
    pageEvidenceBaseUrl: "https://example.feishu.cn/base/ppt-evaluation",
    records,
    payloads,
    reports,
    markers,
    attachmentRoles,
    reportCollectionMarkdowns,
    corruptDownloadedAttachment: false,
    corruptReportCollectionReplay: false,
    async preflight() {},
    async upsertRecord(command) {
      records.set(
        `${command.tableKey}:${command.stableId}`,
        command.payloadHash,
      );
      payloads.set(
        `${command.tableKey}:${command.stableId}`,
        command.payload,
      );
      return {
        remoteRecordId: `rec_${command.stableId}`,
        recordUrl:
          `https://example.feishu.cn/base/ppt-evaluation?record=${encodeURIComponent(command.stableId)}`,
      };
    },
    async uploadAttachment(command) {
      attachmentRoles.push(command.attachmentRole);
      return {
        fileToken: `file_${command.idempotencyKey}`,
        remoteHash: command.contentHash,
        attachmentUrl:
          `https://example.feishu.cn/file/${encodeURIComponent(command.idempotencyKey)}`,
      };
    },
    async downloadAttachment(command) {
      if (this.corruptDownloadedAttachment) {
        return Uint8Array.from([0, 1, 2, 3]);
      }
      return command.expectedContent;
    },
    async createRecordShareLink(command) {
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
      assert.ok(records.has(`artifacts:${command.stableId}`));
    },
    async upsertReportCollection(command) {
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
    },
    async readCommitMarker(command) {
      return markers.get(command.jobId) ?? null;
    },
    async commitBatch(command) {
      markers.set(command.jobId, structuredClone(command));
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
      .filter(([key]) => key.startsWith("runs:"))
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
      /^artifacts:.*:page:\d+$/.test(key),
    ).length,
    16,
  );
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
  await projection.commitAuthorizedSnapshot(
    snapshot,
    await authorizationForSnapshot(
      projection,
      snapshot,
      bakeoff.job.jobId,
    ),
  );

  assert.equal(
    transport.markers.get(bakeoff.job.jobId)?.revision,
    2,
  );
  assert.ok(
    transport.records.has(
      `comparisons:${comparison.comparisons[0]?.comparisonId}`,
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

test("the lark-cli script and its absolute Node runtime remain byte-for-byte frozen", async () => {
  const [entrypoint, script, node] = await Promise.all([
    readFile(FROZEN_LARK_CLI_BINARY),
    readFile(FROZEN_LARK_CLI_SCRIPT),
    readFile(FROZEN_LARK_NODE_BINARY),
  ]);
  const digest = (value: Uint8Array) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  assert.equal(digest(entrypoint), FROZEN_LARK_CLI_SHA256);
  assert.equal(digest(script), FROZEN_LARK_CLI_SHA256);
  assert.equal(digest(node), FROZEN_LARK_NODE_SHA256);
});

test("verified Lark configuration maps seven logical record kinds onto four physical Base tables and a separate Docx report", async () => {
  const transport = await createVerifiedLarkCliTransport({
    configuration: {
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
      baseWebUrl:
        "https://example.feishu.cn/base/ppt-evaluation",
      pageEvidenceBaseUrl:
        "https://evidence.example.test/ppt-evaluation",
      reportDocumentExpectedOrigin: "https://example.feishu.cn",
      targetAccount: "test-account",
      targetRegion: "cn",
    },
  });

  assert.doesNotThrow(() =>
    createHarnessOwnedLarkBaseProjection({
      transport,
      targetAccount: "test-account",
      targetRegion: "cn",
    }),
  );
});
