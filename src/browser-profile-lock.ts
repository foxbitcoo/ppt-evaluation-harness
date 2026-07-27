import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
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
  readonly #retryMs: number;
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
    this.#retryMs = input.retryMs ?? 25;
    this.#timeoutMs = input.timeoutMs ?? 30 * 60 * 1_000;
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
    const owner = randomUUID();
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(owner);
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out acquiring WPS browser profile lock");
        }
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, this.#retryMs);
        });
      }
    }
    try {
      return await operation();
    } finally {
      let currentOwner: string | null = null;
      try {
        currentOwner = await readFile(path, "utf8");
      } catch {
        // A missing lock is handled as an ownership failure below.
      }
      if (currentOwner !== owner) {
        throw new Error("WPS browser profile lock ownership was lost");
      }
      await rm(path, { force: true });
    }
  }
}
