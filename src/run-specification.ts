import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  BakeoffProtocolSnapshot,
  EvaluationCaseRecord,
} from "./domain.ts";
import type { EgressAuthorizationPort } from "./egress-authorization.ts";
import { requireEgressAuthorization } from "./egress-authorization.ts";
import type {
  ImmutableBlobStorePort,
  RetentionPayloadLocation,
} from "./artifact-vault.ts";
import type { ProductPackageSnapshot } from "./product-adapter.ts";

export interface RunSpecificationVersionReferences {
  readonly caseVersion: string;
  readonly productPackageVersion: string;
  readonly runPolicyVersion: string;
  readonly adapterVersion: string;
  readonly schemaVersion: "evaluation-framework-v0.8";
  readonly rubricVersion: "query-six-dimension-v1";
}

export interface RunSpecificationBundle {
  readonly schemaVersion: "run-specification-bundle-v1";
  readonly jobId: string;
  readonly runId: string;
  readonly specCommitSha: string;
  readonly evaluationCase: EvaluationCaseRecord;
  readonly productPackage: ProductPackageSnapshot;
  readonly protocolSnapshot: BakeoffProtocolSnapshot;
  readonly versionReferences: RunSpecificationVersionReferences;
}

export interface RunSpecificationReference {
  readonly schemaVersion: "run-specification-reference-v1";
  readonly jobId: string;
  readonly runId: string;
  readonly contentHash: `sha256:${string}`;
  readonly storeId: string;
  readonly key: string;
  readonly specCommitSha: string;
  readonly versionReferences: RunSpecificationVersionReferences;
}

export interface CaptureRunSpecificationCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly specCommitSha: string;
  readonly evaluationCase: EvaluationCaseRecord;
  readonly productPackage: ProductPackageSnapshot;
  readonly protocolSnapshot: BakeoffProtocolSnapshot;
  readonly requestedAt: string;
}

export interface RunSpecificationVault {
  capture(
    command: CaptureRunSpecificationCommand,
  ): Promise<RunSpecificationReference>;
  read(reference: RunSpecificationReference): Promise<RunSpecificationBundle>;
  retentionLocation(
    reference: RunSpecificationReference,
  ): RetentionPayloadLocation;
}

export interface RunSpecificationVaultDependencies {
  readonly store: ImmutableBlobStorePort;
  readonly egressAuthorization?: EgressAuthorizationPort;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array)
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
}

export function sha256Bytes(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function parseBundle(bytes: Uint8Array): RunSpecificationBundle {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== "run-specification-bundle-v1"
  ) {
    throw new Error("Run specification bundle is invalid");
  }
  return parsed as RunSpecificationBundle;
}

export function createRunSpecificationVault({
  store,
  egressAuthorization,
}: RunSpecificationVaultDependencies): RunSpecificationVault {
  return {
    async capture(command) {
      if (!/^[a-f0-9]{40}$/.test(command.specCommitSha)) {
        throw new Error("Run specification requires an exact spec commit SHA");
      }
      const versionReferences = Object.freeze({
        caseVersion: String(command.evaluationCase.caseVersion),
        productPackageVersion: command.productPackage.packageId,
        runPolicyVersion: command.protocolSnapshot.protocolId,
        adapterVersion: command.productPackage.adapterVersion,
        schemaVersion: "evaluation-framework-v0.8" as const,
        rubricVersion: "query-six-dimension-v1" as const,
      });
      const bundle = Object.freeze<RunSpecificationBundle>({
        schemaVersion: "run-specification-bundle-v1",
        jobId: command.jobId,
        runId: command.runId,
        specCommitSha: command.specCommitSha,
        evaluationCase: Object.freeze(
          structuredClone(command.evaluationCase),
        ),
        productPackage: Object.freeze(
          structuredClone(command.productPackage),
        ),
        protocolSnapshot: Object.freeze(
          structuredClone(command.protocolSnapshot),
        ),
        versionReferences,
      });
      const content = canonicalJsonBytes(bundle);
      const contentHash = sha256Bytes(content);
      const key = `run-specifications/${contentHash.slice("sha256:".length)}`;
      await requireEgressAuthorization(egressAuthorization, {
        requestId: `run-specification-storage:${command.runId}:${contentHash}`,
        jobId: command.jobId,
        runId: command.runId,
        attemptId: null,
        dataClassification: "public_or_synthetic",
        sourceOwner: "ppt-evaluation-harness",
        processingPurpose: "run_specification_storage",
        targetKind: "storage",
        targetService: store.storeId,
        targetAccount: "controlled-recovery-store",
        targetRegion: command.productPackage.environmentOrigin.environment,
        subprocessors: [],
        contentFields: ["run_specification_bundle"],
        requiredRedactions: [],
        requestedAt: command.requestedAt,
      });
      await store.putImmutable(key, content);
      const readback = await store.read(key);
      if (readback === null || sha256Bytes(readback) !== contentHash) {
        throw new Error("Run specification upload readback hash mismatch");
      }
      return Object.freeze({
        schemaVersion: "run-specification-reference-v1",
        jobId: command.jobId,
        runId: command.runId,
        contentHash,
        storeId: store.storeId,
        key,
        specCommitSha: command.specCommitSha,
        versionReferences,
      });
    },

    async read(reference) {
      if (reference.storeId !== store.storeId) {
        throw new Error("Run specification store mismatch");
      }
      const content = await store.read(reference.key);
      if (
        content === null ||
        sha256Bytes(content) !== reference.contentHash
      ) {
        throw new Error(
          `Run specification hash mismatch: ${reference.runId}`,
        );
      }
      const bundle = parseBundle(content);
      if (
        bundle.jobId !== reference.jobId ||
        bundle.runId !== reference.runId ||
        bundle.specCommitSha !== reference.specCommitSha ||
        !isDeepStrictEqual(
          bundle.versionReferences,
          reference.versionReferences,
        )
      ) {
        throw new Error(
          `Run specification lineage mismatch: ${reference.runId}`,
        );
      }
      return bundle;
    },

    retentionLocation(reference) {
      return {
        storeId: reference.storeId,
        key: reference.key,
        contentHash: reference.contentHash,
        copyRole: "run_specification",
      };
    },
  };
}
