import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createHarnessOwnedLarkBaseProjection,
  createLarkBaseProjectionForTest,
  createVerifiedLarkCliTransport,
  requireEgressAuthorization,
  sha256Bytes,
  canonicalJsonBytes,
  type LarkBaseProjectionTransportPort,
} from "../src/index.ts";

const FIXED_TIME = "2020-01-01T00:00:00.000Z";

interface FakeLarkTransport extends LarkBaseProjectionTransportPort {
  readonly records: Map<string, string>;
  readonly reports: Map<string, string>;
  readonly markers: Map<
    string,
    {
      readonly batchHash: `sha256:${string}`;
      readonly reportUrls: readonly {
        readonly reportId: string;
        readonly url: string;
      }[];
    }
  >;
  readonly attachmentRoles: string[];
  corruptDownloadedAttachment: boolean;
}

function fakeTransport(): FakeLarkTransport {
  const records = new Map<string, string>();
  const reports = new Map<string, string>();
  const markers = new Map<
    string,
    {
      readonly batchHash: `sha256:${string}`;
      readonly reportUrls: readonly {
        readonly reportId: string;
        readonly url: string;
      }[];
    }
  >();
  const attachmentRoles: string[] = [];
  return {
    transportId: "test-lark-transport",
    pageEvidenceBaseUrl: "https://example.feishu.cn/base/ppt-evaluation",
    records,
    reports,
    markers,
    attachmentRoles,
    corruptDownloadedAttachment: false,
    async preflight() {},
    async upsertRecord(command) {
      records.set(
        `${command.tableKey}:${command.stableId}`,
        command.payloadHash,
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
    async upsertReport(command) {
      const url =
        `https://example.feishu.cn/docx/${encodeURIComponent(command.reportId)}`;
      reports.set(command.reportId, url);
      return {
        url,
        remoteContentHash: command.payloadHash,
      };
    },
    async readCommitMarker(command) {
      return markers.get(command.jobId) ?? null;
    },
    async commitBatch(command) {
      markers.set(command.jobId, {
        batchHash: command.batchHash,
        reportUrls: command.reportUrls,
      });
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
    ...Array.from({ length: 16 }, (_, index) => `page-${index + 1}`),
    "contact-sheet",
  ]);
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
      pageEvidenceResolverHealthUrl:
        "https://evidence.example.test/ppt-evaluation/health",
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
