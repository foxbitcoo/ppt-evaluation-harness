import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  InMemoryImmutableBlobStore,
  InMemoryArtifactCaptureJournal,
  InMemoryEgressAuthorizationAudit,
  InMemoryPayloadInventory,
  InMemoryFeishuProjection,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createArtifactVault,
  createBakeoffHarness,
  createOperationalLedgerRecoveryService,
  createRetentionService,
  createRunSpecificationVault,
  createScoreAdjudicationService,
  InMemoryTombstoneLedger,
  calculateRenderManifestHash,
  canonicalJsonBytes,
  requireEgressAuthorization,
  sha256Bytes,
  type Artifact,
  type ArtifactCaptureJournalPort,
  type ClockPort,
  type EgressAuthorizationPort,
  type ImmutableBlobStorePort,
  type ProductAdapterPort,
  type RenderManifest,
  type RunSpecificationVault,
} from "../src/index.ts";
import { MOCK_TEST_ENVIRONMENT_ORIGIN } from "../src/environment-origin.ts";

const ARTIFACT_HASH =
  "sha256:05d3ad960c2733cbfeb3a749aafd6319aee9b4916fdc1ddc4721bec2f4c4d751" as const;
const SLIDE_ONE_HASH =
  "sha256:075e01a05f36bb47b630b52d017d005d72cb915e2d1d963fbf57734dd2f0e8db" as const;
const SLIDE_TWO_HASH =
  "sha256:0edf8dea78580a0df727bbf05de75966aad17c72af28348db5f6666a462cc88a" as const;

const APPROVED_EGRESS: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `decision:${request.requestId}`,
      policyVersion: "test-egress-policy-v1",
      request,
      legalSecurityBasis: "synthetic test fixture",
      approvedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
  },
};

test("egress authorization evaluates expiry against an injected call-boundary clock and binds the exact payload hash", async () => {
  const observedRequests: unknown[] = [];
  const clockValues = [
    "2026-07-27T00:00:00.000Z",
    "2026-07-27T00:00:02.000Z",
  ];
  const clock: ClockPort = {
    now() {
      return clockValues.shift() ?? "2026-07-27T00:00:02.000Z";
    },
  };
  const authorization: EgressAuthorizationPort = {
    async authorize(request) {
      observedRequests.push(request);
      return {
        status: "approved",
        decisionId: "decision:expires-between-checks",
        policyVersion: "test-egress-policy-v1",
        request,
        legalSecurityBasis: "synthetic test fixture",
        approvedAt: "2026-07-27T00:00:00.000Z",
        expiresAt: "2026-07-27T00:00:01.000Z",
      };
    },
  };

  await assert.rejects(
    requireEgressAuthorization(
      authorization,
      {
        requestId: "egress-clock-001",
        jobId: "job-stable-001",
        runId: "run-stable-001",
        attemptId: null,
        dataClassification: "public_or_synthetic",
        sourceOwner: "evaluation-owner",
        processingPurpose: "artifact_rendering",
        targetKind: "renderer",
        targetService: "renderer-service",
        targetAccount: "renderer-account",
        targetRegion: "cn",
        subprocessors: ["renderer-subprocessor"],
        contentFields: ["artifact_binary"],
        payloadHash: ARTIFACT_HASH,
        requiredRedactions: [],
      },
      clock,
    ),
    /expired.*artifact_rendering.*blocked/i,
  );
  assert.deepEqual(observedRequests, [
    {
      requestId: "egress-clock-001",
      jobId: "job-stable-001",
      runId: "run-stable-001",
      attemptId: null,
      dataClassification: "public_or_synthetic",
      sourceOwner: "evaluation-owner",
      processingPurpose: "artifact_rendering",
      targetKind: "renderer",
      targetService: "renderer-service",
      targetAccount: "renderer-account",
      targetRegion: "cn",
      subprocessors: ["renderer-subprocessor"],
      contentFields: ["artifact_binary"],
      payloadHash: ARTIFACT_HASH,
      requiredRedactions: [],
      requestedAt: "2026-07-27T00:00:00.000Z",
    },
  ]);
});

