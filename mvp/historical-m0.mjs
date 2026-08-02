#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export const M0_CLASSIFICATION = "PRODUCTION_REPLAY";
export const M0_COMPARISON_MODE = "历史产物对比";
export const M0_CASE = Object.freeze({
  caseId: "volcano-history-query-v1",
  title: "火山为什么会喷发",
  targetPageCount: 8,
  audience: "初中生",
  readingMode: "self_reading",
  query:
    "为初中生制作一份《火山为什么会喷发？》的 8 页科普课堂 PPT，包含成因、喷发过程、典型案例、安全常识和课堂小测，风格清晰活泼、配示意图。",
});

export const PRODUCTS = Object.freeze([
  Object.freeze({ id: "qwen", name: "千问" }),
  Object.freeze({ id: "doubao", name: "豆包" }),
  Object.freeze({ id: "lingxi", name: "WPS 灵犀" }),
]);

export const SCORE_DIMENSIONS = Object.freeze([
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
]);

const DIMENSION_LABELS = Object.freeze({
  requirement_understanding_and_content_coverage: "需求理解与内容覆盖",
  factual_accuracy_and_content_quality: "事实准确性与内容质量",
  narrative_and_audience_fit: "叙事与受众适配",
  visual_aesthetics_and_professional_finish: "视觉美感与专业完成度",
  layout_hierarchy_and_readability: "版式层级与可读性",
  imagery_chart_and_information_expression: "配图、图表与信息表达",
});

const NON_FACTUAL_DIMENSIONS = SCORE_DIMENSIONS.filter(
  (dimension) => dimension !== "factual_accuracy_and_content_quality",
);

const ASSESSED_SCORE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    assessmentStatus: { type: "string", enum: ["ASSESSED"] },
    value: { type: "integer", minimum: 1, maximum: 5 },
    evidencePages: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "integer", minimum: 1 },
    },
    rationale: { type: "string", minLength: 1, maxLength: 240 },
  },
  required: ["assessmentStatus", "value", "evidencePages", "rationale"],
});

const FACTUAL_NOT_ASSESSABLE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    assessmentStatus: { type: "string", enum: ["NOT_ASSESSABLE"] },
    value: { type: "null" },
    evidencePages: {
      type: "array",
      maxItems: 0,
      items: { type: "integer" },
    },
    rationale: { type: "string", minLength: 1, maxLength: 240 },
  },
  required: ["assessmentStatus", "value", "evidencePages", "rationale"],
});

export const M0_JUDGE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    dimensions: {
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        requirement_understanding_and_content_coverage:
          ASSESSED_SCORE_SCHEMA,
        factual_accuracy_and_content_quality:
          FACTUAL_NOT_ASSESSABLE_SCHEMA,
        narrative_and_audience_fit: ASSESSED_SCORE_SCHEMA,
        visual_aesthetics_and_professional_finish:
          ASSESSED_SCORE_SCHEMA,
        layout_hierarchy_and_readability: ASSESSED_SCORE_SCHEMA,
        imagery_chart_and_information_expression:
          ASSESSED_SCORE_SCHEMA,
      }),
      required: SCORE_DIMENSIONS,
    },
  },
  required: ["dimensions"],
});

const DEFAULT_CODEX_EXECUTABLE =
  "/Applications/ChatGPT.app/Contents/Resources/codex";
export const DEFAULT_PRESENTATIONS_RENDER_HELPER = join(
  homedir(),
  ".codex/plugins/cache/openai-primary-runtime/presentations/26.801.11242/skills/presentations/container_tools/render_slides.py",
);
export const DEFAULT_PRESENTATIONS_PYTHON = join(
  homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12",
);
const CODEX_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;

function usage() {
  return `Usage:
  node mvp/historical-m0.mjs \\
    --qwen-pptx <path> \\
    --doubao-pptx <path> \\
    --lingxi-pptx <path> \\
    --output-dir <empty-directory> [--score-fixture <fixture.json>]

The optional --score-fixture path is test-only and bypasses Codex CLI scoring.`;
}

