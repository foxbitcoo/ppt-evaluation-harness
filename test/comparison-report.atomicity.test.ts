import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  InMemoryEgressAuthorizationAudit,
  InMemoryFeishuProjection,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  ProjectionStaleBaselineError,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  VOLCANO_CASE_ID,
  calculateRenderManifestHash,
  canonicalJsonBytes,
  createBakeoffHarness,
  createComparisonReportService,
  createHarnessOwnedLarkBaseProjection,
  createLarkReportCollectionMarkdown,
  createVerifiedLarkCliTransport,
  expectedComparisonCompatibilityFingerprint,
  REVIEWED_LARK_MACHINE_LOCK_ROOT,
  requireEgressAuthorization,
  sha256Bytes,
  type AdjudicationEventRecord,
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

function materializeHttpsReportUrls(
  snapshot: FeishuProjectionSnapshot,
): FeishuProjectionSnapshot {
  const reportUrls = new Map(
    snapshot.reports.map((report) => [
      report.url,
      `https://example.test/docx/${report.reportId}`,
    ]),
  );
  return {
    ...snapshot,
    runRecordTable: snapshot.runRecordTable.map((record) => ({
      ...record,
      reportUrl:
        record.reportUrl === null
          ? null
          : (reportUrls.get(record.reportUrl) ?? record.reportUrl),
      auxiliaryReportUrls:
        record.auxiliaryReportUrls === null
          ? null
          : record.auxiliaryReportUrls.map(
              (url) => reportUrls.get(url) ?? url,
            ),
    })),
    reports: snapshot.reports.map((report) => ({
      ...report,
      url: reportUrls.get(report.url)!,
    })),
  };
}

class HttpsMaterializingProjection extends InMemoryFeishuProjection {
  protected override async materializeAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
  ): Promise<FeishuProjectionSnapshot> {
    return materializeHttpsReportUrls(snapshot);
  }
}

class ObservedMaterializingProjection extends
  HttpsMaterializingProjection {
  materializationCalls = 0;

  protected override async materializeAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
  ): Promise<FeishuProjectionSnapshot> {
    this.materializationCalls += 1;
    return super.materializeAuthorizedSnapshot(snapshot);
  }
}

class CrossWiredReportMaterializingProjection extends
  HttpsMaterializingProjection {
  #crossWireNextMaterialization = false;

  crossWireNextMaterialization(): void {
    this.#crossWireNextMaterialization = true;
  }

  protected override async materializeAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
  ): Promise<FeishuProjectionSnapshot> {
    const materialized =
      await super.materializeAuthorizedSnapshot(snapshot);
    if (!this.#crossWireNextMaterialization) {
      return materialized;
    }
    this.#crossWireNextMaterialization = false;
    return {
      ...materialized,
      runRecordTable: materialized.runRecordTable.map((record) =>
        record.recordType === "bakeoff_job" &&
        record.reportUrl !== null
          ? {
              ...record,
              reportUrl:
                "https://example.test/docx/cross-wired-report",
            }
          : record,
      ),
    };
  }
}

class ResponseLossAfterMaterializationProjection extends
  HttpsMaterializingProjection {
  #loseNextResponse = false;

  loseNextResponse(): void {
    this.#loseNextResponse = true;
  }

  protected override async materializeAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
  ): Promise<FeishuProjectionSnapshot> {
    const materialized =
      await super.materializeAuthorizedSnapshot(snapshot);
    if (this.#loseNextResponse) {
      this.#loseNextResponse = false;
      throw new Error("simulated response loss after remote commit");
    }
    return materialized;
  }
}

async function authorizeSnapshot(
  projection: FeishuProjectionPort,
  snapshot: FeishuProjectionSnapshot,
): Promise<Awaited<ReturnType<typeof requireEgressAuthorization>>> {
  const job = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const evaluationCase = snapshot.caseTable[0];
  assert.ok(job);
  assert.ok(evaluationCase);
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  return requireEgressAuthorization(
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
  );
}

