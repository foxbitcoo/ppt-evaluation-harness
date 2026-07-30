import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { ObservableAttemptEvent } from "./domain.ts";
import type { AttemptCheckpointPort } from "./product-adapter.ts";
import { parseStrictJson } from "./strict-json.ts";

function canonicalLine(event: ObservableAttemptEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export class FileSystemAttemptCheckpointStore
  implements AttemptCheckpointPort
{
  readonly durability = "durable" as const;
  readonly checkpointStoreId: string;
  readonly recoveryReferencePrefix: string;
  readonly #rootPath: string;

  constructor(input: {
    readonly checkpointStoreId: string;
    readonly rootPath: string;
  }) {
    if (input.checkpointStoreId.trim().length === 0) {
      throw new Error("Checkpoint store requires a stable ID");
    }
    this.checkpointStoreId = input.checkpointStoreId;
    this.#rootPath = resolve(input.rootPath);
    if (this.#rootPath === sep) {
      throw new Error("Checkpoint store root must be narrowly scoped");
    }
    this.recoveryReferencePrefix =
      `checkpoint-store:${input.checkpointStoreId}:attempt`;
  }

  #pathFor(attemptId: string): string {
    const digest = createHash("sha256")
      .update(attemptId)
      .digest("hex");
    return resolve(this.#rootPath, `${digest}.jsonl`);
  }

  async append(event: ObservableAttemptEvent): Promise<void> {
    await mkdir(this.#rootPath, { recursive: true, mode: 0o700 });
    const path = this.#pathFor(event.attemptId);
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const prior = existing
      .split("\n")
      .filter(Boolean)
      .map(
        (line, index) =>
          parseStrictJson(
            line,
            `Attempt checkpoint line ${index + 1}`,
          ) as ObservableAttemptEvent,
      )
      .find(({ eventId }) => eventId === event.eventId);
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(event)) {
        throw new Error(
          `Attempt checkpoint identity conflict: ${event.eventId}`,
        );
      }
      return;
    }
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(canonicalLine(event));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readAttempt(
    attemptId: string,
  ): Promise<readonly ObservableAttemptEvent[]> {
    try {
      const content = await readFile(this.#pathFor(attemptId), "utf8");
      return Object.freeze(
        content
          .split("\n")
          .filter(Boolean)
          .map((line, index) =>
            Object.freeze(
              parseStrictJson(
                line,
                `Attempt checkpoint line ${index + 1}`,
              ) as ObservableAttemptEvent,
            ),
          ),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return Object.freeze([]);
      }
      throw error;
    }
  }
}