export function parseCliArgs(argv) {
  const allowed = new Set([
    "--qwen-pptx",
    "--doubao-pptx",
    "--lingxi-pptx",
    "--output-dir",
    "--score-fixture",
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--")) {
      throw new Error(`Invalid arguments.\n${usage()}`);
    }
    if (Object.hasOwn(parsed, key)) {
      throw new Error(`Duplicate argument: ${key}`);
    }
    parsed[key] = value;
  }
  for (const required of [
    "--qwen-pptx",
    "--doubao-pptx",
    "--lingxi-pptx",
    "--output-dir",
  ]) {
    if (!parsed[required]) {
      throw new Error(`Missing ${required}.\n${usage()}`);
    }
  }
  return Object.freeze({
    qwenPptx: resolve(parsed["--qwen-pptx"]),
    doubaoPptx: resolve(parsed["--doubao-pptx"]),
    lingxiPptx: resolve(parsed["--lingxi-pptx"]),
    outputDir: resolve(parsed["--output-dir"]),
    scoreFixture: parsed["--score-fixture"]
      ? resolve(parsed["--score-fixture"])
      : null,
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveStream, rejectStream) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", rejectStream);
    input.on("end", resolveStream);
  });
  return `sha256:${hash.digest("hex")}`;
}

function sha256Json(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

async function runProcess(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedForLimit = false;
    const append = (chunks, chunk, currentBytes) => {
      if (currentBytes + chunk.byteLength > MAX_PROCESS_OUTPUT_BYTES) {
        killedForLimit = true;
        child.kill("SIGKILL");
        return currentBytes;
      }
      chunks.push(chunk);
      return currentBytes + chunk.byteLength;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });
    child.on("error", rejectProcess);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    timer.unref();
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (killedForLimit) {
        rejectProcess(new Error(`${executable} exceeded output limit`));
      } else if (code !== 0) {
        rejectProcess(
          Object.assign(
            new Error(
              `${basename(executable)} exited ${code ?? signal}: ${result.stderr.slice(0, 2_000)}`,
            ),
            { processResult: result },
          ),
        );
      } else {
        resolveProcess(result);
      }
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    }
  });
}

async function assertEmptyOutputDirectory(path) {
  await mkdir(path, { recursive: true });
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw new Error(`Output directory must be empty: ${path}`);
  }
}

export async function inspectPptx(path) {
  const file = await stat(path);
  if (!file.isFile() || file.size === 0) {
    throw new Error(`PPTX is missing or empty: ${path}`);
  }
  if (!path.toLowerCase().endsWith(".pptx")) {
    throw new Error(`Expected a .pptx file: ${path}`);
  }
  await runProcess("unzip", ["-tq", path]);
  const listing = await runProcess("unzip", ["-Z1", path]);
  const slideEntries = listing.stdout
    .split(/\r?\n/u)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry));
  const uniqueSlides = new Set(slideEntries);
  if (uniqueSlides.size === 0 || uniqueSlides.size !== slideEntries.length) {
    throw new Error(`PPTX has an invalid slide package: ${path}`);
  }
  return Object.freeze({
    sourcePath: resolve(path),
    byteSize: file.size,
    pageCount: uniqueSlides.size,
    contentHash: await sha256File(path),
    zipValidation: "PASS",
  });
}

function slideNumberFromFilename(filename) {
  const match = filename.match(/-(\d+)\.png$/u);
  return match ? Number(match[1]) : Number.NaN;
}

async function verifyPng(path) {
  const content = await readFile(path);
  const signature = "89504e470d0a1a0a";
  if (content.byteLength < 24 || content.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`Invalid PNG render: ${path}`);
  }
  return Object.freeze({
    byteSize: content.byteLength,
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20),
    contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  });
}

