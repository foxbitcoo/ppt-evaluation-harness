#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  LIVE_VOLCANO_QUERY_V1,
  WPS_CAPTURE_ONLY_PROTOCOL,
} from "./live-wps-capture-only.mjs";

export { LIVE_VOLCANO_QUERY_V1 };

export const DOUBAO_LIVE_PRODUCT_CONFIGURATION = Object.freeze({
  product: "豆包",
  productUrl: "https://www.doubao.com/",
  accountScope: "current_authenticated_account",
  commercialConstraint: "zero_incremental_cost",
  packageSelection: "best_available_zero_incremental_cost",
  commercialPlanObservation: "ui_unavailable",
  modelSelection: "selection_at_runtime",
  modelNameObservation: "ui_unavailable",
  mode: "ppt_generation",
  length: "detailed",
  style: "intelligent_matching",
  networking: "enabled",
  pageCount: 16,
});

export const DOUBAO_CAPTURE_ONLY_PROTOCOL = WPS_CAPTURE_ONLY_PROTOCOL;

function assertLocalId(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/iu.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

export function buildDoubaoLiveCaptureRequest({ localJobId, localRunId }) {
  assertLocalId(localJobId, "localJobId");
  assertLocalId(localRunId, "localRunId");
  return Object.freeze({
    schemaVersion: "doubao-live-capture-request-v1",
    localJobId,
    localRunId,
    intendedExecutionProvenance: "LIVE_PRODUCTION",
    case: LIVE_VOLCANO_QUERY_V1,
    productConfiguration: DOUBAO_LIVE_PRODUCT_CONFIGURATION,
    protocol: DOUBAO_CAPTURE_ONLY_PROTOCOL,
  });
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function existingBridgePreflight() {
  return Object.freeze({
    available: false,
    reason: "trusted_doubao_live_bridge_executable_unavailable",
    detail: "Trusted Doubao live bridge executable is unavailable in this build.",
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
          new Error(
            `PPTX validation failed: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      } else {
        resolveProcess(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

function isSafeDoubaoSourceUrl(value) {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === "https://www.doubao.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      (parsed.pathname === "/" || /^\/chat\/[0-9]+$/u.test(parsed.pathname))
    );
  } catch {
    return false;
  }
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
        !isSafeDoubaoSourceUrl(event.sourceUrl ?? null) ||
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
  const artifactPath = join(artifactDirectory, "doubao-first.pptx");
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
    filename: "doubao-first.pptx",
    relativePath: "artifacts/doubao-first.pptx",
    mimeType: result.artifact.mimeType,
    byteSize: artifactStat.size,
    contentHash: sha256(result.artifact.content),
    actualPageCount: pageCount,
    targetPageCount: request.case.targetPageCount,
    pageCountDeviation: pageCount - request.case.targetPageCount,
    basicValidation: "PASS",
  });
  return Object.freeze({
    schemaVersion: "doubao-live-capture-run-record-v1",
    localJobId: request.localJobId,
    localRunId: request.localRunId,
    caseId: request.case.caseId,
    product: "豆包",
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

export async function runDoubaoLiveCaptureOnly({
  localJobId,
  localRunId,
  outputDir,
  now = () => new Date().toISOString(),
  testCapturePort,
}) {
  const absoluteOutputDir = resolve(outputDir);
  await assertEmptyDirectory(absoluteOutputDir);
  const request = buildDoubaoLiveCaptureRequest({ localJobId, localRunId });
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
      outcome.observableTrace.map((event) => JSON.stringify(event)).join("\n") +
        "\n",
    );
    await writeFile(
      join(absoluteOutputDir, "run-record.json"),
      `${JSON.stringify(outcome, null, 2)}\n`,
    );
    return outcome;
  }
  const preflight = existingBridgePreflight();
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
    schemaVersion: "doubao-live-capture-run-record-v1",
    localJobId,
    localRunId,
    caseId: request.case.caseId,
    product: "豆包",
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
        "Provide an attested harness-owned external Chrome bridge for Doubao, then rerun without exporting cookies.",
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
        "Usage: node mvp/live-doubao-capture-only.mjs --job-id <id> --run-id <id> --output-dir <empty-directory>",
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
      "Usage: node mvp/live-doubao-capture-only.mjs --job-id <id> --run-id <id> --output-dir <empty-directory>",
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
  const outcome = await runDoubaoLiveCaptureOnly(argumentsForRun);
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
