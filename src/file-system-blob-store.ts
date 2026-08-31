import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type {
  ImmutableBlobStorePort,
  ImmutableBlobWriteContext,
  JobTombstoneLookupPort,
} from "./artifact-vault.ts";
import type { EgressDestinationMetadata } from "./egress-authorization.ts";

function safeKeyFilename(key: string): string {
  if (key.length === 0 || key.length > 1_024) {
    throw new Error("Durable blob key is invalid");
  }
  return `${createHash("sha256").update(key).digest("hex")}.blob`;
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

export interface FileSystemRootIdentity {
  readonly canonicalPath: string;
  readonly deviceId: string;
  readonly inodeId: string;
  readonly ownerUid: number;
  readonly mode: number;
}

function rootIdentityFromMetadata(input: {
  readonly canonicalPath: string;
  readonly metadata: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
    readonly uid: number;
    readonly mode: number;
  };
}): FileSystemRootIdentity {
  return Object.freeze({
    canonicalPath: input.canonicalPath,
    deviceId: String(input.metadata.dev),
    inodeId: String(input.metadata.ino),
    ownerUid: input.metadata.uid,
    mode: input.metadata.mode,
  });
}

function sameRootIdentity(
  left: FileSystemRootIdentity,
  right: FileSystemRootIdentity,
): boolean {
  return left.canonicalPath === right.canonicalPath &&
    left.deviceId === right.deviceId &&
    left.inodeId === right.inodeId &&
    left.ownerUid === right.ownerUid &&
    left.mode === right.mode;
}

function assertSecureRootOwnership(input: {
  readonly uid: number;
  readonly mode: number;
}): void {
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : null;
  if (currentUid === null || input.uid !== currentUid) {
    throw new Error(
      "Durable blob store root must be owned by the current user",
    );
  }
  if ((input.mode & 0o022) !== 0) {
    throw new Error(
      "Durable blob store root must not be group/other writable",
    );
  }
}

function captureInitialRootIdentity(
  rootPath: string,
): FileSystemRootIdentity {
  mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const requestedMetadata = lstatSync(rootPath);
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error("Durable blob store rejects a symbolic link root");
  }
  if (!requestedMetadata.isDirectory()) {
    throw new Error("Durable blob store root is not a directory");
  }
  const canonicalPath = realpathSync(rootPath);
  const metadata = lstatSync(canonicalPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== requestedMetadata.dev ||
    metadata.ino !== requestedMetadata.ino
  ) {
    throw new Error(
      "Durable blob store root identity changed during initialization",
    );
  }
  assertSecureRootOwnership(metadata);
  return rootIdentityFromMetadata({ canonicalPath, metadata });
}

async function captureCurrentRootIdentity(
  rootPath: string,
): Promise<FileSystemRootIdentity> {
  let requestedMetadata: Awaited<ReturnType<typeof lstat>>;
  let canonicalPath: string;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    requestedMetadata = await lstat(rootPath);
    canonicalPath = await realpath(rootPath);
    metadata = await lstat(canonicalPath);
  } catch (error) {
    throw new Error("Durable blob store root identity changed", {
      cause: error,
    });
  }
  if (
    requestedMetadata.isSymbolicLink() ||
    !requestedMetadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== requestedMetadata.dev ||
    metadata.ino !== requestedMetadata.ino
  ) {
    throw new Error("Durable blob store root identity changed");
  }
  assertSecureRootOwnership(metadata);
  return rootIdentityFromMetadata({ canonicalPath, metadata });
}

