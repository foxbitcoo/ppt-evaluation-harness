#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LIVE_VOLCANO_QUERY_V1 } from "./live-wps-capture-only.mjs";

export const LIVE_VENDOR_SEQUENCE = Object.freeze(["wps", "qwen", "doubao"]);

const PRODUCT_NAMES = Object.freeze({
  wps: "WPS AI PPT",
  qwen: "千问",
  doubao: "豆包",
});

function assertLocalJobId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/iu.test(value)
  ) {
    throw new Error("Invalid localJobId");
  }
}

async function assertEmptyDirectory(path) {
  const directory = await stat(path);
  if (!directory.isDirectory() || (await readdir(path)).length !== 0) {
    throw new Error(`Output directory must exist and be empty: ${path}`);
  }
}

function runId(localJobId, vendor) {
  const suffix = createHash("sha256")
    .update(`${localJobId}:${vendor}`)
    .digest("hex")
    .slice(0, 20);
  return `run-live-${vendor}-${suffix}`;
}

async function defaultRunners() {
  const [wps, qwen, doubao] = await Promise.all([
    import("./live-wps-capture-only.mjs"),
    import("./live-qwen-capture-only.mjs"),
    import("./live-doubao-capture-only.mjs"),
  ]);
  return Object.freeze({
    wps: wps.runWpsLiveCaptureOnly,
    qwen: qwen.runQwenLiveCaptureOnly,
    doubao: doubao.runDoubaoLiveCaptureOnly,
  });
}

function orchestrationErrorRecord(vendor, localRunId) {
  return Object.freeze({
    schemaVersion: "capture-orchestration-error-v1",
    localRunId,
    product: PRODUCT_NAMES[vendor],
    caseId: LIVE_VOLCANO_QUERY_V1.caseId,
    status: "orchestration_error",
    submissionEvidence: "unknown",
    executionProvenance: null,
    liveProductionCaptured: false,
    artifact: null,
    safeToRetry: false,
    detail: "Runner failed without authoritative submission-state evidence.",
  });
}

function jobStatus(records) {
  const liveCompleted = records.filter(
    (record) =>
      record.status === "completed" &&
      record.executionProvenance === "LIVE_PRODUCTION" &&
      record.liveProductionCaptured === true &&
      record.artifact !== null,
  ).length;
  const testCompleted = records.filter(
    (record) =>
      record.status === "completed" &&
      record.executionProvenance === "TEST_FAKE" &&
      record.liveProductionCaptured === false,
  ).length;
  const anyCompleted = records.some((record) => record.status === "completed");
  const anyWaiting = records.some(
    (record) => record.status === "waiting_for_human",
  );
  return {
    liveCompleted,
    testCompleted,
    status:
      liveCompleted === LIVE_VENDOR_SEQUENCE.length
        ? "completed"
        : testCompleted === LIVE_VENDOR_SEQUENCE.length
          ? "test_only_completed"
          : anyCompleted
            ? "partial"
            : anyWaiting
              ? "waiting_for_human"
              : "failed",
  };
}

export async function runThreeVendorLiveJob({
  localJobId,
  outputDir,
  runners,
  now = () => new Date().toISOString(),
}) {
  assertLocalJobId(localJobId);
  const absoluteOutputDir = resolve(outputDir);
  await assertEmptyDirectory(absoluteOutputDir);
  const selectedRunners = runners ?? (await defaultRunners());
  for (const vendor of LIVE_VENDOR_SEQUENCE) {
    if (typeof selectedRunners?.[vendor] !== "function") {
      throw new Error(`Missing ${vendor} capture-only Runner`);
    }
  }

  const startedAt = now();
  const runs = [];
  for (const vendor of LIVE_VENDOR_SEQUENCE) {
    const vendorOutputDir = join(absoluteOutputDir, vendor);
    await mkdir(vendorOutputDir);
    const localRunId = runId(localJobId, vendor);
    let record;
    try {
      record = await selectedRunners[vendor]({
        localJobId,
        localRunId,
        outputDir: vendorOutputDir,
      });
    } catch {
      record = orchestrationErrorRecord(vendor, localRunId);
      await writeFile(
        join(vendorOutputDir, "orchestration-error.json"),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    }
    runs.push(Object.freeze({ vendor, record }));
  }
  const endedAt = now();
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("Three-vendor Job clock produced invalid timing");
  }
  const status = jobStatus(runs.map(({ record }) => record));
  const outcome = Object.freeze({
    schemaVersion: "mvp-live-three-vendor-job-v1",
    localJobId,
    caseId: LIVE_VOLCANO_QUERY_V1.caseId,
    intendedExecutionProvenance: "LIVE_PRODUCTION",
    status: status.status,
    liveProductionRunCount: status.liveCompleted,
    testFakeRunCount: status.testCompleted,
    startedAt,
    endedAt,
    elapsedMinutes: Math.round((elapsedMs / 60_000) * 1_000) / 1_000,
    vendorSequence: LIVE_VENDOR_SEQUENCE,
    runs: Object.freeze(runs),
  });
  await writeFile(
    join(absoluteOutputDir, "job-record.json"),
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
      !["--job-id", "--output-dir"].includes(flag) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(
        "Usage: node mvp/live-three-vendor-job.mjs --job-id <id> --output-dir <empty-directory>",
      );
    }
    values.set(flag, value);
  }
  if (
    values.size !== 2 ||
    !values.has("--job-id") ||
    !values.has("--output-dir")
  ) {
    throw new Error(
      "Usage: node mvp/live-three-vendor-job.mjs --job-id <id> --output-dir <empty-directory>",
    );
  }
  return {
    localJobId: values.get("--job-id"),
    outputDir: values.get("--output-dir"),
  };
}

async function main() {
  const input = cliArguments(process.argv.slice(2));
  await mkdir(resolve(input.outputDir), { recursive: true });
  const outcome = await runThreeVendorLiveJob(input);
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