export async function renderPptxToStaticPages({
  pptxPath,
  renderDir,
  expectedPageCount,
  renderHelperPath =
    process.env.PRESENTATIONS_RENDER_HELPER ??
    DEFAULT_PRESENTATIONS_RENDER_HELPER,
  pythonExecutable =
    process.env.PRESENTATIONS_PYTHON ?? DEFAULT_PRESENTATIONS_PYTHON,
}) {
  await mkdir(renderDir, { recursive: true });
  const helper = await stat(renderHelperPath);
  if (!helper.isFile()) {
    throw new Error(`Presentations render helper is unavailable: ${renderHelperPath}`);
  }
  await runProcess(
    pythonExecutable,
    [
      renderHelperPath,
      pptxPath,
      "--output_dir",
      renderDir,
      "--width",
      "1600",
      "--height",
      "900",
    ],
    { timeoutMs: 300_000 },
  );
  const generated = (await readdir(renderDir))
    .filter((entry) => /^slide-\d+\.png$/u.test(entry))
    .sort((left, right) => slideNumberFromFilename(left) - slideNumberFromFilename(right));
  if (generated.length !== expectedPageCount) {
    throw new Error(
      `Static render count ${generated.length} does not match PPTX page count ${expectedPageCount}`,
    );
  }
  const normalized = [];
  for (let index = 0; index < generated.length; index += 1) {
    const targetName = `slide-${String(index + 1).padStart(2, "0")}.png`;
    const sourcePath = join(renderDir, generated[index]);
    const targetPath = join(renderDir, targetName);
    if (sourcePath !== targetPath) {
      await rename(sourcePath, targetPath);
    }
    const verified = await verifyPng(targetPath);
    normalized.push(
      Object.freeze({
        pageNumber: index + 1,
        filename: targetName,
        byteSize: verified.byteSize,
        width: verified.width,
        height: verified.height,
        contentHash: verified.contentHash,
      }),
    );
  }
  return Object.freeze({
    renderer: "PresentationsArtifactToolRenderHelper",
    rendererSource: resolve(renderHelperPath),
    rendererSourceHash: await sha256File(renderHelperPath),
    pythonExecutable: resolve(pythonExecutable),
    animationPolicy: "static_first_frame",
    fidelity: "not_independently_verified_by_command",
    pageCount: normalized.length,
    slides: Object.freeze(normalized),
    contentHash: sha256Json(normalized),
  });
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has invalid keys`);
  }
}

export function normalizeScorecard(raw, pageCount) {
  assertExactKeys(raw, ["dimensions"], "Judge result");
  assertExactKeys(raw.dimensions, SCORE_DIMENSIONS, "Judge dimensions");
  const dimensions = SCORE_DIMENSIONS.map((dimension) => {
    const score = raw.dimensions[dimension];
    assertExactKeys(
      score,
      ["assessmentStatus", "value", "evidencePages", "rationale"],
      `Score ${dimension}`,
    );
    const isFactual = dimension === "factual_accuracy_and_content_quality";
    if (isFactual) {
      if (
        score.assessmentStatus !== "NOT_ASSESSABLE" ||
        score.value !== null ||
        !Array.isArray(score.evidencePages) ||
        score.evidencePages.length !== 0
      ) {
        throw new Error("Factual score must be NOT_ASSESSABLE without a Reference Pack");
      }
    } else if (
      score.assessmentStatus !== "ASSESSED" ||
      !Number.isInteger(score.value) ||
      score.value < 1 ||
      score.value > 5 ||
      !Array.isArray(score.evidencePages) ||
      score.evidencePages.length < 1
    ) {
      throw new Error(`Non-factual score is invalid: ${dimension}`);
    }
    if (
      !Array.isArray(score.evidencePages) ||
      score.evidencePages.some(
        (page) => !Number.isInteger(page) || page < 1 || page > pageCount,
      )
    ) {
      throw new Error(`Score evidence page is invalid: ${dimension}`);
    }
    if (
      typeof score.rationale !== "string" ||
      score.rationale.trim().length === 0 ||
      score.rationale.length > 240
    ) {
      throw new Error(`Score rationale is invalid: ${dimension}`);
    }
    return Object.freeze({
      dimension,
      label: DIMENSION_LABELS[dimension],
      assessmentStatus: score.assessmentStatus,
      value: score.value,
      evidencePages: Object.freeze([...new Set(score.evidencePages)].sort((a, b) => a - b)),
      rationale: score.rationale.trim(),
    });
  });
  const assessed = dimensions.filter(({ value }) => value !== null);
  const experimentalAssessableMean =
    Math.round(
      (assessed.reduce((total, { value }) => total + value, 0) /
        assessed.length) *
        100,
    ) / 100;
  return Object.freeze({
    rubricVersion: "query-six-dimension-m0-v1",
    referencePack: null,
    experimental: true,
    experimentalMetric: "assessable_five_dimension_mean",
    experimentalAssessableMean,
    dimensions: Object.freeze(dimensions),
  });
}

function judgePrompt(pageCount) {
  return `你正在评估一份教育场景 PPT 的静态页面。只根据随附的 ${pageCount} 张页面图片判断，不推断隐藏流程或厂商内部原因。

历史原始 Query：${M0_CASE.query}

请按严格 JSON Schema 给出六维评分。除事实维度外，每个维度必须给 1–5 整数、至少一个真实页码证据和不超过 240 字的简短理由。事实准确性维度没有可辩护的专业知识包，因此必须是 NOT_ASSESSABLE、value=null、evidencePages=[]，不得凭模型常识评分。页数不是历史要求的 8 页时保留真实产物，并在需求理解维度据实反映。只评估静态阅读效果，不评估动画。`;
}

export async function loadScoreFixture(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assertExactKeys(parsed, PRODUCTS.map(({ id }) => id), "Score fixture");
  return parsed;
}

export async function scoreDeck({
  product,
  pageCount,
  imagePaths,
  judgeDir,
  scoreFixture = null,
  codexExecutable = process.env.CODEX_M0_EXECUTABLE ?? DEFAULT_CODEX_EXECUTABLE,
}) {
  await mkdir(judgeDir, { recursive: true });
  const schemaPath = join(judgeDir, "schema.json");
  const promptPath = join(judgeDir, "prompt.txt");
  const rawResultPath = join(judgeDir, "result.raw.json");
  const parsedResultPath = join(judgeDir, "scorecard.json");
  const rawEventsPath = join(judgeDir, "events.raw.jsonl");
  const stderrPath = join(judgeDir, "stderr.log");
  await writeFile(schemaPath, `${JSON.stringify(M0_JUDGE_SCHEMA, null, 2)}\n`);
  await writeFile(promptPath, `${judgePrompt(pageCount)}\n`);

  let raw;
  let scoreSource;
  if (scoreFixture !== null) {
    raw = scoreFixture;
    scoreSource = "FIXTURE";
    await writeFile(rawResultPath, `${JSON.stringify(raw, null, 2)}\n`);
    await writeFile(
      rawEventsPath,
      `${JSON.stringify({ source: "FIXTURE", modelInvoked: false })}\n`,
    );
    await writeFile(stderrPath, "");
  } else {
    scoreSource = "CODEX_CLI";
    const isolatedCwd = await mkdtemp(join(tmpdir(), "ppt-m0-judge-"));
    try {
      const args = [
        "exec",
        "-m",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-s",
        "read-only",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "code_mode_host",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "--json",
        "--output-last-message",
        rawResultPath,
        "-C",
        isolatedCwd,
        ...imagePaths.flatMap((path) => ["-i", path]),
        "-",
      ];
      const processResult = await runProcess(codexExecutable, args, {
        cwd: isolatedCwd,
        stdin: judgePrompt(pageCount),
        timeoutMs: CODEX_TIMEOUT_MS,
      });
      await writeFile(rawEventsPath, processResult.stdout);
      await writeFile(stderrPath, processResult.stderr);
      raw = JSON.parse(await readFile(rawResultPath, "utf8"));
    } catch (error) {
      const result = error?.processResult;
      if (result) {
        await writeFile(rawEventsPath, result.stdout ?? "");
        await writeFile(stderrPath, result.stderr ?? "");
      }
      throw error;
    } finally {
      await rm(isolatedCwd, { recursive: true, force: true });
    }
  }
  const scorecard = Object.freeze({
    productId: product.id,
    productName: product.name,
    classification: M0_CLASSIFICATION,
    comparisonMode: M0_COMPARISON_MODE,
    scoreSource,
    model:
      scoreSource === "CODEX_CLI"
        ? Object.freeze({ name: "gpt-5.6-sol", reasoningEffort: "xhigh" })
        : null,
    ...normalizeScorecard(raw, pageCount),
  });
  await writeFile(parsedResultPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  return scorecard;
}

function scoreByDimension(deck) {
  return new Map(deck.scorecard.dimensions.map((score) => [score.dimension, score]));
}

export function buildPairwiseComparisons(decks) {
  const comparisons = [];
  for (let leftIndex = 0; leftIndex < decks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < decks.length; rightIndex += 1) {
      const left = decks[leftIndex];
      const right = decks[rightIndex];
      const leftScores = scoreByDimension(left);
      const rightScores = scoreByDimension(right);
      const dimensions = SCORE_DIMENSIONS.map((dimension) => {
        const leftScore = leftScores.get(dimension);
        const rightScore = rightScores.get(dimension);
        if (leftScore.value === null || rightScore.value === null) {
          return Object.freeze({
            dimension,
            label: DIMENSION_LABELS[dimension],
            assessmentStatus: "NOT_ASSESSABLE",
            leftValue: leftScore.value,
            rightValue: rightScore.value,
            delta: null,
            winnerProductId: null,
            leftEvidencePages: leftScore.evidencePages,
            rightEvidencePages: rightScore.evidencePages,
          });
        }
        const delta = Math.round((leftScore.value - rightScore.value) * 100) / 100;
        return Object.freeze({
          dimension,
          label: DIMENSION_LABELS[dimension],
          assessmentStatus: "ASSESSED",
          leftValue: leftScore.value,
          rightValue: rightScore.value,
          delta,
          winnerProductId:
            delta > 0 ? left.product.id : delta < 0 ? right.product.id : null,
          leftEvidencePages: leftScore.evidencePages,
          rightEvidencePages: rightScore.evidencePages,
        });
      });
      const experimentalAssessableMeanDelta =
        Math.round((left.scorecard.experimentalAssessableMean - right.scorecard.experimentalAssessableMean) * 100) /
        100;
      const materialGaps = dimensions
        .filter(({ delta }) => delta !== null && Math.abs(delta) >= 1)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3);
      comparisons.push(
        Object.freeze({
          comparisonId: `${left.product.id}-vs-${right.product.id}`,
          comparisonType: "DYNAMIC_PAIRWISE",
          baselineProductId: null,
          leftProductId: left.product.id,
          leftProductName: left.product.name,
          rightProductId: right.product.id,
          rightProductName: right.product.name,
          experimental: true,
          leftExperimentalAssessableMean:
            left.scorecard.experimentalAssessableMean,
          rightExperimentalAssessableMean:
            right.scorecard.experimentalAssessableMean,
          experimentalAssessableMeanDelta,
          experimentalLeaderProductId:
            experimentalAssessableMeanDelta > 0
              ? left.product.id
              : experimentalAssessableMeanDelta < 0
                ? right.product.id
                : null,
          pageCount: Object.freeze({
            left: left.artifact.pageCount,
            right: right.artifact.pageCount,
            delta: left.artifact.pageCount - right.artifact.pageCount,
            mismatch: left.artifact.pageCount !== right.artifact.pageCount,
          }),
          dimensions: Object.freeze(dimensions),
          materialGaps: Object.freeze(materialGaps),
        }),
      );
    }
  }
  return Object.freeze(comparisons);
}

function pageLinks(productId, pages) {
  if (pages.length === 0) return "无";
  return pages
    .map(
      (page) =>
        `[P${page}](./renders/${productId}/slide-${String(page).padStart(2, "0")}.png)`,
    )
    .join("、");
}

function ranking(decks) {
  return [...decks].sort(
    (left, right) =>
      right.scorecard.experimentalAssessableMean -
      left.scorecard.experimentalAssessableMean,
  );
}

function recommendationForGap(comparison, gap) {
  const trailingId = gap.delta > 0 ? comparison.rightProductId : comparison.leftProductId;
  const trailingName =
    trailingId === comparison.leftProductId
      ? comparison.leftProductName
      : comparison.rightProductName;
  const leaderName =
    trailingId === comparison.leftProductId
      ? comparison.rightProductName
      : comparison.leftProductName;
  return `${trailingName}：优先改善“${gap.label}”，结合双方页证据复盘与 ${leaderName} 的可见差距。`;
}

export function buildShortReport({ decks, comparisons, generatedAt }) {
  const ordered = ranking(decks);
  const pageCounts = decks.map(({ product, artifact }) => `${product.name} ${artifact.pageCount} 页`).join("、");
  const mismatch = new Set(decks.map(({ artifact }) => artifact.pageCount)).size > 1;
  const keyGapRows = comparisons
    .flatMap((comparison) =>
      comparison.materialGaps.map((gap) => ({ comparison, gap })),
    )
    .sort((left, right) => Math.abs(right.gap.delta) - Math.abs(left.gap.delta))
    .slice(0, 5);
  const recommendations = [];
  for (const row of keyGapRows) {
    const recommendation = recommendationForGap(row.comparison, row.gap);
    if (!recommendations.includes(recommendation)) recommendations.push(recommendation);
    if (recommendations.length === 3) break;
  }
  const lines = [
    "# AI PPT 历史产物对比 M0",
    "",
    `> 证据类型：\`${M0_CLASSIFICATION}\`；模式：${M0_COMPARISON_MODE}。这些文件不是本次实时生成，结论只适用于三份现有静态产物。第三份产物血缘为 WPS 灵犀。`,
    "",
    "## 关键结论",
    "",
    `- 可评五维实验均值的探索排序：${ordered.map(({ product, scorecard }) => `${product.name} ${scorecard.experimentalAssessableMean.toFixed(2)}`).join(" > ")}。该均值没有经过校准，只用于本次历史产物探索比较，不是权威综合评分。事实准确性因没有知识包统一标记为 \`NOT_ASSESSABLE\`，不进入实验均值。`,
    `- 实际页数：${pageCounts}。${mismatch ? "WPS 灵犀为 12 页，而千问、豆包均为 8 页；相对历史 8 页要求偏差 +4 页，存在明确的 12 页对 8 页差异。保留原始产物，不做重跑或裁页。" : "三份产物页数一致。"}`,
    "- 本次只看静态阅读效果，不评估动画；本地渲染保真度未经过独立人工逐页验收。",
    "",
    "## 关键差距与页证据",
    "",
  ];
  if (keyGapRows.length === 0) {
    lines.push("- 五个可评维度未出现 1 分及以上差距。", "");
  } else {
    for (const { comparison, gap } of keyGapRows) {
      lines.push(
        `- **${comparison.leftProductName} vs ${comparison.rightProductName}｜${gap.label}**：${gap.leftValue} vs ${gap.rightValue}；证据 ${comparison.leftProductName} ${pageLinks(comparison.leftProductId, gap.leftEvidencePages)}，${comparison.rightProductName} ${pageLinks(comparison.rightProductId, gap.rightEvidencePages)}。`,
      );
    }
    lines.push("");
  }
  lines.push("## 产品建议", "");
  if (recommendations.length === 0) {
    lines.push("- 暂无足够的 1 分及以上差距形成优先建议。", "");
  } else {
    for (const recommendation of recommendations) lines.push(`- ${recommendation}`);
    lines.push("");
  }
  lines.push(
    "## 产物与校验证据",
    "",
    "| 产品 | 实际页数 | PPTX SHA-256 | 静态渲染 | 自动评分来源 |",
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

export async function runHistoricalM0(options) {
  await assertEmptyOutputDirectory(options.outputDir);
  const generatedAt = new Date().toISOString();
  const fixture = options.scoreFixture
    ? await loadScoreFixture(options.scoreFixture)
    : null;
  const sourceByProduct = new Map([
    ["qwen", options.qwenPptx],
    ["doubao", options.doubaoPptx],
    ["lingxi", options.lingxiPptx],
  ]);
  const decks = [];
  for (const product of PRODUCTS) {
    const sourcePath = sourceByProduct.get(product.id);
    const inspected = await inspectPptx(sourcePath);
    const artifactDir = join(options.outputDir, "artifacts");
    const artifactPath = join(artifactDir, `${product.id}.pptx`);
    await mkdir(artifactDir, { recursive: true });
    await copyFile(sourcePath, artifactPath);
    if ((await sha256File(artifactPath)) !== inspected.contentHash) {
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
      scoreFixture: fixture?.[product.id] ?? null,
    });
    const deck = Object.freeze({
      product,
      classification: M0_CLASSIFICATION,
      comparisonMode: M0_COMPARISON_MODE,
      executionProvenance: "PRODUCTION_REPLAY",
      generationTrace: null,
      generationElapsedMinutes: null,
      historicalLimitation:
        "现有本地文件导入；没有本次实时提交、厂商任务 ID、过程 Trace 或生成耗时。",
      artifact: Object.freeze({
        filename: `${product.id}.pptx`,
        relativePath: relative(options.outputDir, artifactPath),
        byteSize: inspected.byteSize,
        pageCount: inspected.pageCount,
        targetPageCount: M0_CASE.targetPageCount,
        targetPageDeviation: inspected.pageCount - M0_CASE.targetPageCount,
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
  const report = buildShortReport({ decks, comparisons, generatedAt });
  await writeFile(join(options.outputDir, "report.md"), report);
  const summary = Object.freeze({
    schemaVersion: "historical-ppt-race-m0-v1",
    generatedAt,
    case: M0_CASE,
    classification: M0_CLASSIFICATION,
    comparisonMode: M0_COMPARISON_MODE,
    liveGenerationPerformed: false,
    limitations: Object.freeze([
      "三份文件均为历史产物，不代表本次实时厂商调用。",
      "没有可辩护的专业知识包，事实维度统一 NOT_ASSESSABLE。",
      "静态渲染未经过独立人工逐页验收。",
    ]),
    decks: Object.freeze(decks),
    comparisons,
    reportPath: "report.md",
  });
  await writeFile(
    join(options.outputDir, "m0-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const summary = await runHistoricalM0(options);
  process.stdout.write(
    `${JSON.stringify({
      status: "completed",
      classification: summary.classification,
      comparisonMode: summary.comparisonMode,
      outputDir: options.outputDir,
      reportPath: join(options.outputDir, summary.reportPath),
      products: summary.decks.map(({ product, artifact, scorecard }) => ({
        product: product.name,
        pageCount: artifact.pageCount,
        experimentalAssessableMean:
          scorecard.experimentalAssessableMean,
      })),
      comparisonIds: summary.comparisons.map(({ comparisonId }) => comparisonId),
    }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