function fixtureArtifact(): Artifact {
  return {
    artifactId: "artifact-stable-001",
    runId: "run-stable-001",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    filename: "deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: 7,
    pageCount: 2,
    contentHash: ARTIFACT_HASH,
    capturedAt: "2026-07-27T00:00:00.000Z",
    content: new TextEncoder().encode("deck-v1"),
  };
}

function fixtureRenderManifest(): RenderManifest {
  const manifest: Omit<RenderManifest, "contentHash"> = {
    renderManifestId: "render-stable-001",
    artifactId: "artifact-stable-001",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    renderer: "mock-static-svg@1",
    pageCount: 2,
    renderPolicy: {
      fontPack: "mock-font-pack@1",
      resolution: "1280x720",
      colorProfile: "sRGB",
      animationPolicy: "first_frame",
      externalAssetPolicy: "network_disabled",
    },
    contactSheet: {
      filename: "contact-sheet.svg",
      mimeType: "image/svg+xml" as const,
      contentHash:
        "sha256:bbe093b485d07f5c26c9407252fa7fa9a17fad3828b6b7ef9211173ce313d1f1" as const,
      content: "<svg>contact-sheet</svg>",
    },
    slides: [
      {
        pageNumber: 1,
        filename: "slide-1.svg",
        mimeType: "image/svg+xml",
        contentHash: SLIDE_ONE_HASH,
        content: "<svg>slide-1</svg>",
        extractedText: "slide one",
      },
      {
        pageNumber: 2,
        filename: "slide-2.svg",
        mimeType: "image/svg+xml",
        contentHash: SLIDE_TWO_HASH,
        content: "<svg>slide-2</svg>",
        extractedText: "slide two",
      },
    ],
  };
  return {
    ...manifest,
    contentHash: calculateRenderManifestHash(
      ARTIFACT_HASH,
      manifest,
    ),
  };
}

test("ArtifactVault stores immutable original and derivative lineage in two controlled copies and verifies both readbacks", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondary = new InMemoryImmutableBlobStore("secondary");
  const payloadInventory = new InMemoryPayloadInventory(
    new InMemoryTombstoneLedger(),
  );
  const vault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    payloadInventory,
  });

  const manifest = await vault.capture({
    jobId: "job-stable-001",
    dataClassification: "public_or_synthetic",
    sourceOwner: "evaluation-owner",
    artifact: fixtureArtifact(),
    renderManifest: fixtureRenderManifest(),
  });

  assert.deepEqual(
    {
      artifactId: manifest.artifact.artifactId,
      contentHash: manifest.artifact.contentHash,
      mimeType: manifest.artifact.mimeType,
      byteSize: manifest.artifact.byteSize,
      pageCount: manifest.artifact.pageCount,
      capturedAt: manifest.artifact.capturedAt,
      derivatives: manifest.derivatives
        .filter(({ derivativeType }) => derivativeType === "static_slide")
        .map((lineage) => ({
          derivativeId: lineage.derivativeId,
          sourceArtifactId: lineage.sourceArtifactId,
          pageNumber: lineage.pageNumber,
          contentHash: lineage.contentHash,
        })),
      derivativeTypes: manifest.derivatives.reduce<Record<string, number>>(
        (counts, { derivativeType }) => {
          counts[derivativeType] = (counts[derivativeType] ?? 0) + 1;
          return counts;
        },
        {},
      ),
      primaryKeyCount: primary.listKeys().length,
      secondaryKeyCount: secondary.listKeys().length,
      hasRenderManifest: primary
        .listKeys()
        .includes("artifacts/artifact-stable-001/render-manifest"),
    },
    {
      artifactId: "artifact-stable-001",
      contentHash: ARTIFACT_HASH,
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      byteSize: 7,
      pageCount: 2,
      capturedAt: "2026-07-27T00:00:00.000Z",
      derivatives: [
        {
          derivativeId: "artifact-stable-001:static-slide:1",
          sourceArtifactId: "artifact-stable-001",
          pageNumber: 1,
          contentHash: SLIDE_ONE_HASH,
        },
        {
          derivativeId: "artifact-stable-001:static-slide:2",
          sourceArtifactId: "artifact-stable-001",
          pageNumber: 2,
          contentHash: SLIDE_TWO_HASH,
        },
      ],
      derivativeTypes: {
        static_slide: 2,
        extracted_text: 2,
        contact_sheet: 1,
      },
      primaryKeyCount: 8,
      secondaryKeyCount: 8,
      hasRenderManifest: true,
    },
  );

  const conflictingArtifact = {
    ...fixtureArtifact(),
    contentHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    content: new TextEncoder().encode("deck-v2"),
  };
  await assert.rejects(
    vault.capture({
      jobId: "job-stable-001",
      dataClassification: "public_or_synthetic",
      sourceOwner: "evaluation-owner",
      artifact: conflictingArtifact,
      renderManifest: fixtureRenderManifest(),
    }),
    /immutable blob conflict|content hash mismatch/i,
  );
});

