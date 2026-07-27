import { isDeepStrictEqual } from "node:util";

import type {
  ImmutableBlobStorePort,
  RetentionPayloadLocation,
} from "./artifact-vault.ts";
import { sha256Bytes } from "./run-specification.ts";

export interface RetentionTombstone {
  readonly schemaVersion: "retention-tombstone-v1";
  readonly tombstoneId: string;
  readonly jobId: string;
  readonly subjectIds: readonly string[];
  readonly expiredAt: string;
  readonly payloadLocations: readonly RetentionPayloadLocation[];
}

export interface RetentionDeletionEvidence {
  readonly schemaVersion: "retention-deletion-evidence-v1";
  readonly evidenceId: string;
  readonly tombstoneId: string;
  readonly jobId: string;
  readonly storeId: string;
  readonly key: string;
  readonly expectedContentHash: `sha256:${string}`;
  readonly readbackStatus: "absent";
  readonly deletedAt: string;
}

export interface TombstoneLedgerPort {
  readonly ledgerId: string;
  runIfActive<T>(jobId: string, operation: () => Promise<T>): Promise<T>;
  seal(
    jobId: string,
    create: () => Promise<RetentionTombstone>,
  ): Promise<RetentionTombstone>;
  append(tombstone: RetentionTombstone): Promise<void>;
  appendDeletionEvidence(
    evidence: RetentionDeletionEvidence,
  ): Promise<void>;
  findByJobId(jobId: string): Promise<RetentionTombstone | null>;
  listDeletionEvidence(
    tombstoneId: string,
  ): Promise<readonly RetentionDeletionEvidence[]>;
  list(): Promise<readonly RetentionTombstone[]>;
}

export interface PayloadInventoryPort {
  readonly inventoryId: string;
  register(
    jobId: string,
    locations: readonly RetentionPayloadLocation[],
  ): Promise<void>;
  list(jobId: string): Promise<readonly RetentionPayloadLocation[]>;
}

export class InMemoryPayloadInventory implements PayloadInventoryPort {
  readonly inventoryId: string;
  readonly #locationsByJob = new Map<string, RetentionPayloadLocation[]>();

  constructor(
    private readonly tombstones: Pick<
      TombstoneLedgerPort,
      "findByJobId" | "runIfActive"
    >,
    inventoryId = "in-memory-payload-inventory",
  ) {
    this.inventoryId = inventoryId;
  }

  async register(
    jobId: string,
    locations: readonly RetentionPayloadLocation[],
  ): Promise<void> {
    await this.tombstones.runIfActive(jobId, async () => {
    const registered = this.#locationsByJob.get(jobId) ?? [];
    for (const location of locations) {
      const existing = registered.find(
        ({ storeId, key }) =>
          storeId === location.storeId && key === location.key,
      );
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing, location)) {
          throw new Error(
            `Payload inventory identity conflict: ${location.storeId}/${location.key}`,
          );
        }
        continue;
      }
      registered.push(structuredClone(location));
    }
    this.#locationsByJob.set(jobId, registered);
    });
  }

  async list(jobId: string): Promise<readonly RetentionPayloadLocation[]> {
    return structuredClone(this.#locationsByJob.get(jobId) ?? []);
  }
}

export class InMemoryTombstoneLedger implements TombstoneLedgerPort {
  readonly ledgerId: string;
  readonly #tombstones: RetentionTombstone[] = [];
  readonly #deletionEvidence: RetentionDeletionEvidence[] = [];
  readonly #jobLocks = new Map<string, Promise<void>>();

  constructor(ledgerId = "in-memory-tombstone-ledger") {
    this.ledgerId = ledgerId;
  }

