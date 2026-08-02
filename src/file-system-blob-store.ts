import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { resolve, sep } from "node:path";

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

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FileSystemImmutableBlobStore
  implements ImmutableBlobStorePort
{
  readonly durability = "durable" as const;
  readonly storeId: string;
  readonly recoveryReferencePrefix: string;
  readonly egressDestination: EgressDestinationMetadata;
  readonly #rootPath: string;

  constructor(input: {
    readonly storeId: string;
    readonly rootPath: string;
    readonly tombstones?: JobTombstoneLookupPort;
  }) {
    if (input.storeId.trim().length === 0) {
      throw new Error("Durable blob store requires a stable storeId");
    }
    this.storeId = input.storeId;
    this.#rootPath = resolve(input.rootPath);
    if (this.#rootPath === sep) {
      throw new Error("Durable blob store root must be narrowly scoped");
    }
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

  #pathFor(key: string): string {
    return resolve(this.#rootPath, safeKeyFilename(key));
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
      await mkdir(this.#rootPath, { recursive: true, mode: 0o700 });
      const path = this.#pathFor(key);
      const temporaryPath = resolve(
        this.#rootPath,
        `.${safeKeyFilename(key)}.${process.pid}.${randomUUID()}.tmp`,
      );
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      let temporaryCreated = false;
      try {
        handle = await open(temporaryPath, "wx", 0o600);
        temporaryCreated = true;
        try {
          await handle.writeFile(contentSnapshot);
          await handle.sync();
        } finally {
          await handle.close();
          handle = null;
        }
        context.assertWriteAuthorized();
        try {
          // link(2) publishes one complete, fsynced inode without replacing a
          // winner from another process. Both names are in the same directory.
          await link(temporaryPath, path);
          await syncDirectory(this.#rootPath);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") {
            throw error;
          }
          const existing = await readFile(path);
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
          await syncDirectory(this.#rootPath);
        }
        context.assertWriteAuthorized();
      } finally {
        if (handle !== null) {
          await handle.close();
        }
        if (temporaryCreated) {
          await rm(temporaryPath, { force: true });
          await syncDirectory(this.#rootPath);
        }
      }
    };
    if (this.tombstones === undefined) {
      await write();
    } else {
      await this.tombstones.runIfActive(context.jobId, write);
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      return Uint8Array.from(await readFile(this.#pathFor(key)));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
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
    await rm(this.#pathFor(key), { force: true });
  }
}
