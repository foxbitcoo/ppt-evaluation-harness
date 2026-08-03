#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TABLES = {
  cases: "tblgCGNkvK6taXB4",
  runs: "tblXeULVGlrkD6Zt",
  scores: "tblVFOzP8y5PSZgb",
  gaps: "tblxG3ItdJiBWiO5",
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`Invalid argument near ${key ?? "end"}`);
    args[key.slice(2)] = value;
  }
  for (const required of ["base-token", "evaluation-dir"]) {
    if (!args[required]) throw new Error(`Missing --${required}`);
  }
  return args;
}

function runLark(args) {
  const result = spawnSync("lark-cli", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) throw new Error(`lark-cli returned ok=false: ${result.stdout}`);
  return parsed;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function shanghaiDate(iso) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function findRecord(baseToken, tableId, stableId) {
  const filter = JSON.stringify({ logic: "and", conditions: [["稳定ID", "==", stableId]] });
  const result = runLark([
    "base", "+record-list", "--base-token", baseToken, "--table-id", tableId,
    "--field-id", "稳定ID", "--filter-json", filter, "--limit", "10", "--format", "json",
  ]);
  const ids = result.data?.record_id_list ?? [];
  if (ids.length > 1) throw new Error(`Duplicate stable ID ${stableId} in ${tableId}`);
  return ids[0] ?? null;
}

function waitForRecord(baseToken, tableId, stableId) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const recordId = findRecord(baseToken, tableId, stableId);
    if (recordId) return recordId;
    Atomics.wait(sleeper, 0, 0, 500);
  }
  return null;
}

function upsertRecord(baseToken, tableId, stableId, fields) {
  const existing = findRecord(baseToken, tableId, stableId);
  const args = [
    "base", "+record-upsert", "--base-token", baseToken, "--table-id", tableId,
    "--json", JSON.stringify({ ...fields, "稳定ID": stableId }), "--format", "json",
  ];
  if (existing) args.push("--record-id", existing);
  const result = runLark(args);
  const recordId = existing ?? result.data?.record?.record_id ?? result.data?.record_id ?? waitForRecord(baseToken, tableId, stableId);
  if (!recordId) throw new Error(`Missing record ID after upsert for ${stableId}`);
  return { recordId, created: !existing };
}

function uploadAttachments(baseToken, tableId, recordId, fieldId, files) {
  const args = [
    "base", "+record-upload-attachment", "--base-token", baseToken, "--table-id", tableId,
    "--record-id", recordId, "--field-id", fieldId, "--format", "json",
  ];
  for (const file of files) args.push("--file", `./${relative(process.cwd(), file)}`);
  return runLark(args);
}

function uploadMissingAttachments(baseToken, tableId, recordId, fieldId, files) {
  const result = runLark([
    "base", "+record-get", "--base-token", baseToken, "--table-id", tableId,
    "--record-id", recordId, "--field-id", fieldId, "--format", "json",
  ]);
  const attachments = result.data?.data?.[0]?.[0] ?? [];
  const existingNames = new Set(Array.isArray(attachments) ? attachments.map((attachment) => attachment.name) : []);
  const missing = files.filter((file) => !existingNames.has(basename(file)));
  if (missing.length) uploadAttachments(baseToken, tableId, recordId, fieldId, missing);
}

function dimension(scorecard, id) {
  const item = scorecard.dimensions.find((candidate) => candidate.dimension === id);
  if (!item) throw new Error(`Missing dimension ${id} for ${scorecard.productId}`);
  return item;
}

function dimensionEvidence(scorecard) {
  return scorecard.dimensions.map((item) => `${item.label}:${item.evidencePages.length ? `P${item.evidencePages.join(",P")}` : item.assessmentStatus}`).join("；");
}

function keyDimension(scorecard, order) {
  const assessed = scorecard.dimensions.filter((item) => item.assessmentStatus === "ASSESSED");
  return [...assessed].sort((a, b) => order * (a.value - b.value))[0];
}

function productName(id, decks) {
  return decks.find((deck) => deck.product.id === id)?.product.name ?? id;
}

function comparisonText(comparison, decks) {
  if (!comparison.materialGaps.length) return "本轮五个可评维度无显著分差。";
  return comparison.materialGaps.map((gap) => {
    const winner = gap.winnerProductId ? productName(gap.winnerProductId, decks) : "持平";
    return `${gap.label}：${comparison.leftProductName} ${gap.leftValue} vs ${comparison.rightProductName} ${gap.rightValue}，领先：${winner}`;
  }).join("；");
}

function comparisonEvidence(comparison) {
  return comparison.materialGaps.map((gap) => `${gap.label}：左P${gap.leftEvidencePages.join(",P")}；右P${gap.rightEvidencePages.join(",P")}`).join("；");
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args["evaluation-dir"]);
const summary = JSON.parse(readFileSync(join(root, "live-summary.json"), "utf8"));
const baseToken = args["base-token"];
const batchId = "live-volcano-20260803";
const caseStableId = "case:volcano-query-v1:live-mvp-20260803";

