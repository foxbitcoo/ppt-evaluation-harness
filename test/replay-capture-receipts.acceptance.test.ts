import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  WpsAiPptReplayAdapter,
  resolveWpsAiPptProductAdapterExecutor,
  type WpsAiPptBrowserResult,
} from "../src/wps-aippt.ts";
import {
  InMemoryArtifactCaptureJournal,
  InMemoryImmutableBlobStore,
  createArtifactVault,
} from "../src/artifact-vault.ts";
import {
  InMemoryEgressAuthorizationAudit,
  type EgressAuthorizationPort,
} from "../src/egress-authorization.ts";
import { PRODUCTION_ENVIRONMENT_ORIGIN } from "../src/environment-origin.ts";
import { PRODUCTION_VOLCANO_EVALUATION_CASE } from "../src/fixtures/volcano-case.ts";
import { calculateRenderManifestHash } from "../src/render-manifest.ts";
import {
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
} from "../src/retention.ts";
import type { Artifact, RenderManifest } from "../src/domain.ts";
import type { ProductAttemptResult } from "../src/product-adapter.ts";
import {
  createWpsAiPptRealProviderReplayPackage,
} from "../src/wps-aippt-driver.ts";
import type {
  QwenBrowserExecution,
} from "../src/qwen-production-adapter.ts";
import {
  createQwenRealProviderReplayPackage,
} from "../src/qwen-production-adapter.ts";

const MOCK_PPTX_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
const KNOWN_WPS_CAPTURE_ROOT =
  "/Users/chenyifan/.local/share/ppt-evaluation-harness/rehearsals/wps-real-provider-20260728-round5-resolution-final/artifact-recovery";
const KNOWN_WPS_ARTIFACT_PACKAGE =
  `${KNOWN_WPS_CAPTURE_ROOT}/1413d772544dd0860f0ab556473500a38b82699ccecb75f22d034bdcf02d0b2b.blob`;
const KNOWN_WPS_PPTX =
  `${KNOWN_WPS_CAPTURE_ROOT}/5ec14c8ea2228df6b80a2f0be4a87bcd486aa1d91aa0779c5317c038bd0ceeae.blob`;
const KNOWN_WPS_RENDER_MANIFEST =
  `${KNOWN_WPS_CAPTURE_ROOT}/e85a78fc02dd5ea456ae1f9d5157b8b797bf0c9443f1b2dcf49501a9a6135ae3.blob`;
const KNOWN_WPS_CAPTURE_AVAILABLE =
  existsSync(KNOWN_WPS_ARTIFACT_PACKAGE) &&
  existsSync(KNOWN_WPS_PPTX) &&
  existsSync(KNOWN_WPS_RENDER_MANIFEST);
