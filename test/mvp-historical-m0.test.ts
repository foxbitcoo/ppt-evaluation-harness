// @ts-nocheck -- the MVP command intentionally remains a standalone .mjs entrypoint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  M0_CLASSIFICATION,
  M0_COMPARISON_MODE,
  PRODUCTS,
  SCORE_DIMENSIONS,
  buildPairwiseComparisons,
  buildShortReport,
  normalizeScorecard,
  renderPptxToStaticPages,
  scoreDeck,
} from "../mvp/historical-m0.mjs";

function rawScore(seed: number) {
  const score = (offset: number) => Math.max(1, Math.min(5, seed + offset));
  return {
    dimensions: {
      requirement_understanding_and_content_coverage: {
        assessmentStatus: "ASSESSED",
        value: score(0),
        evidencePages: [1, 2],
        rationale: "封面与目录提供可见结构证据。",
      },
      factual_accuracy_and_content_quality: {
        assessmentStatus: "NOT_ASSESSABLE",
        value: null,
        evidencePages: [],
        rationale: "没有可辩护的知识包，事实维度不评估。",
      },
      narrative_and_audience_fit: {
        assessmentStatus: "ASSESSED",
        value: score(1),
        evidencePages: [2, 5],
        rationale: "目录到正文的路径可见。",
      },
      visual_aesthetics_and_professional_finish: {
        assessmentStatus: "ASSESSED",
        value: score(-1),
        evidencePages: [1, 6],
        rationale: "封面和正文显示一致视觉语言。",
      },
      layout_hierarchy_and_readability: {
        assessmentStatus: "ASSESSED",
        value: score(0),
        evidencePages: [3, 7],
        rationale: "标题、正文层级可以静态阅读。",
      },
      imagery_chart_and_information_expression: {
        assessmentStatus: "ASSESSED",
        value: score(-1),
        evidencePages: [4, 8],
        rationale: "配图提供基础信息表达。",
      },
    },
  };
}

function deck(product, pageCount, seed) {
  return {
    product,
    classification: M0_CLASSIFICATION,
    comparisonMode: M0_COMPARISON_MODE,
    artifact: {
      pageCount,
      contentHash: `sha256:${product.id.padEnd(64, "0")}`,
    },
    scorecard: {
      productId: product.id,
      productName: product.name,
      classification: M0_CLASSIFICATION,
      comparisonMode: M0_COMPARISON_MODE,
      scoreSource: "FIXTURE",
      ...normalizeScorecard(rawScore(seed), pageCount),
    },
  };
}

test("M0 creates all three dynamic pairs without a fixed baseline", () => {
  const qwen = deck(PRODUCTS[0], 8, 3);
  const doubao = deck(PRODUCTS[1], 8, 4);
  const lingxi = deck(PRODUCTS[2], 12, 2);
  const comparisons = buildPairwiseComparisons([qwen, doubao, lingxi]);

  assert.deepEqual(
    comparisons.map(({ comparisonId }) => comparisonId),
    ["qwen-vs-doubao", "qwen-vs-lingxi", "doubao-vs-lingxi"],
  );
  assert.equal(comparisons.length, 3);
  assert.ok(
    comparisons.every(
      (comparison) =>
        comparison.comparisonType === "DYNAMIC_PAIRWISE" &&
        comparison.experimental === true &&
        comparison.baselineProductId === null &&
        !Object.hasOwn(comparison, "baselineRunId") &&
        !Object.hasOwn(comparison, "overallDelta") &&
        !Object.hasOwn(comparison, "overallWinnerProductId"),
    ),
  );
  assert.deepEqual(comparisons[1].pageCount, {
    left: 8,
    right: 12,
    delta: -4,
    mismatch: true,
  });
});

test("pair generation remains complete when the input order changes", () => {
  const decks = [
    deck(PRODUCTS[2], 12, 2),
    deck(PRODUCTS[0], 8, 3),
    deck(PRODUCTS[1], 8, 4),
  ];
  const pairSets = buildPairwiseComparisons(decks).map(
    ({ leftProductId, rightProductId }) =>
      new Set([leftProductId, rightProductId]),
  );
  for (const expected of [
    ["qwen", "doubao"],
    ["qwen", "lingxi"],
    ["doubao", "lingxi"],
  ]) {
    assert.ok(
      pairSets.some(
        (actual) => expected.every((productId) => actual.has(productId)),
      ),
    );
  }
});