export class FileSystemImmutableBlobStore
  implements ImmutableBlobStorePort
{
  readonly durability = "durable" as const;
  readonly storeId: string;
  readonly recoveryReferencePrefix: string;
  readonly egressDestination: EgressDestinationMetadata;
  readonly #rootPath: string;
  readonly #rootIdentity: FileSystemRootIdentity;

  constructor(input: {
    readonly storeId: string;
    readonly rootPath: string;
    readonly expectedRootIdentity?: FileSystemRootIdentity;
    readonly tombstones?: JobTombstoneLookupPort;
  }) {
    if (input.storeId.trim().length === 0) {
      throw new Error("Durable blob store requires a stable storeId");
    }
    this.storeId = input.storeId;
    const requestedRootPath = resolve(input.rootPath);
    if (requestedRootPath === sep) {
      throw new Error("Durable blob store root must be narrowly scoped");
    }
    this.#rootIdentity = captureInitialRootIdentity(requestedRootPath);
    if (
      input.expectedRootIdentity !== undefined &&
      !sameRootIdentity(
        this.#rootIdentity,
        input.expectedRootIdentity,
      )
    ) {
      throw new Error(
        "Durable blob store root identity differs from its attestation",
      );
    }
    this.#rootPath = this.#rootIdentity.canonicalPath;
    this.recoveryReferencePrefix =
      `store:${input.storeId}:sha256-key`;
    this.egressDestination = Object.freeze({
      targetService: "local-durable-immutable-store",
      targetAccount: input.storeId,
      targetRegion: "local",
      subprocessors: [],
    });
    this.tombstones = input.tombstones;
  }

  private readonly tombstones: JobTombstoneLookupPort | undefined;

  async #assertRootStillBound(): Promise<void> {
    const current = await captureCurrentRootIdentity(this.#rootPath);
    if (!sameRootIdentity(current, this.#rootIdentity)) {
      throw new Error("Durable blob store root identity changed");
    }
  }

  async #withVerifiedRoot<T>(
    operation: (root: {
      readonly handle: Awaited<ReturnType<typeof open>>;
      readonly pathFor: (filename: string) => string;
    }) => Promise<T>,
  ): Promise<T> {
    await this.#assertRootStillBound();
    let rootHandle: Awaited<ReturnType<typeof open>>;
    try {
      rootHandle = await open(
        this.#rootPath,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw new Error("Durable blob store root identity changed", {
        cause: error,
      });
    }
    try {
      const openedMetadata = await rootHandle.stat();
      const openedIdentity = rootIdentityFromMetadata({
        canonicalPath: this.#rootPath,
        metadata: openedMetadata,
      });
      if (
        !openedMetadata.isDirectory() ||
        !sameRootIdentity(openedIdentity, this.#rootIdentity)
      ) {
        throw new Error("Durable blob store root identity changed");
      }
      let result: T | undefined;
      let operationError: unknown;
      try {
        result = await operation({
          handle: rootHandle,
          // Node does not expose openat/linkat and macOS does not resolve child
          // paths below /dev/fd/<directory-fd>. Keep the verified descriptor open
          // to bind and re-check the directory inode around the operation, while
          // every leaf open independently uses O_NOFOLLOW.
          pathFor: (filename) => join(this.#rootPath, filename),
        });
      } catch (error) {
        operationError = error;
      }
      try {
        await this.#assertRootStillBound();
      } catch (identityError) {
        throw new Error("Durable blob store root identity changed", {
          cause: operationError ?? identityError,
        });
      }
      if (operationError !== undefined) {
        throw operationError;
      }
      return result as T;
    } finally {
      await rootHandle.close();
    }
  }

  async putImmutable(
    key: string,
    content: Uint8Array,
    context: ImmutableBlobWriteContext,
  ): Promise<void> {
    const write = async () => {
      context.assertWriteAuthorized();
      const contentSnapshot = Uint8Array.from(content);
      if (sha256(contentSnapshot) !== context.contentHash) {
        throw new Error(
          `Immutable blob write context hash mismatch: ${this.storeId}/${key}`,
        );
      }
      await this.#withVerifiedRoot(async ({ handle: rootHandle, pathFor }) => {
        const path = pathFor(safeKeyFilename(key));
        const temporaryPath = pathFor(
          `.${safeKeyFilename(key)}.${process.pid}.${randomUUID()}.tmp`,
        );
        let handle: Awaited<ReturnType<typeof open>> | null = null;
        let temporaryCreated = false;
        try {
          handle = await open(
            temporaryPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          temporaryCreated = true;
          await this.#assertRootStillBound();
          try {
            await handle.writeFile(contentSnapshot);
            await handle.sync();
          } finally {
            await handle.close();
            handle = null;
          }
          context.assertWriteAuthorized();
          await this.#assertRootStillBound();
          try {
            // link(2) publishes one complete, fsynced inode without replacing a
            // winner from another process. The root inode is verified before and
            // after publication and both leaf opens reject symbolic links.
            await link(temporaryPath, path);
            await this.#assertRootStillBound();
            await rootHandle.sync();
          } catch (error) {
            if (errorCode(error) !== "EEXIST") {
              throw error;
            }
            const existingHandle = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            let existing: Buffer;
            try {
              await this.#assertRootStillBound();
              const metadata = await existingHandle.stat();
              if (!metadata.isFile()) {
                throw new Error(
                  `Immutable blob conflict: ${this.storeId}/${key}`,
                );
              }
              existing = await existingHandle.readFile();
            } finally {
              await existingHandle.close();
            }
            if (
              existing.byteLength !== contentSnapshot.byteLength ||
              !existing.equals(contentSnapshot)
            ) {
              throw new Error(
                `Immutable blob conflict: ${this.storeId}/${key}`,
              );
            }
            // The competing publisher may have linked the inode immediately
            // before crashing. Syncing here makes the accepted directory entry
            // durable for this writer too.
            await rootHandle.sync();
          }
          context.assertWriteAuthorized();
        } finally {
          if (handle !== null) {
            await handle.close();
          }
          if (temporaryCreated) {
            let rootStillBound = true;
            try {
              await this.#assertRootStillBound();
            } catch {
              rootStillBound = false;
            }
            if (rootStillBound) {
              await rm(temporaryPath, { force: true });
            }
            await rootHandle.sync();
          }
        }
      });
    };
    if (this.tombstones === undefined) {
      await write();
    } else {
      await this.tombstones.runIfActive(context.jobId, write);
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    return this.#withVerifiedRoot(async ({ pathFor }) => {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          pathFor(safeKeyFilename(key)),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return null;
        }
        throw error;
      }
      try {
        await this.#assertRootStillBound();
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          throw new Error(
            `Immutable blob is not a regular file: ${this.storeId}/${key}`,
          );
        }
        return Uint8Array.from(await handle.readFile());
      } finally {
        await handle.close();
      }
    });
  }

  async releaseWriteClaim(
    _key: string,
    _writeAttemptId: string,
  ): Promise<void> {
    // A published content-addressed object may already have been adopted by a
    // successful capture in another process. Per-attempt ownership cannot be
    // proven from process-local state, so rollback only releases the logical
    // claim; retention/GC is the sole authority allowed to delete final blobs.
  }

  async delete(key: string): Promise<void> {
    await this.#withVerifiedRoot(async ({ handle, pathFor }) => {
      await this.#assertRootStillBound();
      await rm(pathFor(safeKeyFilename(key)), { force: true });
      await this.#assertRootStillBound();
      await handle.sync();
    });
  }
}