const LARK_TEST_CONFIGURATION = {
  concurrencyBoundary: "single_workstation_durable_mutex",
  lockRootPath: REVIEWED_LARK_MACHINE_LOCK_ROOT,
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
  cliIdentityBinding: {
    profile: "test-profile",
    appId: "test-app",
    brand: "feishu",
    defaultAs: "auto",
    identitySource: "auto_detect",
    userOpenId: "test-account",
    tenantKey: "test-tenant",
  },
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
  const capturedArtifactTable = seed.capturedArtifactTable.map(
    (record) => {
      const rendered = {
        ...record.renderManifest,
        slides: record.renderManifest.slides.map((slide) => ({
          ...slide,
          filename: slide.filename.replace(/\.svg$/i, ".png"),
          mimeType: "image/png" as const,
          content: png,
          contentHash: sha256(png),
        })),
      };
      const {
        contentHash: _previousRenderManifestHash,
        ...renderManifestHashInput
      } = rendered;
      return {
        ...record,
        renderManifest: {
          ...rendered,
          contentHash: calculateRenderManifestHash(
            record.artifact.contentHash,
            renderManifestHashInput,
          ),
        },
      };
    },
  );
  const capturesByArtifactId = new Map(
    capturedArtifactTable.map((record) => [
      record.artifactId,
      record,
    ]),
  );
  const evaluationCase = seed.caseTable[0];
  const job = seed.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const protocolSnapshot = job?.protocolSnapshot;
  assert.ok(evaluationCase);
  assert.ok(protocolSnapshot);
  const artifactScoreTable = seed.artifactScoreTable.map((record) => {
    const capture = capturesByArtifactId.get(record.artifactId);
    assert.ok(capture);
    const scorecard = {
      ...record.scorecard,
      evaluationInputManifest: {
        ...record.scorecard.evaluationInputManifest,
        artifactHash: capture.artifact.contentHash,
        renderManifestHash: capture.renderManifest.contentHash,
        renderer: capture.renderManifest.renderer,
      },
    };
    return {
      ...record,
      artifact: capture.artifact,
      renderManifest: capture.renderManifest,
      scorecard,
      comparisonCompatibilityFingerprint:
        expectedComparisonCompatibilityFingerprint(
          scorecard,
          protocolSnapshot,
          evaluationCase,
          capture.renderManifest,
        ),
    };
  });
  const safelyMaterializedSeed: FeishuProjectionSnapshot = {
    ...seed,
    runRecordTable: seed.runRecordTable.map((record) =>
      record.recordType === "bakeoff_job"
        ? {
            ...record,
            reportUrl: null,
            auxiliaryReportUrls: null,
          }
        : record,
    ),
    capturedArtifactTable,
    artifactScoreTable,
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

test("authorized snapshot validation rejects cross-table lineage before materialization", async () => {
  const projection = new ObservedMaterializingProjection();
  await createBakeoffHarness({
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
  const snapshot = projection.snapshot();
  const comparisonIndex = snapshot.productGapCardTable.findIndex(
    (record) => record.recordType === "comparison",
  );
  const comparison = snapshot.productGapCardTable[comparisonIndex];
  assert.ok(comparison?.recordType === "comparison");
  const invalidSnapshot: FeishuProjectionSnapshot = {
    ...snapshot,
    productGapCardTable: snapshot.productGapCardTable.map(
      (record, index) =>
        index !== comparisonIndex
          ? record
          : {
              ...comparison,
              leftRunId: comparison.rightRunId,
              leftScorecardId: comparison.rightScorecardId,
            },
    ),
  };
  const materializationCallsBeforeInvalidCommit =
    projection.materializationCalls;

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      invalidSnapshot,
      await authorizeSnapshot(projection, invalidSnapshot),
    ),
    /Comparison.*lineage|distinct Runs|Scorecard/i,
  );
  assert.equal(
    projection.materializationCalls,
    materializationCallsBeforeInvalidCommit,
  );
});

test("authorized snapshot validation rejects an incomplete or cross-wired completed Run graph before materialization", async () => {
  const projection = new ObservedMaterializingProjection();
  await createBakeoffHarness({
    feishu: projection,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = projection.snapshot();
  const invalidSnapshot: FeishuProjectionSnapshot = {
    ...snapshot,
    runRecordTable: snapshot.runRecordTable.map((record) =>
      record.recordType === "bakeoff_job"
        ? {
            ...record,
            reportUrl: null,
            auxiliaryReportUrls: null,
          }
        : record,
    ),
    capturedArtifactTable: [],
    artifactScoreTable: [],
    adjudicationEventTable: [],
    reviewEventTable: [],
    gapCardWorkflowEventTable: [],
    githubIssueDeliveryReservationTable: [],
    githubIssueLinkEventTable: [],
    productGapCardTable: [],
    reports: [],
  };
  const materializationCallsBeforeInvalidCommit =
    projection.materializationCalls;

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      invalidSnapshot,
      await authorizeSnapshot(projection, invalidSnapshot),
    ),
    /Run graph|selected Run|parent|Captured Artifact|closure/i,
  );
  assert.equal(
    projection.materializationCalls,
    materializationCallsBeforeInvalidCommit,
  );
});

test("authorized snapshot validation rejects invalid Attempt sequences and Observable Event parent bindings before materialization", async (t) => {
  const variants = [
    {
      name: "duplicate Attempt sequence",
      mutate(record) {
        return {
          ...record,
          attemptSeq: 1,
          observableEvents: record.observableEvents?.map((event) => ({
            ...event,
            attemptSeq: 1,
          })) ?? null,
        };
      },
    },
    {
      name: "non-contiguous Attempt sequence",
      mutate(record) {
        return {
          ...record,
          attemptSeq: 3,
          observableEvents: record.observableEvents?.map((event) => ({
            ...event,
            attemptSeq: 3,
          })) ?? null,
        };
      },
    },
    {
      name: "Observable Event sequence",
      mutate(record) {
        return {
          ...record,
          observableEvents: record.observableEvents?.map(
            (event, index) =>
              index === 0
                ? { ...event, attemptSeq: 1 }
                : event,
          ) ?? null,
        };
      },
    },
    {
      name: "Observable Event Run parent",
      mutate(record) {
        return {
          ...record,
          observableEvents: record.observableEvents?.map(
            (event, index) =>
              index === 0
                ? { ...event, runId: "foreign-run" }
                : event,
          ) ?? null,
        };
      },
    },
    {
      name: "Observable Event Attempt parent",
      mutate(record) {
        return {
          ...record,
          observableEvents: record.observableEvents?.map(
            (event, index) =>
              index === 0
                ? { ...event, attemptId: "foreign-attempt" }
                : event,
          ) ?? null,
        };
      },
    },
  ] satisfies readonly {
    readonly name: string;
    readonly mutate: (
      record: FeishuProjectionSnapshot["runRecordTable"][number],
    ) => FeishuProjectionSnapshot["runRecordTable"][number];
  }[];

  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const projection = new ObservedMaterializingProjection();
      await createBakeoffHarness({
        feishu: projection,
        productAdapters: [
          new MockQwenProductAdapter({
            scenario: "retry_then_success",
          }),
        ],
      }).startBakeoffJob({
        environment: "test",
        caseId: VOLCANO_CASE_ID,
      });
      const snapshot = projection.snapshot();
      const attempts = snapshot.runRecordTable.filter(
        ({ recordType }) =>
          recordType === "evaluation_attempt",
      );
      assert.deepEqual(
        attempts.map(({ attemptSeq }) => attemptSeq),
        [1, 2],
      );
      const secondAttempt = attempts[1];
      assert.ok(secondAttempt?.observableEvents?.[0]);
      const invalidSnapshot: FeishuProjectionSnapshot = {
        ...snapshot,
        runRecordTable: snapshot.runRecordTable.map((record) =>
          record.recordId === secondAttempt.recordId
            ? variant.mutate(record)
            : record,
        ),
      };
      const materializationCallsBeforeInvalidCommit =
        projection.materializationCalls;

      await assert.rejects(
        projection.commitAuthorizedSnapshot(
          invalidSnapshot,
          await authorizeSnapshot(projection, invalidSnapshot),
        ),
        /Evaluation Attempt|Attempt sequence|Observable Event|Run graph|parent/i,
      );
      assert.equal(
        projection.materializationCalls,
        materializationCallsBeforeInvalidCommit,
      );
    });
  }
});

