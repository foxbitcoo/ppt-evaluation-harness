#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LIVE_VOLCANO_QUERY_V1 = Object.freeze({
  caseId: "volcano-query-v1",
  track: "query_generation",
  title: "火山为什么会喷发",
  targetPageCount: 16,
  audience: "初中生",
  readingMode: "self_reading",
  query:
    "为初中生制作一份供自主阅读的 16 页《火山为什么会喷发》科普 PPT。严格按以下结构生成：第 1 页封面，第 2 页目录，第 3–14 页正文，第 15 页总结/知识回顾，第 16 页封底。内容覆盖火山成因、喷发过程、典型案例和安全常识；风格清晰活泼，使用适合初中生理解的示意图。",
});

export const WPS_LIVE_PRODUCT_CONFIGURATION = Object.freeze({
  product: "WPS AI PPT",
  productUrl: "https://aippt.wps.cn/aippt/",
  accountScope: "current_authenticated_account",
  commercialConstraint: "zero_incremental_cost",
  packageSelection: "best_available_zero_incremental_cost",
  mode: "professional",
  networking: "enabled",
  pageCount: 16,
});

export const WPS_CAPTURE_ONLY_PROTOCOL = Object.freeze({
  maxAttempts: 1,
  timeoutMs: 30 * 60 * 1_000,
  resultSelectionPolicy: "first_downloaded_pptx",
  retryPolicy: "never_after_submitted_or_unknown",
  unknownSubmissionRetryAllowed: false,
});

function assertLocalId(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/iu.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

export function buildWpsLiveCaptureRequest({ localJobId, localRunId }) {
  assertLocalId(localJobId, "localJobId");
  assertLocalId(localRunId, "localRunId");
  return Object.freeze({
    schemaVersion: "wps-live-capture-request-v1",
    localJobId,
    localRunId,
    intendedExecutionProvenance: "LIVE_PRODUCTION",
    case: LIVE_VOLCANO_QUERY_V1,
    productConfiguration: WPS_LIVE_PRODUCT_CONFIGURATION,
    protocol: WPS_CAPTURE_ONLY_PROTOCOL,
  });
}

const EMBEDDED_BUILD_MANIFEST_PATH = new URL(
  "../src/embedded-build-manifest.ts",
  import.meta.url,
);
const TRUSTED_BRIDGE_EXECUTABLE_PATH = new URL(
  "../bin/wps-aippt-live-bridge",
  import.meta.url,
);

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function existingBridgePreflight() {
  const manifestSource = await readFile(EMBEDDED_BUILD_MANIFEST_PATH, "utf8");
  const hashMatch = manifestSource.match(
    /trustedWpsLiveBridgeExecutableHash:\s*(null|"sha256:[a-f0-9]{64}")/u,
  );
  if (hashMatch === null) {
    return Object.freeze({
      available: false,
      reason: "trusted_live_bridge_manifest_is_unreadable",
      detail: "Trusted WPS live bridge manifest entry is unreadable.",
    });
  }
  if (hashMatch[1] === "null") {
    return Object.freeze({
      available: false,
      reason: "trusted_live_bridge_executable_unavailable",
      detail: "Trusted WPS live bridge executable is unavailable in this build.",
    });
  }
  const expectedHash = hashMatch[1].slice(1, -1);
  try {
    const executable = await readFile(TRUSTED_BRIDGE_EXECUTABLE_PATH);
    if (sha256(executable) !== expectedHash) {
      return Object.freeze({
        available: false,
        reason: "trusted_live_bridge_hash_mismatch",
        detail: "Trusted WPS live bridge executable hash verification failed.",
      });
    }
  } catch {
    return Object.freeze({
      available: false,
      reason: "trusted_live_bridge_executable_unavailable",
      detail: "Trusted WPS live bridge executable is unavailable in this build.",
    });
  }
  return Object.freeze({
    available: false,
    reason: "trusted_live_bridge_cli_host_not_wired",
    detail: "Trusted WPS live bridge exists, but this capture-only CLI host is not wired to it.",
  });
}

async function assertEmptyDirectory(path) {
  const directory = await stat(path);
  if (!directory.isDirectory() || (await readdir(path)).length !== 0) {
    throw new Error(`Output directory must exist and be empty: ${path}`);
  }
}

function elapsedTiming(startedAt, endedAt) {
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("Capture-only clock produced invalid timing");
  }
  return Object.freeze({
    startedAt,
    endedAt,
    elapsedMs,
    elapsedMinutes: Math.round((elapsedMs / 60_000) * 1_000) / 1_000,
  });
}

