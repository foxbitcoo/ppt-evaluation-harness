import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSystemAttemptCheckpointStore } from "../src/file-system-checkpoint-store.ts";
import {
  createHarnessProviderExecutionNotStartedCheckpoint,
  createProviderSubmissionIntentCheckpoint,
} from "../src/product-adapter.ts";
import { VOLCANO_EVALUATION_CASE } from "../src/fixtures/volcano-case.ts";

const COMMAND = Object.freeze({
  jobId: "job-checkpoint-head",
  runId: "run-checkpoint-head",
  attemptId: "run-checkpoint-head-attempt-1",
  attemptSeq: 1,
  timeoutMs: 30 * 60 * 1_000,
  signal: new AbortController().signal,
  evaluationCase: VOLCANO_EVALUATION_CASE,
});

test("authenticated checkpoint recovery rejects a valid ledger prefix after suffix rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-prefix-rollback-"));
  const store = new FileSystemAttemptCheckpointStore({
    checkpointStoreId: "prefix-rollback-checkpoints",
    rootPath: root,
  });
  try {
    await store.append(
      createHarnessProviderExecutionNotStartedCheckpoint({
        jobId: COMMAND.jobId,
        caseId: COMMAND.evaluationCase.caseId,
        runId: COMMAND.runId,
        attemptId: COMMAND.attemptId,
        attemptSeq: COMMAND.attemptSeq,
      }),
    );
    await store.append(
      createProviderSubmissionIntentCheckpoint(
        COMMAND,
        "wps-aippt-browser@1",
        "2026-08-02T00:00:00.000Z",
      ),
    );
    const digest = createHash("sha256")
      .update(COMMAND.attemptId)
      .digest("hex");
    const ledgerPath = join(root, `${digest}.jsonl`);
    const [validPrefix] = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    assert.ok(validPrefix);
    await writeFile(ledgerPath, `${validPrefix}\n`, { mode: 0o600 });

    await assert.rejects(
      store.readAttempt(COMMAND.attemptId),
      /checkpoint.*head.*(?:rollback|conflict|mismatch)/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