test("authorized snapshot replay rejects an internally inconsistent Render Manifest before materialization", async () => {
  const projection = new ObservedMaterializingProjection();
  await createBakeoffHarness({
    feishu: projection,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = projection.snapshot();
  const capture = snapshot.capturedArtifactTable[0];
  assert.ok(capture);
  const invalidRenderManifest = {
    ...capture.renderManifest,
    pageCount: capture.renderManifest.pageCount - 1,
    slides: capture.renderManifest.slides.slice(0, -1),
  };
  const invalidSnapshot: FeishuProjectionSnapshot = {
    ...snapshot,
    capturedArtifactTable: snapshot.capturedArtifactTable.map(
      (record) => ({
        ...record,
        renderManifest: invalidRenderManifest,
      }),
    ),
    artifactScoreTable: snapshot.artifactScoreTable.map(
      (record) => ({
        ...record,
        renderManifest: invalidRenderManifest,
      }),
    ),
  };
  const materializationCallsBeforeInvalidCommit =
    projection.materializationCalls;

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      invalidSnapshot,
      await authorizeSnapshot(projection, invalidSnapshot),
    ),
    /Render Manifest.*page|page inventory|content hash/i,
  );
  assert.equal(
    projection.materializationCalls,
    materializationCallsBeforeInvalidCommit,
  );
});