async function runUnzip(args) {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn("unzip", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectProcess);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectProcess(
          new Error(`PPTX validation failed: ${Buffer.concat(stderr).toString("utf8")}`),
        );
      } else {
        resolveProcess(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

function checkedTrace(events) {
  if (!Array.isArray(events)) throw new Error("Capture trace must be an array");
  return Object.freeze(
    events.map((event, index) => {
      if (
        event === null ||
        typeof event !== "object" ||
        typeof event.eventType !== "string" ||
        !/^[a-z0-9_:-]{3,128}$/iu.test(event.eventType) ||
        !Number.isFinite(Date.parse(event.sourceAt)) ||
        !Number.isFinite(Date.parse(event.observedAt)) ||
        !["not_submitted", "submitted", "unknown"].includes(
          event.submissionEvidenceAtCheckpoint,
        ) ||
        event.vendorTaskId !== null ||
        (event.sourceUrl !== null &&
          event.sourceUrl !== "https://aippt.wps.cn/aippt/") ||
        /cookie|authorization|bearer|token|password|secret|reasoning|thought/iu.test(
          JSON.stringify(event),
        )
      ) {
        throw new Error("Capture trace contains unsafe or unverified evidence");
      }
      return Object.freeze({ sequence: index + 1, ...event });
    }),
  );
}

async function persistTestCapture({
  request,
  outputDir,
  startedAt,
  endedAt,
  result,
}) {
  if (
    result?.outcome !== "captured" ||
    result.executionProvenance !== "TEST_FAKE" ||
    result.submissionEvidence !== "submitted" ||
    result.vendorTaskId !== null ||
    result.artifact?.mimeType !==
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    !(result.artifact.content instanceof Uint8Array)
  ) {
    throw new Error("TEST_FAKE capture result is invalid");
  }
  const observableTrace = checkedTrace(result.observableTrace);
  const artifactDirectory = join(outputDir, "artifacts");
  const artifactPath = join(artifactDirectory, "wps-aippt-first.pptx");
  await mkdir(artifactDirectory);
  await writeFile(artifactPath, result.artifact.content);
  await runUnzip(["-tq", artifactPath]);
  const listing = await runUnzip(["-Z1", artifactPath]);
  const pageCount = listing
    .split(/\r?\n/u)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry)).length;
  if (pageCount < 1) throw new Error("Captured PPTX contains no slides");
  const artifactStat = await stat(artifactPath);
  const artifact = Object.freeze({
    filename: "wps-aippt-first.pptx",
    relativePath: "artifacts/wps-aippt-first.pptx",
    mimeType: result.artifact.mimeType,
    byteSize: artifactStat.size,
    contentHash: sha256(result.artifact.content),
    actualPageCount: pageCount,
    targetPageCount: request.case.targetPageCount,
    pageCountDeviation: pageCount - request.case.targetPageCount,
    basicValidation: "PASS",
  });
  return Object.freeze({
    schemaVersion: "wps-live-capture-run-record-v1",
    localJobId: request.localJobId,
    localRunId: request.localRunId,
    caseId: request.case.caseId,
    product: "WPS AI PPT",
    status: "completed",
    terminalReason: "success",
    submissionEvidence: "submitted",
    intendedExecutionProvenance: "LIVE_PRODUCTION",
    executionProvenance: "TEST_FAKE",
    liveProductionCaptured: false,
    attemptCount: 1,
    vendorTaskId: null,
    requestedProductConfiguration: request.productConfiguration,
    observedProductConfiguration: result.observedProductConfiguration,
    protocol: request.protocol,
    timing: elapsedTiming(startedAt, endedAt),
    observableTrace,
    artifact,
    handoff: null,
  });
}

