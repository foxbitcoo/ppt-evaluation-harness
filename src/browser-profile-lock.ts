import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface BrowserProfileLockPort {
  readonly lockId: string;
  readonly isolation: "in_process" | "cross_process";
  runExclusive<T>(
    profileDigest: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

interface BrowserProfileLockRootIdentity {
  readonly schemaVersion: "browser-profile-lock-root-identity-v1";
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly ownerUserId: number;
  readonly mode: number;
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
    const canonicalRootPath = await realpath(this.#rootPath);
    const rootAnchorDigest = createHash("sha256")
      .update(canonicalRootPath)
      .digest("hex");
    const rootAnchorPath = resolve(
      dirname(canonicalRootPath),
      `.ppt-browser-profile-root-${rootAnchorDigest}.lock`,
    );
    const rootIdentityPath = resolve(
      dirname(canonicalRootPath),
      `.ppt-browser-profile-root-${rootAnchorDigest}.identity.json`,
    );
    await this.#prepareRootAnchor(rootAnchorPath);
    return this.#runFileLockExclusive(
      rootAnchorPath,
      "browser profile root anchor",
      async () => {
        const rootIdentity =
          await this.#bindRootIdentity(rootIdentityPath);
        await this.#assertRootIdentity(rootIdentity);
        const digest = createHash("sha256")
          .update(profileDigest)
          .digest("hex");
        const path = resolve(this.#rootPath, `${digest}.lock`);
        return this.#runFileLockExclusive(
          path,
          "WPS browser profile lock",
          async () => {
            await this.#assertRootIdentityOrFailStop(rootIdentity);
            try {
              return await operation();
            } finally {
              await this.#assertRootIdentityOrFailStop(rootIdentity);
            }
          },
        );
      },
    );
  }

  async #observedRootIdentity():
    Promise<BrowserProfileLockRootIdentity> {
    const [metadata, canonicalPath] = await Promise.all([
      lstat(this.#rootPath),
      realpath(this.#rootPath),
    ]);
    const mode = metadata.mode & 0o777;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined &&
        metadata.uid !== process.getuid()) ||
      (mode & 0o077) !== 0
    ) {
      throw new Error(
        "Browser profile lock root identity is unsafe",
      );
    }
    return Object.freeze({
      schemaVersion:
        "browser-profile-lock-root-identity-v1" as const,
      canonicalPath,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      ownerUserId: metadata.uid,
      mode,
    });
  }

  async #bindRootIdentity(
    rootIdentityPath: string,
  ): Promise<BrowserProfileLockRootIdentity> {
    const observed = await this.#observedRootIdentity();
    const canonicalPayload = `${JSON.stringify(observed)}\n`;
    let existing: string;
    try {
      const identityMetadata = await lstat(rootIdentityPath);
      if (
        !identityMetadata.isFile() ||
        identityMetadata.isSymbolicLink() ||
        (process.getuid !== undefined &&
          identityMetadata.uid !== process.getuid()) ||
        (identityMetadata.mode & 0o077) !== 0
      ) {
        throw new Error(
          "Browser profile lock root identity anchor is unsafe",
        );
      }
      existing = await readFile(rootIdentityPath, "utf8");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const handle = await open(rootIdentityPath, "wx", 0o600);
      try {
        await handle.writeFile(canonicalPayload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(rootIdentityPath, 0o600);
      return observed;
    }
    if (existing !== canonicalPayload) {
      throw new Error(
        "Browser profile lock root identity conflicts with its persistent anchor",
      );
    }
    return observed;
  }

  async #prepareRootAnchor(rootAnchorPath: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const handle = await open(rootAnchorPath, "ax", 0o600);
        await handle.close();
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
      }
      try {
        const metadata = await lstat(rootAnchorPath);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          (process.getuid !== undefined &&
            metadata.uid !== process.getuid())
        ) {
          throw new Error(
            "Browser profile root anchor is unsafe",
          );
        }
        await chmod(rootAnchorPath, 0o600);
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      "Browser profile root anchor could not be stabilized",
    );
  }

  async #assertRootIdentity(
    expected: BrowserProfileLockRootIdentity,
  ): Promise<void> {
    const observed = await this.#observedRootIdentity();
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new Error(
        "Browser profile lock root identity changed",
      );
    }
  }

  async #assertRootIdentityOrFailStop(
    expected: BrowserProfileLockRootIdentity,
  ): Promise<void> {
    try {
      await this.#assertRootIdentity(expected);
    } catch {
      process.kill(process.pid, "SIGKILL");
      await new Promise<never>(() => {});
    }
  }

  async #runFileLockExclusive<T>(
    path: string,
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
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
    let acquired = false;
    let releaseRequested = false;
    let stdout = "";
    let stderr = "";
    let resolveAcquired!: () => void;
    let rejectAcquired!: (error: unknown) => void;
    const acquiredPromise = new Promise<void>((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    const closedPromise = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveClosed, rejectClosed) => {
      child.once("error", (error) => {
        if (acquired && !releaseRequested) {
          process.kill(process.pid, "SIGKILL");
          return;
        }
        rejectAcquired(error);
        rejectClosed(error);
      });
      child.once("close", (code, signal) => {
        if (!acquired) {
          rejectAcquired(
            new Error(
              stderr.trim().length === 0
                ? `Timed out acquiring ${label}`
                : `Timed out acquiring ${label}: ${stderr.trim()}`,
            ),
          );
        } else if (!releaseRequested) {
          // Once a second process can acquire this profile, the original
          // critical section cannot safely continue. Arbitrary operations
          // cannot be cancelled in-process, so fail the whole owner closed.
          process.kill(process.pid, "SIGKILL");
          return;
        }
        resolveClosed({ code, signal });
      });
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      if (acquired) return;
      stdout += value;
      if (
        Buffer.byteLength(stdout, "utf8") >
          Buffer.byteLength(handshake, "utf8") ||
        !handshake.startsWith(stdout)
      ) {
        child.kill("SIGKILL");
        rejectAcquired(
          new Error("Browser profile lock handshake exceeded its bound"),
        );
        return;
      }
      if (stdout === handshake) {
        acquired = true;
        resolveAcquired();
      }
    });
    child.stderr.on("data", (value: string) => {
      stderr += value;
      if (Buffer.byteLength(stderr, "utf8") > 4_096) {
        child.kill("SIGKILL");
        rejectAcquired(
          new Error("Browser profile lock error output exceeded its bound"),
        );
      }
    });
    try {
      await acquiredPromise;
    } catch (error) {
      child.stdin.destroy();
      await closedPromise.catch(() => undefined);
      throw error;
    }
    try {
      return await operation();
    } finally {
      releaseRequested = true;
      child.stdin.end(releaseCommand);
      const { code, signal } = await closedPromise;
      if (code !== 0 || signal !== null || stderr !== "") {
        throw new Error(
          `Browser profile lock holder exited unexpectedly: ${code}/${signal}`,
        );
      }
    }
  }
}