const APPROVED_EGRESS: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `decision:${request.requestId}:${request.requestedAt}`,
      policyVersion: "test-egress-policy-v1",
      request,
      legalSecurityBasis: "retained real-provider receipt test",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
};

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function knownWpsReceiptFixture() {
  const packageManifest = JSON.parse(
    await readFile(KNOWN_WPS_ARTIFACT_PACKAGE, "utf8"),
  ) as {
    readonly artifact: {
      readonly artifactId: string;
      readonly runId: string;
    };
    readonly renderManifestHash: `sha256:${string}`;
    readonly derivatives: readonly {
      readonly derivativeType: string;
      readonly pageNumber: number | null;
      readonly filename: string;
      readonly mimeType: string;
      readonly contentHash: `sha256:${string}`;
    }[];
  };
  const renderDescriptor = JSON.parse(
    await readFile(KNOWN_WPS_RENDER_MANIFEST, "utf8"),
  ) as {
    readonly renderManifestId: string;
    readonly artifactId: string;
    readonly provenance: "PRODUCTION_REPLAY";
    readonly environmentOrigin: {
      readonly environment: "production";
      readonly originId: string;
    };
    readonly renderer: string;
    readonly rendererAuthorizationDecisionId: string;
    readonly renderOutcome: "degraded";
    readonly fidelity: {
      readonly status: "degraded";
      readonly notes: readonly string[];
    };
    readonly pageCount: number;
    readonly renderPolicy: {
      readonly fontPack: string;
      readonly resolution: string;
      readonly colorProfile: string;
      readonly animationPolicy: "first_frame";
      readonly externalAssetPolicy: "network_disabled";
    };
    readonly slides: readonly {
      readonly pageNumber: number;
      readonly filename: string;
      readonly mimeType: "image/png";
      readonly contentHash: `sha256:${string}`;
    }[];
    readonly contactSheet: {
      readonly filename: string;
      readonly mimeType: "image/png";
      readonly contentHash: `sha256:${string}`;
    };
  };
  const contentByHash = new Map<string, Uint8Array>();
  for (const filename of await readdir(KNOWN_WPS_CAPTURE_ROOT)) {
    const content = Uint8Array.from(
      await readFile(`${KNOWN_WPS_CAPTURE_ROOT}/${filename}`),
    );
    contentByHash.set(sha256(content), content);
  }
  const renderedPages = packageManifest.derivatives
    .filter(
      (
        derivative,
      ): derivative is typeof derivative & {
        readonly pageNumber: number;
        readonly mimeType: "image/png";
      } =>
        derivative.derivativeType === "static_slide" &&
        derivative.pageNumber !== null &&
        derivative.mimeType === "image/png",
    )
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map((derivative) => ({
      pageNumber: derivative.pageNumber,
      filename: derivative.filename,
      mimeType: derivative.mimeType,
      content: Uint8Array.from(
        contentByHash.get(derivative.contentHash)!,
      ),
    }));
  const pptx = Uint8Array.from(await readFile(KNOWN_WPS_PPTX));
  const session = {
    outcome: "captured",
    submissionEvidence: "submitted",
    elapsedMs: 121_000,
    observedConfiguration: {
      productUrl: "https://aippt.wps.cn/aippt/",
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
        "ev_0000000000000201",
        "ev_0000000000000202",
      ],
      accountCategoryObservation: {
        status: "ui_unavailable",
        reason:
          "account category UI was not retained in the real-provider capture",
        evidenceId: "ev_0000000000000201",
      },
      commercialPlanObservation: {
        status: "ui_unavailable",
        reason:
          "commercial plan UI was not retained in the real-provider capture",
        evidenceId: "ev_0000000000000202",
      },
    },
    events: [
      {
        eventType: "configuration_observed",
        sourceAt: "2026-07-27T06:00:00.000Z",
        observedAt: "2026-07-27T06:00:01.000Z",
        evidenceId: "ev_0000000000000201",
        sourceUrl: "https://aippt.wps.cn/aippt/",
        submissionEvidenceAtCheckpoint: "not_submitted",
        vendorTaskId: "task_wps_real_capture_20260727",
        taskStateVersion: "created@1",
        adapterVersion: "wps-aippt-browser@1",
        artifactId: null,
      },
      {
        eventType: "artifact_downloaded",
        sourceAt: "2026-07-27T06:02:00.000Z",
        observedAt: "2026-07-27T06:02:01.000Z",
        evidenceId: "ev_0000000000000202",
        sourceUrl: "https://365.kdocs.cn/l/redacted",
        submissionEvidenceAtCheckpoint: "submitted",
        vendorTaskId: "task_wps_real_capture_20260727",
        taskStateVersion: "artifact_ready@6",
        adapterVersion: "wps-aippt-browser@1",
        artifactId: "artifact_wps_retained_real_capture",
      },
    ],
    manualActions: [
      "ingested retained REAL_PROVIDER_CAPTURE without live browser automation",
    ],
    artifact: {
      filename: "wps-volcano-16.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: pptx,
      pageCount: 16,
      capturedAt: "2026-07-27T06:02:01.000Z",
    },
  } as unknown as WpsAiPptBrowserResult;
  const renderManifest = {
    ...renderDescriptor,
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    contentHash: packageManifest.renderManifestHash,
    slides: renderDescriptor.slides.map((slide) => ({
      ...slide,
      content: Uint8Array.from(contentByHash.get(slide.contentHash)!),
      extractedText: `retained real WPS page ${slide.pageNumber}`,
    })),
    contactSheet: {
      ...renderDescriptor.contactSheet,
      content: Uint8Array.from(
        contentByHash.get(renderDescriptor.contactSheet.contentHash)!,
      ),
    },
  } as RenderManifest;
  return {
    artifactIdentity: packageManifest.artifact,
    renderManifest,
    renderedPages,
    session,
  };
}

