// @ts-nocheck -- standalone M0 .mjs integration seam.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_PRESENTATIONS_RENDER_HELPER,
  inspectPptx,
  renderPptxToStaticPages,
} from "../mvp/historical-m0.mjs";

const trustedManifest = JSON.parse(
  await readFile(
    new URL("../mvp/fixtures/doubao-trusted-render-manifest.json", import.meta.url),
    "utf8",
  ),
);

const doubaoPptx = resolve(
  process.env.M0_DOUABO_PPTX ?? "tmp/live-mvp-m0/doubao-history.pptx",
);

test("the trusted Presentations helper reproduces the manually checked Chinese-visible Doubao renders", async (t) => {
  try {
    await stat(doubaoPptx);
  } catch {
    t.skip("set M0_DOUABO_PPTX to run the trusted historical-render integration check");
    return;
  }

  assert.match(
    DEFAULT_PRESENTATIONS_RENDER_HELPER,
    /presentations\/container_tools\/render_slides\.py$/u,
  );
  const source = await inspectPptx(doubaoPptx);
  assert.equal(source.contentHash, trustedManifest.sourceArtifactHash);
  const renderDir = await mkdtemp(join(tmpdir(), "ppt-m0-trusted-render-"));
  const rendered = await renderPptxToStaticPages({
    pptxPath: doubaoPptx,
    renderDir,
    expectedPageCount: trustedManifest.pageCount,
  });

  assert.equal(rendered.renderer, trustedManifest.renderer);
  assert.equal(rendered.rendererSource, DEFAULT_PRESENTATIONS_RENDER_HELPER);
  assert.equal(rendered.rendererSourceHash, trustedManifest.rendererSourceHash);
  assert.equal(rendered.pageCount, trustedManifest.pageCount);
  assert.deepEqual(
    rendered.slides.map(({ pageNumber, contentHash }) => ({
      pageNumber,
      contentHash,
    })),
    trustedManifest.slides,
  );
  assert.ok(
    rendered.slides.every(
      ({ width, height, byteSize }) =>
        width === 1600 && height === 900 && byteSize > 1_000,
    ),
  );
  assert.equal(
    trustedManifest.referenceStatus,
    "MANUALLY_CONFIRMED_CHINESE_VISIBLE",
  );
});