  async #runExclusive<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#jobLocks.get(jobId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#jobLocks.set(jobId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#jobLocks.get(jobId) === tail) {
        this.#jobLocks.delete(jobId);
      }
    }
  }

  async runIfActive<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#runExclusive(jobId, async () => {
      if (
        this.#tombstones.some((candidate) => candidate.jobId === jobId)
      ) {
        throw new Error(
          `Tombstoned Job ${jobId} blocked protected operation`,
        );
      }
      return operation();
    });
  }

  async append(tombstone: RetentionTombstone): Promise<void> {
    return this.#runExclusive(tombstone.jobId, async () => {
    const existing = this.#tombstones.find(
      ({ tombstoneId }) => tombstoneId === tombstone.tombstoneId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, tombstone)) {
        throw new Error(
          `Retention tombstone identity conflict: ${tombstone.tombstoneId}`,
        );
      }
      return;
    }
    const existingForJob = this.#tombstones.find(
      ({ jobId }) => jobId === tombstone.jobId,
    );
    if (existingForJob !== undefined) {
      throw new Error(
        `Retention tombstone already exists for Job: ${tombstone.jobId}`,
      );
    }
    this.#tombstones.push(structuredClone(tombstone));
    });
  }

  async seal(
    jobId: string,
    create: () => Promise<RetentionTombstone>,
  ): Promise<RetentionTombstone> {
    return this.#runExclusive(jobId, async () => {
      const existing = this.#tombstones.find(
        (candidate) => candidate.jobId === jobId,
      );
      if (existing !== undefined) return structuredClone(existing);
      const tombstone = await create();
      if (tombstone.jobId !== jobId) {
        throw new Error("Retention tombstone Job identity mismatch");
      }
      this.#tombstones.push(structuredClone(tombstone));
      return structuredClone(tombstone);
    });
  }

  async appendDeletionEvidence(
    evidence: RetentionDeletionEvidence,
  ): Promise<void> {
    const tombstone = this.#tombstones.find(
      ({ tombstoneId }) => tombstoneId === evidence.tombstoneId,
    );
    if (tombstone === undefined || tombstone.jobId !== evidence.jobId) {
      throw new Error(
        `Retention deletion evidence requires a matching tombstone: ${evidence.evidenceId}`,
      );
    }
    const existing = this.#deletionEvidence.find(
      ({ evidenceId }) => evidenceId === evidence.evidenceId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, evidence)) {
        throw new Error(
          `Retention deletion evidence identity conflict: ${evidence.evidenceId}`,
        );
      }
      return;
    }
    this.#deletionEvidence.push(structuredClone(evidence));
  }

  async findByJobId(jobId: string): Promise<RetentionTombstone | null> {
    const tombstone = this.#tombstones.find(
      (candidate) => candidate.jobId === jobId,
    );
    return tombstone === undefined ? null : structuredClone(tombstone);
  }

  async list(): Promise<readonly RetentionTombstone[]> {
    return structuredClone(this.#tombstones);
  }

  async listDeletionEvidence(
    tombstoneId: string,
  ): Promise<readonly RetentionDeletionEvidence[]> {
    return structuredClone(
      this.#deletionEvidence.filter(
        (evidence) => evidence.tombstoneId === tombstoneId,
      ),
    );
  }
}

export interface ExpireRetentionCommand {
  readonly tombstoneId: string;
  readonly jobId: string;
  readonly subjectIds: readonly string[];
  readonly expiredAt: string;
}

export interface RetentionExpiryResult {
  readonly tombstone: RetentionTombstone;
  readonly deletionEvidence: readonly RetentionDeletionEvidence[];
}

export interface RetentionService {
  expire(command: ExpireRetentionCommand): Promise<RetentionExpiryResult>;
}

export interface PayloadProjectionScrubberPort {
  scrubPayloadsForJob(jobId: string): Promise<void>;
  hasPayloadsForJob(jobId: string): Promise<boolean>;
}

export interface RetentionServiceDependencies {
  readonly stores: readonly ImmutableBlobStorePort[];
  readonly tombstones: TombstoneLedgerPort;
  readonly payloadInventory: PayloadInventoryPort;
  readonly projectionScrubber: PayloadProjectionScrubberPort;
}

