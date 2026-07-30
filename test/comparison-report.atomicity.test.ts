import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  InMemoryEgressAuthorizationAudit,
  InMemoryFeishuProjection,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  createComparisonReportService,
  createHarnessOwnedLarkBaseProjection,
  createLarkReportCollectionMarkdown,
  createVerifiedLarkCliTransport,
  type EgressAuthorizationAuditPort,
  type EgressAuthorizationPort,
  type FeishuProjectionPort,
  type FeishuProjectionSnapshot,
  type LarkBaseProjectionTransportPort,
} from "../src/index.ts";

function sha256(
  value: string | Uint8Array,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const LARK_TEST_CONFIGURATION = {
  baseTokenEnvironmentVariable: "PPT_EVAL_ATOMICITY_TEST_BASE_TOKEN",
  reportDocumentTokenEnvironmentVariable:
    "PPT_EVAL_ATOMICITY_TEST_REPORT_DOC_TOKEN",
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

let verifiedTransportPromise:
  | Promise<LarkBaseProjectionTransportPort>
  | undefined;

function verifiedTransport(): Promise<LarkBaseProjectionTransportPort> {
  verifiedTransportPromise ??= createVerifiedLarkCliTransport({
    configuration: LARK_TEST_CONFIGURATION,
    egressAuthorization: allowLarkMutation,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
  });
  return verifiedTransportPromise;
}

function productionize<T>(value: T): T {
  if (
    typeof value === "string" &&
    value.includes("mock-feishu://")
  ) {
    return value.replace(
      /mock-feishu:\/\/[^)\s"'<>]+/g,
      (url) => {
        const stableId = url
          .slice("mock-feishu://".length)
          .replace(/[^a-zA-Z0-9_-]/g, "-");
        return url.startsWith("mock-feishu://documents/")
          ? `https://example.feishu.cn/docx/${stableId}`
          : `https://evidence.example.test/materialized/${stableId}`;
      },
    ) as T;
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => productionize(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "environmentOrigin"
          ? PRODUCTION_ENVIRONMENT_ORIGIN
          : key === "provenance" && entry === "MOCK"
            ? "PRODUCTION"
            : productionize(entry),
      ]),
    ) as T;
  }
  return value;
}

async function threeVendorProductionSeed(): Promise<FeishuProjectionSnapshot> {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
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
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const seed = productionize(source.snapshot());
  const safelyMaterializedSeed: FeishuProjectionSnapshot = {
    ...seed,
    capturedArtifactTable: seed.capturedArtifactTable.map(
      (record) => ({
        ...record,
        renderManifest: {
          ...record.renderManifest,
          slides: record.renderManifest.slides.map((slide) => ({
            ...slide,
            filename: slide.filename.replace(/\.svg$/i, ".png"),
            mimeType: "image/png",
            content: png,
            contentHash: sha256(png),
          })),
        },
      }),
    ),
  };
  assert.doesNotMatch(
    JSON.stringify(safelyMaterializedSeed),
    /mock-feishu:/,
    "production failure-path fixtures must already contain only safely materialized URLs",
  );
  return safelyMaterializedSeed;
}

async function replayComparisonSource(
  projection: FeishuProjectionPort,
  snapshot: FeishuProjectionSnapshot,
): Promise<void> {
  for (const record of snapshot.caseTable) {
    await projection.upsertCase(record);
  }
  for (const record of snapshot.runRecordTable) {
    await projection.appendRunRecord(record);
  }
  for (const record of snapshot.capturedArtifactTable) {
    await projection.appendCapturedArtifact(record);
  }
  for (const record of snapshot.artifactScoreTable) {
    await projection.appendArtifactScore(record);
  }
}

async function seededProductionProjection(
  transport?: LarkBaseProjectionTransportPort,
): Promise<FeishuProjectionPort> {
  const projection = createHarnessOwnedLarkBaseProjection({
    transport: transport ?? (await verifiedTransport()),
    targetAccount: "test-account",
    targetRegion: "cn",
  });
  await replayComparisonSource(
    projection,
    await threeVendorProductionSeed(),
  );
  return projection;
}

const dynamicPair = [
  {
    leftRunId: "MOCK-run-qwen-volcano-v1",
    rightRunId: "MOCK-run-doubao-volcano-v1",
  },
] as const;

test("production dynamic comparison without persistence authorization leaves the local projection unchanged", async () => {
  const projection = await seededProductionProjection();
  const before = projection.snapshot();

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
    }).createReport({
      jobId: "MOCK-job-volcano-v1",
      pairs: dynamicPair,
    }),
    /requires authorized Lark persistence/i,
  );

  assert.deepEqual(projection.snapshot(), before);
});

test("denied production dynamic-comparison persistence leaves the local projection unchanged", async () => {
  const projection = await seededProductionProjection();
  const before = projection.snapshot();
  const denyLarkPersistence = {
    async authorize(request) {
      return {
        status: "denied" as const,
        decisionId: `denied:${request.requestId}`,
        policyVersion: "test-policy-v1",
        request,
        reason: "test denied Lark persistence",
        decidedAt: request.requestedAt,
      };
    },
  } satisfies EgressAuthorizationPort;

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
      egressAuthorization: denyLarkPersistence,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
    }).createReport({
      jobId: "MOCK-job-volcano-v1",
      pairs: dynamicPair,
    }),
    /authorization denied/i,
  );

  assert.deepEqual(projection.snapshot(), before);
});