test("ArtifactVault rejects a storage copy whose upload readback no longer matches the captured hash", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondaryDelegate = new InMemoryImmutableBlobStore("secondary");
  const captureJournal = new InMemoryArtifactCaptureJournal();
  const payloadInventory = new InMemoryPayloadInventory(
    new InMemoryTombstoneLedger(),
  );
  const corruptSecondary: ImmutableBlobStorePort = {
    storeId: secondaryDelegate.storeId,
    egressDestination: secondaryDelegate.egressDestination,
    putImmutable: (key, content, context) =>
      secondaryDelegate.putImmutable(key, content, context),
    async read(key) {
      const stored = await secondaryDelegate.read(key);
      return stored === null
        ? null
        : Uint8Array.from([...stored, 0]);
    },
    delete: (key) => secondaryDelegate.delete(key),
  };

  await assert.rejects(
    createArtifactVault({
      primary,
      secondary: corruptSecondary,
      egressAuthorization: APPROVED_EGRESS,
      captureJournal,
      payloadInventory,
    }).capture({
      jobId: "job-stable-001",
      dataClassification: "public_or_synthetic",
      sourceOwner: "evaluation-owner",
      artifact: fixtureArtifact(),
      renderManifest: fixtureRenderManifest(),
    }),
    /secondary.*readback.*hash mismatch/i,
  );
  assert.deepEqual(primary.listKeys(), []);
  assert.deepEqual(secondaryDelegate.listKeys(), []);
  assert.deepEqual(
    captureJournal
      .list("job-stable-001", "artifact-stable-001")
      .map(({ eventType }) => eventType),
    ["started", "write_verified", "failed", "cleanup_verified"],
  );
});

test("ArtifactVault cleans partial blobs even when the append-only capture journal fails after a write", async () => {
  const tombstones = new InMemoryTombstoneLedger();
  const primary = new InMemoryImmutableBlobStore("primary", tombstones);
  const secondary = new InMemoryImmutableBlobStore("secondary", tombstones);
  let journalUnavailable = true;
  const observedAttemptIds: string[] = [];
  const captureJournal: ArtifactCaptureJournalPort = {
    async append(event) {
      observedAttemptIds.push(event.captureAttemptId);
      if (
        journalUnavailable &&
        (
          event.eventType === "write_verified" ||
          event.eventType === "failed"
        )
      ) {
        throw new Error("capture journal unavailable");
      }
    },
  };
  const vault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    captureJournal,
    payloadInventory: new InMemoryPayloadInventory(tombstones),
  });

  await assert.rejects(
    vault.capture({
      jobId: "job-journal-failure",
      dataClassification: "public_or_synthetic",
      sourceOwner: "evaluation-owner",
      artifact: fixtureArtifact(),
      renderManifest: fixtureRenderManifest(),
    }),
    /capture journal unavailable/i,
  );
  assert.deepEqual(primary.listKeys(), []);
  assert.deepEqual(secondary.listKeys(), []);
  journalUnavailable = false;
  const retried = await vault.capture({
    jobId: "job-journal-failure",
    dataClassification: "public_or_synthetic",
    sourceOwner: "evaluation-owner",
    artifact: fixtureArtifact(),
    renderManifest: fixtureRenderManifest(),
  });
  assert.equal(retried.artifact.artifactId, "artifact-stable-001");
  assert.deepEqual(
    [...new Set(observedAttemptIds)].map((id) => id.split(":").at(-1)),
    ["1", "2"],
  );
});