const callerMintedWpsCapture = {
  outcome: "captured",
  submissionEvidence: "submitted",
  elapsedMs: 1,
  events: [],
  manualActions: [],
  observedConfiguration: {},
  artifact: {
    filename: "caller-mock.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    content: MOCK_PPTX_BYTES,
    pageCount: 16,
    capturedAt: "2026-07-31T00:00:00.000Z",
  },
} as unknown as WpsAiPptBrowserResult;

const callerMintedQwenCapture = {
  status: "completed",
  submissionEvidence: "submitted",
  elapsedMs: 1,
  observedConfiguration: {},
  milestones: [],
  manualActions: [],
  download: {
    filename: "caller-mock.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    capturedAt: "2026-07-31T00:00:00.000Z",
    content: MOCK_PPTX_BYTES,
  },
  staticRenders: [],
} as unknown as QwenBrowserExecution;

test("WPS caller sessions cannot self-sign the known REAL_PROVIDER_CAPTURE identity", () => {
  assert.throws(
    () =>
      createWpsAiPptRealProviderReplayPackage({
        captureId:
          "wps-real-provider-20260728-round5-resolution-final",
        sessions: [callerMintedWpsCapture],
        renderedPages: [],
      } as Parameters<
        typeof createWpsAiPptRealProviderReplayPackage
      >[0]),
    /harness-owned capture receipt|artifact.*receipt|trace.*receipt/i,
  );
});

test("WPS rejects an unregistered REAL_PROVIDER_CAPTURE identity", () => {
  assert.throws(
    () =>
      createWpsAiPptRealProviderReplayPackage({
        captureId: "caller-invented-wps-capture",
        sessions: [callerMintedWpsCapture],
        renderedPages: [],
      } as Parameters<
        typeof createWpsAiPptRealProviderReplayPackage
      >[0]),
    /harness-owned capture receipt|unregistered capture/i,
  );
});

test(
  "WPS known REAL_PROVIDER_CAPTURE receipt rejects retained PNG byte drift",
  { skip: !KNOWN_WPS_CAPTURE_AVAILABLE },
  async () => {
    const fixture = await knownWpsReceiptFixture();
    const driftedPages = fixture.renderedPages.map((page, index) => ({
      ...page,
      content:
        index === 0
          ? Uint8Array.from(page.content, (byte, byteIndex) =>
              byteIndex === page.content.length - 1
                ? byte ^ 0xff
                : byte,
            )
          : page.content,
    }));

    assert.throws(
      () =>
        createWpsAiPptRealProviderReplayPackage({
          captureId:
            "wps-real-provider-20260728-round5-resolution-final",
          sessions: [fixture.session],
          renderedPages: driftedPages,
        } as Parameters<
          typeof createWpsAiPptRealProviderReplayPackage
        >[0]),
      /retained PNG|render.*receipt|capture receipt/i,
    );
  },
);

