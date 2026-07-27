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

export class InMemoryTombstoneLedger implements TombstoneLedgerPort {
  readonly #tombstones: RetentionTombstone[] = [];
  readonly #deletionEvidence: RetentionDeletionEvidence[] = [];

  async append(tombstone: RetentionTombstone): Promise<void> {
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
  readonly payloadLocations: readonly RetentionPayloadLocation[];
}

export interface RetentionExpiryResult {
  readonly tombstone: RetentionTombstone;
  readonly deletionEvidence: readonly RetentionDeletionEvidence[];
}

export interface RetentionService {
  expire(command: ExpireRetentionCommand): Promise<RetentionExpiryResult>;
}

export interface RetentionServiceDependencies {
  readonly stores: readonly ImmutableBlobStorePort[];
  readonly tombstones: TombstoneLedgerPort;
}

export function createRetentionService({
  stores,
  tombstones,
}: RetentionServiceDependencies): RetentionService {
  const storesById = new Map(stores.map((store) => [store.storeId, store]));
  if (storesById.size !== stores.length) {
    throw new Error("Retention service requires unique store IDs");
  }
  return {
    async expire(command) {
      if (
        command.subjectIds.length === 0 ||
        command.payloadLocations.length === 0 ||
        !Number.isFinite(Date.parse(command.expiredAt))
      ) {
        throw new Error("Retention expiry command is incomplete");
      }
      const locationIdentities = command.payloadLocations.map(
        ({ storeId, key }) => `${storeId}\u0000${key}`,
      );
      if (new Set(locationIdentities).size !== locationIdentities.length) {
        throw new Error("Retention expiry contains duplicate payload locations");
      }
      for (const location of command.payloadLocations) {
        if (!storesById.has(location.storeId)) {
          throw new Error(
            `Retention store is unavailable: ${location.storeId}`,
          );
        }
      }
      const tombstone: RetentionTombstone = {
        schemaVersion: "retention-tombstone-v1",
        tombstoneId: command.tombstoneId,
        jobId: command.jobId,
        subjectIds: [...command.subjectIds],
        expiredAt: command.expiredAt,
        payloadLocations: command.payloadLocations.map((location) => ({
          ...location,
        })),
      };
      await tombstones.append(tombstone);

      const priorEvidence = await tombstones.listDeletionEvidence(
        tombstone.tombstoneId,
      );
      const evidenceById = new Map(
        priorEvidence.map((evidence) => [evidence.evidenceId, evidence]),
      );
      const failures: string[] = [];
      for (const [index, location] of command.payloadLocations.entries()) {
        const evidenceId = `deletion:${command.tombstoneId}:${index + 1}`;
        if (evidenceById.has(evidenceId)) continue;
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
        evidenceById.set(evidenceId, evidence);
      }
      if (failures.length > 0) {
        throw new Error(
          `Retention deletion incomplete: ${failures.join("; ")}`,
        );
      }
      const deletionEvidence = await tombstones.listDeletionEvidence(
        tombstone.tombstoneId,
      );
      if (deletionEvidence.length !== command.payloadLocations.length) {
        throw new Error("Retention deletion evidence is incomplete");
      }
      return { tombstone, deletionEvidence };
    },
  };
}
