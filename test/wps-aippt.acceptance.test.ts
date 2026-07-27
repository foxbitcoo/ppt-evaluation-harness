import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  MockWpsProductAdapter,
  BUILD_IDENTITY,
  BUILD_SPEC_COMMIT_SHA,
  FileSystemAttemptCheckpointStore,
  FileSystemBrowserProfileLock,
  InMemoryAttemptCheckpointStore,
  InMemoryEgressAuthorizationAudit,
  InMemoryFeishuProjection,
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
  ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  VOLCANO_EVALUATION_CASE,
  VENDOR_GENERATION_TIMEOUT_MS,
  WPS_AIPPT_URL,
  WpsAiPptProductAdapter,
  createWpsAiPptBrowserDriverPackage,
  createBakeoffHarness,
  createHarnessOwnedProductionCapabilities,
  parseAdapterExecutionConfiguration,
  type ProductAttemptResult,
  type ProductAdapterPort,
  type ArtifactVault,
  type AttemptCheckpointPort,
  type BrowserProfileLockPort,
  type RunSpecificationVault,
  type SafeRasterRendererPort,
  type WpsAiPptBrowserDriverPort,
  type WpsAiPptBrowserResult,
  type WpsAiPptCapturedBrowserResult,
} from "../src/index.ts";
import { resolveHarnessProductAdapterExecutor } from "../src/mock-wps.ts";
import {
  reconcileHarnessOwnedWpsAiPptTask,
  runHarnessOwnedWpsAiPptBrowser,
} from "../src/wps-aippt-external-runtime.ts";

const execFileAsync = promisify(execFile);

test("the WPS AI PPT production adapter is a pure-data descriptor for the frozen package", () => {
  const adapter: ProductAdapterPort = new WpsAiPptProductAdapter();

  assert.equal(WPS_AIPPT_URL, "https://aippt.wps.cn/aippt/");
  assert.deepEqual(adapter.productPackage.experienceConfiguration, {
    productUrl: WPS_AIPPT_URL,
    accountScope: "current_authenticated_account",
    accountObservationPolicy:
      "observe_category_or_record_ui_unavailable",
    commercialPlanObservationPolicy:
      "observe_plan_name_or_record_ui_unavailable",
    packageSelection: "best_available_zero_incremental_cost",
    incrementalCost: 0,
    mode: "professional",
    networking: "enabled",
    pageCount: 16,
  });
  assert.equal(adapter.productPackage.provenance, "PRODUCTION");
  assert.equal(
    adapter.productPackage.environmentOrigin.environment,
    "production",
  );
  assert.equal(
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ).adapterKind,
    "wps-aippt-browser",
  );
  assert.equal("execute" in adapter, false);
  assert.equal("factory" in adapter, false);
});

async function knownGoodPptxBytes(): Promise<Uint8Array> {
  const mock = new MockWpsProductAdapter();
  const execute = resolveHarnessProductAdapterExecutor(
    mock.implementationPackage,
    parseAdapterExecutionConfiguration(
      mock.executionConfigurationPackage,
    ),
  );
  const artifact = await execute({
    jobId: "fixture-job",
    runId: "fixture-run",
    attemptId: "fixture-attempt",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok("content" in artifact);
  return artifact.content;
}

function capturedBrowserResult(
  pptx: Uint8Array,
  submissionEvidence: "submitted" | "unknown" = "submitted",
  renderOutcome: "faithful" | "degraded" = "faithful",
): WpsAiPptCapturedBrowserResult {
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return {
    outcome: "captured",
    submissionEvidence,
    elapsedMs: 120_000,
    observedConfiguration: {
      productUrl: WPS_AIPPT_URL,
      accountScope: "current_authenticated_account",
      accountObservationPolicy:
        "observe_category_or_record_ui_unavailable",
      commercialPlanObservationPolicy:
        "observe_plan_name_or_record_ui_unavailable",
      packageSelection: "best_available_zero_incremental_cost",
      incrementalCost: 0,
      mode: "professional",
      networking: "enabled",
      pageCount: 16,
      evidenceIds: [
        "ev_0000000000000001",
        "ev_0000000000000002",
      ],
      accountCategoryObservation: {
        status: "ui_unavailable",
        reason: "account category control was not visible",
        evidenceId: "ev_0000000000000001",
      },
      commercialPlanObservation: {
        status: "ui_unavailable",
        reason: "commercial plan control was not visible",
        evidenceId: "ev_0000000000000002",
      },
    },
    events: [
      {
        eventType: "configuration_observed",
        sourceAt: "2026-07-27T06:00:00.000Z",
        observedAt: "2026-07-27T06:00:01.000Z",
        evidenceId: "ev_0000000000000001",
        sourceUrl:
          "https://aippt.wps.cn/aippt/?task=redacted#step",
        submissionEvidenceAtCheckpoint: "not_submitted",
        vendorTaskId: "task_wps_volcano_20260727",
        taskStateVersion: "created@1",
        adapterVersion: "wps-aippt-browser@1",
        artifactId: null,
      },
      {
        eventType: "artifact_downloaded",
        sourceAt: "2026-07-27T06:02:00.000Z",
        observedAt: "2026-07-27T06:02:01.000Z",
        evidenceId: "ev_0000000000000002",
        sourceUrl: "https://365.kdocs.cn/l/redacted?auth=removed",
        submissionEvidenceAtCheckpoint: "submitted",
        vendorTaskId: "task_wps_volcano_20260727",
        taskStateVersion: "artifact_ready@6",
        adapterVersion: "wps-aippt-browser@1",
        artifactId: "artifact_wps_volcano_16",
      },
    ],
    manualActions: ["selected professional mode"],
    artifact: {
      filename: "wps-volcano-16.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: pptx,
      pageCount: 16,
      capturedAt: "2026-07-27T06:02:01.000Z",
    },
    render: {
      renderer: "chrome-native-static-capture@1",
      fontPack: "wps-web-current",
      resolution: "1280x720",
      colorProfile: "sRGB",
      redactionStatus: "passed",
      renderOutcome,
      fidelity: {
        status: renderOutcome === "faithful" ? "verified" : "degraded",
        notes:
          renderOutcome === "faithful"
            ? []
            : ["local renderer substituted Chinese glyphs"],
      },
      slides: Array.from({ length: 16 }, (_, index) => {
        const pageNumber = index + 1;
        return {
          pageNumber,
          filename: `slide-${pageNumber}.png`,
          mimeType: "image/png" as const,
          content: png,
          extractedText: `WPS page ${pageNumber}`,
        };
      }),
      contactSheet: {
        filename: "contact-sheet.png",
        mimeType: "image/png",
        content: png,
      },
    },
  };
}

function pngWithCorruptIdatAndValidCrc(content: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(content);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 1
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
    return value >>> 0;
  });
  let offset = 8;
  while (offset + 12 <= copy.byteLength) {
    const length = view.getUint32(offset, false);
    const type = new TextDecoder().decode(
      copy.subarray(offset + 4, offset + 8),
    );
    if (type === "IDAT") {
      copy[offset + 8] = (copy[offset + 8] ?? 0) ^ 0xff;
      let crc = 0xffffffff;
      for (const byte of copy.subarray(offset + 4, offset + 8 + length)) {
        crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
      }
      view.setUint32(offset + 8 + length, (crc ^ 0xffffffff) >>> 0, false);
      return copy;
    }
    offset += 12 + length;
  }
  throw new Error("PNG fixture has no IDAT chunk");
}