test("authorized snapshot replay rejects invalid adjudication human-final fields before materialization", async () => {
  const projection = new ObservedMaterializingProjection();
  await createBakeoffHarness({
    feishu: projection,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = projection.snapshot();
  const score = snapshot.artifactScoreTable[0];
  const dimension = score?.scorecard.dimensions.find(
    ({ assessmentStatus }) =>
      assessmentStatus === "ASSESSED",
  );
  assert.ok(score);
  assert.ok(dimension);
  assert.notEqual(dimension.value, null);
  const invalidEvent = {
    recordType: "adjudication_event",
    schemaVersion: "adjudication-event-v1",
    adjudicationEventId: "adj-invalid-snapshot-replay",
    scorecardId: score.scorecard.scorecardId,
    artifactId: score.artifactId,
    runId: score.runId,
    jobId: score.jobId,
    dimension: dimension.dimension,
    modelOriginalAssessmentStatus:
      dimension.assessmentStatus,
    modelOriginalScore: dimension.value,
    humanFinalAssessmentStatus: "NOT_ASSESSABLE",
    humanFinalScore: 99,
    evidencePages: dimension.evidencePages,
    actorId: "",
    occurredAt: "not-a-date",
    createdAt: "not-a-date",
    lastSyncedAt: "not-a-date",
    reason: "",
    priorAdjudicationEventId: null,
    provenance: score.provenance,
    environmentOrigin: score.environmentOrigin,
  } as unknown as AdjudicationEventRecord;
  const invalidSnapshot: FeishuProjectionSnapshot = {
    ...snapshot,
    adjudicationEventTable: [invalidEvent],
  };
  const materializationCallsBeforeInvalidCommit =
    projection.materializationCalls;

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      invalidSnapshot,
      await authorizeSnapshot(projection, invalidSnapshot),
    ),
    /Adjudication Event.*invalid|human.*score|actor|timestamp/i,
  );
  assert.equal(
    projection.materializationCalls,
    materializationCallsBeforeInvalidCommit,
  );
});

test("authorized snapshot validation rejects materialized report-link drift", async () => {
  const projection =
    new CrossWiredReportMaterializingProjection();
  await createBakeoffHarness({
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
  const snapshot = projection.snapshot();
  projection.crossWireNextMaterialization();

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      snapshot,
      await authorizeSnapshot(projection, snapshot),
    ),
    /Report ownership does not match Bakeoff Job/i,
  );
});

test("a successful materialized commit converges local Job report links and reports to the committed HTTPS snapshot", async () => {
  const projection = new HttpsMaterializingProjection();
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
  const dynamic = await createComparisonReportService({
    feishu: projection,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: dynamicPair,
  });
  const staged = projection.snapshot();

  await projection.commitAuthorizedSnapshot(
    staged,
    await authorizeSnapshot(projection, staged),
  );

  const committed = projection.snapshot();
  const expectedUrl =
    `https://example.test/docx/${dynamic.report.reportId}`;
  const job = committed.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  assert.deepEqual(job?.auxiliaryReportUrls, [expectedUrl]);
  assert.equal(
    committed.reports.find(
      ({ reportId }) => reportId === dynamic.report.reportId,
    )?.url,
    expectedUrl,
  );
});

