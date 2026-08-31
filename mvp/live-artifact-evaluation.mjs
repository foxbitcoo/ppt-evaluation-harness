#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPairwiseComparisons,
  inspectPptx,
  renderPptxToStaticPages,
  scoreDeck,
} from "./historical-m0.mjs";

export const LIVE_CLASSIFICATION = "LIVE_PRODUCTION";
export const LIVE_COMPARISON_MODE = "实时厂商赛马";
export const LIVE_CASE = Object.freeze({
  caseId: "volcano-query-v1",
  title: "火山为什么会喷发",
  targetPageCount: 16,
  audience: "初中生",
  readingMode: "self_reading",
  query:
    "为初中生制作一份供自主阅读的 16 页《火山为什么会喷发》科普 PPT。严格按以下结构生成：第 1 页封面，第 2 页目录，第 3–14 页正文，第 15 页总结/知识回顾，第 16 页封底。内容覆盖火山成因、喷发过程、典型案例和安全常识；风格清晰活泼，使用适合初中生理解的示意图。",
});

export const LIVE_PRODUCTS = Object.freeze([
  Object.freeze({ id: "wps", name: "WPS AI PPT" }),
  Object.freeze({ id: "qwen", name: "千问" }),
  Object.freeze({ id: "doubao", name: "豆包" }),
]);

function usage() {
  return `Usage:
  node mvp/live-artifact-evaluation.mjs \\
    --wps-capture <directory> \\
    --qwen-capture <directory> \\
    --doubao-capture <directory> \\
    --output-dir <empty-directory>`;
}

export function parseLiveEvaluationArgs(argv) {
  const allowed = new Set([
    "--wps-capture",
    "--qwen-capture",
    "--doubao-capture",
    "--output-dir",
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) {
      throw new Error(`Invalid arguments.\n${usage()}`);
    }
    if (Object.hasOwn(parsed, flag)) {
      throw new Error(`Duplicate argument: ${flag}`);
    }
    parsed[flag] = value;
  }
  for (const required of [
    "--wps-capture",
    "--qwen-capture",
    "--doubao-capture",
    "--output-dir",
  ]) {
    if (!parsed[required]) throw new Error(`Missing ${required}.\n${usage()}`);
  }
  return Object.freeze({
    captureDirs: Object.freeze({
      wps: resolve(parsed["--wps-capture"]),
      qwen: resolve(parsed["--qwen-capture"]),
      doubao: resolve(parsed["--doubao-capture"]),
    }),
    outputDir: resolve(parsed["--output-dir"]),
  });
}

function sha256Json(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function normalizeSha256(value) {
  if (typeof value !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(value)) {
    throw new Error("Capture record has an invalid SHA-256");
  }
  return value.startsWith("sha256:") ? value.toLowerCase() : `sha256:${value.toLowerCase()}`;
}

async function assertEmptyOutputDirectory(path) {
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length !== 0) {
    throw new Error(`Output directory must be empty: ${path}`);
  }
}

function parseTrace(text, productName) {
  const events = text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  if (events.length === 0) throw new Error(`${productName} Trace is empty`);
  for (const event of events) {
    if (
      typeof event?.timestamp !== "string" ||
      !Number.isFinite(Date.parse(event.timestamp)) ||
      typeof event?.event !== "string" ||
      event.event.length === 0
    ) {
      throw new Error(`${productName} Trace contains an invalid event`);
    }
  }
  return Object.freeze(events.map((event) => Object.freeze(event)));
}

async function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue to the next explicit candidate.
    }
  }
  return null;
}

function productElapsedMinutes(record) {
  if (Number.isFinite(record.generationElapsedMinutes)) {
    return record.generationElapsedMinutes;
  }
  if (Number.isFinite(record.vendorReportedGenerationElapsedMinutes)) {
    return record.vendorReportedGenerationElapsedMinutes;
  }
  if (Number.isFinite(record.wallClockElapsedMinutes)) {
    return record.wallClockElapsedMinutes;
  }
  return null;
}

