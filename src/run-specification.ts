import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type {
  BakeoffProtocolSnapshot,
  EvaluationCaseRecord,
} from "./domain.ts";
import type {
  ApprovedEgressAuthorization,
  EgressAuthorizationPort,
} from "./egress-authorization.ts";
import {
  approvedEgressAuthorizationHash,
  assertPersistedApprovedEgressAuthorization,
  requireEgressAuthorization,
} from "./egress-authorization.ts";
import type {
  ImmutableBlobStorePort,
  RetentionPayloadLocation,
} from "./artifact-vault.ts";
import type {
  ProductAdapterImplementationPackage,
  ProductPackageSnapshot,
} from "./product-adapter.ts";
import type { PayloadInventoryPort } from "./retention.ts";

export interface RunSpecificationVersionReferences {
  readonly caseVersion: string;
  readonly productPackageVersion: string;
  readonly runPolicyVersion: string;
  readonly adapterVersion: string;
  readonly schemaVersion: "evaluation-framework-v0.8";
  readonly rubricVersion: "query-six-dimension-v1";
  readonly caseContentHash: `sha256:${string}`;
  readonly productPackageContentHash: `sha256:${string}`;
  readonly protocolSnapshotContentHash: `sha256:${string}`;
  readonly adapterSpecificationHash: `sha256:${string}`;
  readonly schemaSnapshotHash: `sha256:${string}`;
  readonly rubricSnapshotHash: `sha256:${string}`;
  readonly estimatorSnapshotHash: `sha256:${string}`;
  readonly runnerCodeDigest: `sha256:${string}`;
  readonly runnerImageDigest: `sha256:${string}`;
  readonly environmentEvidenceHash: `sha256:${string}`;
}

export interface RunSpecificationBundle {
  readonly schemaVersion: "run-specification-bundle-v1";
  readonly jobId: string;
  readonly runId: string;
  readonly specCommitSha: string;
  readonly evaluationCase: EvaluationCaseRecord;
  readonly productPackage: ProductPackageSnapshot;
  readonly protocolSnapshot: BakeoffProtocolSnapshot;
  readonly adapterSpecification: {
    readonly packageId: string;
    readonly adapterVersion: string;
    readonly vendorId: string;
    readonly egressDestination: ProductPackageSnapshot["egressDestination"];
    readonly implementationDigest: `sha256:${string}`;
    readonly implementationPackageName: string;
    readonly implementationPackageByteSize: number;
  };
  readonly schemaSnapshot: {
    readonly schemaVersion: "evaluation-framework-v0.8";
    readonly requiredLineage: readonly string[];
  };
  readonly rubricSnapshot: {
    readonly rubricVersion: "query-six-dimension-v1";
    readonly dimensions: readonly string[];
  };
  readonly estimatorSnapshot: {
    readonly estimatorVersion: "delivery-quality-gate-v1";
    readonly deliveryGate: "automatic_non_scoring_gate";
    readonly scoringScale: "six_dimensions_1_to_5";
  };
  readonly runnerCodeEvidence: {
    readonly specCommitSha: string;
    readonly entrypoint: "src/bakeoff.ts";
    readonly files: readonly {
      readonly path: string;
      readonly contentHash: `sha256:${string}`;
    }[];
    readonly contentHash: `sha256:${string}`;
  };
  readonly runnerImageEvidence: {
    readonly runtimeFamily: "node";
    readonly runtimeVersion: string;
    readonly imageReference: string;
    readonly runtimePackageManifest: {
      readonly nodeExecutableHash: `sha256:${string}`;
      readonly runnerBundleHash: `sha256:${string}`;
      readonly dependencyLockHash: `sha256:${string}`;
      readonly platform: string;
      readonly architecture: string;
    };
    readonly contentHash: `sha256:${string}`;
  };
  readonly environmentEvidence: {
    readonly environmentOriginId: string;
    readonly targetEnvironment: string;
    readonly platform: string;
    readonly architecture: string;
    readonly nodeVersion: string;
  };
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
  readonly egressAuthorization: ApprovedEgressAuthorization;
  readonly egressAuthorizationHash: `sha256:${string}`;
}

