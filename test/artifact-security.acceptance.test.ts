import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryImmutableBlobStore,
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
  type Artifact,
  type EgressAuthorizationPort,
  type ImmutableBlobStorePort,
  type ProductAdapterPort,
  type RenderManifest,
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
  return {
    renderManifestId: "render-stable-001",
    artifactId: "artifact-stable-001",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    renderer: "mock-static-svg@1",
    pageCount: 2,
    contentHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
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
}

test("ArtifactVault stores immutable original and derivative lineage in two controlled copies and verifies both readbacks", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondary = new InMemoryImmutableBlobStore("secondary");
  const vault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
  });

  const manifest = await vault.capture({
    jobId: "job-stable-001",
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
      derivatives: manifest.derivatives.map((lineage) => ({
        derivativeId: lineage.derivativeId,
        sourceArtifactId: lineage.sourceArtifactId,
        pageNumber: lineage.pageNumber,
        contentHash: lineage.contentHash,
      })),
      primaryKeys: primary.listKeys(),
      secondaryKeys: secondary.listKeys(),
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
      primaryKeys: [
        "artifacts/artifact-stable-001/derivatives/static-slide-1",
        "artifacts/artifact-stable-001/derivatives/static-slide-2",
        "artifacts/artifact-stable-001/manifest",
        "artifacts/artifact-stable-001/original",
      ],
      secondaryKeys: [
        "artifacts/artifact-stable-001/derivatives/static-slide-1",
        "artifacts/artifact-stable-001/derivatives/static-slide-2",
        "artifacts/artifact-stable-001/manifest",
        "artifacts/artifact-stable-001/original",
      ],
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
      artifact: conflictingArtifact,
      renderManifest: fixtureRenderManifest(),
    }),
    /immutable blob conflict|content hash mismatch/i,
  );
});

test("ArtifactVault rejects a storage copy whose upload readback no longer matches the captured hash", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondaryDelegate = new InMemoryImmutableBlobStore("secondary");
  const corruptSecondary: ImmutableBlobStorePort = {
    storeId: secondaryDelegate.storeId,
    putImmutable: (key, content) =>
      secondaryDelegate.putImmutable(key, content),
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
    }).capture({
      jobId: "job-stable-001",
      artifact: fixtureArtifact(),
      renderManifest: fixtureRenderManifest(),
    }),
    /secondary.*readback.*hash mismatch/i,
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
  const purposes: string[] = [];
  const authorization: EgressAuthorizationPort = {
    async authorize(request) {
      purposes.push(request.processingPurpose);
      return APPROVED_EGRESS.authorize(request);
    },
  };
  const feishu = new InMemoryFeishuProjection();

  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
    egressAuthorization: authorization,
    artifactVault: createArtifactVault({
      primary,
      secondary,
      egressAuthorization: authorization,
    }),
    runSpecificationVault: createRunSpecificationVault({
      store: recovery,
      egressAuthorization: authorization,
    }),
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
      specification: {
        schemaVersion: "run-specification-reference-v1",
        jobId: "MOCK-job-volcano-v1",
        runId: "MOCK-run-wps-volcano-v1",
        contentHash:
          vendorRun.specificationReference?.contentHash,
        storeId: "recovery",
        key: vendorRun.specificationReference?.key,
        specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
        versionReferences: {
          caseVersion: "1",
          productPackageVersion: "MOCK-wps-package-v1",
          runPolicyVersion: "MOCK-query-default-cost-v1",
          adapterVersion: "mock-wps@1",
          schemaVersion: "evaluation-framework-v0.8",
          rubricVersion: "query-six-dimension-v1",
        },
      },
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
      derivativeCount: 16,
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
});

test("a recovery rehearsal rebuilds a complete hash-validated Job from the external ledger export, Run specs, and secondary Artifact copy only", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondary = new InMemoryImmutableBlobStore("secondary");
  const recovery = new InMemoryImmutableBlobStore("recovery");
  const tombstones = new InMemoryTombstoneLedger();
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
  });
  const runSpecificationVault = createRunSpecificationVault({
    store: recovery,
    egressAuthorization: APPROVED_EGRESS,
  });
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
    egressAuthorization: APPROVED_EGRESS,
    artifactVault,
    runSpecificationVault,
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
  });
  const exported = await recoveryService.exportLedger({
    exportId: "ledger-export-001",
    jobId: "MOCK-job-volcano-v1",
    checkpoint: "run-record-seq:3",
    snapshot: feishu.snapshot(),
    createdAt: "2026-01-01T00:15:00.000Z",
    encryption: "test-managed-key-v1",
    retentionExpiresAt: "2026-02-01T00:00:00.000Z",
  });

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
      verifiedHashCount: 20,
      usedSources: [
        "versioned_recovery_export",
        "run_specification_recovery_store",
        "secondary_artifact_copy",
      ],
    },
  );
});

test("retention expiry tombstones and deletes every controlled payload class while recovery refuses resurrection", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondary = new InMemoryImmutableBlobStore("secondary");
  const recovery = new InMemoryImmutableBlobStore("recovery");
  const quarantine = new InMemoryImmutableBlobStore("quarantine");
  const tombstones = new InMemoryTombstoneLedger();
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
  });
  const runSpecificationVault = createRunSpecificationVault({
    store: recovery,
    egressAuthorization: APPROVED_EGRESS,
  });
  const feishu = new InMemoryFeishuProjection();
  const bakeoff = await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
    egressAuthorization: APPROVED_EGRESS,
    artifactVault,
    runSpecificationVault,
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
  );
  const payloadLocations = [
    ...vendorRun.artifactPackageManifest.payloadLocations,
    runSpecificationVault.retentionLocation(
      vendorRun.specificationReference,
    ),
    recoveryService.retentionLocation(exported),
    {
      storeId: "quarantine",
      key: "quarantine/MOCK-job-volcano-v1/redaction-failure-001",
      contentHash: quarantineHash,
      copyRole: "quarantine" as const,
    },
  ];

  const expiry = await createRetentionService({
    stores: [primary, secondary, recovery, quarantine],
    tombstones,
  }).expire({
    tombstoneId: "tombstone-MOCK-job-volcano-v1",
    jobId: "MOCK-job-volcano-v1",
    subjectIds: [
      "MOCK-run-wps-volcano-v1",
      "MOCK-artifact-wps-volcano-v1",
      "ledger-export-retention-001",
    ],
    expiredAt: "2026-02-01T00:00:00.000Z",
    payloadLocations,
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
      deletedPayloads: 39,
      primaryKeys: [],
      secondaryKeys: [],
      recoveryKeys: [],
      quarantineKeys: [],
      retainedTombstones: 1,
      deletionEvidence: 39,
    },
  );

  const originalLocation =
    vendorRun.artifactPackageManifest.payloadLocations.find(
      ({ copyRole, key }) =>
        copyRole === "secondary" && key.endsWith("/original"),
    );
  assert.ok(originalLocation);
  assert.ok(bakeoff.artifact);
  await secondary.putImmutable(
    originalLocation.key,
    bakeoff.artifact.content,
  );
  await assert.rejects(
    recoveryService.rehearse({
      exportReference: exported,
      rehearsedAt: "2026-02-01T00:10:00.000Z",
    }),
    /tombstoned.*cannot be resurrected/i,
  );
});