export async function runWpsLiveCaptureOnly({
  localJobId,
  localRunId,
  outputDir,
  now = () => new Date().toISOString(),
  testCapturePort,
}) {
  const absoluteOutputDir = resolve(outputDir);
  await assertEmptyDirectory(absoluteOutputDir);
  const request = buildWpsLiveCaptureRequest({ localJobId, localRunId });
  const startedAt = now();
  await writeFile(
    join(absoluteOutputDir, "capture-request.json"),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  if (testCapturePort !== undefined) {
    if (testCapturePort?.kind !== "TEST_FAKE_CAPTURE_PORT") {
      throw new Error("Only an explicit TEST_FAKE capture port may be injected");
    }
    const captured = await testCapturePort.capture(request);
    const endedAt = now();
    const outcome = await persistTestCapture({
      request,
      outputDir: absoluteOutputDir,
      startedAt,
      endedAt,
      result: captured,
    });
    await writeFile(
      join(absoluteOutputDir, "trace.jsonl"),
      outcome.observableTrace.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    await writeFile(
      join(absoluteOutputDir, "run-record.json"),
      `${JSON.stringify(outcome, null, 2)}\n`,
    );
    return outcome;
  }
  const preflight = await existingBridgePreflight();
  const endedAt = now();
  const traceEvent = Object.freeze({
    sequence: 1,
    eventType: "trusted_bridge_preflight_failed",
    sourceAt: endedAt,
    observedAt: endedAt,
    scope: "LOCAL_PREFLIGHT",
    submissionEvidenceAtCheckpoint: "not_submitted",
    vendorTaskId: null,
    detail: preflight.detail,
  });
  const outcome = Object.freeze({
    schemaVersion: "wps-live-capture-run-record-v1",
    localJobId,
    localRunId,
    caseId: request.case.caseId,
    product: "WPS AI PPT",
    status: "waiting_for_human",
    terminalReason: "human_wait",
    submissionEvidence: "not_submitted",
    intendedExecutionProvenance: "LIVE_PRODUCTION",
    executionProvenance: null,
    liveProductionCaptured: false,
    attemptCount: 0,
    vendorTaskId: null,
    requestedProductConfiguration: request.productConfiguration,
    observedProductConfiguration: null,
    protocol: request.protocol,
    timing: elapsedTiming(startedAt, endedAt),
    observableTrace: Object.freeze([traceEvent]),
    artifact: null,
    handoff: Object.freeze({
      state: "waiting_for_human",
      reason: preflight.reason,
      browserStateMutated: false,
      safeToRetryAfterResolution: true,
      requiredAction:
        "Provide an attested harness-owned external Chrome bridge, then rerun without exporting cookies.",
    }),
  });
  await writeFile(
    join(absoluteOutputDir, "trace.jsonl"),
    `${JSON.stringify(traceEvent)}\n`,
  );
  await writeFile(
    join(absoluteOutputDir, "run-record.json"),
    `${JSON.stringify(outcome, null, 2)}\n`,
  );
  return outcome;
}

function cliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--job-id", "--run-id", "--output-dir"].includes(flag) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(
        "Usage: node mvp/live-wps-capture-only.mjs --job-id <id> --run-id <id> --output-dir <empty-directory>",
      );
    }
    values.set(flag, value);
  }
  if (
    values.size !== 3 ||
    !values.has("--job-id") ||
    !values.has("--run-id") ||
    !values.has("--output-dir")
  ) {
    throw new Error(
      "Usage: node mvp/live-wps-capture-only.mjs --job-id <id> --run-id <id> --output-dir <empty-directory>",
    );
  }
  return {
    localJobId: values.get("--job-id"),
    localRunId: values.get("--run-id"),
    outputDir: values.get("--output-dir"),
  };
}

async function main() {
  const argumentsForRun = cliArguments(process.argv.slice(2));
  await mkdir(resolve(argumentsForRun.outputDir), { recursive: true });
  const outcome = await runWpsLiveCaptureOnly(argumentsForRun);
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exitCode = outcome.status === "completed" ? 0 : 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