export async function loadVerifiedLiveCapture({ product, captureDir }) {
  const runRecordPath = join(captureDir, "run-record.json");
  const requestPath = join(captureDir, "capture-request.json");
  const tracePath = join(captureDir, "trace.jsonl");
  const [record, request, traceText] = await Promise.all([
    readFile(runRecordPath, "utf8").then(JSON.parse),
    readFile(requestPath, "utf8").then(JSON.parse),
    readFile(tracePath, "utf8"),
  ]);
  if (
    record.status !== "completed" ||
    record.executionProvenance !== LIVE_CLASSIFICATION ||
    record.liveProductionCaptured !== true ||
    record.artifact === null ||
    record.attemptCount !== 1
  ) {
    throw new Error(`${product.name} is not a completed one-attempt LIVE_PRODUCTION capture`);
  }
  if (request.prompt !== LIVE_CASE.query) {
    throw new Error(`${product.name} capture does not use the frozen Query`);
  }
  const recordedArtifactPath = record.artifact.path;
  const artifactPath = await firstExistingFile([
    typeof recordedArtifactPath === "string" && recordedArtifactPath.startsWith("/")
      ? recordedArtifactPath
      : "",
    typeof recordedArtifactPath === "string" ? resolve(recordedArtifactPath) : "",
    join(captureDir, record.artifact.fileName ?? ""),
    join(captureDir, basename(recordedArtifactPath ?? "")),
  ].filter(Boolean));
  if (artifactPath === null) {
    throw new Error(`${product.name} captured PPTX cannot be resolved`);
  }
  const inspected = await inspectPptx(artifactPath);
  if (inspected.contentHash !== normalizeSha256(record.artifact.sha256)) {
    throw new Error(`${product.name} captured PPTX hash mismatch`);
  }
  if (inspected.pageCount !== record.artifact.verifiedPageCount) {
    throw new Error(`${product.name} captured PPTX page-count mismatch`);
  }
  const trace = parseTrace(traceText, product.name);
  if (!trace.some(({ event }) => event === "submission_confirmed")) {
    throw new Error(`${product.name} Trace lacks submission evidence`);
  }
  if (!trace.some(({ event }) => event === "artifact_downloaded")) {
    throw new Error(`${product.name} Trace lacks artifact evidence`);
  }
  return Object.freeze({
    product,
    captureDir,
    request: Object.freeze(request),
    record: Object.freeze(record),
    trace,
    traceText,
    artifactPath,
    inspected,
    elapsedMinutes: productElapsedMinutes(record),
  });
}

function scoreMap(deck) {
  return new Map(deck.scorecard.dimensions.map((dimension) => [dimension.dimension, dimension]));
}

function pageLinks(productId, pages) {
  return pages.length === 0
    ? "无"
    : pages
        .map(
          (page) =>
            `[P${page}](./renders/${productId}/slide-${String(page).padStart(2, "0")}.png)`,
        )
        .join("、");
}

function orderedDecks(decks) {
  return [...decks].sort(
    (left, right) =>
      right.scorecard.experimentalAssessableMean -
      left.scorecard.experimentalAssessableMean,
  );
}

function strongestDimension(deck) {
  return [...deck.scorecard.dimensions]
    .filter(({ value }) => value !== null)
    .sort((left, right) => right.value - left.value)[0];
}

function materialRows(comparisons) {
  return comparisons
    .flatMap((comparison) =>
      comparison.materialGaps.map((gap) => ({ comparison, gap })),
    )
    .sort((left, right) => Math.abs(right.gap.delta) - Math.abs(left.gap.delta));
}

function trailingAndLeading(row) {
  const { comparison, gap } = row;
  if (gap.delta > 0) {
    return {
      trailingId: comparison.rightProductId,
      trailingName: comparison.rightProductName,
      leadingId: comparison.leftProductId,
      leadingName: comparison.leftProductName,
      trailingPages: gap.rightEvidencePages,
      leadingPages: gap.leftEvidencePages,
    };
  }
  return {
    trailingId: comparison.leftProductId,
    trailingName: comparison.leftProductName,
    leadingId: comparison.rightProductId,
    leadingName: comparison.rightProductName,
    trailingPages: gap.leftEvidencePages,
    leadingPages: gap.rightEvidencePages,
  };
}

