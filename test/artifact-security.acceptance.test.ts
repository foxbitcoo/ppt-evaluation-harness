import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryImmutableBlobStore,
  InMemoryArtifactCaptureJournal,
  InMemoryEgressAuthorizationAudit,
  InMemoryPayloadInventory,
  InMemoryFeishuProjection,
  MockDoubaoProductAdapter,
  MockQwenProductAdapter,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createArtifactVault,
  createBakeoffHarness,
  createOperationalLedgerRecoveryService,
  createRetentionService,
  createRunSpecificationVault,
  createScoreAdjudicationService,
  InMemoryTombstoneLedger,
  approvedEgressAuthorizationHash,
  assertApprovedEgressAuthorizationCurrent,
  assertPersistedApprovedEgressAuthorization,
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

function testAdapterImplementationPackage(packageName: string) {
  const content = new TextEncoder().encode(packageName);
  return {
    packageName,
    contentHash: sha256Bytes(content),
    content,
  } as const;
}

const APPROVED_EGRESS: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `decision:${request.requestId}:${request.requestedAt}`,
      policyVersion: "test-egress-policy-v1",
      request,
      legalSecurityBasis: "synthetic test fixture",
      approvedAt: request.requestedAt,
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
  },
};

async function authorizeProjectionSnapshot(
  target: InMemoryFeishuProjection,
  snapshot: ReturnType<InMemoryFeishuProjection["snapshot"]>,
  jobId: string,
  evaluationCase:
    ReturnType<InMemoryFeishuProjection["snapshot"]>["caseTable"][number],
) {
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  return requireEgressAuthorization(
    APPROVED_EGRESS,
    {
      requestId: `operational-ledger-projection:${jobId}:${payloadHash}`,
      jobId,
      runId: null,
      attemptId: null,
      dataClassification: evaluationCase.dataClassification,
      sourceOwner: evaluationCase.sourceOwner,
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: target.egressDestination.targetService,
      targetAccount: target.egressDestination.targetAccount,
      targetRegion: target.egressDestination.targetRegion,
      subprocessors: target.egressDestination.subprocessors,
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

test("persisted approval evidence accepts an approval issued after its request and before expiry", async () => {
  const request = {
    requestId: "persisted-approval-ordering",
    jobId: "job-stable-001",
    runId: "run-stable-001",
    attemptId: null,
    dataClassification: "public_or_synthetic" as const,
    sourceOwner: "evaluation-owner",
    processingPurpose: "run_specification_storage" as const,
    targetKind: "storage" as const,
    targetService: "recovery-store",
    targetAccount: "recovery-account",
    targetRegion: "cn",
    subprocessors: [],
    contentFields: ["run_specification_bundle"],
    payloadHash: ARTIFACT_HASH,
    requiredRedactions: [],
    requestedAt: "2026-07-27T00:00:00.000Z",
  };
  const decision = {
    status: "approved" as const,
    decisionId: "decision:persisted-approval-ordering",
    policyVersion: "test-egress-policy-v1",
    request,
    legalSecurityBasis: "synthetic test fixture",
    approvedAt: "2026-07-27T00:00:00.010Z",
    expiresAt: "2026-07-27T00:00:01.000Z",
  };

  assert.doesNotThrow(() =>
    assertPersistedApprovedEgressAuthorization(
      decision,
      request,
      approvedEgressAuthorizationHash(decision),
    ),
  );
  assert.throws(
    () =>
      assertApprovedEgressAuthorizationCurrent(
        {
          ...decision,
          policyVersion: "",
        },
        {
          now: () => "2026-07-27T00:00:00.020Z",
        },
      ),
    /denied or incompatible/i,
  );
});

test("ArtifactVault obtains a fresh short-lived authorization immediately before every immutable write", async () => {
  const events: string[] = [];
  let clockTick = 0;
  const baseTime = Date.parse("2026-07-27T00:00:00.000Z");
  const clock: ClockPort = {
    clockId: "short-lived-artifact-write-clock",
    now() {
      const value = new Date(baseTime + clockTick * 500).toISOString();
      clockTick += 1;
      return value;
    },
  };
  const authorization: EgressAuthorizationPort = {
    async authorize(request) {
      events.push(
        `authorize:${request.targetService}:${request.requestId
          .split(`:${request.targetService}:`)
          .at(-1)}`,
      );
      return {
        status: "approved",
        decisionId: `decision:${request.requestId}`,
        policyVersion: "short-lived-policy-v1",
        request,
        legalSecurityBasis: "synthetic test fixture",
        approvedAt: request.requestedAt,
        expiresAt: new Date(
          Date.parse(request.requestedAt) + 1_250,
        ).toISOString(),
      };
    },
  };
  const wrapStore = (
    delegate: InMemoryImmutableBlobStore,
  ): ImmutableBlobStorePort => ({
    storeId: delegate.storeId,
    egressDestination: delegate.egressDestination,
    async putImmutable(key, content, context) {
      events.push(
        `put:${delegate.egressDestination.targetService}:${key}`,
      );
      await delegate.putImmutable(key, content, context);
    },
    read: (key) => delegate.read(key),
    releaseWriteClaim: (key, writeAttemptId) =>
      delegate.releaseWriteClaim(key, writeAttemptId),
    delete: (key) => delegate.delete(key),
  });
  const tombstones = new InMemoryTombstoneLedger();
  const primary = new InMemoryImmutableBlobStore("primary", tombstones);
  const secondary = new InMemoryImmutableBlobStore(
    "secondary",
    tombstones,
  );
  const manifest = await createArtifactVault({
    primary: wrapStore(primary),
    secondary: wrapStore(secondary),
    egressAuthorization: authorization,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
    captureJournal: new InMemoryArtifactCaptureJournal(),
    payloadInventory: new InMemoryPayloadInventory(tombstones),
    clock,
  }).capture({
    jobId: "job-short-lived-authorization",
    dataClassification: "public_or_synthetic",
    sourceOwner: "evaluation-owner",
    artifact: fixtureArtifact(),
    renderManifest: fixtureRenderManifest(),
  });

  assert.equal(manifest.egressAuthorizations.length, 16);
  assert.equal(events.length, 32);
  for (let index = 0; index < events.length; index += 2) {
    const authorizationEvent = events[index];
    const putEvent = events[index + 1];
    assert.ok(authorizationEvent?.startsWith("authorize:"));
    assert.ok(putEvent?.startsWith("put:"));
    assert.equal(
      authorizationEvent?.replace("authorize:", ""),
      putEvent?.replace("put:", ""),
    );
  }
  const authorizationTimes = manifest.egressAuthorizations.map(
    ({ request }) => Date.parse(request.requestedAt),
  );
  assert.ok(
    authorizationTimes.slice(1).every(
      (requestedAt, index) =>
        requestedAt >
        Date.parse(
          manifest.egressAuthorizations[index]?.expiresAt ?? "",
        ),
    ),
  );
});

test("ArtifactVault refuses a write when authorization expires during an awaited store preflight", async () => {
  let currentTime = Date.parse("2026-07-27T00:00:00.000Z");
  const clock: ClockPort = {
    clockId: "slow-store-authorization-clock",
    now: () => new Date(currentTime).toISOString(),
  };
  const authorization: EgressAuthorizationPort = {
    async authorize(request) {
      return {
        status: "approved",
        decisionId: `decision:${request.requestId}`,
        policyVersion: "slow-store-policy-v1",
        request,
        legalSecurityBasis: "synthetic test fixture",
        approvedAt: request.requestedAt,
        expiresAt: new Date(
          Date.parse(request.requestedAt) + 1_000,
        ).toISOString(),
      };
    },
  };
  const slowStore = (
    delegate: InMemoryImmutableBlobStore,
  ): ImmutableBlobStorePort => ({
    storeId: delegate.storeId,
    egressDestination: delegate.egressDestination,
    putImmutable: async (key, content, context) => {
      currentTime += 2_000;
      await delegate.putImmutable(key, content, context);
    },
    read: (key) => delegate.read(key),
    releaseWriteClaim: (key, writeAttemptId) =>
      delegate.releaseWriteClaim(key, writeAttemptId),
    delete: (key) => delegate.delete(key),
  });
  const tombstones = new InMemoryTombstoneLedger();
  const primary = new InMemoryImmutableBlobStore("primary", tombstones);
  const secondary = new InMemoryImmutableBlobStore(
    "secondary",
    tombstones,
  );

  await assert.rejects(
    createArtifactVault({
      primary: slowStore(primary),
      secondary: slowStore(secondary),
      egressAuthorization: authorization,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      captureJournal: new InMemoryArtifactCaptureJournal(),
      payloadInventory: new InMemoryPayloadInventory(tombstones),
      clock,
    }).capture({
      jobId: "job-slow-store-authorization",
      dataClassification: "public_or_synthetic",
      sourceOwner: "evaluation-owner",
      artifact: fixtureArtifact(),
      renderManifest: fixtureRenderManifest(),
    }),
    /expired.*artifact_storage|artifact_storage.*expired/i,
  );
  assert.deepEqual(primary.listKeys(), []);
  assert.deepEqual(secondary.listKeys(), []);
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
  const captureJournal = new InMemoryArtifactCaptureJournal();
  const payloadInventory = new InMemoryPayloadInventory(
    new InMemoryTombstoneLedger(),
  );
  const vault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
    captureJournal,
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
  await assert.rejects(
    vault.capture({
      jobId: "job-stable-001",
      dataClassification: "public_or_synthetic",
      sourceOwner: "evaluation-owner",
      artifact: {
        ...fixtureArtifact(),
        filename: "conflicting-filename.pptx",
      },
      renderManifest: fixtureRenderManifest(),
    }),
    /payload inventory identity conflict/i,
  );
  const captureAttempts = [
    ...new Set(
      captureJournal
        .list("job-stable-001", "artifact-stable-001")
        .map(({ captureAttemptId }) => captureAttemptId),
    ),
  ];
  const conflictingAttemptId = captureAttempts.at(-1);
  assert.ok(conflictingAttemptId);
  assert.deepEqual(
    captureJournal
      .list("job-stable-001", "artifact-stable-001")
      .filter(
        ({ captureAttemptId }) =>
          captureAttemptId === conflictingAttemptId,
      )
      .map(({ eventType }) => eventType),
    ["started", "failed", "cleanup_verified"],
  );
  const forgedManifest = {
    ...manifest,
    schemaVersion: "artifact-package-manifest-v999",
    captureJournalId: "",
    captureAttemptId: "forged-attempt",
    payloadLocations: manifest.payloadLocations.map((location) =>
      location.copyRole === "secondary"
        ? {
            ...location,
            storeId: "forged-secondary-store",
          }
        : location,
    ),
    egressAuthorizations: manifest.egressAuthorizations.map(
      (authorization) => ({
        ...authorization,
        status: "denied",
        reason: "forged denial",
        decidedAt: authorization.request.requestedAt,
      }),
    ),
  };
  await assert.rejects(
    vault.readFromSecondary(forgedManifest as never),
    /artifact.*manifest|capture journal|authorization|store/i,
  );
});

test("Artifact capture journal rejects a completed trace that omitted its planned immutable writes", async () => {
  const journal = new InMemoryArtifactCaptureJournal(
    "journal-planned-write-validation",
  );
  const captureAttemptId = await journal.beginAttempt({
    jobId: "job-journal-plan",
    artifactId: "artifact-journal-plan",
    detail: "planned:999",
  });
  await journal.append({
    eventId: `${captureAttemptId}:completed`,
    captureAttemptId,
    jobId: "job-journal-plan",
    artifactId: "artifact-journal-plan",
    eventType: "completed",
    storeId: null,
    key: null,
    detail: "verified:0",
  });

  await assert.rejects(
    journal.verifyCompletedAttempt({
      captureAttemptId,
      jobId: "job-journal-plan",
      artifactId: "artifact-journal-plan",
      expectedWrites: [],
    }),
    /journal trace.*incomplete|planned.*write/i,
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
    releaseWriteClaim: (key, writeAttemptId) =>
      secondaryDelegate.releaseWriteClaim(key, writeAttemptId),
    delete: (key) => secondaryDelegate.delete(key),
  };

  await assert.rejects(
    createArtifactVault({
      primary,
      secondary: corruptSecondary,
      egressAuthorization: APPROVED_EGRESS,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
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
  const durableJournal = new InMemoryArtifactCaptureJournal();
  let journalUnavailable = true;
  const observedAttemptIds: string[] = [];
  const captureJournal: ArtifactCaptureJournalPort = {
    journalId: durableJournal.journalId,
    beginAttempt: (input) => durableJournal.beginAttempt(input),
    verifyCompletedAttempt: (input) =>
      durableJournal.verifyCompletedAttempt(input),
    async append(event) {
      observedAttemptIds.push(event.captureAttemptId);
      await durableJournal.append(event);
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
  const createVault = () => createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
    captureJournal,
    payloadInventory: new InMemoryPayloadInventory(tombstones),
  });

  await assert.rejects(
    createVault().capture({
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
  const retried = await createVault().capture({
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

test("ArtifactVault deletes a blob committed before a lost upload acknowledgement", async () => {
  const tombstones = new InMemoryTombstoneLedger();
  const primaryDelegate = new InMemoryImmutableBlobStore(
    "primary",
    tombstones,
  );
  const secondary = new InMemoryImmutableBlobStore("secondary", tombstones);
  let loseAcknowledgement = true;
  const primary: ImmutableBlobStorePort = {
    storeId: primaryDelegate.storeId,
    egressDestination: primaryDelegate.egressDestination,
    async putImmutable(key, content, context) {
      await primaryDelegate.putImmutable(key, content, context);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("upload acknowledgement lost");
      }
    },
    read: (key) => primaryDelegate.read(key),
    releaseWriteClaim: (key, writeAttemptId) =>
      primaryDelegate.releaseWriteClaim(key, writeAttemptId),
    delete: (key) => primaryDelegate.delete(key),
  };

  await assert.rejects(
    createArtifactVault({
      primary,
      secondary,
      egressAuthorization: APPROVED_EGRESS,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      captureJournal: new InMemoryArtifactCaptureJournal(),
      payloadInventory: new InMemoryPayloadInventory(tombstones),
    }).capture({
      jobId: "job-lost-ack",
      dataClassification: "public_or_synthetic",
      sourceOwner: "evaluation-owner",
      artifact: fixtureArtifact(),
      renderManifest: fixtureRenderManifest(),
    }),
    /acknowledgement lost/i,
  );
  assert.deepEqual(primaryDelegate.listKeys(), []);
  assert.deepEqual(secondary.listKeys(), []);
});

test("a failed concurrent Artifact capture releases only its own shared-blob write claim", async () => {
  const tombstones = new InMemoryTombstoneLedger();
  const primaryDelegate = new InMemoryImmutableBlobStore(
    "primary",
    tombstones,
  );
  const secondary = new InMemoryImmutableBlobStore(
    "secondary",
    tombstones,
  );
  let manifestBeforeReads = 0;
  let releaseManifestReads = () => {};
  const manifestReadsReady = new Promise<void>((resolve) => {
    releaseManifestReads = resolve;
  });
  const primary: ImmutableBlobStorePort = {
    storeId: primaryDelegate.storeId,
    egressDestination: primaryDelegate.egressDestination,
    putImmutable: (key, content, context) =>
      primaryDelegate.putImmutable(key, content, context),
    async read(key) {
      const content = await primaryDelegate.read(key);
      if (
        key === "artifacts/artifact-stable-001/manifest" &&
        content === null &&
        manifestBeforeReads < 2
      ) {
        manifestBeforeReads += 1;
        if (manifestBeforeReads === 2) releaseManifestReads();
        await manifestReadsReady;
        return null;
      }
      return content;
    },
    releaseWriteClaim: (key, writeAttemptId) =>
      primaryDelegate.releaseWriteClaim(key, writeAttemptId),
    delete: (key) => primaryDelegate.delete(key),
  };
  const failingDelegate = new InMemoryArtifactCaptureJournal();
  let failFirstWriteJournal = true;
  const failingJournal: ArtifactCaptureJournalPort = {
    journalId: failingDelegate.journalId,
    beginAttempt: (input) => failingDelegate.beginAttempt(input),
    verifyCompletedAttempt: (input) =>
      failingDelegate.verifyCompletedAttempt(input),
    async append(event) {
      await failingDelegate.append(event);
      if (
        failFirstWriteJournal &&
        event.eventType === "write_verified"
      ) {
        failFirstWriteJournal = false;
        throw new Error("concurrent capture journal failure");
      }
    },
  };
  const payloadInventory = new InMemoryPayloadInventory(tombstones);
  const successfulVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
    captureJournal: new InMemoryArtifactCaptureJournal(),
    payloadInventory,
  });
  const failingVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
    captureJournal: failingJournal,
    payloadInventory,
  });
  const command = {
    jobId: "job-concurrent-capture",
    dataClassification: "public_or_synthetic" as const,
    sourceOwner: "evaluation-owner",
    artifact: fixtureArtifact(),
    renderManifest: fixtureRenderManifest(),
  };

  const [successful, failed] = await Promise.allSettled([
    successfulVault.capture(command),
    failingVault.capture(command),
  ]);
  assert.equal(successful.status, "fulfilled");
  assert.equal(failed.status, "rejected");
  if (successful.status !== "fulfilled") {
    assert.fail("the successful concurrent capture did not complete");
  }
  assert.match(
    failed.status === "rejected" && failed.reason instanceof Error
      ? failed.reason.message
      : "",
    /concurrent capture journal failure/i,
  );
  assert.equal(primaryDelegate.listKeys().length, 8);
  assert.equal(secondary.listKeys().length, 8);
  const recovered = await successfulVault.readFromSecondary(
    successful.value,
  );
  assert.equal(
    recovered.manifest.artifact.contentHash,
    fixtureArtifact().contentHash,
  );
});

test("a successful late-joining Artifact capture retains its shared blob when the original claimant later fails", async () => {
  const tombstones = new InMemoryTombstoneLedger();
  const primary = new InMemoryImmutableBlobStore("primary", tombstones);
  const secondary = new InMemoryImmutableBlobStore(
    "secondary",
    tombstones,
  );
  let signalFirstWrite = () => {};
  let releaseFirstWrite = () => {};
  const firstWrite = new Promise<void>((resolve) => {
    signalFirstWrite = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const failingDelegate = new InMemoryArtifactCaptureJournal();
  let pauseAndFail = true;
  const failingJournal: ArtifactCaptureJournalPort = {
    journalId: failingDelegate.journalId,
    beginAttempt: (input) => failingDelegate.beginAttempt(input),
    verifyCompletedAttempt: (input) =>
      failingDelegate.verifyCompletedAttempt(input),
    async append(event) {
      await failingDelegate.append(event);
      if (pauseAndFail && event.eventType === "write_verified") {
        pauseAndFail = false;
        signalFirstWrite();
        await release;
        throw new Error("late original claimant failure");
      }
    },
  };
  const payloadInventory = new InMemoryPayloadInventory(tombstones);
  const failingVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
    captureJournal: failingJournal,
    payloadInventory,
  });
  const successfulVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit: new InMemoryEgressAuthorizationAudit(),
    captureJournal: new InMemoryArtifactCaptureJournal(),
    payloadInventory,
  });
  const command = {
    jobId: "job-late-joining-capture",
    dataClassification: "public_or_synthetic" as const,
    sourceOwner: "evaluation-owner",
    artifact: fixtureArtifact(),
    renderManifest: fixtureRenderManifest(),
  };

  const failingCapture = failingVault.capture(command);
  await firstWrite;
  const successfulManifest = await successfulVault.capture(command);
  releaseFirstWrite();
  await assert.rejects(failingCapture, /late original claimant failure/i);

  assert.equal(primary.listKeys().length, 8);
  assert.equal(secondary.listKeys().length, 8);
  const recovered = await successfulVault.readFromSecondary(
    successfulManifest,
  );
  assert.equal(
    recovered.manifest.artifact.contentHash,
    fixtureArtifact().contentHash,
  );
});

test("Bakeoff fails closed before a vendor call when its call-boundary egress authorization is denied", async () => {
  let vendorCalls = 0;
  const adapter: ProductAdapterPort = {
    implementationPackage:
      testAdapterImplementationPackage("denied-vendor-adapter-test"),
    executionConfigurationPackage:
      testAdapterImplementationPackage("denied-vendor-execution-test"),
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
  const tombstones = new InMemoryTombstoneLedger();
  const payloadInventory = new InMemoryPayloadInventory(
    tombstones,
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
    egressAudit,
    payloadInventory,
  });
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: authorization,
    egressAudit,
    captureJournal: new InMemoryArtifactCaptureJournal(),
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
    tombstones,
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
  const replayed = await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
    egressAuthorization: authorization,
    egressAudit,
    artifactVault,
    runSpecificationVault,
    payloadInventory,
    tombstones,
    specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  assert.equal(replayed.job.status, "completed");
  const freshTombstones = new InMemoryTombstoneLedger();
  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: [new MockWpsProductAdapter()],
      egressAuthorization: authorization,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      artifactVault,
      runSpecificationVault,
      payloadInventory: new InMemoryPayloadInventory(freshTombstones),
      tombstones: freshTombstones,
      specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /protocol mismatch/i,
  );
  const changedAdapterDelegate = new MockWpsProductAdapter();
  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapters: [
        {
          implementationPackage: testAdapterImplementationPackage(
            "changed-adapter-implementation-test",
          ),
          executionConfigurationPackage:
            changedAdapterDelegate.executionConfigurationPackage,
          productPackage: changedAdapterDelegate.productPackage,
          execute: (command) => changedAdapterDelegate.execute(command),
        },
      ],
      egressAuthorization: authorization,
      egressAudit,
      artifactVault,
      runSpecificationVault,
      payloadInventory,
      specCommitSha: "9e68de5801bc14f00c187336000c83ce8cc37efa",
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /protocol mismatch/i,
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
        canonicalJsonBytes(specification.runnerCodeEvidence.files),
      ),
      runnerImage: sha256Bytes(
        canonicalJsonBytes(
          specification.runnerImageEvidence.runtimePackageManifest,
        ),
      ),
      environment: sha256Bytes(
        canonicalJsonBytes(specification.environmentEvidence),
      ),
    },
  );
  assert.ok(
    [
      "src/artifact-vault.ts",
      "src/bakeoff.ts",
      "src/ledger-recovery.ts",
      "src/retention.ts",
      "package-lock.json",
    ].every((path) =>
      specification.runnerCodeEvidence.files.some(
        (entry) => entry.path === path,
      ),
    ),
  );
  assert.match(
    specification.adapterSpecification.implementationDigest,
    /^sha256:[a-f0-9]{64}$/,
  );
});

test("Feishu projection commits one authorized canonical batch without rewriting unrelated history", async () => {
  const feishu = new InMemoryFeishuProjection();
  await feishu.createReport({
    reportId: "unrelated-report",
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    title: "Unrelated",
    jobId: "unrelated-job",
    runIds: [],
    artifactIds: [],
    claimLevel: "case_sample",
    markdown: "unrelated",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });

  assert.equal(outcome.job.status, "completed");
  assert.deepEqual(
    feishu.snapshot().reports.map(({ reportId }) => reportId).sort(),
    ["MOCK-report-volcano-v1", "unrelated-report"],
  );
});

test("a concurrent Feishu scrub cannot be overwritten by the final replace of an authorized projection commit", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const evaluationCase = snapshot.caseTable[0];
  assert.ok(evaluationCase);
  const target = new InMemoryFeishuProjection();
  const contentFields = [
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
  ] as const;
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  const authorization = await requireEgressAuthorization(
    APPROVED_EGRESS,
    {
      requestId: `operational-ledger-projection:MOCK-job-volcano-v1:${payloadHash}`,
      jobId: "MOCK-job-volcano-v1",
      runId: null,
      attemptId: null,
      dataClassification: evaluationCase.dataClassification,
      sourceOwner: evaluationCase.sourceOwner,
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: target.egressDestination.targetService,
      targetAccount: target.egressDestination.targetAccount,
      targetRegion: target.egressDestination.targetRegion,
      subprocessors: target.egressDestination.subprocessors,
      contentFields,
      payloadHash,
      requiredRedactions: [],
    },
    {
      clockId: "projection-concurrency-clock",
      now: () => "2026-07-27T00:00:00.000Z",
    },
  );

  await Promise.all([
    target.commitAuthorizedSnapshot(snapshot, authorization),
    target.scrubPayloadsForJob("MOCK-job-volcano-v1"),
  ]);

  assert.equal(
    await target.hasPayloadsForJob("MOCK-job-volcano-v1"),
    false,
  );
  assert.deepEqual(target.snapshot(), {
    caseTable: [],
    runRecordTable: [],
    capturedArtifactTable: [],
    artifactScoreTable: [],
    adjudicationEventTable: [],
    reviewEventTable: [],
    gapCardWorkflowEventTable: [],
    githubIssueDeliveryReservationTable: [],
    githubIssueLinkEventTable: [],
    productGapCardTable: [],
    reports: [],
  });
});

test("a Job B projection commit cannot restore Job A rows scrubbed by a concurrent transaction", async () => {
  const target = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: target,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const seeded = target.snapshot();
  const caseA = seeded.caseTable[0];
  const jobA = seeded.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  assert.ok(caseA);
  assert.ok(jobA);
  const caseB = {
    ...caseA,
    recordId: "case-record-job-b",
    caseId: "case-job-b",
    title: "Independent Job B Case",
  };
  const jobB = {
    ...jobA,
    recordId: "job-record-b",
    jobId: "job-b",
    caseId: caseB.caseId,
    selectedRunIds: [],
  };
  const snapshotB = {
    caseTable: [caseB],
    runRecordTable: [jobB],
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
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshotB));
  const authorizationB = await requireEgressAuthorization(
    APPROVED_EGRESS,
    {
      requestId: `operational-ledger-projection:job-b:${payloadHash}`,
      jobId: "job-b",
      runId: null,
      attemptId: null,
      dataClassification: caseB.dataClassification,
      sourceOwner: caseB.sourceOwner,
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: target.egressDestination.targetService,
      targetAccount: target.egressDestination.targetAccount,
      targetRegion: target.egressDestination.targetRegion,
      subprocessors: target.egressDestination.subprocessors,
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

  await Promise.all([
    target.commitAuthorizedSnapshot(snapshotB, authorizationB),
    target.scrubPayloadsForJob("MOCK-job-volcano-v1"),
  ]);

  assert.equal(
    await target.hasPayloadsForJob("MOCK-job-volcano-v1"),
    false,
  );
  assert.equal(
    target
      .snapshot()
      .runRecordTable.filter(
        ({ jobId }) => jobId === "MOCK-job-volcano-v1",
      ).length,
    0,
  );
  assert.equal(
    target
      .snapshot()
      .runRecordTable.filter(({ jobId }) => jobId === "job-b")
      .length,
    1,
  );
});

test("an authorized projection commit preserves a concurrent public ledger mutation", async () => {
  const target = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: target,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = target.snapshot();
  const job = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const evaluationCase = snapshot.caseTable[0];
  const existingReport = snapshot.reports[0];
  assert.ok(job);
  assert.ok(evaluationCase);
  assert.ok(existingReport);
  const authorization = await authorizeProjectionSnapshot(
    target,
    snapshot,
    job.jobId,
    evaluationCase,
  );
  const pendingCommit = target.commitAuthorizedSnapshot(
    snapshot,
    authorization,
  );
  await Promise.resolve();
  const { url: _discardedUrl, ...draft } = existingReport;
  await target.createReport({
    ...draft,
    reportId: "concurrent-report-other-job",
    jobId: "other-job",
    title: "Concurrent report from another Job",
  });
  await pendingCommit;

  assert.equal(
    target
      .snapshot()
      .reports.some(
        ({ reportId }) =>
          reportId === "concurrent-report-other-job",
      ),
    true,
  );
});

test("Feishu projection rejects a one-Job batch containing an unrelated Case outside that Job authorization", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const sourceSnapshot = source.snapshot();
  const job = sourceSnapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const authorizedCase = sourceSnapshot.caseTable[0];
  assert.ok(job);
  assert.ok(authorizedCase);
  const unrelatedRestrictedCase = {
    ...authorizedCase,
    recordId: "unrelated-restricted-case-record",
    caseId: "unrelated-restricted-case",
    title: "Unrelated restricted Case",
    dataClassification: "restricted" as const,
    sourceOwner: "unrelated-owner",
  };
  const snapshot = {
    caseTable: [authorizedCase, unrelatedRestrictedCase],
    runRecordTable: [job],
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
  const target = new InMemoryFeishuProjection();
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  const authorization = await requireEgressAuthorization(
    APPROVED_EGRESS,
    {
      requestId: `operational-ledger-projection:${job.jobId}:${payloadHash}`,
      jobId: job.jobId,
      runId: null,
      attemptId: null,
      dataClassification: authorizedCase.dataClassification,
      sourceOwner: authorizedCase.sourceOwner,
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: target.egressDestination.targetService,
      targetAccount: target.egressDestination.targetAccount,
      targetRegion: target.egressDestination.targetRegion,
      subprocessors: target.egressDestination.subprocessors,
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

  await assert.rejects(
    target.commitAuthorizedSnapshot(snapshot, authorization),
    /Case.*scope|authorization mismatch|batch.*Case/i,
  );
  assert.deepEqual(target.snapshot().caseTable, []);
});

test("Feishu projection rejects Job B authorization carrying a workflow row for Job A Gap Card", async () => {
  const target = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: target,
    productAdapters: [
      new MockWpsProductAdapter(),
      new MockQwenProductAdapter(),
      new MockDoubaoProductAdapter(),
    ],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const seeded = target.snapshot();
  const caseA = seeded.caseTable[0];
  const jobA = seeded.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  const gapCardA = seeded.productGapCardTable.find(
    ({ recordType }) => recordType === "gap_card",
  );
  assert.ok(caseA);
  assert.ok(jobA);
  if (gapCardA?.recordType !== "gap_card") {
    throw new Error("Expected Job A Product Gap Card");
  }
  const caseB = {
    ...caseA,
    recordId: "case-record-workflow-job-b",
    caseId: "case-workflow-job-b",
    title: "Workflow Job B Case",
  };
  const jobB = {
    ...jobA,
    recordId: "job-record-workflow-b",
    jobId: "job-workflow-b",
    caseId: caseB.caseId,
    selectedRunIds: [],
  };
  const crossJobWorkflowEvent = {
    recordType: "gap_card_workflow_event" as const,
    schemaVersion: "gap-card-workflow-event-v1" as const,
    workflowEventId: "workflow-event-job-b-for-job-a-card",
    gapCardId: gapCardA.gapCardId,
    decision: "rejected" as const,
    actorId: "reviewer-b",
    occurredAt: "2026-07-27T09:00:00.000Z",
    createdAt: "2026-07-27T09:00:00.000Z",
    lastSyncedAt: "2026-07-27T09:00:00.000Z",
    reason: "must not cross Job ownership",
    priorWorkflowEventId: null,
    provenance: gapCardA.provenance,
    environmentOrigin: gapCardA.environmentOrigin,
  };
  const snapshotB = {
    caseTable: [caseB],
    runRecordTable: [jobB],
    capturedArtifactTable: [],
    artifactScoreTable: [],
    adjudicationEventTable: [],
    reviewEventTable: [],
    gapCardWorkflowEventTable: [crossJobWorkflowEvent],
    githubIssueDeliveryReservationTable: [],
    githubIssueLinkEventTable: [],
    productGapCardTable: [],
    reports: [],
  };
  const authorizationB = await authorizeProjectionSnapshot(
    target,
    snapshotB,
    jobB.jobId,
    caseB,
  );

  await assert.rejects(
    target.commitAuthorizedSnapshot(snapshotB, authorizationB),
    /Gap Card.*Job|authorization mismatch|ownership/i,
  );
  assert.equal(
    target
      .snapshot()
      .gapCardWorkflowEventTable.some(
        ({ workflowEventId }) =>
          workflowEventId ===
          crossJobWorkflowEvent.workflowEventId,
      ),
    false,
  );
});

test("Feishu projection rejects a runtime-denied authorization even when destination and payload hash match", async () => {
  const source = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu: source,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = source.snapshot();
  const target = new InMemoryFeishuProjection();
  const payloadHash = sha256Bytes(canonicalJsonBytes(snapshot));
  const forgedAuthorization = {
    status: "denied",
    decisionId: "forged-projection-denial",
    policyVersion: "forged-policy",
    reason: "required redaction was not performed",
    decidedAt: "2026-07-27T00:00:00.000Z",
    request: {
      requestId: `operational-ledger-projection:wrong-job:${payloadHash}`,
      jobId: "wrong-job",
      runId: "wrong-run",
      attemptId: "wrong-attempt",
      dataClassification: "restricted",
      sourceOwner: "attacker-owner",
      processingPurpose: "operational_ledger_projection_storage",
      targetKind: "storage",
      targetService: target.egressDestination.targetService,
      targetAccount: target.egressDestination.targetAccount,
      targetRegion: target.egressDestination.targetRegion,
      subprocessors: target.egressDestination.subprocessors,
      contentFields: ["wrong_field"],
      payloadHash,
      requiredRedactions: ["secret"],
      requestedAt: "2026-07-27T00:00:00.000Z",
    },
  };

  await assert.rejects(
    target.commitAuthorizedSnapshot(
      snapshot,
      forgedAuthorization as never,
    ),
    /authorization.*invalid|authorization mismatch|denied|incompatible/i,
  );
  assert.deepEqual(target.snapshot().runRecordTable, []);
});

test("scrubbing one Job preserves a shared Case for an active Job without reporting it as expired-Job payload", async () => {
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapters: [new MockWpsProductAdapter()],
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const snapshot = feishu.snapshot();
  const sharedCase = snapshot.caseTable[0];
  const originalJob = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  assert.ok(sharedCase);
  assert.ok(originalJob);
  await feishu.appendRunRecord({
    ...originalJob,
    recordId: "shared-case-job-b",
    jobId: "shared-case-job-b",
    selectedRunIds: [],
  });

  await feishu.scrubPayloadsForJob("MOCK-job-volcano-v1");

  assert.equal(
    await feishu.hasPayloadsForJob("MOCK-job-volcano-v1"),
    false,
  );
  assert.deepEqual(
    feishu.snapshot().caseTable.map(({ caseId }) => caseId),
    [sharedCase.caseId],
  );
  await assert.doesNotReject(feishu.upsertCase(sharedCase));
  assert.ok(
    feishu
      .snapshot()
      .runRecordTable.some(({ jobId }) => jobId === "shared-case-job-b"),
  );
});

test("a tombstone racing a long vendor run prevents the final Feishu projection from resurrecting payloads", async () => {
  const delegate = new MockWpsProductAdapter();
  let releaseVendor = () => {};
  let signalStarted = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseVendor = resolve;
  });
  const adapter: ProductAdapterPort = {
    implementationPackage:
      testAdapterImplementationPackage("delayed-adapter-test"),
    executionConfigurationPackage:
      delegate.executionConfigurationPackage,
    productPackage: delegate.productPackage,
    async execute(command) {
      signalStarted();
      await release;
      return delegate.execute(command);
    },
  };
  const tombstones = new InMemoryTombstoneLedger();
  const inventory = new InMemoryPayloadInventory(tombstones);
  const feishu = new InMemoryFeishuProjection();
  const pending = createBakeoffHarness({
    feishu,
    productAdapters: [adapter],
    egressAuthorization: APPROVED_EGRESS,
    tombstones,
    payloadInventory: inventory,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  await started;
  await tombstones.append({
    schemaVersion: "retention-tombstone-v1",
    tombstoneId: "tombstone-racing-job",
    jobId: "MOCK-job-volcano-v1",
    subjectIds: [],
    expiredAt: "2026-01-01T00:00:00.000Z",
    payloadLocations: await inventory.list("MOCK-job-volcano-v1"),
  });
  releaseVendor();

  await assert.rejects(pending, /tombstoned/i);
  assert.deepEqual(feishu.snapshot(), {
    caseTable: [],
    runRecordTable: [],
    capturedArtifactTable: [],
    artifactScoreTable: [],
    adjudicationEventTable: [],
    reviewEventTable: [],
    gapCardWorkflowEventTable: [],
    githubIssueDeliveryReservationTable: [],
    githubIssueLinkEventTable: [],
    productGapCardTable: [],
    reports: [],
  });
});

test("a recovery rehearsal rebuilds a complete hash-validated Job from the external ledger export, Run specs, and secondary Artifact copy only", async () => {
  const primary = new InMemoryImmutableBlobStore("primary");
  const secondary = new InMemoryImmutableBlobStore("secondary");
  const recovery = new InMemoryImmutableBlobStore("recovery");
  const tombstones = new InMemoryTombstoneLedger();
  const payloadInventory = new InMemoryPayloadInventory(tombstones);
  const egressAudit = new InMemoryEgressAuthorizationAudit();
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit,
    captureJournal: new InMemoryArtifactCaptureJournal(),
    payloadInventory,
  });
  const runSpecificationVault = createRunSpecificationVault({
    store: recovery,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit,
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
  let recoveryNow = "2026-01-01T00:19:00.000Z";
  const recoveryClock: ClockPort = {
    now: () => recoveryNow,
  };
  const recoveryService = createOperationalLedgerRecoveryService({
    recoveryStore: recovery,
    artifactVault,
    runSpecificationVault,
    tombstones,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit,
    payloadInventory,
    clock: recoveryClock,
  });
  const snapshot = feishu.snapshot();
  const adjudication = snapshot.adjudicationEventTable[0];
  const capturedForConflict = snapshot.capturedArtifactTable[0];
  const recoveryVendorRun = snapshot.runRecordTable.find(
    ({ recordType }) => recordType === "vendor_run",
  );
  assert.ok(adjudication);
  assert.ok(capturedForConflict);
  assert.ok(recoveryVendorRun?.specificationReference);
  await assert.rejects(
    recoveryService.exportLedger({
      exportId: "ledger-export-artifact-metadata-conflict",
      jobId: "MOCK-job-volcano-v1",
      checkpoint: "run-record-seq:3",
      snapshot: {
        ...snapshot,
        capturedArtifactTable: [
          {
            ...capturedForConflict,
            artifact: {
              ...capturedForConflict.artifact,
              filename: "conflicting-feishu-metadata.pptx",
            },
          },
        ],
      },
      createdAt: "2026-01-01T00:13:00.000Z",
      encryption: "test-managed-key-v1",
      retentionExpiresAt: "2026-02-01T00:00:00.000Z",
    }),
    /artifact recovery.*lineage.*inconsistent/i,
  );
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
      egressAudit,
      payloadInventory,
      clock: recoveryClock,
    }).rehearse({
      exportReference: exported,
      rehearsedAt: "2026-01-01T00:19:00.000Z",
    }),
    /run specification.*lineage.*case/i,
  );

  recoveryNow = "2026-01-01T00:20:00.000Z";
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
  let crossingClockCalls = 0;
  const crossingExpiryService = createOperationalLedgerRecoveryService({
    recoveryStore: recovery,
    artifactVault,
    runSpecificationVault,
    tombstones,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit,
    payloadInventory,
    clock: {
      clockId: "crossing-expiry-recovery-clock",
      now: () =>
        crossingClockCalls++ === 0
          ? "2026-01-31T23:59:59.000Z"
          : "2026-02-01T00:00:01.000Z",
    },
  });
  await assert.rejects(
    crossingExpiryService.rehearse({
      exportReference: exported,
      rehearsedAt: "2026-01-31T23:59:59.000Z",
    }),
    /expired during rehearsal/i,
  );
  await assert.rejects(
    runSpecificationVault.read({
      ...recoveryVendorRun.specificationReference,
      schemaVersion: "tampered-run-spec-reference" as never,
    }),
    /persisted egress authorization|store mismatch|hash mismatch|run specification/i,
  );
  const tamperedSpecificationAuthorization = {
    ...recoveryVendorRun.specificationReference.egressAuthorization,
    policyVersion: "attacker-recomputed-policy",
  };
  await assert.rejects(
    runSpecificationVault.read({
      ...recoveryVendorRun.specificationReference,
      egressAuthorization: tamperedSpecificationAuthorization,
      egressAuthorizationHash: approvedEgressAuthorizationHash(
        tamperedSpecificationAuthorization,
      ),
    }),
    /authorization.*audit|persisted egress authorization.*invalid/i,
  );
  await assert.rejects(
    recoveryService.rehearse({
      exportReference: {
        ...exported,
        egressAuthorization: {
          ...exported.egressAuthorization,
          status: "denied",
          reason: "tampered persisted decision",
          decidedAt: recoveryNow,
        } as never,
      },
      rehearsedAt: recoveryNow,
    }),
    /authorization audit evidence is invalid|persisted egress authorization decision is invalid/i,
  );
  await assert.rejects(
    recoveryService.rehearse({
      exportReference: {
        ...exported,
        egressAuthorization: {
          ...exported.egressAuthorization,
          expiresAt: exported.egressAuthorization.request.requestedAt,
        },
      },
      rehearsedAt: recoveryNow,
    }),
    /authorization audit evidence is invalid|persisted egress authorization decision is invalid/i,
  );
  await assert.rejects(
    recoveryService.rehearse({
      exportReference: {
        ...exported,
        retentionExpiresAt: "2099-01-01T00:00:00.000Z",
      },
      rehearsedAt: recoveryNow,
    }),
    /export lineage mismatch/i,
  );
  recoveryNow = exported.retentionExpiresAt;
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
  const egressAudit = new InMemoryEgressAuthorizationAudit();
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit,
    captureJournal: new InMemoryArtifactCaptureJournal(),
    payloadInventory: inventory,
  });
  const runSpecificationVault = createRunSpecificationVault({
    store: recovery,
    egressAuthorization: APPROVED_EGRESS,
    egressAudit,
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
    egressAudit,
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
  const expiredCase = feishu.snapshot().caseTable[0];
  const expiredCapture = feishu.snapshot().capturedArtifactTable[0];
  assert.ok(vendorRun?.artifactPackageManifest);
  assert.ok(vendorRun.specificationReference);
  assert.ok(expiredCase);
  assert.ok(expiredCapture);
  const quarantineContent = new TextEncoder().encode("quarantine-redaction");
  const quarantineHash =
    "sha256:6522847fd9c23d726ae26793b8ba71fefab67ca748608141e2b80236d35a4cf8" as const;
  await quarantine.putImmutable(
    "quarantine/MOCK-job-volcano-v1/redaction-failure-001",
    quarantineContent,
    {
      jobId: "MOCK-job-volcano-v1",
      contentHash: quarantineHash,
      writeAttemptId: "quarantine-redaction-failure-001",
      assertWriteAuthorized: () => {},
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
  assert.deepEqual(feishu.snapshot(), {
    caseTable: [],
    runRecordTable: [],
    capturedArtifactTable: [],
    artifactScoreTable: [],
    adjudicationEventTable: [],
    reviewEventTable: [],
    gapCardWorkflowEventTable: [],
    githubIssueDeliveryReservationTable: [],
    githubIssueLinkEventTable: [],
    productGapCardTable: [],
    reports: [],
  });
  await assert.rejects(
    feishu.appendCapturedArtifact(expiredCapture),
    /tombstoned.*projection write/i,
  );
  await assert.rejects(
    feishu.upsertCase(expiredCase),
    /tombstoned Case.*projection write/i,
  );
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
        writeAttemptId: "post-retention-resurrection-attempt",
        assertWriteAuthorized: () => {},
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