function testCrc32(content: Uint8Array): number {
  const table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 1
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of content) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZipEntryOffsets(
  content: Uint8Array,
  entryName: string,
): {
  readonly centralOffset: number;
  readonly localOffset: number;
  readonly dataStart: number;
  readonly dataLength: number;
} {
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let eocd = -1;
  for (let offset = content.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1);
  let centralOffset = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const name = new TextDecoder().decode(
      content.subarray(
        centralOffset + 46,
        centralOffset + 46 + nameLength,
      ),
    );
    if (name === entryName) {
      const localOffset = view.getUint32(centralOffset + 42, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      return {
        centralOffset,
        localOffset,
        dataStart: localOffset + 30 + localNameLength + localExtraLength,
        dataLength: view.getUint32(centralOffset + 20, true),
      };
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing ZIP fixture entry: ${entryName}`);
}

function mutateStoredZipEntryText(
  content: Uint8Array,
  entryName: string,
  from: string,
  to: string,
): Uint8Array {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const copy = Uint8Array.from(content);
  const offsets = storedZipEntryOffsets(copy, entryName);
  const entry = copy.subarray(
    offsets.dataStart,
    offsets.dataStart + offsets.dataLength,
  );
  const position = Buffer.from(entry).indexOf(Buffer.from(from));
  assert.notEqual(position, -1);
  entry.set(new TextEncoder().encode(to), position);
  const crc = testCrc32(entry);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setUint32(offsets.localOffset + 14, crc, true);
  view.setUint32(offsets.centralOffset + 16, crc, true);
  return copy;
}

function browserDriverPackage(
  result: WpsAiPptBrowserResult,
  provenance: "PRODUCTION" | "TEST_FAKE" = "TEST_FAKE",
): WpsAiPptBrowserDriverPort {
  return createWpsAiPptBrowserDriverPackage({
    provenance,
    sessions: [result],
  });
}

test("the public browser-driver fixture factory cannot mint PRODUCTION sessions", async () => {
  const pptx = await knownGoodPptxBytes();

  assert.throws(
    () =>
      createWpsAiPptBrowserDriverPackage({
        provenance: "PRODUCTION",
        sessions: [capturedBrowserResult(pptx)],
      }),
    /cannot mint PRODUCTION|TEST_FAKE fixture/i,
  );
});

test("production rejects default in-memory recovery dependencies before driver execution", async () => {
  await assert.rejects(
    async () =>
      createBakeoffHarness({
        feishu: new InMemoryFeishuProjection({
          targetEnvironment: "production",
        }),
        productAdapter: new WpsAiPptProductAdapter(),
        egressAuthorization: {
          async authorize() {
            throw new Error("durability preflight must run before egress");
          },
        },
        rendererDestination:
          ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
      }).startBakeoffJob({
        environment: "production",
        caseId: VOLCANO_EVALUATION_CASE.caseId,
      }),
    /production.*durable.*ArtifactVault/i,
  );
});

test("production rejects caller objects that merely self-report durable and isolated capabilities", async () => {
  const artifactVault = {
    storageProfile: {
      durability: "durable",
      primaryStoreId: "test-primary",
      secondaryStoreId: "test-recovery",
      recoveryReferencePrefix: "store:test-recovery:key",
    },
    async capture() {
      throw new Error("must not capture");
    },
    async readFromSecondary() {
      throw new Error("must not read");
    },
  } as ArtifactVault;
  const runSpecificationVault = {
    storageProfile: {
      durability: "durable",
      storeId: "test-run-spec",
      recoveryReferencePrefix: "store:test-run-spec:key",
    },
    async capture() {
      throw new Error("must not capture");
    },
    async read() {
      throw new Error("must not read");
    },
    retentionLocation() {
      throw new Error("must not resolve retention");
    },
  } as RunSpecificationVault;
  const attemptCheckpointStore: AttemptCheckpointPort = {
    checkpointStoreId: "test-durable-checkpoints",
    durability: "durable",
    recoveryReferencePrefix: "checkpoint:test",
    async append() {
      throw new Error("must not append");
    },
  };
  const browserProfileLock: BrowserProfileLockPort = {
    lockId: "test-cross-process-lock",
    isolation: "cross_process",
    async runExclusive(_profileDigest, operation) {
      return await operation();
    },
  };
  const safeRasterRenderer: SafeRasterRendererPort = {
    rendererId: "test-authorized-renderer",
    async render() {
      throw new Error("must not render");
    },
  };

  await assert.rejects(
    async () =>
      createBakeoffHarness({
        feishu: new InMemoryFeishuProjection({
          targetEnvironment: "production",
        }),
        productAdapter: new WpsAiPptProductAdapter(),
        artifactVault,
        runSpecificationVault,
        attemptCheckpointStore,
        browserProfileLock,
        safeRasterRenderer,
        rendererDestination:
          ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
        egressAuthorization: {
          async authorize() {
            throw new Error("must not authorize");
          },
        },
      }).startBakeoffJob({
        environment: "production",
        caseId: VOLCANO_EVALUATION_CASE.caseId,
      }),
    /production.*harness-owned attested capabilities/i,
  );
});

test("harness-owned production capabilities require distinct configured Artifact failure domains", () => {
  const tombstones = new InMemoryTombstoneLedger(
    "capability-failure-domain-test",
  );
  const payloadInventory = new InMemoryPayloadInventory(tombstones);
  assert.throws(
    () =>
      createHarnessOwnedProductionCapabilities({
        artifactPrimary: {
          failureDomainId: "same-domain",
          rootPath: "/tmp/capability-primary-domain/store",
          rootReference: "root:capability-primary",
          storeId: "capability-primary-store",
        },
        artifactRecovery: {
          failureDomainId: "same-domain",
          rootPath: "/tmp/capability-recovery-domain/store",
          rootReference: "root:capability-recovery",
          storeId: "capability-recovery-store",
        },
        runSpecification: {
          failureDomainId: "run-spec-domain",
          rootPath: "/tmp/capability-run-spec-domain/store",
          rootReference: "root:capability-run-spec",
          storeId: "capability-run-spec-store",
        },
        checkpoint: {
          rootPath: "/tmp/capability-checkpoint-domain/store",
          rootReference: "root:capability-checkpoint",
          storeId: "capability-checkpoint-store",
        },
        profileLock: {
          rootPath: "/tmp/capability-lock-domain/store",
          rootReference: "root:capability-lock",
          lockId: "capability-profile-lock",
        },
        renderer: {
          rendererId: "capability-renderer",
          slidesDirectory: "/tmp/unused-renderer-slides",
          extractedTextPrefix: "page",
          fontPack: "test",
          resolution: "1x1",
          colorProfile: "sRGB",
          fidelityNotes: ["test"],
        },
        tombstones,
        payloadInventory,
        egressAuthorization: {
          async authorize() {
            throw new Error("must not authorize during construction");
          },
        },
        egressAudit: new InMemoryEgressAuthorizationAudit(),
      }),
    /distinct failure domains and roots/i,
  );
});

test("a runtime source-revision override cannot replace the embedded verified build manifest", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        "await import('./src/build-identity.ts')",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          PPT_EVALUATION_BUILD_SPEC_COMMIT_SHA:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    ),
    /runtime source revision does not match embedded build manifest/i,
  );
});

test("the embedded build manifest verifies the exact executable source archive", () => {
  assert.deepEqual(
    {
      source: BUILD_IDENTITY.source,
      sourceArchiveDigest: BUILD_IDENTITY.sourceArchiveDigest,
      sourceArchiveEntryCount:
        BUILD_IDENTITY.sourceArchiveEntryCount,
    },
    {
      source: "EMBEDDED_VERIFIED_BUILD_MANIFEST",
      sourceArchiveDigest:
        "sha256:c3562301401205c7b6dbc4d9da801bf42048ad9a2acd93612b6f5e688ee73ac6",
      sourceArchiveEntryCount: 34,
    },
  );
});

function testWpsBoundaryAdapter(
  packageId = "MOCK-wps-aippt-browser-package-v1",
): ProductAdapterPort {
  const productionAdapter = new WpsAiPptProductAdapter();
  return {
    implementationPackage:
      productionAdapter.implementationPackage,
    executionConfigurationPackage:
      productionAdapter.executionConfigurationPackage,
    productPackage: {
      ...productionAdapter.productPackage,
      packageId,
      displayName: "Mock-boundary WPS AI PPT",
      provenance: "MOCK",
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      egressDestination: {
        targetService: "mock-wps-aippt-browser",
        targetAccount: "mock-current-account",
        targetRegion: "test",
        subprocessors: [],
      },
    },
  };
}

test("the trusted registry executes the WPS package only through the registered browser-driver package", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(capturedBrowserResult(pptx));
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "test-wps-checkpoints",
  );

  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: driver,
      attemptCheckpointStore: checkpoints,
    },
  );
  const result = (await execute({
    jobId: "job-wps-real",
    runId: "run-wps-real",
    attemptId: "attempt-wps-real-1",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  })) as ProductAttemptResult;

  assert.equal(result.terminalReason, "success");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(result.artifactCandidates.length, 1);
  assert.equal(
    result.artifactCandidates[0]?.artifact.provenance,
    "MOCK",
  );
  assert.equal(
    result.artifactCandidates[0]?.artifact.pageCount,
    16,
  );
  assert.equal(
    result.artifactCandidates[0]?.safeRasterCandidate?.slides.length,
    16,
  );
  assert.match(
    result.artifactCandidates[0]?.artifact.contentHash ?? "",
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(
    result.observableEvents?.map(({ eventType }) => eventType),
    ["configuration_observed", "artifact_downloaded"],
  );
  assert.deepEqual(
    checkpoints.snapshot().map((event) => ({
      evidenceRef: event.evidenceRef,
      sourceUrl: event.sourceUrl,
      submissionEvidenceAtCheckpoint:
        event.submissionEvidenceAtCheckpoint,
    })),
    [
      {
        evidenceRef: "ev_0000000000000001",
        sourceUrl: "https://aippt.wps.cn/aippt/",
        submissionEvidenceAtCheckpoint: "not_submitted",
      },
      {
        evidenceRef: "ev_0000000000000002",
        sourceUrl: "https://365.kdocs.cn/l/redacted",
        submissionEvidenceAtCheckpoint: "submitted",
      },
    ],
  );
});

test("production rejects an arbitrary browser closure that is not backed by the harness allowlist packages", async () => {
  const forgedDriver = {
    driverId: "wps-aippt-test-fixture",
    provenance: "PRODUCTION",
    async run() {
      throw new Error("must never execute");
    },
  } as unknown as WpsAiPptBrowserDriverPort;

  await assert.rejects(
    async () =>
      createBakeoffHarness({
        feishu: new InMemoryFeishuProjection({
          targetEnvironment: "production",
        }),
        productAdapter: new WpsAiPptProductAdapter(),
        wpsAiPptBrowserDriver: forgedDriver,
        rendererDestination:
          ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION,
      egressAuthorization: {
          async authorize() {
            throw new Error("driver allowlist must run before egress");
          },
        },
      }).startBakeoffJob({
        environment: "production",
        caseId: VOLCANO_EVALUATION_CASE.caseId,
      }),
    /registered browser driver package|implementation package.*allowlisted/i,
  );
});

test("the Run Specification uses the harness build identity instead of a caller-supplied SHA", async () => {
  const pptx = await knownGoodPptxBytes();
  const feishu = new InMemoryFeishuProjection();
  await createBakeoffHarness({
    feishu,
    productAdapter: testWpsBoundaryAdapter(
      "MOCK-wps-build-identity-package-v1",
    ),
    wpsAiPptBrowserDriver: browserDriverPackage(
      capturedBrowserResult(pptx),
    ),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  const reference = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "vendor_run")
    ?.specificationReference;
  assert.equal(
    reference?.specCommitSha,
    BUILD_SPEC_COMMIT_SHA,
  );
});

test("the Bakeoff harness owns WPS browser-driver injection and still blocks production lineage in test", async () => {
  const driver = createWpsAiPptBrowserDriverPackage({
    provenance: "TEST_FAKE",
    sessions: [],
  });

  await assert.rejects(
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection(),
      productAdapter: new WpsAiPptProductAdapter(),
      wpsAiPptBrowserDriver: driver,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /test rejected Product Package/,
  );
});

test("WPS observable Trace rejects credential-bearing evidence before persistence", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const driver = browserDriverPackage({
        outcome: "technical_failure",
        submissionEvidence: "unknown",
        elapsedMs: 1,
        events: [
          {
            eventType: "submission_reconcile_failed access_token",
            sourceAt: "2026-07-27T06:00:00.000Z",
            observedAt: "2026-07-27T06:00:01.000Z",
            evidenceId: "ev_0000000000000003",
            sourceUrl: "https://aippt.wps.cn/aippt/",
            submissionEvidenceAtCheckpoint: "unknown",
            vendorTaskId: "task_wps_sensitive_trace",
            taskStateVersion: "unknown@1",
            adapterVersion: "wps-aippt-browser@1",
            artifactId: null,
          },
        ],
        manualActions: [],
      });
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { wpsAiPptBrowserDriver: driver },
  );

  await assert.rejects(
    execute({
      jobId: "job-wps-trace",
      runId: "run-wps-trace",
      attemptId: "attempt-wps-trace-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /not safe to persist/,
  );
});

test("WPS Trace rejects non-WPS origins and JWT-like path evidence", async () => {
  const adapter = new WpsAiPptProductAdapter();
  for (const sourceUrl of [
    "https://evil.example/aippt/",
    "https://aippt.wps.cn/aippt/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.c2lnbmF0dXJlMTIzNDU2",
  ]) {
    const failed: WpsAiPptBrowserResult = {
      outcome: "technical_failure",
      submissionEvidence: "unknown",
      elapsedMs: 1,
      events: [
        {
          eventType: "task_state_observed",
          sourceAt: "2026-07-27T06:00:00.000Z",
          observedAt: "2026-07-27T06:00:01.000Z",
          evidenceId: "ev_0000000000000300",
          sourceUrl,
          submissionEvidenceAtCheckpoint: "unknown",
          vendorTaskId: "task_wps_url_validation",
          taskStateVersion: "unknown@1",
          adapterVersion: "wps-aippt-browser@1",
          artifactId: null,
        },
      ],
      manualActions: [],
    };
    const execute = resolveHarnessProductAdapterExecutor(
      adapter.implementationPackage,
      parseAdapterExecutionConfiguration(
        adapter.executionConfigurationPackage,
      ),
      {
        wpsAiPptBrowserDriver:
          createWpsAiPptBrowserDriverPackage({
            provenance: "TEST_FAKE",
            sessions: [failed],
          }),
      },
    );
    await assert.rejects(
      execute({
        jobId: "job-wps-url",
        runId: "run-wps-url",
        attemptId: "attempt-wps-url-1",
        attemptSeq: 1,
        timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
        signal: new AbortController().signal,
        evaluationCase: VOLCANO_EVALUATION_CASE,
      }),
      /allowlisted WPS URL|JWT-like/i,
    );
  }
});

test("a captured WPS Artifact must carry proved submission evidence", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(
    capturedBrowserResult(pptx, "unknown"),
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    { wpsAiPptBrowserDriver: driver },
  );

  await assert.rejects(
    execute({
      jobId: "job-wps-unknown",
      runId: "run-wps-unknown",
      attemptId: "attempt-wps-unknown-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /captured Artifact requires submitted evidence/,
  );
});

test("the WPS adapter rejects a PPTX whose ZIP central-directory CRC does not match its entry bytes", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const corrupted = Uint8Array.from(await knownGoodPptxBytes());
  const view = new DataView(
    corrupted.buffer,
    corrupted.byteOffset,
    corrupted.byteLength,
  );
  let centralOffset = -1;
  for (let offset = 0; offset + 46 <= corrupted.byteLength; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      centralOffset = offset;
      break;
    }
  }
  assert.notEqual(centralOffset, -1);
  view.setUint32(
    centralOffset + 16,
    view.getUint32(centralOffset + 16, true) ^ 0xffffffff,
    true,
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: browserDriverPackage(
        capturedBrowserResult(corrupted),
      ),
    },
  );

  await assert.rejects(
    execute({
      jobId: "job-wps-crc",
      runId: "run-wps-crc",
      attemptId: "attempt-wps-crc-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /CRC|ZIP|OPC/i,
  );
});

test("the WPS adapter rejects a ZIP whose local CRC disagrees with the central record", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const corrupted = Uint8Array.from(await knownGoodPptxBytes());
  const offsets = storedZipEntryOffsets(
    corrupted,
    "ppt/presentation.xml",
  );
  const view = new DataView(
    corrupted.buffer,
    corrupted.byteOffset,
    corrupted.byteLength,
  );
  view.setUint32(
    offsets.localOffset + 14,
    view.getUint32(offsets.localOffset + 14, true) ^ 0xffffffff,
    true,
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: browserDriverPackage(
        capturedBrowserResult(corrupted),
      ),
    },
  );
  await assert.rejects(
    execute({
      jobId: "job-wps-local-crc",
      runId: "run-wps-local-crc",
      attemptId: "attempt-wps-local-crc-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /local.*CRC|local ZIP header mismatch/i,
  );
});

test("the WPS adapter decodes XML entities before rejecting external relationships", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const corrupted = mutateStoredZipEntryText(
    await knownGoodPptxBytes(),
    "_rels/.rels",
    "ppt/presentation.xml",
    "h&#116;tp://x.co/xyz",
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: browserDriverPackage(
        capturedBrowserResult(corrupted),
      ),
    },
  );
  await assert.rejects(
    execute({
      jobId: "job-wps-obfuscated-external",
      runId: "run-wps-obfuscated-external",
      attemptId: "attempt-wps-obfuscated-external-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /external relationship.*forbidden/i,
  );
});

test("the WPS adapter requires every presentation slide ID to resolve through its relationships", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const corrupted = mutateStoredZipEntryText(
    await knownGoodPptxBytes(),
    "ppt/presentation.xml",
    'r:id="rId1"',
    'r:id="rIx1"',
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: browserDriverPackage(
        capturedBrowserResult(corrupted),
      ),
    },
  );
  await assert.rejects(
    execute({
      jobId: "job-wps-slide-relationship",
      runId: "run-wps-slide-relationship",
      attemptId: "attempt-wps-slide-relationship-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /presentation slide IDs.*relationships/i,
  );
});

test("presentation page counting ignores sldId markup inside XML comments", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const original =
    '<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/><p:sldId id="259" r:id="rId4"/>';
  const commented =
    '<!--<p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/><p:sldId id="3" r:id="rId3"/><p:sldId id="4" r:id="rId4"/>--> ';
  const corrupted = mutateStoredZipEntryText(
    await knownGoodPptxBytes(),
    "ppt/presentation.xml",
    original,
    commented,
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: browserDriverPackage(
        capturedBrowserResult(corrupted),
      ),
    },
  );
  await assert.rejects(
    execute({
      jobId: "job-wps-commented-slide-ids",
      runId: "run-wps-commented-slide-ids",
      attemptId: "attempt-wps-commented-slide-ids-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /presentation slide IDs.*relationships/i,
  );
});

test("presentation page counting ignores sldId markup inside CDATA", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const original =
    '<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/><p:sldId id="259" r:id="rId4"/><p:sldId id="260" r:id="rId5"/><p:sldId id="261" r:id="rId6"/>';
  const cdata =
    '<![CDATA[<p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/><p:sldId id="3" r:id="rId3"/><p:sldId id="4" r:id="rId4"/><p:sldId id="5" r:id="rId5"/><p:sldId id="6" r:id="rId6"/>]]>';
  const corrupted = mutateStoredZipEntryText(
    await knownGoodPptxBytes(),
    "ppt/presentation.xml",
    original,
    cdata,
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: browserDriverPackage(
        capturedBrowserResult(corrupted),
      ),
    },
  );
  await assert.rejects(
    execute({
      jobId: "job-wps-cdata-slide-ids",
      runId: "run-wps-cdata-slide-ids",
      attemptId: "attempt-wps-cdata-slide-ids-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: VOLCANO_EVALUATION_CASE,
    }),
    /presentation slide IDs.*relationships/i,
  );
});

test("the harness persists WPS observable Trace and the driver-provided 16-page static render", async () => {
  const productionAdapter = new WpsAiPptProductAdapter();
  const pptx = await knownGoodPptxBytes();
  const driver = browserDriverPackage(capturedBrowserResult(pptx));
  const testDescriptor: ProductAdapterPort = {
    implementationPackage:
      productionAdapter.implementationPackage,
    executionConfigurationPackage:
      productionAdapter.executionConfigurationPackage,
    productPackage: {
      ...productionAdapter.productPackage,
      packageId: "MOCK-wps-aippt-browser-package-v1",
      displayName: "Mock-boundary WPS AI PPT",
      provenance: "MOCK",
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
      egressDestination: {
        targetService: "mock-wps-aippt-browser",
        targetAccount: "mock-current-account",
        targetRegion: "test",
        subprocessors: [],
      },
    },
  };
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: testDescriptor,
    wpsAiPptBrowserDriver: driver,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(
    outcome.renderManifest?.renderer,
    "chrome-native-static-capture@1",
  );
  assert.equal(outcome.renderManifest?.slides.length, 16);
  const attempt = feishu
    .snapshot()
    .runRecordTable.find(
      ({ recordType }) => recordType === "evaluation_attempt",
    );
  assert.deepEqual(
    attempt?.observableEvents?.map(({ eventType }) => eventType),
    ["configuration_observed", "artifact_downloaded"],
  );
  assert.deepEqual(attempt?.manualActions, [
    "selected professional mode",
  ]);
});

test("the public WPS real-smoke fixture records one safe 16-page capture without browser secrets or local paths", () => {
  const fixtureText = readFileSync(
    new URL(
      "../docs/smoke/wps-aippt-real-smoke-2026-07-27.json",
      import.meta.url,
    ),
    "utf8",
  );
  const fixture = JSON.parse(fixtureText) as {
    artifact: {
      byteSize: number;
      contentHash: string;
      pageCount: number;
    };
    execution: {
      retryCount: number;
      submitCount: number;
    };
    observableEvents: Array<{ eventType: string }>;
    render: {
      contactSheetHash: string;
      contactSheetDimensions: string;
      contactSheetComposition: string;
      fidelityStatus: string;
      outcome: string;
      pageCount: number;
      staticSlideHashes: string[];
      visualAssessment: string;
    };
    durableRecoveryRehearsal: {
      artifactStorage: {
        primaryFailureDomainId: string;
        recoveryFailureDomainId: string;
        recoveryStoreId: string;
        originalRecoveryKey: string;
        originalRecoveryHash: string;
      };
      runSpecificationStorage: {
        caseProvenance: string;
        storeId: string;
        key: string;
        contentHash: string;
      };
      derivativeCount: number;
      recoveredDerivativeCount: number;
      recoveredOriginalHash: string;
      buildSpecCommitSha: string;
      buildIdentitySource: string;
      checkpointStorage: {
        checkpointStoreId: string;
        recoveryReferencePrefix: string;
        attemptReference: string;
        recoveredCheckpointCount: number;
        replayAvailable: boolean;
      };
      publicProductionHarness: boolean;
      executionEvidencePresent: boolean;
      recoveryCommand: string;
      status: string;
    };
    productPackage: {
      accountCategoryObservation: {
        status: string;
        evidenceId: string;
      };
      commercialPlanObservation: {
        status: string;
        evidenceId: string;
      };
    };
  };

  assert.equal(fixture.execution.submitCount, 1);
  assert.equal(fixture.execution.retryCount, 0);
  assert.equal(fixture.artifact.pageCount, 16);
  assert.equal(fixture.render.pageCount, 16);
  assert.equal(fixture.render.outcome, "degraded");
  assert.equal(fixture.render.fidelityStatus, "degraded");
  assert.equal(fixture.render.visualAssessment, "NOT_ASSESSABLE");
  assert.equal(fixture.render.staticSlideHashes.length, 16);
  assert.match(fixture.render.contactSheetHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fixture.render.contactSheetDimensions, "1280x720");
  assert.equal(
    fixture.render.contactSheetComposition,
    "4x4 stitched thumbnails from all 16 pages",
  );
  assert.deepEqual(
    {
      status: fixture.durableRecoveryRehearsal.status,
      derivativeCount:
        fixture.durableRecoveryRehearsal.derivativeCount,
      recoveredDerivativeCount:
        fixture.durableRecoveryRehearsal.recoveredDerivativeCount,
      recoveryStoreId:
        fixture.durableRecoveryRehearsal.artifactStorage
          .recoveryStoreId,
    },
    {
      status: "public_production_replay_recovered",
      derivativeCount: 33,
      recoveredDerivativeCount: 33,
      recoveryStoreId: "wps-smoke-artifact-recovery-v2",
    },
  );
  assert.match(
    fixture.durableRecoveryRehearsal.buildSpecCommitSha,
    /^[a-f0-9]{40}$/,
  );
  assert.equal(
    fixture.durableRecoveryRehearsal.buildIdentitySource,
    "EMBEDDED_VERIFIED_BUILD_MANIFEST",
  );
  assert.equal(
    fixture.durableRecoveryRehearsal.publicProductionHarness,
    true,
  );
  assert.equal(
    fixture.durableRecoveryRehearsal.executionEvidencePresent,
    true,
  );
  assert.deepEqual(
    fixture.durableRecoveryRehearsal.checkpointStorage,
    {
      rootReference: "root:checkpoint-domain-v1",
      checkpointStoreId: "wps-smoke-checkpoints-v2",
      recoveryReferencePrefix:
        "checkpoint-store:wps-smoke-checkpoints-v2:attempt",
      attemptReference:
        "checkpoint-store:wps-smoke-checkpoints-v2:attempt:production-run-wps-aippt-best-zero-incremental--d8babfee598dcd9b77e665f723e0cea6-volcano-v1-attempt-1",
      recoveredCheckpointCount: 2,
      replayAvailable: true,
    },
  );
  assert.notEqual(
    fixture.durableRecoveryRehearsal.artifactStorage
      .primaryFailureDomainId,
    fixture.durableRecoveryRehearsal.artifactStorage
      .recoveryFailureDomainId,
  );
  assert.equal(
    fixture.durableRecoveryRehearsal.runSpecificationStorage
      .caseProvenance,
    "PRODUCTION",
  );
  assert.match(
    fixture.durableRecoveryRehearsal.recoveryCommand,
    /^node --import tsx scripts\/recover-wps-production-run\.ts /,
  );
  assert.equal(
    fixture.durableRecoveryRehearsal.recoveredOriginalHash,
    fixture.artifact.contentHash,
  );
  assert.equal(
    fixture.durableRecoveryRehearsal.artifactStorage
      .originalRecoveryHash,
    fixture.artifact.contentHash,
  );
  assert.match(
    fixture.durableRecoveryRehearsal.artifactStorage
      .originalRecoveryKey,
    /^artifacts\/[a-z0-9-]+\/original$/,
  );
  assert.match(
    fixture.durableRecoveryRehearsal.runSpecificationStorage.key,
    /^run-specifications\/[a-f0-9]{64}$/,
  );
  assert.equal(
    fixture.productPackage.accountCategoryObservation.status,
    "ui_unavailable",
  );
  assert.equal(
    fixture.productPackage.commercialPlanObservation.status,
    "ui_unavailable",
  );
  assert.match(
    fixture.productPackage.accountCategoryObservation.evidenceId,
    /^ev_[a-f0-9]{16,64}$/,
  );
  assert.equal(
    fixture.artifact.contentHash,
    "sha256:c87cf5bd16ee81ebd72bd2e1df9705e4336576d5f6976323de3925d886b54e86",
  );
  assert.equal(fixture.artifact.byteSize, 1_805_544);
  assert.deepEqual(
    fixture.observableEvents.map(({ eventType }) => eventType),
    [
      "home_loaded",
      "professional_mode_observed",
      "query_submitted",
      "network_search_observed",
      "intent_confirmed",
      "outline_completed_16_pages",
      "artifact_generation_completed",
      "cloud_editor_opened",
      "artifact_downloaded",
      "static_render_completed_degraded",
    ],
  );
  assert.doesNotMatch(
    fixtureText,
    /cookie|authorization|bearer|token|password|localstorage|sessionstorage|\/Users\/|\/tmp\/|"account(?:Id|Name|Email)"\s*:/i,
  );
});

test("production WPS execution rejects caller-supplied TEST_FAKE sessions", async () => {
  const pptx = await knownGoodPptxBytes();
  await assert.rejects(
    async () =>
      createBakeoffHarness({
        feishu: new InMemoryFeishuProjection({
          targetEnvironment: "production",
        }),
        productAdapter: new WpsAiPptProductAdapter(),
        wpsAiPptBrowserDriver: browserDriverPackage(
          capturedBrowserResult(pptx),
        ),
      }).startBakeoffJob({
        environment: "production",
        caseId: VOLCANO_EVALUATION_CASE.caseId,
      }),
    /production.*rejects caller-supplied WPS browser sessions/i,
  );
});

test("a degraded raster is captured but visual dimensions are NOT_ASSESSABLE and comparison is prohibited", async () => {
  const pptx = await knownGoodPptxBytes();
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: testWpsBoundaryAdapter(
      "MOCK-wps-degraded-raster-package-v1",
    ),
    wpsAiPptBrowserDriver: browserDriverPackage(
      capturedBrowserResult(pptx, "submitted", "degraded"),
    ),
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
  });

  assert.equal(outcome.renderManifest?.renderOutcome, "degraded");
  assert.deepEqual(outcome.renderManifest?.fidelity, {
    status: "degraded",
    notes: ["local renderer substituted Chinese glyphs"],
  });
  const visualDimensions = outcome.scorecard?.dimensions.filter(
    ({ dimension }) =>
      dimension === "visual_aesthetics_and_professional_finish" ||
      dimension === "layout_hierarchy_and_readability" ||
      dimension === "imagery_chart_and_information_expression",
  );
  assert.equal(visualDimensions?.length, 3);
  assert.ok(
    visualDimensions?.every(
      ({ assessmentStatus, value }) =>
        assessmentStatus === "NOT_ASSESSABLE" && value === null,
    ),
  );
  assert.equal(
    outcome.scorecard?.deliveryQualityGates.find(
      ({ gate }) => gate === "sufficient_faithful_visual_input",
    )?.status,
    "CONDITIONAL",
  );
  const vendorRun = feishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "vendor_run");
  assert.equal(
    vendorRun?.artifactPackageManifest?.renderOutcome,
    "degraded",
  );
});

test("filesystem profile locks serialize the same WPS profile across lock instances", async () => {
  const rootPath = await mkdtemp(
    join(tmpdir(), "ppt-eval-wps-profile-lock-"),
  );
  try {
    const firstLock = new FileSystemBrowserProfileLock({
      lockId: "wps-profile-lock-a",
      rootPath,
    });
    const secondLock = new FileSystemBrowserProfileLock({
      lockId: "wps-profile-lock-b",
      rootPath,
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;
    const first = firstLock.runExclusive(
      "sha256:shared-wps-profile",
      async () => {
        firstEntered();
        await release;
      },
    );
    await entered;
    const second = secondLock.runExclusive(
      "sha256:shared-wps-profile",
      async () => {
        secondEntered = true;
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.equal(secondEntered, false);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  } finally {
    await rm(rootPath, { force: true, recursive: true });
  }
});

test("durable checkpoint replay is idempotent across store instances and rejects only conflicting content", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "wps-checkpoint-idempotency-"),
  );
  const first = new FileSystemAttemptCheckpointStore({
    checkpointStoreId: "checkpoint-idempotency",
    rootPath: root,
  });
  const second = new FileSystemAttemptCheckpointStore({
    checkpointStoreId: "checkpoint-idempotency",
    rootPath: root,
  });
  const checkpoint = {
    eventId: "attempt-replay-wps-event-1",
    jobId: "job-replay",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
    runId: "run-replay",
    attemptId: "attempt-replay",
    attemptSeq: 1,
    eventType: "query_submitted",
    sourceAt: "2026-07-27T06:00:00.000Z",
    observedAt: "2026-07-27T06:00:01.000Z",
    writerId: "wps-aippt-browser@1",
    evidenceRef: "ev_0000000000000001",
    sourceUrl: WPS_AIPPT_URL,
    submissionEvidenceAtCheckpoint: "submitted" as const,
    vendorTaskId: "task_wps_replay_20260727",
    taskStateVersion: "submitted@2",
    adapterVersion: "wps-aippt-browser@1",
    artifactId: null,
  };
  try {
    await first.append(checkpoint);
    await second.append(structuredClone(checkpoint));
    assert.equal(
      (await second.readAttempt(checkpoint.attemptId)).length,
      1,
    );
    await assert.rejects(
      second.append({
        ...checkpoint,
        eventType: "different_event",
      }),
      /checkpoint identity conflict/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CAPTCHA, capacity, UI drift, export, and download failures are distinct and never auto-retried", async () => {
  const pptx = await knownGoodPptxBytes();
  const failures = [
    "captcha",
    "capacity",
    "ui_drift",
    "export_failure",
    "download_failure",
  ] as const;
  for (const [index, outcomeName] of failures.entries()) {
    const feishu = new InMemoryFeishuProjection();
    const failed: WpsAiPptBrowserResult = {
      outcome: outcomeName,
      submissionEvidence: "not_submitted",
      elapsedMs: 1,
      events: [
        {
          eventType: outcomeName,
          sourceAt: "2026-07-27T06:00:00.000Z",
          observedAt: "2026-07-27T06:00:01.000Z",
          evidenceId:
            `ev_${String(index + 10).padStart(16, "0")}` as const,
          sourceUrl: "https://aippt.wps.cn/aippt/",
          submissionEvidenceAtCheckpoint: "not_submitted",
          vendorTaskId:
            `task_wps_failure_${index}` as `task_${string}`,
          taskStateVersion: "failed@1",
          adapterVersion: "wps-aippt-browser@1",
          artifactId: null,
        },
      ],
      manualActions: [],
    };
    const driver = createWpsAiPptBrowserDriverPackage({
      provenance: "TEST_FAKE",
      sessions: [failed, capturedBrowserResult(pptx)],
    });

    const result = await createBakeoffHarness({
      feishu,
      productAdapter: testWpsBoundaryAdapter(
        `MOCK-wps-${outcomeName}-package-v1`,
      ),
      wpsAiPptBrowserDriver: driver,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    });

    assert.equal(result.artifact, null);
    const attempts = feishu
      .snapshot()
      .runRecordTable.filter(
        ({ recordType }) => recordType === "evaluation_attempt",
      );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.terminalReason, outcomeName);
  }
});

test("an unknown WPS task state requires and persists an explicit reconciliation checkpoint", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "unknown-task-reconciliation",
  );
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: createWpsAiPptBrowserDriverPackage({
        provenance: "TEST_FAKE",
        sessions: [
          {
            outcome: "task_state_unknown",
            submissionEvidence: "unknown",
            elapsedMs: 1,
            events: [
              {
                eventType: "task_reconciliation_checked",
                sourceAt: "2026-07-27T06:00:00.000Z",
                observedAt: "2026-07-27T06:00:01.000Z",
                evidenceId: "ev_0000000000000099",
                sourceUrl:
                  "https://aippt.wps.cn/aippt/?task=private#state",
                submissionEvidenceAtCheckpoint: "unknown",
                vendorTaskId: "task_wps_unknown_20260727",
                taskStateVersion: "unknown@4",
                adapterVersion: "wps-aippt-browser@1",
                artifactId: null,
              },
            ],
            manualActions: [],
          },
        ],
        reconciliations: [
          {
            query: {
              vendorTaskId: "task_wps_unknown_20260727",
              taskStateVersion: "unknown@4",
              eventHistoryHash:
                "sha256:055101bfe93e2a763ba429d8f82fbdb4825d3c8d54b108af82c21a09ecf7d45a",
              artifactContentHash: null,
            },
            observedState: "unknown",
            observedAt: "2026-07-27T06:00:02.000Z",
            evidenceId: "ev_0000000000000100",
          },
        ],
      }),
      attemptCheckpointStore: checkpoints,
    },
  );

  const result = (await execute({
    jobId: "job-wps-reconcile",
    runId: "run-wps-reconcile",
    attemptId: "attempt-wps-reconcile-1",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  })) as ProductAttemptResult;

  assert.equal(result.terminalReason, "task_state_unknown");
  assert.equal(result.submissionEvidence, "unknown");
  assert.deepEqual(
    checkpoints.snapshot().map((event) => ({
      eventType: event.eventType,
      sourceUrl: event.sourceUrl,
      submissionEvidenceAtCheckpoint:
        event.submissionEvidenceAtCheckpoint,
    })),
    [
      {
        eventType: "task_reconciliation_checked",
        sourceUrl: "https://aippt.wps.cn/aippt/",
        submissionEvidenceAtCheckpoint: "unknown",
      },
      {
        eventType: "task_reconciliation_result",
        sourceUrl: null,
        submissionEvidenceAtCheckpoint: "unknown",
      },
    ],
  );
});

test("a submitted unknown WPS result preserves submission and accepts artifact-ready reconciliation", async () => {
  const adapter = new WpsAiPptProductAdapter();
  const checkpoints = new InMemoryAttemptCheckpointStore(
    "submitted-unknown-task-reconciliation",
  );
  const event = {
    eventType: "task_reconciliation_checked",
    sourceAt: "2026-07-27T06:00:00.000Z",
    observedAt: "2026-07-27T06:00:01.000Z",
    evidenceId: "ev_0000000000000199",
    sourceUrl: "https://aippt.wps.cn/aippt/?task=private#state",
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "task_wps_submitted_unknown_20260727",
    taskStateVersion: "submitted@4",
    adapterVersion: "wps-aippt-browser@1",
    artifactId: null,
  } as const;
  const eventHistoryHash =
    `sha256:${createHash("sha256")
      .update(JSON.stringify([event]))
      .digest("hex")}` as const;
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
    {
      wpsAiPptBrowserDriver: createWpsAiPptBrowserDriverPackage({
        provenance: "TEST_FAKE",
        sessions: [
          {
            outcome: "task_state_unknown",
            submissionEvidence: "submitted",
            elapsedMs: 1,
            events: [event],
            manualActions: [],
          },
        ],
        reconciliations: [
          {
            query: {
              vendorTaskId:
                "task_wps_submitted_unknown_20260727",
              taskStateVersion: "submitted@4",
              eventHistoryHash,
              artifactContentHash: null,
            },
            observedState: "artifact_ready",
            observedAt: "2026-07-27T06:00:02.000Z",
            evidenceId: "ev_0000000000000200",
          },
        ],
      }),
      attemptCheckpointStore: checkpoints,
    },
  );

  const result = (await execute({
    jobId: "job-wps-submitted-unknown",
    runId: "run-wps-submitted-unknown",
    attemptId: "attempt-wps-submitted-unknown-1",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  })) as ProductAttemptResult;

  assert.equal(result.terminalReason, "download_failure");
  assert.equal(result.submissionEvidence, "submitted");
  assert.equal(
    checkpoints.snapshot().at(-1)
      ?.submissionEvidenceAtCheckpoint,
    "submitted",
  );
});

test("the harness-owned reconciliation API uses the fixed controlled endpoint and correlates the exact query", async () => {
  const previousUrl =
    process.env.PPT_EVALUATION_WPS_BROWSER_BRIDGE_URL;
  const previousFetch = globalThis.fetch;
  const query = {
    vendorTaskId: "task_wps_unknown_20260727" as const,
    taskStateVersion: "unknown@4",
    eventHistoryHash:
      "sha256:055101bfe93e2a763ba429d8f82fbdb4825d3c8d54b108af82c21a09ecf7d45a" as const,
    artifactContentHash: null,
  };
  process.env.PPT_EVALUATION_WPS_BROWSER_BRIDGE_URL =
    "http://127.0.0.1:59999/arbitrary-runtime";
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "http://127.0.0.1:47821/v1/wps-aippt/reconcile",
    );
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as {
      readonly query: unknown;
      readonly requestId: string;
      readonly queryHash: string;
    };
    assert.deepEqual(body.query, query);
    assert.match(body.requestId, /^wps-request-[a-f0-9-]{36}$/);
    assert.match(body.queryHash, /^sha256:[a-f0-9]{64}$/);
    return new Response(
      JSON.stringify({
        requestId: body.requestId,
        queryHash: body.queryHash,
        evidence: {
          query,
          observedState: "unknown",
          observedAt: "2026-07-27T06:00:02.000Z",
          evidenceId: "ev_0000000000000100",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  try {
    const evidence =
      await reconcileHarnessOwnedWpsAiPptTask(query);
    assert.deepEqual(evidence.query, query);
    assert.equal(evidence.observedState, "unknown");
    assert.equal(evidence.evidenceId, "ev_0000000000000100");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) {
      delete process.env.PPT_EVALUATION_WPS_BROWSER_BRIDGE_URL;
    } else {
      process.env.PPT_EVALUATION_WPS_BROWSER_BRIDGE_URL =
        previousUrl;
    }
  }
});

test("the controlled production bridge rejects an uncorrelated terminal outcome", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `${JSON.stringify({
        type: "result",
        requestId: "wps-request-00000000-0000-0000-0000-000000000000",
        commandHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        result: {
          outcome: "technical_failure",
          submissionEvidence: "not_submitted",
          elapsedMs: 1,
          events: [],
          manualActions: [],
        },
      })}\n`,
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      },
    );
  try {
    await assert.rejects(
      runHarnessOwnedWpsAiPptBrowser(
        {
          jobId: "job-wps-correlation",
          runId: "run-wps-correlation",
          attemptId: "attempt-wps-correlation-1",
          attemptSeq: 1,
          timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
          signal: new AbortController().signal,
          evaluationProvenance: "PRODUCTION",
          url: WPS_AIPPT_URL,
          prompt: VOLCANO_EVALUATION_CASE.vendorPrompt,
          accountScope: "current_authenticated_account",
          packageSelection:
            "best_available_zero_incremental_cost",
          mode: "professional",
          networking: "enabled",
          pageCount: 16,
        },
        async () => {},
      ),
      /bridge response correlation failed/i,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a submitted checkpoint is durably reconciled when the production bridge ends before a result", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "wps-submitted-reconcile-"),
  );
  const checkpoints = new FileSystemAttemptCheckpointStore({
    checkpointStoreId: "submitted-reconcile",
    rootPath: root,
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly requestId: string;
      readonly commandHash?: string;
      readonly queryHash?: string;
      readonly query?: unknown;
    };
    if (String(input).endsWith("/run")) {
      return new Response(
        `${JSON.stringify({
          type: "checkpoint",
          requestId: body.requestId,
          commandHash: body.commandHash,
          event: {
            eventType: "query_submitted",
            sourceAt: "2026-07-27T06:00:00.000Z",
            observedAt: "2026-07-27T06:00:01.000Z",
            evidenceId: "ev_0000000000000111",
            sourceUrl: WPS_AIPPT_URL,
            submissionEvidenceAtCheckpoint: "submitted",
            vendorTaskId: "task_wps_interrupted_20260727",
            taskStateVersion: "submitted@2",
            adapterVersion: "wps-aippt-browser@1",
            artifactId: null,
          },
        })}\n`,
        {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        },
      );
    }
    assert.ok(String(input).endsWith("/reconcile"));
    return new Response(
      JSON.stringify({
        requestId: body.requestId,
        queryHash: body.queryHash,
        evidence: {
          query: body.query,
          observedState: "unknown",
          observedAt: "2026-07-27T06:00:02.000Z",
          evidenceId: "ev_0000000000000112",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  try {
    const adapter = new WpsAiPptProductAdapter();
    const execute = resolveHarnessProductAdapterExecutor(
      adapter.implementationPackage,
      parseAdapterExecutionConfiguration(
        adapter.executionConfigurationPackage,
      ),
      { attemptCheckpointStore: checkpoints },
    );
    const result = (await execute({
      jobId: "job-wps-interrupted",
      runId: "run-wps-interrupted",
      attemptId: "attempt-wps-interrupted-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: {
        ...VOLCANO_EVALUATION_CASE,
        provenance: "PRODUCTION",
      },
    })) as ProductAttemptResult;
    assert.equal(result.terminalReason, "task_state_unknown");
    assert.deepEqual(
      (await checkpoints.readAttempt(
        "attempt-wps-interrupted-1",
      )).map(({ eventType }) => eventType),
      ["query_submitted", "task_reconciliation_result"],
    );
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("a restarted production Attempt reads durable stateVersion checkpoints and reconciles before another browser call", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "wps-restart-reconcile-"),
  );
  const checkpoints = new FileSystemAttemptCheckpointStore({
    checkpointStoreId: "restart-reconcile",
    rootPath: root,
  });
  await checkpoints.append({
    eventId: "attempt-wps-restart-1-wps-event-1",
    jobId: "job-wps-restart",
    caseId: VOLCANO_EVALUATION_CASE.caseId,
    runId: "run-wps-restart",
    attemptId: "attempt-wps-restart-1",
    attemptSeq: 1,
    eventType: "query_submitted",
    sourceAt: "2026-07-27T06:00:00.000Z",
    observedAt: "2026-07-27T06:00:01.000Z",
    writerId: "wps-aippt-browser@1",
    evidenceRef: "ev_0000000000000121",
    sourceUrl: WPS_AIPPT_URL,
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "task_wps_restart_20260727",
    taskStateVersion: "submitted@2",
    adapterVersion: "wps-aippt-browser@1",
    artifactId: null,
  });
  const previousFetch = globalThis.fetch;
  let browserRunCalls = 0;
  let reconciliationCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/run")) {
      browserRunCalls += 1;
      throw new Error("browser must not rerun before restart reconciliation");
    }
    reconciliationCalls += 1;
    const body = JSON.parse(String(init?.body)) as {
      readonly requestId: string;
      readonly queryHash: string;
      readonly query: unknown;
    };
    return new Response(
      JSON.stringify({
        requestId: body.requestId,
        queryHash: body.queryHash,
        evidence: {
          query: body.query,
          observedState: "unknown",
          observedAt: "2026-07-27T06:00:02.000Z",
          evidenceId: "ev_0000000000000122",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  try {
    const adapter = new WpsAiPptProductAdapter();
    const execute = resolveHarnessProductAdapterExecutor(
      adapter.implementationPackage,
      parseAdapterExecutionConfiguration(
        adapter.executionConfigurationPackage,
      ),
      { attemptCheckpointStore: checkpoints },
    );
    const result = (await execute({
      jobId: "job-wps-restart",
      runId: "run-wps-restart",
      attemptId: "attempt-wps-restart-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: {
        ...VOLCANO_EVALUATION_CASE,
        provenance: "PRODUCTION",
      },
    })) as ProductAttemptResult;
    assert.equal(browserRunCalls, 0);
    assert.equal(reconciliationCalls, 1);
    assert.equal(result.terminalReason, "task_state_unknown");
    assert.deepEqual(
      (await checkpoints.readAttempt(
        "attempt-wps-restart-1",
      )).map(({ taskStateVersion }) => taskStateVersion),
      ["submitted@2", "submitted@2"],
    );
    const replayed = (await execute({
      jobId: "job-wps-restart",
      runId: "run-wps-restart",
      attemptId: "attempt-wps-restart-1",
      attemptSeq: 1,
      timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
      signal: new AbortController().signal,
      evaluationCase: {
        ...VOLCANO_EVALUATION_CASE,
        provenance: "PRODUCTION",
      },
    })) as ProductAttemptResult;
    assert.equal(replayed.terminalReason, "task_state_unknown");
    assert.equal(browserRunCalls, 0);
    assert.equal(reconciliationCalls, 1);
    assert.equal(
      (await checkpoints.readAttempt(
        "attempt-wps-restart-1",
      )).length,
      2,
    );
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer authorization is decided before an untrusted WPS raster candidate is decoded", async () => {
  const pptx = await knownGoodPptxBytes();
  const captured = capturedBrowserResult(pptx);
  const unsafe: WpsAiPptCapturedBrowserResult = {
    ...captured,
    render: {
      ...captured.render!,
      slides: captured.render!.slides.map((slide, index) =>
        index === 0
          ? { ...slide, content: new TextEncoder().encode("<svg/>") }
          : slide,
      ),
    },
  };
  const feishu = new InMemoryFeishuProjection();
  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapter: testWpsBoundaryAdapter(
        "MOCK-wps-render-authorization-package-v1",
      ),
      wpsAiPptBrowserDriver: browserDriverPackage(unsafe),
      egressAuthorization: {
        async authorize(request) {
          if (request.processingPurpose === "artifact_rendering") {
            return {
              status: "denied",
              decisionId: "deny-render-before-decode",
              policyVersion: "test-render-deny-v1",
              request,
              reason: "renderer not authorized",
              decidedAt: request.requestedAt,
            };
          }
          return {
            status: "approved",
            decisionId: `approved:${request.requestId}`,
            policyVersion: "test-vendor-only-v1",
            request,
            legalSecurityBasis: "synthetic fixture",
            approvedAt: request.requestedAt,
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
        },
      },
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /renderer not authorized|egress authorization denied/i,
  );
  assert.equal(feishu.snapshot().capturedArtifactTable.length, 0);
});

test("safe raster rejects corrupt IDAT even when the attacker recomputes the PNG CRC", async () => {
  const pptx = await knownGoodPptxBytes();
  const captured = capturedBrowserResult(pptx);
  const badPng = pngWithCorruptIdatAndValidCrc(
    captured.render!.slides[0]!.content,
  );
  const driver = createWpsAiPptBrowserDriverPackage({
    provenance: "TEST_FAKE",
    sessions: [
      {
        ...captured,
        render: {
          ...captured.render!,
          slides: captured.render!.slides.map((slide, index) =>
            index === 0 ? { ...slide, content: badPng } : slide,
          ),
        },
      },
    ],
  });

  await assert.rejects(
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection(),
      productAdapter: testWpsBoundaryAdapter(
        "MOCK-wps-corrupt-idat-package-v1",
      ),
      wpsAiPptBrowserDriver: driver,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /decode|corrupt|png|image/i,
  );
});

test("safe raster rejects faithful render outcome paired with degraded fidelity", async () => {
  const pptx = await knownGoodPptxBytes();
  const captured = capturedBrowserResult(pptx);
  const driver = createWpsAiPptBrowserDriverPackage({
    provenance: "TEST_FAKE",
    sessions: [
      {
        ...captured,
        render: {
          ...captured.render!,
          renderOutcome: "faithful",
          fidelity: {
            status: "degraded",
            notes: ["font substitution observed"],
          },
        },
      },
    ],
  });

  await assert.rejects(
    createBakeoffHarness({
      feishu: new InMemoryFeishuProjection(),
      productAdapter: testWpsBoundaryAdapter(
        "MOCK-wps-contradictory-render-package-v1",
      ),
      wpsAiPptBrowserDriver: driver,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_EVALUATION_CASE.caseId,
    }),
    /faithful.*fidelity|contradictory render/i,
  );
});