test(
  "WPS known REAL_PROVIDER_CAPTURE carries its harness receipt into production execution evidence",
  { skip: !KNOWN_WPS_CAPTURE_AVAILABLE },
  async () => {
    const fixture = await knownWpsReceiptFixture();
    const driver = createWpsAiPptRealProviderReplayPackage({
      captureId:
        "wps-real-provider-20260728-round5-resolution-final",
      sessions: [fixture.session],
      renderedPages: fixture.renderedPages,
    });
    const adapter = new WpsAiPptReplayAdapter();
    const execute = resolveWpsAiPptProductAdapterExecutor(
      adapter.implementationPackage,
      adapter.executionConfiguration,
      driver,
    );
    const artifactSuffix =
      `-artifact-${sha256(
        (fixture.session as Extract<
          WpsAiPptBrowserResult,
          { outcome: "captured" }
        >).artifact.content,
      ).slice(7, 23)}`;
    const attemptId = fixture.artifactIdentity.artifactId.slice(
      0,
      -artifactSuffix.length,
    );

    const result = await execute({
      jobId: "job-wps-known-receipt",
      runId: fixture.artifactIdentity.runId,
      attemptId,
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
    }) as ProductAttemptResult;

    assert.equal(
      result.artifactCandidates[0]?.productionExecutionEvidence
        ?.captureReceipt?.captureId,
      "wps-real-provider-20260728-round5-resolution-final",
    );
  },
);

test(
  "ArtifactVault accepts the exact WPS retained derivative set bound by the harness receipt",
  { skip: !KNOWN_WPS_CAPTURE_AVAILABLE },
  async () => {
    const fixture = await knownWpsReceiptFixture();
    const driver = createWpsAiPptRealProviderReplayPackage({
      captureId:
        "wps-real-provider-20260728-round5-resolution-final",
      sessions: [fixture.session],
      renderedPages: fixture.renderedPages,
    });
    const adapter = new WpsAiPptReplayAdapter();
    const execute = resolveWpsAiPptProductAdapterExecutor(
      adapter.implementationPackage,
      adapter.executionConfiguration,
      driver,
    );
    const artifactContent = (
      fixture.session as Extract<
        WpsAiPptBrowserResult,
        { outcome: "captured" }
      >
    ).artifact.content;
    const artifactSuffix =
      `-artifact-${sha256(artifactContent).slice(7, 23)}`;
    const attemptId = fixture.artifactIdentity.artifactId.slice(
      0,
      -artifactSuffix.length,
    );
    const result = await execute({
      jobId: "job-wps-known-derivative-receipt",
      runId: fixture.artifactIdentity.runId,
      attemptId,
      attemptSeq: 1,
      timeoutMs: 30 * 60 * 1_000,
      signal: new AbortController().signal,
      evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
    }) as ProductAttemptResult;
    const candidate = result.artifactCandidates[0]!;
    assert.equal(
      calculateRenderManifestHash(
        candidate.artifact.contentHash,
        fixture.renderManifest,
      ),
      fixture.renderManifest.contentHash,
    );
    assert.ok(candidate.productionExecutionEvidence);
    const primary = new InMemoryImmutableBlobStore("wps-receipt-primary");
    const secondary = new InMemoryImmutableBlobStore(
      "wps-receipt-secondary",
    );
    const vault = createArtifactVault({
      primary,
      secondary,
      egressAuthorization: APPROVED_EGRESS,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      captureJournal: new InMemoryArtifactCaptureJournal(),
      payloadInventory: new InMemoryPayloadInventory(
        new InMemoryTombstoneLedger(),
      ),
    });

    const packageManifest = await vault.capture({
      jobId: "job-wps-known-derivative-receipt",
      dataClassification: "public_or_synthetic",
      sourceOwner: "ppt-evaluation-harness",
      artifact: candidate.artifact,
      renderManifest: fixture.renderManifest,
      productionExecutionEvidence:
        {
          ...candidate.productionExecutionEvidence,
          rasterManifestHash:
            fixture.renderManifest.contentHash,
        },
    });

    assert.equal(packageManifest.derivatives.length, 33);
  },
);

