import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Artifact } from "../src/domain.ts";
import { InMemoryEgressAuthorizationAudit } from "../src/egress-authorization.ts";
import { MOCK_TEST_ENVIRONMENT_ORIGIN } from "../src/environment-origin.ts";
import { VOLCANO_EVALUATION_CASE } from "../src/fixtures/volcano-case.ts";
import {
  MockWpsProductAdapter,
  resolveHarnessProductAdapterExecutor,
} from "../src/mock-wps.ts";
import {
  parseAdapterExecutionConfiguration,
} from "../src/product-adapter.ts";
import {
  FROZEN_ARTIFACT_RENDERER_ID,
  createHarnessOwnedProductionCapabilities,
} from "../src/production-capabilities.ts";
import {
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
} from "../src/retention.ts";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function knownGoodPptxBytes(): Promise<Uint8Array> {
  const adapter = new MockWpsProductAdapter();
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
  );
  const result = await execute({
    jobId: "production-renderer-fixture-job",
    runId: "production-renderer-fixture-run",
    attemptId: "production-renderer-fixture-attempt",
    attemptSeq: 1,
    timeoutMs: 30 * 60 * 1_000,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  assert.ok("content" in result);
  return result.content;
}

function artifact(content: Uint8Array, artifactId: string): Artifact {
  return Object.freeze({
    artifactId,
    runId: `${artifactId}-run`,
    provenance: "PRODUCTION_REPLAY",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    filename: `${artifactId}.pptx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: content.byteLength,
    pageCount: 16,
    contentHash: sha256(content),
    capturedAt: "2026-07-31T00:00:00.000Z",
    content,
  });
}

async function capabilityFixture(
  root: string,
  renderer: Parameters<
    typeof createHarnessOwnedProductionCapabilities
  >[0]["renderer"],
) {
  const tombstones = new InMemoryTombstoneLedger(
    "production-renderer-tombstones",
  );
  return createHarnessOwnedProductionCapabilities({
    artifactPrimary: {
      operatorDomainLabel: "production-renderer-primary",
      rootPath: join(root, "primary"),
      rootReference: "root:production-renderer-primary",
      storeId: "production-renderer-primary",
    },
    artifactRecovery: {
      operatorDomainLabel: "production-renderer-recovery",
      rootPath: join(root, "recovery"),
      rootReference: "root:production-renderer-recovery",
      storeId: "production-renderer-recovery",
    },
    runSpecification: {
      operatorDomainLabel: "production-renderer-run-spec",
      rootPath: join(root, "run-spec"),
      rootReference: "root:production-renderer-run-spec",
      storeId: "production-renderer-run-spec",
    },
    checkpoint: {
      rootPath: join(root, "checkpoints"),
      rootReference: "root:production-renderer-checkpoints",
      storeId: "production-renderer-checkpoints",
    },
    profileLock: {
      rootPath: join(root, "locks"),
      rootReference: "root:production-renderer-locks",
      lockId: "production-renderer-locks",
    },
    renderer,
    tombstones,
    payloadInventory: new InMemoryPayloadInventory(tombstones),
    egressAuthorization: {
      async authorize() {
        throw new Error("renderer unit test must not authorize storage");
      },
    },
    egressAudit: new InMemoryEgressAuthorizationAudit(),
  });
}

async function writeLegacySlides(root: string, source: Artifact) {
  const artifactDirectory = join(
    root,
    source.contentHash.slice("sha256:".length),
  );
  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all(
    Array.from({ length: 16 }, async (_, index) => {
      const pageNumber = index + 1;
      await writeFile(
        join(
          artifactDirectory,
          `slide-${String(pageNumber).padStart(2, "0")}.png`,
        ),
        PNG,
      );
    }),
  );
}

test("legacy pre-rendered slides are degraded and are isolated by Artifact content hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-legacy-"));
  try {
    const slidesRoot = join(root, "slides");
    const first = artifact(
      await knownGoodPptxBytes(),
      "production-renderer-first-artifact",
    );
    await writeLegacySlides(slidesRoot, first);
    const capabilities = await capabilityFixture(root, {
      rendererId: "artifact-bound-degraded-renderer:1",
      slidesDirectory: slidesRoot,
      extractedTextPrefix: "legacy page",
      fontPack: "legacy-observed-fonts",
      resolution: "1x1",
      colorProfile: "sRGB",
      fidelityNotes: ["font fidelity has not been attested"],
    });

    const firstRender = await capabilities.safeRasterRenderer.render({
      artifact: first,
      authorizationDecisionId: "renderer-approved",
    });
    assert.equal(firstRender.renderOutcome, "degraded");
    assert.equal(firstRender.fidelity.status, "degraded");

    const secondContent = Uint8Array.from([
      ...first.content,
      0,
    ]);
    const second = artifact(
      secondContent,
      "production-renderer-second-artifact",
    );
    await assert.rejects(
      capabilities.safeRasterRenderer.render({
        artifact: second,
        authorizationDecisionId: "renderer-approved",
      }),
      /artifact-specific.*slides|ENOENT/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the source-reviewed frozen renderer converts the current Artifact to 16 faithful PNGs", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-frozen-"));
  try {
    const capabilities = await capabilityFixture(root, {
      rendererId: FROZEN_ARTIFACT_RENDERER_ID,
      slidesDirectory: join(root, "legacy-unused"),
      extractedTextPrefix: "unused",
      fontPack: "caller-value-must-not-control-fidelity",
      resolution: "caller-value-must-not-control-fidelity",
      colorProfile: "sRGB",
      fidelityNotes: ["legacy fallback only"],
      fixedRenderer: "frozen-libreoffice-poppler-v1",
    });
    const source = artifact(
      await knownGoodPptxBytes(),
      "production-renderer-frozen-artifact",
    );

    const candidate = await capabilities.safeRasterRenderer.render({
      artifact: source,
      authorizationDecisionId: "renderer-approved",
    });

    assert.equal(candidate.renderOutcome, "faithful");
    assert.equal(candidate.fidelity.status, "verified");
    assert.equal(candidate.slides.length, 16);
    assert.equal(candidate.resolution, "1920x1080");
    assert.equal(
      candidate.fontPack,
      "libreoffice-pdffonts-no-substitution-audit:1",
    );
    assert.match(
      candidate.renderer,
      /^frozen-libreoffice-poppler-artifact-renderer:1:sha256:[a-f0-9]{64}$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an arbitrary caller-signed executable and matching hash cannot become harness-owned", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-self-signed-"));
  try {
    const selfSignedRenderer = {
      rendererId: "caller-self-signed-renderer:1",
      slidesDirectory: join(root, "legacy-unused"),
      extractedTextPrefix: "unused",
      fontPack: "caller",
      resolution: "1x1",
      colorProfile: "sRGB",
      fidelityNotes: ["caller claims faithful"],
      attestedExecutable: {
        executablePath: join(root, "malicious-renderer"),
        executableHash:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    } as unknown as Parameters<
      typeof createHarnessOwnedProductionCapabilities
    >[0]["renderer"];
    await assert.rejects(
      capabilityFixture(root, selfSignedRenderer),
      /rejects caller-supplied executable identity/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
