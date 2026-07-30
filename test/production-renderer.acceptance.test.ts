import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  frozenRendererSandboxProfileForTest,
  rendererBundleClosureDigestForTest,
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

async function writeNativeFrozenEvidence(
  root: string,
  source: Artifact,
  slides: readonly {
    readonly pageNumber: number;
    readonly content: Uint8Array;
  }[],
) {
  const evidenceDirectory = join(
    root,
    source.contentHash.slice("sha256:".length),
  );
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const manifestSlides = [];
  for (const slide of slides) {
    const filename =
      `native-slide-${String(slide.pageNumber).padStart(2, "0")}.png`;
    await writeFile(
      join(evidenceDirectory, filename),
      slide.content,
      { mode: 0o600 },
    );
    manifestSlides.push({
      pageNumber: slide.pageNumber,
      filename,
      contentHash: sha256(slide.content),
    });
  }
  await writeFile(
    join(evidenceDirectory, "manifest.json"),
    JSON.stringify({
      schemaVersion: "native-frozen-render-evidence-v1",
      artifactContentHash: source.contentHash,
      surfaceClass: "native_frozen",
      viewport: "1920x1080",
      resolution: "1920x1080",
      colorProfile: "sRGB",
      cropPolicy: "native_completion_view",
      animationFramePolicy: "completion_state",
      slides: manifestSlides,
    }),
    { mode: 0o600 },
  );
}