test(
  "ArtifactVault rejects WPS retained PNG drift after receipt registration",
  { skip: !KNOWN_WPS_CAPTURE_AVAILABLE },
  async () => {
    const fixture = await knownWpsReceiptFixture();
    const driver = createWpsAiPptRealProviderReplayPackage({
      captureId:
        "wps-real-provider-20260728-round5-resolution-final",
      sessions: [fixture.session],
      renderedPages: fixture.renderedPages,
    });
    assert.ok(driver.captureReceipt);
    const captured = fixture.session as Extract<
      WpsAiPptBrowserResult,
      { outcome: "captured" }
    >;
    const artifact: Artifact = {
      artifactId: fixture.renderManifest.artifactId,
      runId: fixture.artifactIdentity.runId,
      provenance: "PRODUCTION_REPLAY",
      environmentOrigin: fixture.renderManifest.environmentOrigin,
      filename: captured.artifact.filename,
      mimeType: captured.artifact.mimeType,
      byteSize: captured.artifact.content.byteLength,
      pageCount: captured.artifact.pageCount,
      contentHash: sha256(captured.artifact.content),
      capturedAt: captured.artifact.capturedAt,
      content: Uint8Array.from(captured.artifact.content),
    };
    const replacementContent =
      fixture.renderedPages[1]!.content;
    const driftedWithoutHash = {
      ...fixture.renderManifest,
      slides: fixture.renderManifest.slides.map((slide, index) =>
        index === 0
          ? {
              ...slide,
              content: Uint8Array.from(replacementContent),
              contentHash: sha256(replacementContent),
            }
          : slide,
      ),
    };
    const driftedManifest: RenderManifest = {
      ...driftedWithoutHash,
      contentHash: calculateRenderManifestHash(
        artifact.contentHash,
        driftedWithoutHash,
      ),
    };
    const primary = new InMemoryImmutableBlobStore(
      "wps-drift-primary",
    );
    const secondary = new InMemoryImmutableBlobStore(
      "wps-drift-secondary",
    );
    const vault = createArtifactVault({
      primary,
      secondary,
      egressAuthorization: APPROVED_EGRESS,
      egressAudit: new InMemoryEgressAuthorizationAudit(),
      captureJournal: new InMemoryArtifactCaptureJournal(),
      payloadInventory: new InMemoryPayloadInventory(
        new InMemoryTombstoneLedger(),
      ),
    });

    await assert.rejects(
      vault.capture({
        jobId: "job-wps-drifted-derivative-receipt",
        dataClassification: "public_or_synthetic",
        sourceOwner: "ppt-evaluation-harness",
        artifact,
        renderManifest: driftedManifest,
        productionExecutionEvidence: {
          executionMode: "PRODUCTION_REPLAY",
          captureSource: "REAL_PROVIDER_CAPTURE",
          driverSessionId: "session_replay_wps_known_receipt",
          vendorTaskId: "task_wps_real_capture_20260727",
          taskStateVersion: "artifact_ready@6",
          driverVersion: "wps-aippt-harness-browser-bridge@2",
          adapterVersion: "wps-aippt-browser@1",
          outcome: "captured",
          artifactContentHash: artifact.contentHash,
          traceHash:
            "sha256:4d28f5a44ed4ba86d559592a366c410943ca72f152b6b63fd2e0819ae5509341",
          captureReceipt: driver.captureReceipt,
          rasterManifestHash: driftedManifest.contentHash,
        },
      }),
      /registered.*render.*receipt|render.*digest.*mismatch/i,
    );
    assert.deepEqual(primary.listKeys(), []);
    assert.deepEqual(secondary.listKeys(), []);
  },
);

test("Qwen mock bytes cannot register themselves as a REAL_PROVIDER_CAPTURE", () => {
  assert.throws(
    () =>
      createQwenRealProviderReplayPackage({
        captureId: "caller-invented-qwen-capture",
        sessions: [callerMintedQwenCapture],
      } as Parameters<
        typeof createQwenRealProviderReplayPackage
      >[0]),
    /harness-owned capture receipt|unregistered capture/i,
  );
});
