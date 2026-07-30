import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { FileSystemBrowserProfileLock } from "../src/browser-profile-lock.ts";
import type { ObservableAttemptEvent } from "../src/domain.ts";
import {
  FileSystemImmutableBlobStore,
} from "../src/file-system-blob-store.ts";
import {
  FileSystemAttemptCheckpointStore,
} from "../src/file-system-checkpoint-store.ts";
import {
  appendProviderSubmissionIntentCheckpoint,
  attemptSubmissionState,
  createHarnessProviderExecutionNotStartedCheckpoint,
  createProviderSubmissionIntentCheckpoint,
  InMemoryAttemptCheckpointStore,
  submissionEvidenceBoundToCheckpoints,
} from "../src/product-adapter.ts";
import { VOLCANO_EVALUATION_CASE } from "../src/fixtures/volcano-case.ts";
import {
  validateWpsProductionRecoveryPayloads,
} from "../src/wps-production-recovery.ts";
import {
  trustedWpsRecoveryCheckpoint,
} from "../src/wps-recovery-checkpoints.ts";

const COMMAND = Object.freeze({
  jobId: "job-t10-recovery",
  runId: "run-t10-recovery",
  attemptId: "run-t10-recovery-attempt-1",
  attemptSeq: 1,
  timeoutMs: 30 * 60 * 1_000,
  signal: new AbortController().signal,
  evaluationCase: VOLCANO_EVALUATION_CASE,
});

const WPS_RECOVERY_ROOT =
  "/Users/chenyifan/.local/share/ppt-evaluation-harness/rehearsals/wps-real-provider-20260728-round5-resolution-final";
const WPS_RECOVERY_AVAILABLE = existsSync(WPS_RECOVERY_ROOT);
const WPS_TRUSTED_CHECKPOINT =
  trustedWpsRecoveryCheckpoint(
    "wps-real-provider-20260728-round5-resolution-final",
  );
const TEST_VERIFIER_BUILD_IDENTITY = Object.freeze({
  schemaVersion: "ppt-evaluation-build-identity-v1" as const,
  specCommitSha: "9bcaa7708934ad5c67e275bc5863e81efad7bec0",
  source: "EMBEDDED_VERIFIED_BUILD_MANIFEST" as const,
  sourceArchiveDigest:
    "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const,
  sourceArchiveEntryCount: 1,
  embeddedManifestHash:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const,
  manifestHash:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222" as const,
});

async function knownWpsRecoveryPayloads() {
  const artifactStore = new FileSystemImmutableBlobStore({
    storeId: WPS_TRUSTED_CHECKPOINT.storeIds.artifact,
    rootPath: join(WPS_RECOVERY_ROOT, "artifact-recovery"),
  });
  const runSpecificationStore = new FileSystemImmutableBlobStore({
    storeId: WPS_TRUSTED_CHECKPOINT.storeIds.runSpecification,
    rootPath: join(WPS_RECOVERY_ROOT, "run-specification"),
  });
  const checkpointStore = new FileSystemAttemptCheckpointStore({
    checkpointStoreId: WPS_TRUSTED_CHECKPOINT.storeIds.checkpoint,
    rootPath: join(WPS_RECOVERY_ROOT, "checkpoint"),
  });
  const [manifest, original, runSpecification, checkpoints] =
    await Promise.all([
      artifactStore.read(WPS_TRUSTED_CHECKPOINT.keys.manifest),
      artifactStore.read(WPS_TRUSTED_CHECKPOINT.keys.original),
      runSpecificationStore.read(
        WPS_TRUSTED_CHECKPOINT.keys.runSpecification,
      ),
      checkpointStore.readAttempt(
        WPS_TRUSTED_CHECKPOINT.attemptId,
      ),
    ]);
  assert.ok(manifest);
  assert.ok(original);
  assert.ok(runSpecification);
  return {
    command: {
      registryId: WPS_TRUSTED_CHECKPOINT.registryId,
      artifactRecoveryRootReference:
        WPS_TRUSTED_CHECKPOINT.rootReferences.artifactRecovery,
      runSpecificationRootReference:
        WPS_TRUSTED_CHECKPOINT.rootReferences.runSpecification,
      checkpointRootReference:
        WPS_TRUSTED_CHECKPOINT.rootReferences.checkpoint,
      artifactStoreId: WPS_TRUSTED_CHECKPOINT.storeIds.artifact,
      manifestKey: WPS_TRUSTED_CHECKPOINT.keys.manifest,
      originalKey: WPS_TRUSTED_CHECKPOINT.keys.original,
      runSpecificationStoreId:
        WPS_TRUSTED_CHECKPOINT.storeIds.runSpecification,
      runSpecificationKey:
        WPS_TRUSTED_CHECKPOINT.keys.runSpecification,
      checkpointStoreId:
        WPS_TRUSTED_CHECKPOINT.storeIds.checkpoint,
      attemptId: WPS_TRUSTED_CHECKPOINT.attemptId,
    },
    registryHash: WPS_TRUSTED_CHECKPOINT.registryHash,
    manifest,
    original,
    runSpecification,
    checkpoints,
    readArtifactPayload: (key: string) => artifactStore.read(key),
    trustedCheckpoint: WPS_TRUSTED_CHECKPOINT,
    verifierBuildIdentity: TEST_VERIFIER_BUILD_IDENTITY,
  };
}