if (summary.classification !== "LIVE_PRODUCTION" || !summary.liveGenerationPerformed) {
  throw new Error("Publisher accepts only a completed LIVE_PRODUCTION evaluation");
}

const casePayload = {
  schemaVersion: "case-v1",
  caseId: caseStableId,
  title: summary.case.title,
  mode: summary.case.mode,
  query: summary.case.query,
  targetPageCount: summary.case.targetPageCount,
  structure: summary.case.structure,
  knowledgePackMode: summary.case.knowledgePackMode,
  knowledgePackRef: summary.case.knowledgePackRef,
};
const caseRecord = upsertRecord(baseToken, TABLES.cases, caseStableId, {
  "载荷": JSON.stringify(casePayload),
  "载荷哈希": sha256Json(casePayload),
});

const runRecords = [];
const scoreRecords = [];
for (const deck of summary.decks) {
  const productId = deck.product.id;
  const runStableId = `live-run:${deck.run.runId}`;
  const runPayload = {
    schemaVersion: "live-run-projection-v1",
    caseStableId,
    classification: deck.classification,
    comparisonMode: deck.comparisonMode,
    product: deck.product,
    run: deck.run,
    artifact: deck.artifact,
    renderManifest: {
      renderer: deck.renderManifest.renderer,
      animationPolicy: deck.renderManifest.animationPolicy,
      pageCount: deck.renderManifest.pageCount,
      slides: deck.renderManifest.slides.map(({ pageNumber, filename, contentHash }) => ({ pageNumber, filename, contentHash })),
    },
  };
  const model = deck.run.configuration.model ?? deck.run.configuration.qualityMode ?? deck.run.configuration.generationMode;
  const entryUrls = {
    wps: "https://aippt.wps.cn/aippt/",
    qwen: "https://www.qianwen.com/",
    doubao: "https://www.doubao.com/",
  };
  const runRecord = upsertRecord(baseToken, TABLES.runs, runStableId, {
    "运行ID": deck.run.runId,
    "数据环境": "LIVE_PRODUCTION",
    "厂商": deck.product.name,
    "模型/档位": String(model),
    "套餐参数": JSON.stringify(deck.run.configuration),
    "提示词": summary.case.query,
    "过程Trace": JSON.stringify(deck.run.trace),
    "总耗时分钟": Number(deck.run.elapsedMinutes.toFixed(1)),
    "开始时间": shanghaiDate(deck.run.submittedAt),
    "结束时间": shanghaiDate(deck.run.completedAt),
    "首个有效输出时间": shanghaiDate(deck.run.completedAt),
    "运行状态": "成功",
    "阻断/错误": deck.run.timingNote ?? "",
    "目标页数": deck.artifact.targetPageCount,
    "实际页数": deck.artifact.pageCount,
    "页数偏差": deck.artifact.targetPageDeviation,
    "产物SHA256": deck.artifact.contentHash.replace(/^sha256:/u, ""),
    "网页入口": entryUrls[productId],
    "产物链接": deck.run.taskUrl,
    "静态渲染状态": "已生成",
    "载荷": JSON.stringify(runPayload),
    "载荷哈希": sha256Json(runPayload),
  });
  const artifact = join(root, deck.artifact.relativePath);
  const renderDir = join(root, "renders", productId);
  const montage = join(renderDir, "montage.png");
  const slides = readdirSync(renderDir).filter((name) => /^slide-\d+\.png$/u.test(name)).sort().map((name) => join(renderDir, name));
  uploadMissingAttachments(baseToken, TABLES.runs, runRecord.recordId, "PPT产物", [artifact]);
  uploadMissingAttachments(baseToken, TABLES.runs, runRecord.recordId, "产物附件", [montage, ...slides]);
  runRecords.push({ stableId: runStableId, recordId: runRecord.recordId, product: deck.product.name });

  const scorecard = deck.scorecard;
  const requirement = dimension(scorecard, "requirement_understanding_and_content_coverage");
  const facts = dimension(scorecard, "factual_accuracy_and_content_quality");
  const narrative = dimension(scorecard, "narrative_and_audience_fit");
  const visual = dimension(scorecard, "visual_aesthetics_and_professional_finish");
  const layout = dimension(scorecard, "layout_hierarchy_and_readability");
  const imagery = dimension(scorecard, "imagery_chart_and_information_expression");
  const strongest = keyDimension(scorecard, -1);
  const weakest = keyDimension(scorecard, 1);
  const scoreStableId = `live-score:${deck.run.runId}:${scorecard.rubricVersion}`;
  const scorePayload = {
    schemaVersion: "live-score-projection-v1",
    caseStableId,
    runStableId,
    product: deck.product,
    artifact: deck.artifact,
    scorecard,
  };
  const scoreRecord = upsertRecord(baseToken, TABLES.scores, scoreStableId, {
    "数据环境": "LIVE_PRODUCTION",
    "MVP批次": batchId,
    "厂商": deck.product.name,
    "评分器": `${scorecard.model.name} / ${scorecard.model.reasoningEffort} / ${scorecard.rubricVersion}`,
    "目标页数": deck.artifact.targetPageCount,
    "实际页数": deck.artifact.pageCount,
    "页数偏差": deck.artifact.targetPageDeviation,
    "需求理解与内容覆盖": requirement.value,
    "事实准确与内容质量": `${facts.assessmentStatus}｜${facts.rationale}`,
    "叙事与受众适配": narrative.value,
    "视觉美感与专业完成度": visual.value,
    "版式层级与可读性": layout.value,
    "配图图表与信息表达": imagery.value,
    "五维实验均值": scorecard.experimentalAssessableMean,
    "关键优点": `${strongest.label} ${strongest.value}/5｜${strongest.rationale}`,
    "关键问题": `${weakest.label} ${weakest.value}/5｜${weakest.rationale}`,
    "页面证据": dimensionEvidence(scorecard),
    "比较口径": "实时厂商赛马；同一冻结Query；单次样本；任意两两对比；静态阅读；事实维度本轮不参与评分",
    "评分时间": shanghaiDate(summary.generatedAt),
    "载荷": JSON.stringify(scorePayload),
    "载荷哈希": sha256Json(scorePayload),
  });
  uploadMissingAttachments(baseToken, TABLES.scores, scoreRecord.recordId, "静态渲染", [montage]);
  scoreRecords.push({ stableId: scoreStableId, recordId: scoreRecord.recordId, product: deck.product.name });
}

