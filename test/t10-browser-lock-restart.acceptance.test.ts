import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { FileSystemBrowserProfileLock } from "../src/browser-profile-lock.ts";

test("normal browser profile lock release still serializes contenders", async () => {
  const rootPath = await mkdtemp(
    join(tmpdir(), "t10-browser-lock-normal-release-"),
  );
  let releaseFirst!: () => void;
  let firstEntered = false;
  let secondEntered = false;
  const first = new FileSystemBrowserProfileLock({
    lockId: "t10-normal-first",
    rootPath,
    timeoutMs: 2_000,
  });
  const second = new FileSystemBrowserProfileLock({
    lockId: "t10-normal-second",
    rootPath,
    timeoutMs: 2_000,
  });
  let secondRun: Promise<void> | undefined;
  const firstRun = first.runExclusive("shared-profile", async () => {
    firstEntered = true;
    await new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });
  });
  try {
    while (!firstEntered) {
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 1);
      });
    }
    secondRun = second.runExclusive(
      "shared-profile",
      async () => {
        secondEntered = true;
      },
    );
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 50);
    });
    assert.equal(secondEntered, false);
    releaseFirst();
    await firstRun;
    await secondRun;
    assert.equal(secondEntered, true);
  } finally {
    releaseFirst?.();
    await firstRun.catch(() => undefined);
    await secondRun?.catch(() => undefined);
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("a browser profile owner fail-stops when its acquired lock holder crashes", async () => {
  const rootPath = await mkdtemp(
    join(tmpdir(), "t10-browser-lock-holder-crash-"),
  );
  const moduleUrl = pathToFileURL(
    resolve("src/browser-profile-lock.ts"),
  ).href;
  const childProgram = `
    import { FileSystemBrowserProfileLock } from ${JSON.stringify(moduleUrl)};
    const lock = new FileSystemBrowserProfileLock({
      lockId: "t10-holder-crash-owner",
      rootPath: process.argv[1],
      timeoutMs: 5000,
    });
    await lock.runExclusive("shared-profile", async () => {
      process.stdout.write("acquired\\n");
      for (;;) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      }
    });
  `;
  const owner = spawn(
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
  const ownerExit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    owner.once("error", rejectExit);
    owner.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  const processRows = () =>
    execFileSync(
      "/bin/ps",
      ["-axo", "pid=,ppid=,comm="],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 3))
      .map(([processId, parentProcessId, command]) => ({
        processId: Number(processId),
        parentProcessId: Number(parentProcessId),
        command: command ?? "",
      }));
  try {
    const acquiredDeadline = Date.now() + 5_000;
    while (
      !stdout.includes("acquired\n") &&
      Date.now() < acquiredDeadline
    ) {
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 10);
      });
    }
    assert.ok(
      stdout.includes("acquired\n"),
      `profile-lock owner did not acquire: ${stderr}`,
    );
    const lockfProcess = processRows().find(
      ({ parentProcessId, command }) =>
        parentProcessId === owner.pid &&
        command === "/usr/bin/lockf",
    );
    assert.ok(lockfProcess, "the owner must have one lockf child");
    let holderProcess:
      | ReturnType<typeof processRows>[number]
      | undefined;
    const holderDeadline = Date.now() + 2_000;
    while (holderProcess === undefined && Date.now() < holderDeadline) {
      holderProcess = processRows().find(
        ({ parentProcessId }) =>
          parentProcessId === lockfProcess.processId,
      );
      if (holderProcess === undefined) {
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, 10);
        });
      }
    }
    assert.ok(holderProcess, "lockf must have one holder child");
    process.kill(holderProcess.processId, "SIGKILL");

    const exitResult = await Promise.race([
      ownerExit.then((result) => ({
        kind: "exit" as const,
        result,
      })),
      new Promise<{ readonly kind: "timeout" }>((resolveTimeout) => {
        const timeout = setTimeout(
          () => resolveTimeout({ kind: "timeout" }),
          2_000,
        );
        timeout.unref();
      }),
    ]);
    assert.notEqual(
      exitResult.kind,
      "timeout",
      "the old owner must fail-stop instead of continuing without its lock",
    );
    assert.deepEqual(
      exitResult.kind === "exit" ? exitResult.result : null,
      { code: null, signal: "SIGKILL" },
    );

    let replacementEntered = false;
    await new FileSystemBrowserProfileLock({
      lockId: "t10-holder-crash-replacement",
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
    await ownerExit.catch(() => undefined);
    await rm(rootPath, { recursive: true, force: true });
  }
});