test("the frozen renderer sandbox denies repository and ~/.codex reads plus non-allowlisted process execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-sandbox-"));
  try {
    const allowed = join(root, "allowed.txt");
    await writeFile(allowed, "allowed-renderer-input", { mode: 0o600 });
    const profile = frozenRendererSandboxProfileForTest({
      invocationRoot: root,
      executablePath: "/bin/cat",
    });
    assert.equal(
      spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/bin/cat", allowed],
        { encoding: "utf8" },
      ).stdout,
      "allowed-renderer-input",
    );
    for (const forbidden of [
      resolve("package.json"),
      join(homedir(), ".codex", "AGENTS.md"),
    ]) {
      const attempt = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/bin/cat", forbidden],
        { encoding: "utf8" },
      );
      assert.notEqual(attempt.status, 0);
      assert.equal(attempt.stdout, "");
    }
    const shell = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/sh", "-c", "exit 0"],
      { encoding: "utf8" },
    );
    assert.notEqual(shell.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the frozen renderer identity changes when a loaded bundle dependency drifts", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-bundle-"));
  try {
    const executable = join(root, "renderer");
    const dependency = join(root, "librenderer.dylib");
    await writeFile(executable, "fixed-entrypoint-v1", { mode: 0o700 });
    await writeFile(dependency, "loaded-dependency-v1", { mode: 0o600 });
    const before = rendererBundleClosureDigestForTest([
      { label: "fixture", rootPath: root },
    ]);

    await writeFile(dependency, "loaded-dependency-v2", { mode: 0o600 });
    const after = rendererBundleClosureDigestForTest([
      { label: "fixture", rootPath: root },
    ]);

    assert.notEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("LibreOffice structural checks remain degraded without content-addressed native-frozen evidence", async () => {
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

    assert.equal(candidate.renderOutcome, "degraded");
    assert.equal(candidate.fidelity.status, "degraded");
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

test("byte-identical content-addressed native-frozen evidence upgrades the canonical render to faithful", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-native-"));
  try {
    const evidenceRoot = join(root, "native-evidence");
    const capabilities = await capabilityFixture(root, {
      rendererId: FROZEN_ARTIFACT_RENDERER_ID,
      slidesDirectory: join(root, "legacy-unused"),
      extractedTextPrefix: "unused",
      fontPack: "caller-value-must-not-control-fidelity",
      resolution: "caller-value-must-not-control-fidelity",
      colorProfile: "sRGB",
      fidelityNotes: ["legacy fallback only"],
      fixedRenderer: "frozen-libreoffice-poppler-v1",
      nativeFrozenEvidenceDirectory: evidenceRoot,
    });
    const source = artifact(
      await knownGoodPptxBytes(),
      "production-renderer-native-evidence-artifact",
    );
    const canonical = await capabilities.safeRasterRenderer.render({
      artifact: source,
      authorizationDecisionId: "renderer-approved",
    });
    assert.equal(canonical.renderOutcome, "degraded");
    await writeNativeFrozenEvidence(
      evidenceRoot,
      source,
      canonical.slides,
    );

    const verified = await capabilities.safeRasterRenderer.render({
      artifact: source,
      authorizationDecisionId: "renderer-approved",
    });

    assert.equal(verified.renderOutcome, "faithful");
    assert.equal(verified.fidelity.status, "verified");
    assert.match(
      verified.fidelity.notes.join("\n"),
      /native-frozen.*sha256:[a-f0-9]{64}/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered native-frozen evidence fails closed before it can claim faithful rendering", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-native-tamper-"));
  try {
    const evidenceRoot = join(root, "native-evidence");
    const capabilities = await capabilityFixture(root, {
      rendererId: FROZEN_ARTIFACT_RENDERER_ID,
      slidesDirectory: join(root, "legacy-unused"),
      extractedTextPrefix: "unused",
      fontPack: "caller-value-must-not-control-fidelity",
      resolution: "caller-value-must-not-control-fidelity",
      colorProfile: "sRGB",
      fidelityNotes: ["legacy fallback only"],
      fixedRenderer: "frozen-libreoffice-poppler-v1",
      nativeFrozenEvidenceDirectory: evidenceRoot,
    });
    const source = artifact(
      await knownGoodPptxBytes(),
      "production-renderer-native-evidence-tamper",
    );
    const canonical = await capabilities.safeRasterRenderer.render({
      artifact: source,
      authorizationDecisionId: "renderer-approved",
    });
    await writeNativeFrozenEvidence(
      evidenceRoot,
      source,
      canonical.slides,
    );
    await writeFile(
      join(
        evidenceRoot,
        source.contentHash.slice("sha256:".length),
        "native-slide-01.png",
      ),
      PNG,
      { mode: 0o600 },
    );

    await assert.rejects(
      capabilities.safeRasterRenderer.render({
        artifact: source,
        authorizationDecisionId: "renderer-approved",
      }),
      /native-frozen evidence content hash or visual surface does not match/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the harness snapshots its native-frozen evidence root before caller mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-renderer-native-root-"));
  try {
    const trustedEvidenceRoot = join(root, "trusted-native-evidence");
    const attackerEvidenceRoot = join(root, "attacker-native-evidence");
    const renderer = {
      rendererId: FROZEN_ARTIFACT_RENDERER_ID,
      slidesDirectory: join(root, "legacy-unused"),
      extractedTextPrefix: "unused",
      fontPack: "caller-value-must-not-control-fidelity",
      resolution: "caller-value-must-not-control-fidelity",
      colorProfile: "sRGB",
      fidelityNotes: ["legacy fallback only"],
      fixedRenderer: "frozen-libreoffice-poppler-v1" as const,
      nativeFrozenEvidenceDirectory: trustedEvidenceRoot,
    };
    const capabilities = await capabilityFixture(root, renderer);
    const source = artifact(
      await knownGoodPptxBytes(),
      "production-renderer-native-root-snapshot",
    );
    const canonical = await capabilities.safeRasterRenderer.render({
      artifact: source,
      authorizationDecisionId: "renderer-approved",
    });
    await writeNativeFrozenEvidence(
      attackerEvidenceRoot,
      source,
      canonical.slides,
    );
    renderer.nativeFrozenEvidenceDirectory = attackerEvidenceRoot;

    const afterMutation =
      await capabilities.safeRasterRenderer.render({
        artifact: source,
        authorizationDecisionId: "renderer-approved",
      });

    assert.equal(afterMutation.renderOutcome, "degraded");
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