test("Bakeoff fails closed before a vendor call when its call-boundary egress authorization is denied", async () => {
  let vendorCalls = 0;
  const adapter: ProductAdapterPort = {
    productPackage: {
      packageId: "MOCK-denied-vendor-package-v1",
      vendorId: "denied-vendor",
      displayName: "Denied Vendor",
      adapterVersion: "denied-vendor-adapter@1",
      provenance: "MOCK",
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      egressDestination: {
        targetService: "denied-vendor-service",
        targetAccount: "denied-vendor-test-account",
        targetRegion: "test",
        subprocessors: [],
      },
    },
    async execute() {
      vendorCalls += 1;
      throw new Error("vendor must not be called");
    },
  };
  const authorization: EgressAuthorizationPort = {
    async authorize(request) {
      if (request.processingPurpose !== "vendor_generation") {
        return APPROVED_EGRESS.authorize(request);
      }
      return {
        status: "denied",
        decisionId: `denied:${request.requestId}`,
        policyVersion: "test-egress-policy-v1",
        request,
        reason: "vendor egress is outside the approved scope",
        decidedAt: "2026-07-27T00:00:00.000Z",
      };
    },
  };
  const feishu = new InMemoryFeishuProjection();

  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: [adapter],
      egressAuthorization: authorization,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /vendor_generation.*denied.*blocked/i,
  );
  assert.deepEqual(
    {
      vendorCalls,
      runRecords: feishu.snapshot().runRecordTable.length,
      captures: feishu.snapshot().capturedArtifactTable.length,
    },
    {
      vendorCalls: 0,
      runRecords: 0,
      captures: 0,
    },
  );
});