export function buildLiveShortReport({ decks, comparisons, generatedAt }) {
  const ordered = orderedDecks(decks);
  const gaps = materialRows(comparisons);
  const wpsDeck = decks.find(({ product }) => product.id === "wps");
  const wpsGapRows = gaps.filter(
    (row) => trailingAndLeading(row).trailingId === "wps",
  );
  const wpsFallback = [...wpsDeck.scorecard.dimensions]
    .filter(({ value }) => value !== null)
    .sort((left, right) => left.value - right.value)
    .slice(0, 3);
  const pageCounts = decks
    .map(
      ({ product, artifact }) =>
        `${product.name} ${artifact.pageCount} 页（偏差 ${artifact.targetPageDeviation >= 0 ? "+" : ""}${artifact.targetPageDeviation}）`,
    )
    .join("、");
  const lines = [
    "# AI PPT 三厂商实时赛马 MVP",
    "",
    `> 证据类型：\`${LIVE_CLASSIFICATION}\`；模式：${LIVE_COMPARISON_MODE}。三家均使用同一个冻结 Query，各真实提交一次；只评估静态阅读效果，不评估动画。`,
    "",
    "## 关键结论",
    "",
    `- 可评五维实验均值排序：${ordered.map(({ product, scorecard }) => `${product.name} ${scorecard.experimentalAssessableMean.toFixed(2)}`).join(" > ")}。该指标尚未校准，仅用于本次探索比较；事实维度因本轮没有场景知识包统一为 \`NOT_ASSESSABLE\`。`,
    `- 页数执行：${pageCounts}。保留第一份真实产物，不裁页、不因偏差重跑。`,
    `- 耗时分钟：${decks.map(({ product, run }) => `${product.name} ${run.elapsedMinutes === null ? "不可可靠重建" : run.elapsedMinutes.toFixed(1)}`).join("、")}。WPS 总时长包含人工确认暂停；豆包采用页面报告的活跃生成时长，不把验证码等待计入模型生成速度。`,
    "",
    "## 各家关键优势",
    "",
  ];
  for (const deck of decks) {
    const strongest = strongestDimension(deck);
    lines.push(
      `- **${deck.product.name}｜${strongest.label} ${strongest.value}/5**：${strongest.rationale}（证据 ${pageLinks(deck.product.id, strongest.evidencePages)}）`,
    );
  }
  lines.push("", "## 关键差距", "");
  if (gaps.length === 0) {
    lines.push("- 五个可评维度没有出现 1 分及以上差距。");
  } else {
    for (const row of gaps.slice(0, 5)) {
      const { comparison, gap } = row;
      lines.push(
        `- **${comparison.leftProductName} vs ${comparison.rightProductName}｜${gap.label}**：${gap.leftValue} vs ${gap.rightValue}；证据 ${comparison.leftProductName} ${pageLinks(comparison.leftProductId, gap.leftEvidencePages)}，${comparison.rightProductName} ${pageLinks(comparison.rightProductId, gap.rightEvidencePages)}。`,
      );
    }
  }
  lines.push("", "## WPS 优先改进的三个问题", "");
  if (wpsGapRows.length > 0) {
    for (const row of wpsGapRows.slice(0, 3)) {
      const relation = trailingAndLeading(row);
      lines.push(
        `- **${row.gap.label}**：WPS 落后于 ${relation.leadingName}；先复盘 WPS ${pageLinks("wps", relation.trailingPages)} 与对方 ${pageLinks(relation.leadingId, relation.leadingPages)} 的可见差异，再转成模板、内容规划或配图策略改动。`,
      );
    }
  } else {
    for (const dimension of wpsFallback) {
      lines.push(
        `- **${dimension.label}**：这是 WPS 当前较低分维度之一（${dimension.value}/5），优先复盘 ${pageLinks("wps", dimension.evidencePages)}；本轮没有形成 1 分及以上的明确落后证据。`,
      );
    }
  }
  lines.push(
    "",
    "## 产物与验证",
    "",
    "| 产品 | 页数 | PPTX SHA-256 | 静态渲染 | 评分来源 |",
    "|---|---:|---|---|---|",
  );
  for (const deck of decks) {
    lines.push(
      `| ${deck.product.name} | ${deck.artifact.pageCount} | \`${deck.artifact.contentHash}\` | [页面目录](./renders/${deck.product.id}/) | ${deck.scorecard.scoreSource} |`,
    );
  }
  lines.push("", `生成时间：${generatedAt}`, "");
  return `${lines.join("\n")}\n`;
}

