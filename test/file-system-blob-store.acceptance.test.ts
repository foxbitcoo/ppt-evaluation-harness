import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { renameSync, symlinkSync, watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSystemImmutableBlobStore } from "../src/file-system-blob-store.ts";

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function writeContext(
  content: Uint8Array,
  writeAttemptId: string,
): {
  readonly jobId: string;
  readonly contentHash: `sha256:${string}`;
  readonly writeAttemptId: string;
  readonly assertWriteAuthorized: () => void;
} {
  return {
    jobId: "job-file-system-blob-store",
    contentHash: sha256(content),
    writeAttemptId,
    assertWriteAuthorized() {},
  };
}

async function runWorker(options: {
  readonly script: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly killOnFirstDirectoryEntry?: string;
}): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}> {
  let child: ReturnType<typeof spawn>;
  let killedOnDirectoryEntry = false;
  const watcher =
    options.killOnFirstDirectoryEntry === undefined
      ? null
      : watch(options.killOnFirstDirectoryEntry, () => {
          if (killedOnDirectoryEntry) return;
          killedOnDirectoryEntry = true;
          watcher?.close();
          child.kill("SIGKILL");
        });
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      options.script,
    ],
    {
      env: {
        ...process.env,
        ...options.environment,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  const childStderr = child.stderr;
  if (childStderr === null) {
    watcher?.close();
    child.kill();
    throw new Error("Worker stderr pipe was not created");
  }
  childStderr.setEncoding("utf8");
  childStderr.on("data", (value: string) => {
    if (stderr.length < 16_384) stderr += value;
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      watcher?.close();
      resolve({ code, signal, stderr });
    });
  });
}

