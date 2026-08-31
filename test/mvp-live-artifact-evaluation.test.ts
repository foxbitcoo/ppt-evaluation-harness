// @ts-nocheck -- the MVP command intentionally remains a standalone .mjs entrypoint.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPairwiseComparisons,
  normalizeScorecard,
} from "../mvp/historical-m0.mjs";
import {
  LIVE_CLASSIFICATION,
  LIVE_COMPARISON_MODE,
  LIVE_PRODUCTS,
  buildLiveShortReport,
  parseLiveEvaluationArgs,
} from "../mvp/live-artifact-evaluation.mjs";

function rawScore(seed: number) {
  const value = (offset: number) => Math.max(1, Math.min(5, seed + offset));
  return {
    dimensions: {
      requirement_understanding_and_content_coverage: {
        assessmentStatus: "ASSESSED",
        value: value(0),
        evidencePages: [1, 2],
        rationale: "结构与目标受众清晰可见。",
      },
      factual_accuracy_and_content_quality: {
        assessmentStatus: "NOT_ASSESSABLE",
        value: null,
        evidencePages: [],
        rationale: "本轮没有绑定场景知识包。",
      },
      narrative_and_audience_fit: {
        assessmentStatus: "ASSESSED",
        value: value(1),
        evidencePages: [2, 15],
        rationale: "叙事路径适合自主阅读。",
      },
      visual_aesthetics_and_professional_finish: {
        assessmentStatus: "ASSESSED",
        value: value(-1),
        evidencePages: [1, 16],
        rationale: "封面与封底形成一致视觉语言。",
      },
      layout_hierarchy_and_readability: {
        assessmentStatus: "ASSESSED",
        value: value(0),
        evidencePages: [3, 8],
        rationale: "标题和正文层级清楚。",
      },
      imagery_chart_and_information_expression: {
        assessmentStatus: "ASSESSED",
        value: value(-1),
        evidencePages: [4, 9],
        rationale: "示意图能够辅助解释内容。",
      },
    },
  };
}

function deck(product, pageCount, seed, elapsedMinutes) {
  return {
    product,
    classification: LIVE_CLASSIFICATION,
    comparisonMode: LIVE_COMPARISON_MODE,
    run: { elapsedMinutes },
    artifact: {
      pageCount,
      targetPageDeviation: pageCount - 16,
      contentHash: `sha256:${product.id.padEnd(64, "0")}`,
    },
    scorecard: {
      productId: product.id,
      productName: product.name,
      classification: LIVE_CLASSIFICATION,
      comparisonMode: LIVE_COMPARISON_MODE,
      scoreSource: "FIXTURE",
      ...normalizeScorecard(rawScore(seed), pageCount),
    },
  };
}

test("live evaluation arguments require three capture directories", () => {
  const parsed = parseLiveEvaluationArgs([
    "--wps-capture",
    "wps",
    "--qwen-capture",
    "qwen",
    "--doubao-capture",
    "doubao",
    "--output-dir",
    "out",
  ]);
  assert.ok(parsed.captureDirs.wps.endsWith("/wps"));
  assert.ok(parsed.outputDir.endsWith("/out"));
  assert.throws(
    () =>
      parseLiveEvaluationArgs([
        "--wps-capture",
        "wps",
        "--qwen-capture",
        "qwen",
        "--output-dir",
        "out",
      ]),
    /Missing --doubao-capture/u,
  );
});

test("live report preserves LIVE provenance, all pairs, page deviation, and WPS priorities", () => {
  const decks = [
    deck(LIVE_PRODUCTS[0], 17, 2, 53.458),
    deck(LIVE_PRODUCTS[1], 16, 4, 6.204),
    deck(LIVE_PRODUCTS[2], 16, 3, 11.1),
  ];
  const comparisons = buildPairwiseComparisons(decks);
  const report = buildLiveShortReport({
    decks,
    comparisons,
    generatedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(comparisons.length, 3);
  assert.match(report, /LIVE_PRODUCTION/u);
  assert.match(report, /实时厂商赛马/u);
  assert.match(report, /WPS AI PPT 17 页（偏差 \+1）/u);
  assert.match(report, /千问 16 页（偏差 \+0）/u);
  assert.match(report, /WPS 优先改进的三个问题/u);
  assert.match(report, /NOT_ASSESSABLE/u);
  assert.doesNotMatch(report, /历史产物/u);
});