const gapRecords = [];
for (const comparison of summary.comparisons) {
  const stableId = `live-gap:${comparison.comparisonId}:20260803`;
  const leader = comparison.experimentalLeaderProductId ? productName(comparison.experimentalLeaderProductId, summary.decks) : "持平";
  const payload = { schemaVersion: "live-comparison-projection-v1", caseStableId, batchId, comparison };
  const record = upsertRecord(baseToken, TABLES.gaps, stableId, {
    "数据环境": "LIVE_PRODUCTION",
    "MVP批次": batchId,
    "类型": "动态两两对比",
    "对比对象": `${comparison.leftProductName} vs ${comparison.rightProductName}`,
    "领先对象": leader,
    "关键差距": comparisonText(comparison, summary.decks),
    "页面证据": comparisonEvidence(comparison),
    "产品建议": "优先复盘有明确页面证据且分差至少 1 分的维度；把差距转成内容规划、模板版式或配图策略的可验证改动。",
    "生成时间": shanghaiDate(summary.generatedAt),
    "载荷": JSON.stringify(payload),
    "载荷哈希": sha256Json(payload),
  });
  gapRecords.push({ stableId, recordId: record.recordId });
}

const reportStableId = "live-report:volcano-query-v1:20260803";
const sorted = [...summary.decks].sort((a, b) => b.scorecard.experimentalAssessableMean - a.scorecard.experimentalAssessableMean);
const reportPayload = {
  schemaVersion: "live-report-projection-v1",
  caseStableId,
  batchId,
  ranking: sorted.map((deck) => ({ product: deck.product.name, experimentalAssessableMean: deck.scorecard.experimentalAssessableMean })),
  limitations: summary.limitations,
  reportPath: basename(summary.reportPath),
  summaryPayloadHash: summary.payloadHash,
};
const reportRecord = upsertRecord(baseToken, TABLES.gaps, reportStableId, {
  "数据环境": "LIVE_PRODUCTION",
  "MVP批次": batchId,
  "类型": "简短总报告",
  "对比对象": "WPS AI PPT / 千问 / 豆包",
  "领先对象": sorted[0].product.name,
  "关键差距": `可评五维实验均值：${sorted.map((deck) => `${deck.product.name} ${deck.scorecard.experimentalAssessableMean.toFixed(1)}`).join(" > ")}；事实维度本轮不参与。`,
  "页面证据": "详见三家静态预览及动态两两对比记录",
  "产品建议": "WPS 优先补齐有效科普示意图、严格执行页结构，并保留当前叙事与视觉风格优势。",
  "生成时间": shanghaiDate(summary.generatedAt),
  "载荷": JSON.stringify(reportPayload),
  "载荷哈希": sha256Json(reportPayload),
});
uploadMissingAttachments(baseToken, TABLES.gaps, reportRecord.recordId, "报告附件", [join(root, "report.md"), join(root, "live-summary.json")]);

const readback = {
  case: { stableId: caseStableId, recordId: caseRecord.recordId },
  runs: runRecords,
  scores: scoreRecords,
  gaps: gapRecords,
  report: { stableId: reportStableId, recordId: reportRecord.recordId },
};
console.log(JSON.stringify(readback, null, 2));
