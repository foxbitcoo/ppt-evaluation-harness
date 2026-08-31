import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSystemAttemptCheckpointStore } from "../src/file-system-checkpoint-store.ts";
import { createHarnessProviderExecutionNotStartedCheckpoint } from "../src/product-adapter.ts";

test("legacy checkpoint recovery rejects a root inode that differs from its durable registry identity", async () => {
  const parent = await mkdtemp(join(tmpdir(), "checkpoint-root-binding-"));
  const root = join(parent, "checkpoint");
  const displaced = join(parent, "checkpoint-displaced");
  const attemptId = "registry-bound-attempt-1";
  try {
    await mkdir(root, { mode: 0o700 });
    const metadata = await lstat(root);
    const expectedRootIdentity = {
      canonicalPath: await realpath(root),
      deviceId: String(metadata.dev),
      inodeId: String(metadata.ino),
      ownerUid: metadata.uid,
      mode: metadata.mode,
    };
    await rename(root, displaced);
    await mkdir(root, { mode: 0o700 });
    const digest = createHash("sha256").update(attemptId).digest("hex");
    await writeFile(
      join(root, `${digest}.jsonl`),
      `${JSON.stringify(
        createHarnessProviderExecutionNotStartedCheckpoint({
          jobId: "registry-bound-job",
          caseId: "registry-bound-case",
          runId: "registry-bound-run",
          attemptId,
          attemptSeq: 1,
        }),
      )}\n`,
      { mode: 0o600 },
    );
    const store = new FileSystemAttemptCheckpointStore({
      checkpointStoreId: "registry-bound-checkpoints",
      rootPath: root,
      legacyReadOnly: true,
      expectedRootIdentity,
    });

    await assert.rejects(
      store.readAttempt(attemptId),
      /checkpoint.*root identity.*(?:attestation|registry|changed)/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
