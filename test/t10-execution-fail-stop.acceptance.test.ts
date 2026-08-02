import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createWallClockAttemptDeadline,
} from "../src/bakeoff.ts";
import { FileSystemBrowserProfileLock } from "../src/browser-profile-lock.ts";
import {
  ProcessGroupTerminationIncompleteError,
} from "../src/process-group-supervisor.ts";

test("the wall-clock deadline preserves a typed fail-stop raised during abort shutdown", async () => {
  const deadline = createWallClockAttemptDeadline({
    shutdownGraceMs: 50,
  });
  const failure =
    new ProcessGroupTerminationIncompleteError(98_765);
  await assert.rejects(
    deadline.run(
      (signal) =>
        new Promise<never>((_, rejectOperation) => {
          signal.addEventListener(
            "abort",
            () => rejectOperation(failure),
            { once: true },
          );
        }),
      1,
    ),
    (error: unknown) => error === failure,
  );
});

test("the wall-clock deadline owns abort and does not return until the background operation settles", async () => {
  const deadline = createWallClockAttemptDeadline({
    shutdownGraceMs: 250,
  });
  let aborted = false;
  let settled = false;
  const result = await deadline.run(
    (signal) =>
      new Promise<string>((resolveOperation) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            setTimeout(() => {
              settled = true;
              resolveOperation("settled-after-abort");
            }, 20);
          },
          { once: true },
        );
      }),
    1,
  );

  assert.equal(aborted, true);
  assert.equal(settled, true);
  assert.deepEqual(result, {
    timedOut: true,
    elapsedMs: 1,
    shutdownCompleted: true,
    shutdownValue: "settled-after-abort",
  });
});

test("an unresolved adapter shutdown fail-stops its owner before finalization or profile-lock release", async () => {
  const rootPath = await mkdtemp(
    join(tmpdir(), "t10-adapter-shutdown-fail-stop-"),
  );
  const bakeoffUrl = pathToFileURL(resolve("src/bakeoff.ts")).href;
  const lockUrl = pathToFileURL(
    resolve("src/browser-profile-lock.ts"),
  ).href;
  const feishuUrl = pathToFileURL(resolve("src/feishu.ts")).href;
  const mockWpsUrl = pathToFileURL(resolve("src/mock-wps.ts")).href;
  const program = `
    import {
      AdapterShutdownIncompleteError,
      createBakeoffHarness,
    } from ${JSON.stringify(bakeoffUrl)};
    import { FileSystemBrowserProfileLock } from ${JSON.stringify(lockUrl)};
    import { InMemoryFeishuProjection } from ${JSON.stringify(feishuUrl)};
    import { MockWpsProductAdapter } from ${JSON.stringify(mockWpsUrl)};

    const profileLock = new FileSystemBrowserProfileLock({
      lockId: "t10-unresolved-adapter-owner",
      rootPath: process.argv[1],
      timeoutMs: 2_000,
    });
    await profileLock.runExclusive("shared-profile", async () => {
      process.stdout.write("profile-lock-acquired\\n");
      await createBakeoffHarness({
        feishu: new InMemoryFeishuProjection(),
        productAdapter: new MockWpsProductAdapter(),
        attemptDeadline: {
          async run() {
            throw new AdapterShutdownIncompleteError();
          },
        },
      }).startBakeoffJob({
        environment: "test",
        caseId: "volcano-query-v1",
      });
      process.stdout.write("attempt-finalized\\n");
    });
    process.stdout.write("profile-lock-released\\n");
  `;
  const owner = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      program,
      rootPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", (value: string) => {
    stdout += value;
  });
  owner.stderr.setEncoding("utf8");
  owner.stderr.on("data", (value: string) => {
    stderr += value;
  });
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClose, rejectClose) => {
    owner.once("error", rejectClose);
    owner.once("close", (code, signal) => {
      resolveClose({ code, signal });
    });
  });
  try {
    const result = await Promise.race([
      closed,
      new Promise<never>((_, rejectTimeout) => {
        const timer = setTimeout(
          () => rejectTimeout(new Error("fail-stop owner stayed alive")),
          5_000,
        );
        timer.unref();
      }),
    ]);
    assert.deepEqual(
      result,
      { code: null, signal: "SIGKILL" },
      stderr,
    );
    assert.match(stdout, /profile-lock-acquired/);
    assert.doesNotMatch(stdout, /attempt-finalized|profile-lock-released/);

    let replacementEntered = false;
    await new FileSystemBrowserProfileLock({
      lockId: "t10-unresolved-adapter-replacement",
      rootPath,
      timeoutMs: 1_000,
    }).runExclusive("shared-profile", async () => {
      replacementEntered = true;
    });
    assert.equal(replacementEntered, true);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
    }
    await closed.catch(() => undefined);
    await rm(rootPath, { recursive: true, force: true });
  }
});
