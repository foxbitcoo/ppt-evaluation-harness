import { createHash } from "node:crypto";

import {
  FileSystemAttemptCheckpointStore,
  FileSystemImmutableBlobStore,
  loadDurableRootRegistry,
  resolveDurableRoot,
} from "../src/index.ts";

const [
  registryId,
  artifactRecoveryRootReference,
  runSpecificationRootReference,
  checkpointRootReference,
  artifactStoreId,
  manifestKey,
  originalKey,
  runSpecificationStoreId,
  runSpecificationKey,
  checkpointStoreId,
  attemptId,
] = process.argv.slice(2);

if (
  registryId === undefined ||
  artifactRecoveryRootReference === undefined ||
  runSpecificationRootReference === undefined ||
  checkpointRootReference === undefined ||
  artifactStoreId === undefined ||
  manifestKey === undefined ||
  originalKey === undefined ||
  runSpecificationStoreId === undefined ||
  runSpecificationKey === undefined ||
  checkpointStoreId === undefined ||
  attemptId === undefined
) {
  throw new Error("Recovery command arguments are incomplete");
}

const hash = (content: Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;
const registry = await loadDurableRootRegistry(registryId);
const artifactStore = new FileSystemImmutableBlobStore({
  storeId: artifactStoreId,
  rootPath: resolveDurableRoot(
    registry,
    artifactRecoveryRootReference,
  ),
});
const runSpecificationStore = new FileSystemImmutableBlobStore({
  storeId: runSpecificationStoreId,
  rootPath: resolveDurableRoot(
    registry,
    runSpecificationRootReference,
  ),
});
const checkpointStore = new FileSystemAttemptCheckpointStore({
  checkpointStoreId,
  rootPath: resolveDurableRoot(registry, checkpointRootReference),
});
const [manifest, original, runSpecification, checkpoints] =
  await Promise.all([
    artifactStore.read(manifestKey),
    artifactStore.read(originalKey),
    runSpecificationStore.read(runSpecificationKey),
    checkpointStore.readAttempt(attemptId),
  ]);
if (
  manifest === null ||
  original === null ||
  runSpecification === null ||
  checkpoints.length === 0
) {
  throw new Error("Durable Doubao recovery payload is incomplete");
}
const manifestIdentity = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(manifest),
) as {
  readonly artifact?: {
    readonly contentHash?: string;
    readonly provenance?: string;
  };
  readonly productionExecutionEvidence?: {
    readonly executionMode?: string;
    readonly captureSource?: string;
  };
};
const runSpecificationBundle = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(runSpecification),
) as {
  readonly evaluationCase?: { readonly provenance?: string };
  readonly adapterSpecification?: {
    readonly browserDriverEvidence?: {
      readonly driverId?: string;
      readonly provenance?: string;
    };
  };
};
const originalHash = hash(original);
if (
  manifestIdentity.artifact?.contentHash !== originalHash ||
  manifestIdentity.productionExecutionEvidence?.executionMode !==
    "PRODUCTION_REPLAY" ||
  manifestIdentity.productionExecutionEvidence.captureSource !==
    "REAL_PROVIDER_CAPTURE" ||
  runSpecificationBundle.evaluationCase?.provenance !== "PRODUCTION" ||
  runSpecificationBundle.adapterSpecification?.browserDriverEvidence
    ?.driverId !== "doubao-real-provider-replay" ||
  checkpoints.some(
    ({ taskStateVersion }) =>
      taskStateVersion !== null &&
      taskStateVersion !== undefined &&
      !/@\d+$/.test(taskStateVersion),
  )
) {
  throw new Error("Durable Doubao recovery lineage validation failed");
}

process.stdout.write(
  `${JSON.stringify({
    registryId,
    registryHash: registry.registryHash,
    rootReferences: {
      artifactRecovery: artifactRecoveryRootReference,
      runSpecification: runSpecificationRootReference,
      checkpoint: checkpointRootReference,
    },
    manifestHash: hash(manifest),
    originalHash,
    runSpecificationHash: hash(runSpecification),
    checkpointCount: checkpoints.length,
    browserDriverId:
      runSpecificationBundle.adapterSpecification
        ?.browserDriverEvidence?.driverId,
  })}\n`,
);
