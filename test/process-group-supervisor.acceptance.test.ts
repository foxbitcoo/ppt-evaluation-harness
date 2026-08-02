import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  terminateChildProcessGroup,
} from "../src/process-group-supervisor.ts";

test("process-group termination kills an uncooperative bridge and every descendant before returning", async () => {
  const leaderProgram = `
    const { spawn } = await import("node:child_process");
    process.on("SIGTERM", () => {});
    const descendant = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      { stdio: "ignore" },
    );
    process.stdout.write(String(descendant.pid) + "\\n");
    setInterval(() => {}, 1_000);
  `;
  const leader = spawn(
    process.execPath,
    ["--input-type=module", "-e", leaderProgram],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const leaderPid = leader.pid;
  assert.ok(leaderPid);
  let output = "";
  leader.stdout.setEncoding("utf8");
  leader.stdout.on("data", (value: string) => {
    output += value;
  });
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    leader.once("error", rejectClose);
    leader.once("close", () => resolveClose());
  });
  let descendantPid = 0;
  try {
    const readyDeadline = Date.now() + 2_000;
    while (descendantPid === 0 && Date.now() < readyDeadline) {
      descendantPid = Number(output.trim());
      if (!Number.isSafeInteger(descendantPid) || descendantPid <= 0) {
        descendantPid = 0;
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, 10);
        });
      }
    }
    assert.ok(descendantPid > 0, "bridge descendant did not start");

    await terminateChildProcessGroup(leader, {
      termGraceMs: 50,
      killGraceMs: 2_000,
    });
    await closed;

    assert.throws(
      () => process.kill(-leaderPid, 0),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH",
    );
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH",
    );
  } finally {
    try {
      process.kill(-leaderPid, "SIGKILL");
    } catch {
      // The passing path already confirmed the whole process group is absent.
    }
    await closed.catch(() => undefined);
  }
});