test(
  "WPS recovery binds the retained Artifact, receipt, render, Run Specification, checkpoints, and identities",
  { skip: !WPS_RECOVERY_AVAILABLE },
  async () => {
    const payloads = await knownWpsRecoveryPayloads();
    const result =
      await validateWpsProductionRecoveryPayloads(payloads);

    assert.equal(result.jobId, WPS_TRUSTED_CHECKPOINT.jobId);
    assert.equal(result.runId, WPS_TRUSTED_CHECKPOINT.runId);
    assert.equal(
      result.attemptId,
      WPS_TRUSTED_CHECKPOINT.attemptId,
    );
    assert.equal(
      result.artifactId,
      WPS_TRUSTED_CHECKPOINT.artifactId,
    );
    assert.equal(result.derivativeCount, 33);
    assert.equal(result.recoveredDerivativeCount, 33);
    assert.equal(result.checkpointCount, 2);
    assert.deepEqual(result.binaryValidation, {
      pptxSlideCount: 16,
      staticPngCount: 16,
      contactSheetPngCount: 1,
    });
  },
);

test(
  "WPS recovery fails closed on registry, Run Specification, checkpoint ordering, and Render drift",
  { skip: !WPS_RECOVERY_AVAILABLE },
  async () => {
    const payloads = await knownWpsRecoveryPayloads();
    await assert.rejects(
      validateWpsProductionRecoveryPayloads({
        ...payloads,
        registryHash:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
      /root registry.*trusted checkpoint/i,
    );

    const driftedSpecification = Uint8Array.from(
      payloads.runSpecification,
    );
    driftedSpecification[driftedSpecification.length - 1] =
      (driftedSpecification[driftedSpecification.length - 1] ?? 0) ^ 1;
    await assert.rejects(
      validateWpsProductionRecoveryPayloads({
        ...payloads,
        runSpecification: driftedSpecification,
      }),
      /Run Specification.*JSON|Run Specification.*checkpoint/i,
    );

    await assert.rejects(
      validateWpsProductionRecoveryPayloads({
        ...payloads,
        checkpoints: [...payloads.checkpoints].reverse(),
      }),
      /checkpoint.*lineage|checkpoint.*order|checkpoint.*Trace/i,
    );

    const renderKey =
      `artifacts/${WPS_TRUSTED_CHECKPOINT.artifactId}/render-manifest`;
    await assert.rejects(
      validateWpsProductionRecoveryPayloads({
        ...payloads,
        readArtifactPayload: async (key) => {
          const content = await payloads.readArtifactPayload(key);
          if (content === null || key !== renderKey) return content;
          const tampered = Uint8Array.from(content);
          tampered[tampered.length - 1] =
            (tampered[tampered.length - 1] ?? 0) ^ 1;
          return tampered;
        },
      }),
      /Render manifest.*JSON|Render manifest.*checkpoint/i,
    );
  },
);

test("the real WPS trace keeps configuration non-terminal and cannot trigger a duplicate submission", async () => {
  const control =
    createHarnessProviderExecutionNotStartedCheckpoint({
      jobId: COMMAND.jobId,
      caseId: COMMAND.evaluationCase.caseId,
      runId: COMMAND.runId,
      attemptId: COMMAND.attemptId,
      attemptSeq: COMMAND.attemptSeq,
    });
  const intent = createProviderSubmissionIntentCheckpoint(
    COMMAND,
    "wps-aippt-browser@1",
    "2026-07-31T00:00:00.000Z",
  );
  const configurationObserved: ObservableAttemptEvent = Object.freeze({
    ...intent,
    eventId: `${COMMAND.attemptId}-configuration-observed`,
    eventType: "configuration_observed",
    sourceAt: "2026-07-31T00:00:01.000Z",
    observedAt: "2026-07-31T00:00:01.000Z",
    evidenceRef: "ev_0000000000000001",
    sourceUrl: "https://aippt.wps.cn/aippt/",
    submissionEvidenceAtCheckpoint: "not_submitted",
    vendorTaskId: "task_wps_real_capture_20260727",
    taskStateVersion: "created@1",
  });
  const terminalNotSubmitted: ObservableAttemptEvent = Object.freeze({
    ...configurationObserved,
    eventId: `${COMMAND.attemptId}-terminal-not-submitted`,
    eventType: "query_not_submitted",
    sourceAt: "2026-07-31T00:00:02.000Z",
    observedAt: "2026-07-31T00:00:02.000Z",
    evidenceRef: "ev_0000000000000002",
    vendorTaskId: null,
    taskStateVersion: "not_submitted@1",
  });
  const artifactDownloaded: ObservableAttemptEvent = Object.freeze({
    ...configurationObserved,
    eventId: `${COMMAND.attemptId}-artifact-downloaded`,
    eventType: "artifact_downloaded",
    sourceAt: "2026-07-31T00:00:03.000Z",
    observedAt: "2026-07-31T00:00:03.000Z",
    evidenceRef: "ev_0000000000000003",
    sourceUrl: "https://365.kdocs.cn/l/redacted",
    submissionEvidenceAtCheckpoint: "submitted",
    taskStateVersion: "artifact_ready@6",
    artifactId: "artifact_wps_retained_real_capture",
  });

  assert.equal(
    attemptSubmissionState([control, intent, configurationObserved]),
    "unknown",
  );
  assert.equal(
    submissionEvidenceBoundToCheckpoints(
      "not_submitted",
      [control, intent, configurationObserved],
    ),
    "unknown",
  );
  assert.equal(
    attemptSubmissionState([
      control,
      intent,
      {
        ...terminalNotSubmitted,
        vendorTaskId: "task_not_proven_absent",
      },
    ]),
    "unknown",
  );
  assert.equal(
    attemptSubmissionState([
      control,
      intent,
      {
        ...terminalNotSubmitted,
        writerId: "untrusted-writer@1",
      },
    ]),
    "unknown",
  );
  assert.equal(
    attemptSubmissionState([
      control,
      intent,
      configurationObserved,
      terminalNotSubmitted,
    ]),
    "not_submitted",
  );
  assert.equal(
    attemptSubmissionState([
      control,
      intent,
      configurationObserved,
      artifactDownloaded,
    ]),
    "submitted",
  );

  const store = new InMemoryAttemptCheckpointStore(
    "t10-real-wps-trace",
  );
  for (const event of [
    control,
    intent,
    configurationObserved,
    artifactDownloaded,
  ]) {
    await store.append(event);
  }
  await assert.rejects(
    appendProviderSubmissionIntentCheckpoint(
      store,
      COMMAND,
      "wps-aippt-browser@1",
      "2026-07-31T00:00:04.000Z",
    ),
    /cannot follow submitted Attempt state/i,
  );
  assert.equal(
    store
      .snapshot()
      .filter(({ eventType }) => eventType === "submission_intent")
      .length,
    1,
  );
});

test("all three provider adapters start one idempotent next submission epoch after proven non-submission", async () => {
  for (const adapterVersion of [
    "wps-aippt-browser@1",
    "qwen-web@1",
    "doubao-web-ppt@1",
  ]) {
    const store = new InMemoryAttemptCheckpointStore(
      `t10-submission-intent-epochs:${adapterVersion}`,
    );
    const firstIntent = createProviderSubmissionIntentCheckpoint(
      COMMAND,
      adapterVersion,
      "2026-07-31T00:00:00.000Z",
    );
    await store.append(firstIntent);
    await store.append({
      ...firstIntent,
      eventId: `${COMMAND.attemptId}-terminal-not-submitted`,
      eventType: "query_not_submitted",
      sourceAt: "2026-07-31T00:00:01.000Z",
      observedAt: "2026-07-31T00:00:01.000Z",
      evidenceRef: "ev_0000000000000003",
      submissionEvidenceAtCheckpoint: "not_submitted",
      taskStateVersion: "not_submitted@1",
    });

    const secondIntent =
      await appendProviderSubmissionIntentCheckpoint(
        store,
        COMMAND,
        adapterVersion,
        "2026-07-31T00:00:02.000Z",
      );
    const repeated =
      await appendProviderSubmissionIntentCheckpoint(
        store,
        COMMAND,
        adapterVersion,
        "2026-07-31T00:00:03.000Z",
      );

    assert.equal(
      secondIntent.eventId,
      `${COMMAND.attemptId}-submission-intent-2`,
    );
    assert.deepEqual(repeated, secondIntent);
    assert.equal(
      attemptSubmissionState(
        await store.readAttempt(COMMAND.attemptId),
      ),
      "unknown",
    );
    assert.equal(
      store
        .snapshot()
        .filter(({ eventType }) => eventType === "submission_intent")
        .length,
      2,
    );
  }
});

test("a legacy submitted Attempt without an intent cannot mint a new submission epoch", async () => {
  const store = new InMemoryAttemptCheckpointStore(
    "t10-legacy-submitted-attempt",
  );
  await store.append({
    eventId: `${COMMAND.attemptId}-legacy-submitted`,
    jobId: COMMAND.jobId,
    caseId: COMMAND.evaluationCase.caseId,
    runId: COMMAND.runId,
    attemptId: COMMAND.attemptId,
    attemptSeq: COMMAND.attemptSeq,
    eventType: "query_submitted",
    sourceAt: "2026-07-31T00:00:00.000Z",
    observedAt: "2026-07-31T00:00:00.000Z",
    writerId: "wps-aippt-browser@1",
    evidenceRef: "ev_legacy_submitted",
    sourceUrl: "https://aippt.wps.cn/aippt/",
    submissionEvidenceAtCheckpoint: "submitted",
    vendorTaskId: "task_legacy_submitted",
    taskStateVersion: "query_submitted@1",
    adapterVersion: "wps-aippt-browser@1",
    artifactId: null,
  });

  await assert.rejects(
    appendProviderSubmissionIntentCheckpoint(
      store,
      COMMAND,
      "wps-aippt-browser@1",
      "2026-07-31T00:00:01.000Z",
    ),
    /cannot follow submitted Attempt state/i,
  );
  assert.equal(store.snapshot().length, 1);
});

test("recovered submission intents require a contiguous explicit epoch identity", async () => {
  const store = new InMemoryAttemptCheckpointStore(
    "t10-invalid-intent-epoch",
  );
  await store.append({
    ...createProviderSubmissionIntentCheckpoint(
      COMMAND,
      "qwen-web@1",
      "2026-07-31T00:00:00.000Z",
    ),
    eventId: `${COMMAND.attemptId}-submission-intent-3`,
  });

  await assert.rejects(
    appendProviderSubmissionIntentCheckpoint(
      store,
      COMMAND,
      "qwen-web@1",
      "2026-07-31T00:00:01.000Z",
    ),
    /epoch.*contiguous|identity.*invalid/i,
  );
});

test("a browser profile lock is released when its owner process is killed", async () => {
  const rootPath = await mkdtemp(
    join(tmpdir(), "t10-browser-lock-crash-"),
  );
  const moduleUrl = pathToFileURL(
    resolve("src/browser-profile-lock.ts"),
  ).href;
  const childProgram = `
    import { FileSystemBrowserProfileLock } from ${JSON.stringify(moduleUrl)};
    const lock = new FileSystemBrowserProfileLock({
      lockId: "t10-child-owner",
      rootPath: process.argv[1],
      timeoutMs: 5000,
    });
    await lock.runExclusive("shared-profile", async () => {
      process.stdout.write("acquired\\n");
      await new Promise(() => {});
    });
  `;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      childProgram,
      rootPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolveAcquired, rejectAcquired) => {
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (value: string) => {
        stdout += value;
        if (stdout.includes("acquired\n")) resolveAcquired();
      });
      child.once("error", rejectAcquired);
      child.once("exit", (code, signal) => {
        if (!stdout.includes("acquired\n")) {
          rejectAcquired(
            new Error(
              `profile-lock child exited before acquisition: ${code}/${signal}`,
            ),
          );
        }
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    });

    let entered = false;
    await new FileSystemBrowserProfileLock({
      lockId: "t10-recovery-owner",
      rootPath,
      retryMs: 5,
      timeoutMs: 1_000,
    }).runExclusive("shared-profile", async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("lock-file PID metadata cannot steal an active browser profile advisory lock", async () => {
  const rootPath = await mkdtemp(
    join(tmpdir(), "t10-browser-lock-pid-reuse-"),
  );
  const profile = "pid-reuse-profile";
  const digest = createHash("sha256").update(profile).digest("hex");
  const lockPath = join(rootPath, `${digest}.lock`);
  const first = new FileSystemBrowserProfileLock({
    lockId: "t10-pid-owner",
    rootPath,
    retryMs: 5,
    timeoutMs: 1_000,
  });
  const second = new FileSystemBrowserProfileLock({
    lockId: "t10-pid-contender",
    rootPath,
    retryMs: 5,
    timeoutMs: 50,
  });
  let release!: () => void;
  const held = first.runExclusive(profile, async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        processId: process.pid,
        processStartIdentity: "simulated-reused-pid",
      }),
    );
    await new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
  });
  try {
    while (release === undefined) {
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, 1)
      );
    }
    await assert.rejects(
      second.runExclusive(profile, async () => {
        throw new Error("PID metadata stole an active profile lock");
      }),
      /timed out acquiring/i,
    );
  } finally {
    release?.();
    await held;
    await rm(rootPath, { recursive: true, force: true });
  }
});