export interface CaptureRunSpecificationCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly specCommitSha: string;
  readonly evaluationCase: EvaluationCaseRecord;
  readonly productPackage: ProductPackageSnapshot;
  readonly protocolSnapshot: BakeoffProtocolSnapshot;
  readonly adapterImplementationPackage: ProductAdapterImplementationPackage;
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
  readonly payloadInventory: PayloadInventoryPort;
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

function snapshotHash(value: unknown): `sha256:${string}` {
  return sha256Bytes(canonicalJsonBytes(value));
}

const PROJECT_ROOT_URL = new URL("../", import.meta.url);
const PROJECT_ROOT_PATH = fileURLToPath(PROJECT_ROOT_URL);

function sourceFiles(directory: URL): readonly URL[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const child = new URL(
        entry.isDirectory() ? `${entry.name}/` : entry.name,
        directory,
      );
      if (entry.isDirectory()) return sourceFiles(child);
      return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
    });
}

const RUNNER_BUNDLE_FILES = Object.freeze(
  [
    ...sourceFiles(new URL("./src/", PROJECT_ROOT_URL)),
    new URL("./package.json", PROJECT_ROOT_URL),
    new URL("./package-lock.json", PROJECT_ROOT_URL),
  ]
    .map((url) => ({
      path: relative(PROJECT_ROOT_PATH, fileURLToPath(url)),
      contentHash: sha256Bytes(readFileSync(url)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path)),
);
const RUNNER_CODE_CONTENT_HASH = snapshotHash(RUNNER_BUNDLE_FILES);
const NODE_EXECUTABLE_CONTENT_HASH = sha256Bytes(readFileSync(process.execPath));
const DEPENDENCY_LOCK_CONTENT_HASH =
  RUNNER_BUNDLE_FILES.find(({ path }) => path === "package-lock.json")
    ?.contentHash;
if (DEPENDENCY_LOCK_CONTENT_HASH === undefined) {
  throw new Error("Runner dependency lock is missing");
}
const RUNNER_RUNTIME_PACKAGE_MANIFEST = Object.freeze({
  nodeExecutableHash: NODE_EXECUTABLE_CONTENT_HASH,
  runnerBundleHash: RUNNER_CODE_CONTENT_HASH,
  dependencyLockHash: DEPENDENCY_LOCK_CONTENT_HASH,
  platform: process.platform,
  architecture: process.arch,
});
const RUNNER_RUNTIME_PACKAGE_HASH = snapshotHash(
  RUNNER_RUNTIME_PACKAGE_MANIFEST,
);

function expectedVersionReferences(
  bundle: Omit<RunSpecificationBundle, "versionReferences">,
): RunSpecificationVersionReferences {
  return Object.freeze({
    caseVersion: String(bundle.evaluationCase.caseVersion),
    productPackageVersion: bundle.productPackage.packageId,
    runPolicyVersion: bundle.protocolSnapshot.protocolId,
    adapterVersion: bundle.productPackage.adapterVersion,
    schemaVersion: "evaluation-framework-v0.8",
    rubricVersion: "query-six-dimension-v1",
    caseContentHash: snapshotHash(bundle.evaluationCase),
    productPackageContentHash: snapshotHash(bundle.productPackage),
    protocolSnapshotContentHash: snapshotHash(bundle.protocolSnapshot),
    adapterSpecificationHash: snapshotHash(bundle.adapterSpecification),
    schemaSnapshotHash: snapshotHash(bundle.schemaSnapshot),
    rubricSnapshotHash: snapshotHash(bundle.rubricSnapshot),
    estimatorSnapshotHash: snapshotHash(bundle.estimatorSnapshot),
    runnerCodeDigest: bundle.runnerCodeEvidence.contentHash,
    runnerImageDigest: bundle.runnerImageEvidence.contentHash,
    environmentEvidenceHash: snapshotHash(bundle.environmentEvidence),
  });
}

export function createRunSpecificationVault({
  store,
  egressAuthorization,
  payloadInventory,
}: RunSpecificationVaultDependencies): RunSpecificationVault {
  return {
    async capture(command) {
      if (!/^[a-f0-9]{40}$/.test(command.specCommitSha)) {
        throw new Error("Run specification requires an exact spec commit SHA");
      }
      if (
        command.adapterImplementationPackage.packageName.trim().length ===
          0 ||
        sha256Bytes(command.adapterImplementationPackage.content) !==
          command.adapterImplementationPackage.contentHash
      ) {
        throw new Error(
          "Run specification requires an exact adapter implementation package",
        );
      }
      const bundleWithoutReferences = Object.freeze({
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
        adapterSpecification: Object.freeze({
          packageId: command.productPackage.packageId,
          adapterVersion: command.productPackage.adapterVersion,
          vendorId: command.productPackage.vendorId,
          egressDestination: Object.freeze(
            structuredClone(command.productPackage.egressDestination),
          ),
          implementationDigest:
            command.adapterImplementationPackage.contentHash,
          implementationPackageName:
            command.adapterImplementationPackage.packageName,
          implementationPackageByteSize:
            command.adapterImplementationPackage.content.byteLength,
        }),
        schemaSnapshot: Object.freeze({
          schemaVersion: "evaluation-framework-v0.8" as const,
          requiredLineage: Object.freeze([
            "case",
            "run",
            "attempt",
            "artifact",
            "render_manifest",
            "scorecard",
          ]),
        }),
        rubricSnapshot: Object.freeze({
          rubricVersion: "query-six-dimension-v1" as const,
          dimensions: Object.freeze([
            "requirement_understanding_and_content_coverage",
            "factual_accuracy_and_content_quality",
            "narrative_and_audience_fit",
            "visual_aesthetics_and_professional_finish",
            "layout_hierarchy_and_readability",
            "imagery_chart_and_information_expression",
          ]),
        }),
        estimatorSnapshot: Object.freeze({
          estimatorVersion: "delivery-quality-gate-v1" as const,
          deliveryGate: "automatic_non_scoring_gate" as const,
          scoringScale: "six_dimensions_1_to_5" as const,
        }),
        runnerCodeEvidence: Object.freeze({
          specCommitSha: command.specCommitSha,
          entrypoint: "src/bakeoff.ts" as const,
          files: RUNNER_BUNDLE_FILES,
          contentHash: RUNNER_CODE_CONTENT_HASH,
        }),
        runnerImageEvidence: Object.freeze({
          runtimeFamily: "node" as const,
          runtimeVersion: process.version,
          imageReference:
            `local-runtime-package@${RUNNER_RUNTIME_PACKAGE_HASH}`,
          runtimePackageManifest: RUNNER_RUNTIME_PACKAGE_MANIFEST,
          contentHash: RUNNER_RUNTIME_PACKAGE_HASH,
        }),
        environmentEvidence: Object.freeze({
          environmentOriginId:
            command.productPackage.environmentOrigin.originId,
          targetEnvironment:
            command.productPackage.environmentOrigin.environment,
          platform: process.platform,
          architecture: process.arch,
          nodeVersion: process.version,
        }),
      }) satisfies Omit<RunSpecificationBundle, "versionReferences">;
      const versionReferences = expectedVersionReferences(
        bundleWithoutReferences,
      );
      const bundle = Object.freeze<RunSpecificationBundle>({
        ...bundleWithoutReferences,
        versionReferences,
      });
      const content = canonicalJsonBytes(bundle);
      const contentHash = sha256Bytes(content);
      const key = `run-specifications/${contentHash.slice("sha256:".length)}`;
      const authorization = await requireEgressAuthorization(egressAuthorization, {
        requestId: `run-specification-storage:${command.runId}:${contentHash}`,
        jobId: command.jobId,
        runId: command.runId,
        attemptId: null,
        dataClassification: command.evaluationCase.dataClassification,
        sourceOwner: command.evaluationCase.sourceOwner,
        processingPurpose: "run_specification_storage",
        targetKind: "storage",
        targetService: store.egressDestination.targetService,
        targetAccount: store.egressDestination.targetAccount,
        targetRegion: store.egressDestination.targetRegion,
        subprocessors: store.egressDestination.subprocessors,
        contentFields: ["run_specification_bundle"],
        payloadHash: contentHash,
        requiredRedactions: [],
      });
      await payloadInventory.register(command.jobId, [
        {
          storeId: store.storeId,
          key,
          contentHash,
          copyRole: "run_specification",
        },
      ]);
      await store.putImmutable(key, content, {
        jobId: command.jobId,
        contentHash,
        writeAttemptId:
          `run-specification:${command.jobId}:${command.runId}:${contentHash}`,
      });
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
        egressAuthorization: authorization,
        egressAuthorizationHash:
          approvedEgressAuthorizationHash(authorization),
      });
    },

    async read(reference) {
      if (reference.storeId !== store.storeId) {
        throw new Error("Run specification store mismatch");
      }
      if (
        reference.schemaVersion !==
          "run-specification-reference-v1" ||
        reference.key !==
          `run-specifications/${reference.contentHash.slice("sha256:".length)}`
      ) {
        throw new Error("Run specification reference lineage mismatch");
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
      assertPersistedApprovedEgressAuthorization(
        reference.egressAuthorization,
        {
          requestId:
            `run-specification-storage:${reference.runId}:${reference.contentHash}`,
          jobId: reference.jobId,
          runId: reference.runId,
          attemptId: null,
          dataClassification:
            bundle.evaluationCase.dataClassification,
          sourceOwner: bundle.evaluationCase.sourceOwner,
          processingPurpose: "run_specification_storage",
          targetKind: "storage",
          targetService: store.egressDestination.targetService,
          targetAccount: store.egressDestination.targetAccount,
          targetRegion: store.egressDestination.targetRegion,
          subprocessors: store.egressDestination.subprocessors,
          contentFields: ["run_specification_bundle"],
          payloadHash: reference.contentHash,
          requiredRedactions: [],
          requestedAt:
            reference.egressAuthorization.request.requestedAt,
        },
        reference.egressAuthorizationHash,
      );
      if (
        bundle.jobId !== reference.jobId ||
        bundle.runId !== reference.runId ||
        bundle.specCommitSha !== reference.specCommitSha ||
        !isDeepStrictEqual(
          bundle.versionReferences,
          reference.versionReferences,
        ) ||
        reference.egressAuthorization.request.payloadHash !==
          reference.contentHash ||
        reference.egressAuthorization.request.requestId !==
          `run-specification-storage:${reference.runId}:${reference.contentHash}` ||
        reference.egressAuthorization.request.jobId !== reference.jobId ||
        reference.egressAuthorization.request.runId !== reference.runId ||
        reference.egressAuthorization.request.attemptId !== null ||
        reference.egressAuthorization.request.dataClassification !==
          bundle.evaluationCase.dataClassification ||
        reference.egressAuthorization.request.sourceOwner !==
          bundle.evaluationCase.sourceOwner ||
        reference.egressAuthorization.request.processingPurpose !==
          "run_specification_storage" ||
        reference.egressAuthorization.request.targetKind !== "storage" ||
        reference.egressAuthorization.request.targetService !==
          store.egressDestination.targetService ||
        reference.egressAuthorization.request.targetAccount !==
          store.egressDestination.targetAccount ||
        reference.egressAuthorization.request.targetRegion !==
          store.egressDestination.targetRegion ||
        !isDeepStrictEqual(
          reference.egressAuthorization.request.subprocessors,
          store.egressDestination.subprocessors,
        ) ||
        !isDeepStrictEqual(
          reference.egressAuthorization.request.contentFields,
          ["run_specification_bundle"],
        ) ||
        reference.egressAuthorization.request.requiredRedactions.length !==
          0 ||
        !isDeepStrictEqual(
          bundle.versionReferences,
          expectedVersionReferences({
            schemaVersion: bundle.schemaVersion,
            jobId: bundle.jobId,
            runId: bundle.runId,
            specCommitSha: bundle.specCommitSha,
            evaluationCase: bundle.evaluationCase,
            productPackage: bundle.productPackage,
            protocolSnapshot: bundle.protocolSnapshot,
            adapterSpecification: bundle.adapterSpecification,
            schemaSnapshot: bundle.schemaSnapshot,
            rubricSnapshot: bundle.rubricSnapshot,
            estimatorSnapshot: bundle.estimatorSnapshot,
            runnerCodeEvidence: bundle.runnerCodeEvidence,
            runnerImageEvidence: bundle.runnerImageEvidence,
            environmentEvidence: bundle.environmentEvidence,
          }),
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
