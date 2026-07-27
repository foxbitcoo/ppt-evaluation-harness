import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

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

export class FileSystemImmutableBlobStore
  implements ImmutableBlobStorePort
{
  readonly durability = "durable" as const;
  readonly storeId: string;
  readonly recoveryReferencePrefix: string;
  readonly egressDestination: EgressDestinationMetadata;
  readonly #rootPath: string;
  readonly #createdByAttempt = new Map<string, string>();

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
      await mkdir(this.#rootPath, { recursive: true, mode: 0o700 });
      const path = this.#pathFor(key);
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
          this.#createdByAttempt.set(key, context.writeAttemptId);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        const existing = await readFile(path);
        if (!isDeepStrictEqual(existing, content)) {
          throw new Error(`Immutable blob conflict: ${this.storeId}/${key}`);
        }
      }
      context.assertWriteAuthorized();
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
    key: string,
    writeAttemptId: string,
  ): Promise<void> {
    if (this.#createdByAttempt.get(key) === writeAttemptId) {
      this.#createdByAttempt.delete(key);
      await this.delete(key);
    }
  }

  async delete(key: string): Promise<void> {
    this.#createdByAttempt.delete(key);
    await rm(this.#pathFor(key), { force: true });
  }
}