test("an interrupted filesystem writer never publishes a partial immutable blob", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "ppt-file-system-blob-crash-atomic-"),
  );
  const store = new FileSystemImmutableBlobStore({
    storeId: "crash-atomic-store",
    rootPath: root,
  });
  const content = new Uint8Array(128 * 1024 * 1024).fill(0x5a);
  const moduleUrl = new URL(
    "../src/file-system-blob-store.ts",
    import.meta.url,
  ).href;
  const worker = [
    `import { FileSystemImmutableBlobStore } from ${JSON.stringify(moduleUrl)};`,
    "const content = new Uint8Array(128 * 1024 * 1024).fill(0x5a);",
    "const store = new FileSystemImmutableBlobStore({",
    '  storeId: "crash-atomic-store",',
    "  rootPath: process.env.PPT_BLOB_TEST_ROOT,",
    "});",
    'await store.putImmutable("shared-key", content, {',
    '  jobId: "job-file-system-blob-store",',
    `  contentHash: ${JSON.stringify(sha256(content))},`,
    '  writeAttemptId: "interrupted-writer",',
    "  assertWriteAuthorized() {},",
    "});",
  ].join("\n");

  try {
    const exit = await runWorker({
      script: worker,
      environment: { PPT_BLOB_TEST_ROOT: root },
      // The watcher is one-shot and scoped to this empty temporary root. It
      // terminates the writer as soon as its first filesystem entry appears,
      // before a large write can finish.
      killOnFirstDirectoryEntry: root,
    });
    assert.deepEqual(
      { code: exit.code, signal: exit.signal },
      { code: null, signal: "SIGKILL" },
      `writer was not crash-terminated; stderr=${exit.stderr}`,
    );
    assert.equal(
      await store.read("shared-key"),
      null,
      "a failed writer exposed a partial final object",
    );

    await store.putImmutable(
      "shared-key",
      content,
      writeContext(content, "healthy-retry"),
    );
    assert.deepEqual(await store.read("shared-key"), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed writer cannot delete a shared blob adopted by another process", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "ppt-file-system-blob-shared-rollback-"),
  );
  const store = new FileSystemImmutableBlobStore({
    storeId: "shared-rollback-store",
    rootPath: root,
  });
  const content = new TextEncoder().encode(
    "one immutable payload shared by two capture attempts",
  );
  const moduleUrl = new URL(
    "../src/file-system-blob-store.ts",
    import.meta.url,
  ).href;
  const adopter = [
    `import { FileSystemImmutableBlobStore } from ${JSON.stringify(moduleUrl)};`,
    `const content = new Uint8Array(${JSON.stringify([...content])});`,
    "const store = new FileSystemImmutableBlobStore({",
    '  storeId: "shared-rollback-store",',
    "  rootPath: process.env.PPT_BLOB_TEST_ROOT,",
    "});",
    'await store.putImmutable("shared-key", content, {',
    '  jobId: "job-file-system-blob-store",',
    `  contentHash: ${JSON.stringify(sha256(content))},`,
    '  writeAttemptId: "successful-adopter",',
    "  assertWriteAuthorized() {},",
    "});",
  ].join("\n");

  try {
    await store.putImmutable(
      "shared-key",
      content,
      writeContext(content, "failed-creator"),
    );
    const exit = await runWorker({
      script: adopter,
      environment: { PPT_BLOB_TEST_ROOT: root },
    });
    assert.deepEqual(
      { code: exit.code, signal: exit.signal },
      { code: 0, signal: null },
      exit.stderr,
    );

    await store.releaseWriteClaim("shared-key", "failed-creator");

    const freshReader = new FileSystemImmutableBlobStore({
      storeId: "shared-rollback-store",
      rootPath: root,
    });
    assert.deepEqual(
      await freshReader.read("shared-key"),
      content,
      "rollback deleted an immutable blob already adopted by another capture",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blob store rejects root replacement without writing through a symbolic alias", async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "ppt-file-system-blob-root-identity-"),
  );
  const root = join(fixtureRoot, "store");
  const originalRoot = join(fixtureRoot, "store-original");
  const escapeRoot = join(fixtureRoot, "escape");
  await Promise.all([
    mkdir(root, { mode: 0o700 }),
    mkdir(escapeRoot, { mode: 0o700 }),
  ]);
  const store = new FileSystemImmutableBlobStore({
    storeId: "root-identity-store",
    rootPath: root,
  });
  const content = new TextEncoder().encode(
    "must remain bound to the original directory inode",
  );
  try {
    await rename(root, originalRoot);
    await symlink(escapeRoot, root, "dir");
    await assert.rejects(
      store.putImmutable(
        "replacement-key",
        content,
        writeContext(content, "replacement-writer"),
      ),
      /root identity changed|symbolic link/i,
    );
    assert.deepEqual(
      await readdir(escapeRoot),
      [],
      "the rejected write escaped through the replacement symlink",
    );
    await assert.rejects(
      store.read("replacement-key"),
      /root identity changed|symbolic link/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a blob store fails closed when its bound root becomes group-writable", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "ppt-file-system-blob-root-mode-"),
  );
  const store = new FileSystemImmutableBlobStore({
    storeId: "root-mode-store",
    rootPath: root,
  });
  const content = new TextEncoder().encode("permission-bound payload");
  try {
    await chmod(root, 0o720);
    await assert.rejects(
      store.putImmutable(
        "permission-key",
        content,
        writeContext(content, "permission-writer"),
      ),
      /group\/other writable/i,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("a blob store detects mid-publication root replacement without writing to the replacement target", async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "ppt-file-system-blob-mid-replacement-"),
  );
  const root = join(fixtureRoot, "store");
  const originalRoot = join(fixtureRoot, "store-original");
  const replacementTarget = join(fixtureRoot, "replacement-target");
  await Promise.all([
    mkdir(root, { mode: 0o700 }),
    mkdir(replacementTarget, { mode: 0o700 }),
  ]);
  const store = new FileSystemImmutableBlobStore({
    storeId: "mid-replacement-store",
    rootPath: root,
  });
  const content = new TextEncoder().encode(
    "content must never reach a replacement root",
  );
  let authorizationChecks = 0;
  try {
    await assert.rejects(
      store.putImmutable("mid-replacement-key", content, {
        jobId: "job-file-system-blob-store",
        contentHash: sha256(content),
        writeAttemptId: "mid-replacement-writer",
        assertWriteAuthorized() {
          authorizationChecks += 1;
          if (authorizationChecks === 2) {
            renameSync(root, originalRoot);
            symlinkSync(replacementTarget, root, "dir");
          }
        },
      }),
      /root identity changed/i,
    );
    assert.deepEqual(
      await readdir(replacementTarget),
      [],
      "no temporary or final object may be created in the replacement root",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