export function createRetentionService({
  stores,
  tombstones,
  payloadInventory,
  projectionScrubber,
}: RetentionServiceDependencies): RetentionService {
  const storesById = new Map(stores.map((store) => [store.storeId, store]));
  if (storesById.size !== stores.length) {
    throw new Error("Retention service requires unique store IDs");
  }
  return {
    async expire(command) {
      if (
        command.subjectIds.length === 0 ||
        !Number.isFinite(Date.parse(command.expiredAt))
      ) {
        throw new Error("Retention expiry command is incomplete");
      }
      const tombstone = await tombstones.seal(
        command.jobId,
        async () => {
          const payloadLocations = await payloadInventory.list(command.jobId);
          if (payloadLocations.length === 0) {
            throw new Error("Retention expiry command is incomplete");
          }
          const locationIdentities = payloadLocations.map(
            ({ storeId, key }) => `${storeId}\u0000${key}`,
          );
          if (
            new Set(locationIdentities).size !==
            locationIdentities.length
          ) {
            throw new Error(
              "Retention expiry contains duplicate payload locations",
            );
          }
          for (const location of payloadLocations) {
            if (!storesById.has(location.storeId)) {
              throw new Error(
                `Retention store is unavailable: ${location.storeId}`,
              );
            }
          }
          return {
            schemaVersion: "retention-tombstone-v1",
            tombstoneId: command.tombstoneId,
            jobId: command.jobId,
            subjectIds: [...command.subjectIds],
            expiredAt: command.expiredAt,
            payloadLocations: payloadLocations.map((location) => ({
              ...location,
            })),
          };
        },
      );
      if (
        tombstone.tombstoneId !== command.tombstoneId ||
        tombstone.expiredAt !== command.expiredAt ||
        !isDeepStrictEqual(tombstone.subjectIds, command.subjectIds)
      ) {
        throw new Error(
          `Retention tombstone identity conflict: ${command.tombstoneId}`,
        );
      }
      const payloadLocations = tombstone.payloadLocations;
      await projectionScrubber.scrubPayloadsForJob(command.jobId);
      if (await projectionScrubber.hasPayloadsForJob(command.jobId)) {
        throw new Error(
          `Retention projection payload scrub is incomplete: ${command.jobId}`,
        );
      }

      const failures: string[] = [];
      for (const [index, location] of payloadLocations.entries()) {
        const evidenceId = `deletion:${command.tombstoneId}:${index + 1}`;
        const store = storesById.get(location.storeId);
        if (store === undefined) continue;
        const before = await store.read(location.key);
        if (
          before !== null &&
          sha256Bytes(before) !== location.contentHash
        ) {
          failures.push(
            `payload hash mismatch before deletion: ${location.storeId}/${location.key}`,
          );
        }
        await store.delete(location.key);
        const after = await store.read(location.key);
        if (after !== null) {
          failures.push(
            `payload deletion readback is not absent: ${location.storeId}/${location.key}`,
          );
          continue;
        }
        const evidence: RetentionDeletionEvidence = {
          schemaVersion: "retention-deletion-evidence-v1",
          evidenceId,
          tombstoneId: tombstone.tombstoneId,
          jobId: tombstone.jobId,
          storeId: location.storeId,
          key: location.key,
          expectedContentHash: location.contentHash,
          readbackStatus: "absent",
          deletedAt: command.expiredAt,
        };
        await tombstones.appendDeletionEvidence(evidence);
      }
      if (failures.length > 0) {
        throw new Error(
          `Retention deletion incomplete: ${failures.join("; ")}`,
        );
      }
      const deletionEvidence = await tombstones.listDeletionEvidence(
        tombstone.tombstoneId,
      );
      if (deletionEvidence.length !== payloadLocations.length) {
        throw new Error("Retention deletion evidence is incomplete");
      }
      return { tombstone, deletionEvidence };
    },
  };
}