test("fixture scoring bypasses the Codex executable and preserves raw plus parsed results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-m0-fixture-"));
  const scorecard = await scoreDeck({
    product: PRODUCTS[0],
    pageCount: 8,
    imagePaths: [],
    judgeDir: directory,
    scoreFixture: rawScore(3),
    codexExecutable: "/definitely/not/invoked",
  });

  assert.equal(scorecard.scoreSource, "FIXTURE");
  assert.equal(scorecard.model, null);
  assert.equal(scorecard.experimental, true);
  assert.equal(scorecard.experimentalMetric, "assessable_five_dimension_mean");
  assert.equal(typeof scorecard.experimentalAssessableMean, "number");
  assert.equal(Object.hasOwn(scorecard, "overallScore"), false);
  assert.equal(scorecard.dimensions.length, 6);
  assert.equal(
    scorecard.dimensions.find(
      ({ dimension }) => dimension === "factual_accuracy_and_content_quality",
    )?.assessmentStatus,
    "NOT_ASSESSABLE",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "result.raw.json"), "utf8")),
    rawScore(3),
  );
  assert.equal(
    JSON.parse(await readFile(join(directory, "events.raw.jsonl"), "utf8"))
      .modelInvoked,
    false,
  );
  assert.equal(
    JSON.parse(await readFile(join(directory, "scorecard.json"), "utf8"))
      .scoreSource,
    "FIXTURE",
  );
});

test("scoring rejects invented factual assessment without a knowledge pack", () => {
  const invalid = rawScore(3);
  invalid.dimensions.factual_accuracy_and_content_quality = {
    assessmentStatus: "ASSESSED",
    value: 5,
    evidencePages: [3],
    rationale: "不应被接受。",
  };
  assert.throws(
    () => normalizeScorecard(invalid, 8),
    /Factual score must be NOT_ASSESSABLE/u,
  );
});

test("short report keeps replay provenance, page mismatch, and the exact third-product lineage visible", () => {
  const decks = [
    deck(PRODUCTS[0], 8, 3),
    deck(PRODUCTS[1], 8, 4),
    deck(PRODUCTS[2], 12, 2),
  ];
  const report = buildShortReport({
    decks,
    comparisons: buildPairwiseComparisons(decks),
    generatedAt: "2026-08-02T00:00:00.000Z",
  });
  assert.match(report, /PRODUCTION_REPLAY/u);
  assert.match(report, /历史产物对比/u);
  assert.match(report, /WPS 灵犀为 12 页，而千问、豆包均为 8 页/u);
  assert.match(report, /偏差 \+4 页/u);
  assert.match(report, /NOT_ASSESSABLE/u);
  assert.match(report, /可评五维实验均值/u);
  assert.match(report, /没有经过校准/u);
  assert.doesNotMatch(report, /总分|整体分/u);
  assert.doesNotMatch(report, /WPS AI PPT/u);
});

test("the score schema remains exactly six dimensions", () => {
  assert.equal(SCORE_DIMENSIONS.length, 6);
  assert.equal(new Set(SCORE_DIMENSIONS).size, 6);
});

test("renderer contract invokes the configured helper and verifies PNG count, signature, size, and hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-m0-render-contract-"));
  const helperPath = join(directory, "stub-render-helper.mjs");
  const inputPath = join(directory, "source.pptx");
  const renderDir = join(directory, "renders");
  const invocationPath = join(directory, "invocation.json");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lqzdLwAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(inputPath, "stub pptx content");
  await writeFile(
    helperPath,
    `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const outputDir = args[args.indexOf("--output_dir") + 1];
await mkdir(outputDir, { recursive: true });
const png = Buffer.from("${png.toString("base64")}", "base64");
await writeFile(join(outputDir, "slide-1.png"), png);
await writeFile(join(outputDir, "slide-2.png"), png);
await writeFile(${JSON.stringify(invocationPath)}, JSON.stringify(args));
`,
  );

  const rendered = await renderPptxToStaticPages({
    pptxPath: inputPath,
    renderDir,
    expectedPageCount: 2,
    renderHelperPath: helperPath,
    pythonExecutable: process.execPath,
  });
  const invocation = JSON.parse(await readFile(invocationPath, "utf8"));
  assert.deepEqual(invocation, [
    inputPath,
    "--output_dir",
    renderDir,
    "--width",
    "1600",
    "--height",
    "900",
  ]);
  assert.equal(rendered.renderer, "PresentationsArtifactToolRenderHelper");
  assert.equal(rendered.rendererSource, helperPath);
  assert.equal(rendered.pageCount, 2);
  assert.deepEqual(
    rendered.slides.map(({ pageNumber, filename, width, height }) => ({
      pageNumber,
      filename,
      width,
      height,
    })),
    [
      { pageNumber: 1, filename: "slide-01.png", width: 1, height: 1 },
      { pageNumber: 2, filename: "slide-02.png", width: 1, height: 1 },
    ],
  );
  const expectedHash = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  assert.ok(
    rendered.slides.every(
      ({ contentHash, byteSize }) =>
        contentHash === expectedHash && byteSize === png.byteLength,
    ),
  );
});