test("Bakeoff freezes a content-addressed Run specification and authorized dual-copy Artifact package on the public start path", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondary = new InMemoryImmutableBlobStore("secondary");
  const recovery = new InMemoryImmutableBlobStore("recovery");
  const payloadInventory = new InMemoryPayloadInventory(
    new InMemoryTombstoneLedger(),
  );
  const purposes: string[] = [];
  const authorizationRequests: Parameters<
    EgressAuthorizationPort["authorize"]
  >[0][] = [];
  const authorization: EgressAuthorizationPort = {
    async authorize(request) {
      purposes.push(request.processingPurpose);
      authorizationRequests.push(request);
      return APPROVED_EGRESS.authorize(request);
    },
  };
  const feishu = new InMemoryFeishuProjection();
  const egressAudit = new InMemoryEgressAuthorizationAudit();
  const runSpecificationVault = createRunSpecificationVault({
    store: recovery,
    egressAuthorization: authorization,
    payloadInventory,
  });
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: authorization,
    payloadInventory,
  });

  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
    egressAuthorization: authorization,
    egressAudit,
    artifactVault,
    runSpecificationVault,
    payloadInventory,
    specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  const vendorRun = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "vendor_run");
  assert.ok(vendorRun);
  assert.deepEqual(
    {
      specification: vendorRun.specificationReference,
      artifact: vendorRun.artifactPackageManifest?.artifact,
      derivativeCount:
        vendorRun.artifactPackageManifest?.derivatives.length,
      purposes: [...new Set(purposes)].sort(),
      recoveryKeys: recovery.listKeys(),
      copiesMatch:
        JSON.stringify(primary.listKeys()) ===
        JSON.stringify(secondary.listKeys()),
    },
    {
      specification: vendorRun.specificationReference,
      artifact: {
        artifactId: "MOCK-artifact-wps-volcano-v1",
        runId: "MOCK-run-wps-volcano-v1",
        contentHash: vendorRun.artifactPackageManifest?.artifact.contentHash,
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: vendorRun.artifactPackageManifest?.artifact.byteSize,
        pageCount: 16,
        capturedAt: "2026-01-01T00:00:00.000Z",
        filename: "MOCK-wps-volcano-16.pptx",
      },
      derivativeCount: 33,
      purposes: [
        "artifact_rendering",
        "artifact_storage",
        "operational_ledger_projection_storage",
        "run_specification_storage",
        "vendor_generation",
      ],
      recoveryKeys: [
        vendorRun.specificationReference?.key,
      ],
      copiesMatch: true,
    },
  );
  assert.match(
    vendorRun.specificationReference?.contentHash ?? "",
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    vendorRun.specificationReference?.key,
    `run-specifications/${vendorRun.specificationReference?.contentHash.slice(
      "sha256:".length,
    )}`,
  );
  assert.equal(
    vendorRun.specificationReference?.egressAuthorization.request.payloadHash,
    vendorRun.specificationReference?.contentHash,
  );
  const projectionRequest = authorizationRequests.find(
    ({ processingPurpose }) =>
      processingPurpose === "operational_ledger_projection_storage",
  );
  assert.ok(projectionRequest);
  assert.equal(
    projectionRequest.payloadHash,
    sha256Bytes(canonicalJsonBytes(feishu.snapshot())),
  );
  assert.deepEqual(projectionRequest.contentFields, [
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
  ]);
  assert.equal(
    egressAudit
      .list()
      .find(
        ({ request }) =>
          request.processingPurpose ===
          "operational_ledger_projection_storage",
      )?.request.payloadHash,
    projectionRequest.payloadHash,
  );
  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: [new MockWpsProductAdapter()],
      egressAuthorization: authorization,
      egressAudit,
      artifactVault,
      runSpecificationVault,
      payloadInventory,
      rendererDestination: {
        targetService: "different-renderer",
        targetAccount: "different-account",
        targetRegion: "test",
        subprocessors: [],
      },
      specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /protocol mismatch|security context mismatch/i,
  );
  const specification = await runSpecificationVault.read(
    vendorRun.specificationReference,
  );
  const hashes = vendorRun.specificationReference.versionReferences;
  assert.deepEqual(
    {
      case: hashes.caseContentHash,
      productPackage: hashes.productPackageContentHash,
      protocol: hashes.protocolSnapshotContentHash,
      adapter: hashes.adapterSpecificationHash,
      schema: hashes.schemaSnapshotHash,
      rubric: hashes.rubricSnapshotHash,
      estimator: hashes.estimatorSnapshotHash,
      runnerCode: hashes.runnerCodeDigest,
      runnerImage: hashes.runnerImageDigest,
      environment: hashes.environmentEvidenceHash,
    },
    {
      case: sha256Bytes(
        canonicalJsonBytes(specification.evaluationCase),
      ),
      productPackage: sha256Bytes(
        canonicalJsonBytes(specification.productPackage),
      ),
      protocol: sha256Bytes(
        canonicalJsonBytes(specification.protocolSnapshot),
      ),
      adapter: sha256Bytes(
        canonicalJsonBytes(specification.adapterSpecification),
      ),
      schema: sha256Bytes(
        canonicalJsonBytes(specification.schemaSnapshot),
      ),
      rubric: sha256Bytes(
        canonicalJsonBytes(specification.rubricSnapshot),
      ),
      estimator: sha256Bytes(
        canonicalJsonBytes(specification.estimatorSnapshot),
      ),
      runnerCode: sha256Bytes(
        readFileSync(new URL("../src/bakeoff.ts", import.meta.url)),
      ),
      runnerImage: sha256Bytes(readFileSync(process.execPath)),
      environment: sha256Bytes(
        canonicalJsonBytes(specification.environmentEvidence),
      ),
    },
  );
});

