import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

export interface BrowserProfileLockPort {
  readonly lockId: string;
  readonly isolation: "in_process" | "cross_process";
  runExclusive<T>(
    profileDigest: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export class InProcessBrowserProfileLock
  implements BrowserProfileLockPort
{
  readonly isolation = "in_process" as const;
  readonly lockId: string;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(lockId = "in-process-browser-profile-lock") {
    this.lockId = lockId;
  }

  async runExclusive<T>(
    profileDigest: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const previous = this.#tails.get(profileDigest) ?? Promise.resolve();
    const tail = previous.then(() => gate);
    this.#tails.set(profileDigest, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(profileDigest) === tail) {
        this.#tails.delete(profileDigest);
      }
    }
  }
}

export class FileSystemBrowserProfileLock
  implements BrowserProfileLockPort
{
  readonly isolation = "cross_process" as const;
  readonly lockId: string;
  readonly #rootPath: string;
  readonly #timeoutMs: number;

  constructor(input: {
    readonly lockId: string;
    readonly rootPath: string;
    readonly retryMs?: number;
    readonly timeoutMs?: number;
  }) {
    if (input.lockId.trim().length === 0) {
      throw new Error("Browser profile lock requires a stable ID");
    }
    this.lockId = input.lockId;
    this.#rootPath = resolve(input.rootPath);
    if (this.#rootPath === sep) {
      throw new Error("Browser profile lock root must be narrowly scoped");
    }
    if (
      input.retryMs !== undefined &&
      (!Number.isFinite(input.retryMs) || input.retryMs <= 0)
    ) {
      throw new Error("Browser profile lock retry interval is invalid");
    }
    this.#timeoutMs = input.timeoutMs ?? 30 * 60 * 1_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Browser profile lock timeout is invalid");
    }
  }

  async runExclusive<T>(
    profileDigest: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await mkdir(this.#rootPath, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256")
      .update(profileDigest)
      .digest("hex");
    const path = resolve(this.#rootPath, `${digest}.lock`);
    const handshake = "ppt-browser-profile-lock-acquired-v1\n";
    const releaseCommand = "release\n";
    const holderScript = [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (value) => { input += value; });',
      'process.stdin.on("end", () => {',
      `  process.exit(input === "" || input === ${JSON.stringify(releaseCommand)} ? 0 : 64);`,
      "});",
      `process.stdout.write(${JSON.stringify(handshake)});`,
      "process.stdin.resume();",
    ].join("\n");
    const child = spawn(
      "/usr/bin/lockf",
      [
        "-t",
        String(this.#timeoutMs / 1_000),
        path,
        process.execPath,
        "--input-type=module",
        "-e",
        holderScript,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    await new Promise<void>((resolveAcquired, rejectAcquired) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const reject = (error: Error) => {
        if (settled) return;
        settled = true;
        rejectAcquired(error);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (value: string) => {
        if (settled) return;
        stdout += value;
        if (Buffer.byteLength(stdout, "utf8") > 256) {
          child.kill("SIGKILL");
          reject(new Error("Browser profile lock handshake exceeded its bound"));
          return;
        }
        if (stdout === handshake) {
          settled = true;
          resolveAcquired();
        }
      });
      child.stderr.on("data", (value: string) => {
        stderr += value;
        if (Buffer.byteLength(stderr, "utf8") > 4_096) {
          child.kill("SIGKILL");
          reject(new Error("Browser profile lock error output exceeded its bound"));
        }
      });
      child.once("error", (error) => reject(error));
      child.once("close", () => {
        reject(
          new Error(
            stderr.trim().length === 0
              ? "Timed out acquiring WPS browser profile lock"
              : `Timed out acquiring WPS browser profile lock: ${stderr.trim()}`,
          ),
        );
      });
    });
    try {
      return await operation();
    } finally {
      const closed = new Promise<void>((resolveClosed, rejectClosed) => {
        child.once("error", rejectClosed);
        child.once("close", (code, signal) => {
          if (code === 0 && signal === null) {
            resolveClosed();
            return;
          }
          rejectClosed(
            new Error(
              `Browser profile lock holder exited unexpectedly: ${code}/${signal}`,
            ),
          );
        });
      });
      child.stdin.end(releaseCommand);
      await closed;
    }
  }
}