test("a failed production persistence audit leaves the dynamic-comparison projection unchanged", async () => {
  const projection = await seededProductionProjection();
  const before = projection.snapshot();
  const failingAudit = {
    auditId: "test-failing-audit",
    async append() {
      throw new Error("simulated durable audit failure");
    },
    async assertRecorded() {
      throw new Error("simulated durable audit failure");
    },
  } satisfies EgressAuthorizationAuditPort;

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
      egressAuthorization: allowLarkMutation,
      egressAudit: failingAudit,
    }).createReport({
      jobId: "MOCK-job-volcano-v1",
      pairs: dynamicPair,
    }),
    /simulated durable audit failure/i,
  );

  assert.deepEqual(projection.snapshot(), before);
});

test("a remote Lark commit failure leaves the production dynamic-comparison projection unchanged", async () => {
  const transport = await createVerifiedLarkCliTransport({
    configuration: LARK_TEST_CONFIGURATION,
    egressAuthorization: allowLarkMutation,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
  });
  const records = new Map<
    string,
    { readonly payload: string; readonly payloadHash: string }
  >();
  const attachments = new Map<string, Uint8Array>();
  let reportReadback:
    | {
        readonly jobId: string;
        readonly reports: readonly {
          readonly reportId: string;
          readonly title: string;
          readonly markdown: string;
          readonly payloadHash: `sha256:${string}`;
        }[];
        readonly collectionHash: `sha256:${string}`;
        readonly url: string;
        readonly revisionId: number;
      }
    | undefined;
  let commitAttempts = 0;
  transport.preflight = async () => {};
  transport.readCommitMarker = async () => null;
  transport.upsertRecord = async (command) => {
    const key = `${command.tableKey}:${command.stableId}`;
    records.set(key, {
      payload: command.payload,
      payloadHash: command.payloadHash,
    });
    return {
      remoteRecordId: key,
      recordUrl:
        `https://example.feishu.cn/base/ppt-evaluation/${encodeURIComponent(key)}`,
    };
  };
  transport.verifyRecord = async (command) => {
    assert.deepEqual(
      records.get(`${command.tableKey}:${command.stableId}`),
      {
        payload: command.payload,
        payloadHash: command.payloadHash,
      },
    );
  };
  transport.uploadAttachment = async (command) => {
    const fileToken =
      `file-${createHash("sha256")
        .update(command.stableId)
        .update(command.attachmentRole)
        .digest("hex")}`;
    attachments.set(fileToken, Uint8Array.from(command.content));
    return {
      fileToken,
      remoteHash: command.contentHash,
      attachmentUrl:
        `https://example.feishu.cn/drive/${fileToken}`,
    };
  };
  transport.downloadAttachment = async (command) => {
    const content = attachments.get(command.fileToken);
    assert.ok(content, `missing fake remote attachment ${command.fileToken}`);
    return Uint8Array.from(content);
  };
  transport.createRecordShareLink = async (command) =>
    `https://evidence.example.test/records/${encodeURIComponent(command.remoteRecordId)}`;
  transport.verifyPageEvidence = async (command) => {
    assert.equal(sha256(command.content), command.contentHash);
    assert.match(command.expectedUrl, /^https:\/\//);
  };
  transport.upsertReportCollection = async (command) => {
    const url =
      `https://example.feishu.cn/docx/${encodeURIComponent(command.jobId)}`;
    reportReadback = {
      jobId: command.jobId,
      reports: command.reports,
      collectionHash: command.collectionHash,
      url,
      revisionId: 1,
    };
    return {
      url,
      remoteContentHash: sha256(
        createLarkReportCollectionMarkdown({
          jobId: command.jobId,
          reports: command.reports,
          collectionHash: command.collectionHash,
        }),
      ),
      revisionId: 1,
    };
  };
  transport.verifyReportCollection = async (command) => {
    assert.deepEqual(reportReadback, {
      jobId: command.jobId,
      reports: command.reports,
      collectionHash: command.collectionHash,
      url: command.expectedUrl,
      revisionId: command.expectedRevisionId,
    });
  };
  transport.commitBatch = async () => {
    commitAttempts += 1;
    throw new Error("simulated remote Lark commit failure");
  };
  const projection = await seededProductionProjection(transport);
  const before = projection.snapshot();

  await assert.rejects(
    createComparisonReportService({
      feishu: projection,
      egressAuthorization: allowLarkMutation,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
    }).createReport({
      jobId: "MOCK-job-volcano-v1",
      pairs: dynamicPair,
    }),
    /simulated remote Lark commit failure/i,
  );

  assert.equal(
    commitAttempts,
    1,
    "the fixture must pass materialization and readback before failing at commitBatch",
  );
  assert.deepEqual(projection.snapshot(), before);
});