test("a recovery rehearsal rebuilds a complete hash-validated Job from the external ledger export, Run specs, and secondary Artifact copy only", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondary = new InMemoryImmutableBlobStore("secondary");
  const recovery = new InMemoryImmutableBlobStore("recovery");
  const tombstones = new InMemoryTombstoneLedger();
  const payloadInventory = new InMemoryPayloadInventory(tombstones);
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    payloadInventory,
  });
  const runSpecificationVault = createRunSpecificationVault({
    store: recovery,
    egressAuthorization: APPROVED_EGRESS,
    payloadInventory,
  });
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
    egressAuthorization: APPROVED_EGRESS,
    artifactVault,
    runSpecificationVault,
    payloadInventory,
    tombstones,
    specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  await createScoreAdjudicationService({
    feishu,
  }).adjudicateDimension({
    adjudicationEventId: "adjudication-recovery-001",
    scorecardId: "MOCK-scorecard-wps-volcano-v1",
    dimension: "narrative_and_audience_fit",
    humanFinalScore: 3,
    actorId: "pm-recovery",
    occurredAt: "2026-01-01T00:10:00.000Z",
    reason: "Recovery export must preserve append-only adjudication history.",
    priorAdjudicationEventId: null,
  });
  const recoveryService = createOperationalLedgerRecoveryService({
    recoveryStore: recovery,
    artifactVault,
    runSpecificationVault,
    tombstones,
    egressAuthorization: APPROVED_EGRESS,
    payloadInventory,
  });
  const snapshot = feishu.snapshot();
  const adjudication = snapshot.adjudicationEventTable[0];
  assert.ok(adjudication);
  await assert.rejects(
    recoveryService.exportLedger({
      exportId: "ledger-export-dangling-history",
      jobId: "MOCK-job-volcano-v1",
      checkpoint: "run-record-seq:3",
      snapshot: {
        ...snapshot,
        adjudicationEventTable: [
          ...snapshot.adjudicationEventTable,
          {
            ...adjudication,
            adjudicationEventId: "adjudication-dangling-001",
            scorecardId: "scorecard-missing-from-job",
          },
        ],
      },
      createdAt: "2026-01-01T00:14:00.000Z",
      encryption: "test-managed-key-v1",
      retentionExpiresAt: "2026-02-01T00:00:00.000Z",
    }),
    /dangling.*adjudication.*history/i,
  );
  await assert.rejects(
    recoveryService.exportLedger({
      exportId: "ledger-export-wrong-history-owner",
      jobId: "MOCK-job-volcano-v1",
      checkpoint: "run-record-seq:3",
      snapshot: {
        ...snapshot,
        adjudicationEventTable: [
          {
            ...adjudication,
            runId: "run-with-wrong-owner",
          },
        ],
      },
      createdAt: "2026-01-01T00:14:30.000Z",
      encryption: "test-managed-key-v1",
      retentionExpiresAt: "2026-02-01T00:00:00.000Z",
    }),
    /adjudication history ownership.*mismatch/i,
  );
  const exported = await recoveryService.exportLedger({
    exportId: "ledger-export-001",
    jobId: "MOCK-job-volcano-v1",
    checkpoint: "run-record-seq:3",
    snapshot,
    createdAt: "2026-01-01T00:15:00.000Z",
    encryption: "test-managed-key-v1",
    retentionExpiresAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(
    exported.egressAuthorization.request.payloadHash,
    exported.contentHash,
  );
  assert.deepEqual(exported.egressAuthorization.request.contentFields, [
    "cases",
    "run_records",
    "attempt_events",
    "artifact_manifests",
    "scorecards",
    "adjudication_history",
    "review_history",
    "gap_card_workflow_history",
    "github_issue_delivery_reservations",
    "github_issue_link_history",
    "comparisons",
    "product_gap_cards",
    "reports",
  ]);

  const mismatchedSpecificationVault: RunSpecificationVault = {
    ...runSpecificationVault,
    async read(reference) {
      const specification = await runSpecificationVault.read(reference);
      return {
        ...specification,
        evaluationCase: {
          ...specification.evaluationCase,
          caseId: "different-case",
        },
      };
    },
  };
  await assert.rejects(
    createOperationalLedgerRecoveryService({
      recoveryStore: recovery,
      artifactVault,
      runSpecificationVault: mismatchedSpecificationVault,
      tombstones,
      egressAuthorization: APPROVED_EGRESS,
      payloadInventory,
    }).rehearse({
      exportReference: exported,
      rehearsedAt: "2026-01-01T00:19:00.000Z",
    }),
    /run specification.*lineage.*case/i,
  );

  const rehearsal = await recoveryService.rehearse({
    exportReference: exported,
    rehearsedAt: "2026-01-01T00:20:00.000Z",
  });

  assert.deepEqual(
    {
      complete: rehearsal.complete,
      jobId: rehearsal.jobId,
      recordCount: rehearsal.recordCount,
      runIds: rehearsal.recoveredJob.vendorRuns.map(
        ({ recordId }) => recordId,
      ),
      artifactIds: rehearsal.artifacts.map(
        ({ manifest }) => manifest.artifact.artifactId,
      ),
      specificationRunIds: rehearsal.runSpecifications.map(
        ({ runId }) => runId,
      ),
      adjudicationIds:
        rehearsal.recoveredJob.adjudicationEvents.map(
          ({ adjudicationEventId }) => adjudicationEventId,
        ),
      verifiedHashCount: rehearsal.verifiedHashes.length,
      usedSources: rehearsal.usedSources,
    },
    {
      complete: true,
      jobId: "MOCK-job-volcano-v1",
      recordCount: 9,
      runIds: ["MOCK-run-wps-volcano-v1"],
      artifactIds: ["MOCK-artifact-wps-volcano-v1"],
      specificationRunIds: ["MOCK-run-wps-volcano-v1"],
      adjudicationIds: ["adjudication-recovery-001"],
      verifiedHashCount: 38,
      usedSources: [
        "versioned_recovery_export",
        "run_specification_recovery_store",
        "secondary_artifact_copy",
      ],
    },
  );
  await assert.rejects(
    recoveryService.rehearse({
      exportReference: exported,
      rehearsedAt: exported.retentionExpiresAt,
    }),
    /recovery blocked.*expired/i,
  );
});