export async function runLiveArtifactEvaluation(options) {
  await assertEmptyOutputDirectory(options.outputDir);
  const generatedAt = new Date().toISOString();
  const captures = [];
  for (const product of LIVE_PRODUCTS) {
    captures.push(
      await loadVerifiedLiveCapture({
        product,
        captureDir: options.captureDirs[product.id],
      }),
    );
  }
  const decks = [];
  for (const capture of captures) {
    const { product, inspected } = capture;
    const artifactDir = join(options.outputDir, "artifacts");
    const artifactPath = join(artifactDir, `${product.id}.pptx`);
    await mkdir(artifactDir, { recursive: true });
    await copyFile(capture.artifactPath, artifactPath);
    const copied = await inspectPptx(artifactPath);
    if (copied.contentHash !== inspected.contentHash) {
      throw new Error(`Copied artifact hash mismatch: ${product.name}`);
    }
    const renderDir = join(options.outputDir, "renders", product.id);
    const renderManifest = await renderPptxToStaticPages({
      pptxPath: artifactPath,
      renderDir,
      expectedPageCount: inspected.pageCount,
    });
    const imagePaths = renderManifest.slides.map(({ filename }) =>
      join(renderDir, filename),
    );
    const scorecard = await scoreDeck({
      product,
      pageCount: inspected.pageCount,
      imagePaths,
      judgeDir: join(options.outputDir, "judge", product.id),
      classification: LIVE_CLASSIFICATION,
      comparisonMode: LIVE_COMPARISON_MODE,
      caseDefinition: LIVE_CASE,
    });
    const runOutputDir = join(options.outputDir, "runs", product.id);
    await mkdir(runOutputDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(runOutputDir, "capture-request.json"),
        `${JSON.stringify(capture.request, null, 2)}\n`,
      ),
      writeFile(
        join(runOutputDir, "run-record.json"),
        `${JSON.stringify(capture.record, null, 2)}\n`,
      ),
      writeFile(join(runOutputDir, "trace.jsonl"), capture.traceText),
    ]);
    const deck = Object.freeze({
      product,
      classification: LIVE_CLASSIFICATION,
      comparisonMode: LIVE_COMPARISON_MODE,
      executionProvenance: LIVE_CLASSIFICATION,
      run: Object.freeze({
        runId: capture.record.runId,
        vendorTaskId: capture.record.vendorTaskId,
        taskUrl: capture.record.taskUrl,
        submittedAt: capture.record.submittedAt,
        completedAt:
          capture.record.generationCompletedObservedAt ??
          capture.record.lastObservedAt,
        elapsedMinutes: capture.elapsedMinutes,
        timingNote: capture.record.timingNote ?? null,
        attemptCount: capture.record.attemptCount,
        configuration: capture.request.configuration,
        trace: capture.trace,
      }),
      artifact: Object.freeze({
        filename: `${product.id}.pptx`,
        relativePath: relative(options.outputDir, artifactPath),
        byteSize: inspected.byteSize,
        pageCount: inspected.pageCount,
        targetPageCount: LIVE_CASE.targetPageCount,
        targetPageDeviation: inspected.pageCount - LIVE_CASE.targetPageCount,
        contentHash: inspected.contentHash,
        zipValidation: inspected.zipValidation,
      }),
      renderManifest,
      scorecard,
    });
    decks.push(deck);
    await mkdir(join(options.outputDir, "decks"), { recursive: true });
    await writeFile(
      join(options.outputDir, "decks", `${product.id}.json`),
      `${JSON.stringify(deck, null, 2)}\n`,
    );
  }
  const comparisons = buildPairwiseComparisons(decks);
  await mkdir(join(options.outputDir, "comparisons"), { recursive: true });
  for (const comparison of comparisons) {
    await writeFile(
      join(options.outputDir, "comparisons", `${comparison.comparisonId}.json`),
      `${JSON.stringify(comparison, null, 2)}\n`,
    );
  }
  const report = buildLiveShortReport({ decks, comparisons, generatedAt });
  await writeFile(join(options.outputDir, "report.md"), report);
  const summaryCore = {
    schemaVersion: "live-ppt-race-mvp-v1",
    generatedAt,
    case: LIVE_CASE,
    classification: LIVE_CLASSIFICATION,
    comparisonMode: LIVE_COMPARISON_MODE,
    liveGenerationPerformed: true,
    limitations: Object.freeze([
      "事实维度没有绑定场景知识包，本轮统一 NOT_ASSESSABLE。",
      "只评估静态阅读效果，不评估动画。",
      "静态渲染未经过独立人工逐页验收。",
      "WPS 总时长包含人工确认暂停，不应直接解释为纯生成速度。",
    ]),
    decks: Object.freeze(decks),
    comparisons,
    reportPath: "report.md",
  };
  const summary = Object.freeze({
    ...summaryCore,
    payloadHash: sha256Json(summaryCore),
  });
  await writeFile(
    join(options.outputDir, "live-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

async function main() {
  const options = parseLiveEvaluationArgs(process.argv.slice(2));
  const summary = await runLiveArtifactEvaluation(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "completed",
        classification: summary.classification,
        comparisonMode: summary.comparisonMode,
        outputDir: options.outputDir,
        reportPath: join(options.outputDir, summary.reportPath),
        products: summary.decks.map(({ product, artifact, scorecard }) => ({
          product: product.name,
          pageCount: artifact.pageCount,
          experimentalAssessableMean: scorecard.experimentalAssessableMean,
        })),
        comparisonIds: summary.comparisons.map(({ comparisonId }) => comparisonId),
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