test("the same dynamic pair is idempotent after its first report was materialized", async () => {
  const projection = new HttpsMaterializingProjection();
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
  const service = createComparisonReportService({
    feishu: projection,
  });
  const first = await service.createReport({
    jobId: bakeoff.job.jobId,
    pairs: dynamicPair,
  });
  const staged = projection.snapshot();
  await projection.commitAuthorizedSnapshot(
    staged,
    await authorizeSnapshot(projection, staged),
  );

  const replay = await service.createReport({
    jobId: bakeoff.job.jobId,
    pairs: dynamicPair,
  });

  assert.equal(replay.report.reportId, first.report.reportId);
  assert.equal(
    replay.report.url,
    `https://example.test/docx/${first.report.reportId}`,
  );
  assert.equal(
    projection.snapshot().reports.filter(
      ({ reportId }) => reportId === first.report.reportId,
    ).length,
    1,
  );
});

test("a response-loss retry converges the local projection and preserves dynamic-pair idempotency", async () => {
  const projection =
    new ResponseLossAfterMaterializationProjection();
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
  const service = createComparisonReportService({
    feishu: projection,
  });
  const first = await service.createReport({
    jobId: bakeoff.job.jobId,
    pairs: dynamicPair,
  });
  const staged = projection.snapshot();
  projection.loseNextResponse();

  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      staged,
      await authorizeSnapshot(projection, staged),
    ),
    /simulated response loss after remote commit/i,
  );
  await projection.commitAuthorizedSnapshot(
    staged,
    await authorizeSnapshot(projection, staged),
  );
  const replay = await service.createReport({
    jobId: bakeoff.job.jobId,
    pairs: dynamicPair,
  });

  const expectedUrl =
    `https://example.test/docx/${first.report.reportId}`;
  assert.equal(replay.report.url, expectedUrl);
  assert.deepEqual(
    projection.snapshot().runRecordTable.find(
      ({ recordType }) => recordType === "bakeoff_job",
    )?.auxiliaryReportUrls,
    [expectedUrl],
  );
  assert.equal(
    projection.snapshot().reports.filter(
      ({ reportId }) => reportId === first.report.reportId,
    ).length,
    1,
  );
});

test("two dynamic reports staged from one baseline cannot overwrite each other and converge after a stale retry", async () => {
  const projection = new HttpsMaterializingProjection();
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
  const baseline = await projection.captureCommitBaseline(
    bakeoff.job.jobId,
  );
  const stage = async (
    pairs: NonNullable<Parameters<
      ReturnType<typeof createComparisonReportService>["createReport"]
    >[0]["pairs"]>,
  ) => {
    const staged = projection.forkForStaging(
      baseline.localSnapshot,
    );
    const outcome = await createComparisonReportService({
      feishu: staged,
    }).createReport({
      jobId: bakeoff.job.jobId,
      pairs,
    });
    return { staged, outcome };
  };
  const first = await stage(dynamicPair);
  const reversePair = [
    {
      leftRunId: "MOCK-run-doubao-volcano-v1",
      rightRunId: "MOCK-run-qwen-volcano-v1",
    },
  ] as const;
  const second = await stage(reversePair);

  await projection.commitAuthorizedSnapshot(
    first.staged.snapshot(),
    await authorizeSnapshot(projection, first.staged.snapshot()),
    baseline,
  );
  await assert.rejects(
    projection.commitAuthorizedSnapshot(
      second.staged.snapshot(),
      await authorizeSnapshot(projection, second.staged.snapshot()),
      baseline,
    ),
    ProjectionStaleBaselineError,
  );

  const retryBaseline = await projection.captureCommitBaseline(
    bakeoff.job.jobId,
  );
  const retry = projection.forkForStaging(
    retryBaseline.localSnapshot,
  );
  const retried = await createComparisonReportService({
    feishu: retry,
  }).createReport({
    jobId: bakeoff.job.jobId,
    pairs: reversePair,
  });
  await projection.commitAuthorizedSnapshot(
    retry.snapshot(),
    await authorizeSnapshot(projection, retry.snapshot()),
    retryBaseline,
  );

  const job = projection.snapshot().runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  assert.deepEqual(
    new Set(job?.auxiliaryReportUrls),
    new Set([
      `https://example.test/docx/${first.outcome.report.reportId}`,
    ]),
  );
  assert.equal(
    retried.report.reportId,
    first.outcome.report.reportId,
  );
  assert.equal(projection.snapshot().reports.length, 2);
});

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
  transport.acquireProjectionMutex = async () => async () => {};
  transport.withProjectionMutex = async (_jobId, operation) =>
    await operation();
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