test("retention expiry tombstones and deletes every controlled payload class while recovery refuses resurrection", async () => {
  const tombstones = new InMemoryTombstoneLedger();
  const inventory = new InMemoryPayloadInventory(tombstones);
  const primary = new InMemoryImmutableBlobStore("primary", tombstones);
  const secondary = new InMemoryImmutableBlobStore("secondary", tombstones);
  const recovery = new InMemoryImmutableBlobStore("recovery", tombstones);
  const quarantine = new InMemoryImmutableBlobStore(
    "quarantine",
    tombstones,
  );
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    payloadInventory: inventory,
  });
  const runSpecificationVault = createRunSpecificationVault({
    store: recovery,
    egressAuthorization: APPROVED_EGRESS,
    payloadInventory: inventory,
  });
  const feishu = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
    egressAuthorization: APPROVED_EGRESS,
    artifactVault,
    runSpecificationVault,
    payloadInventory: inventory,
    tombstones,
    specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const recoveryService = createOperationalLedgerRecoveryService({
    recoveryStore: recovery,
    artifactVault,
    runSpecificationVault,
    tombstones,
    egressAuthorization: APPROVED_EGRESS,
    payloadInventory: inventory,
  });
  const exported = await recoveryService.exportLedger({
    exportId: "ledger-export-retention-001",
    jobId: "MOCK-job-volcano-v1",
    checkpoint: "run-record-seq:3",
    snapshot: feishu.snapshot(),
    createdAt: "2026-01-01T00:15:00.000Z",
    encryption: "test-managed-key-v1",
    retentionExpiresAt: "2026-02-01T00:00:00.000Z",
  });
  const vendorRun = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "vendor_run");
  assert.ok(vendorRun?.artifactPackageManifest);
  assert.ok(vendorRun.specificationReference);
  const quarantineContent = new TextEncoder().encode("quarantine-redaction");
  const quarantineHash =
    "sha256:6522847fd9c23d726ae26793b8ba71fefab67ca748608141e2b80236d35a4cf8" as const;
  await quarantine.putImmutable(
    "quarantine/MOCK-job-volcano-v1/redaction-failure-001",
    quarantineContent,
    {
      jobId: "MOCK-job-volcano-v1",
      contentHash: quarantineHash,
    },
  );
  await inventory.register("MOCK-job-volcano-v1", [
    {
      storeId: "quarantine",
      key: "quarantine/MOCK-job-volcano-v1/redaction-failure-001",
      contentHash: quarantineHash,
      copyRole: "quarantine" as const,
    },
  ]);

  const expiry = await createRetentionService({
    stores: [primary, secondary, recovery, quarantine],
    tombstones,
    payloadInventory: inventory,
    projectionScrubber: feishu,
  }).expire({
    tombstoneId: "tombstone-MOCK-job-volcano-v1",
    jobId: "MOCK-job-volcano-v1",
    subjectIds: [
      "MOCK-run-wps-volcano-v1",
      "MOCK-artifact-wps-volcano-v1",
      "ledger-export-retention-001",
    ],
    expiredAt: "2026-02-01T00:00:00.000Z",
  });

  assert.deepEqual(
    {
      tombstoneId: expiry.tombstone.tombstoneId,
      deletedPayloads: expiry.deletionEvidence.length,
      primaryKeys: primary.listKeys(),
      secondaryKeys: secondary.listKeys(),
      recoveryKeys: recovery.listKeys(),
      quarantineKeys: quarantine.listKeys(),
      retainedTombstones: (await tombstones.list()).length,
      deletionEvidence:
        (await tombstones.listDeletionEvidence(
          expiry.tombstone.tombstoneId,
        )).length,
    },
    {
      tombstoneId: "tombstone-MOCK-job-volcano-v1",
      deletedPayloads: 75,
      primaryKeys: [],
      secondaryKeys: [],
      recoveryKeys: [],
      quarantineKeys: [],
      retainedTombstones: 1,
      deletionEvidence: 75,
    },
  );
  assert.equal(feishu.snapshot().capturedArtifactTable.length, 0);
  assert.equal(feishu.snapshot().artifactScoreTable.length, 0);
  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: [new MockWpsProductAdapter()],
      egressAuthorization: APPROVED_EGRESS,
      artifactVault,
      runSpecificationVault,
      payloadInventory: inventory,
      tombstones,
      specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /tombstoned.*cannot be replayed/i,
  );

  const originalLocation =
    vendorRun.artifactPackageManifest.payloadLocations.find(
      ({ copyRole, key }) =>
        copyRole === "secondary" && key.endsWith("/original"),
    );
  assert.ok(originalLocation);
  assert.ok(bakeoff.artifact);
  await assert.rejects(
    secondary.putImmutable(
      originalLocation.key,
      bakeoff.artifact.content,
      {
        jobId: "MOCK-job-volcano-v1",
        contentHash: originalLocation.contentHash,
      },
    ),
    /tombstoned.*write/i,
  );
  await assert.rejects(
    recoveryService.rehearse({
      exportReference: exported,
      rehearsedAt: "2026-02-01T00:10:00.000Z",
    }),
    /tombstoned.*cannot be resurrected/i,
  );
});
