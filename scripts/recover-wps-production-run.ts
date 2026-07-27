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
const registry = await loadDurableRootRegistry(registryId);
const artifactRecoveryRoot = resolveDurableRoot(
  registry,
  artifactRecoveryRootReference,
);
const runSpecificationRoot = resolveDurableRoot(
  registry,
  runSpecificationRootReference,
);
const checkpointRoot = resolveDurableRoot(
  registry,
  checkpointRootReference,
);
const artifactStore = new FileSystemImmutableBlobStore({
  storeId: artifactStoreId,
  rootPath: artifactRecoveryRoot,
});
const runSpecificationStore = new FileSystemImmutableBlobStore({
  storeId: runSpecificationStoreId,
  rootPath: runSpecificationRoot,
});
const checkpointStore = new FileSystemAttemptCheckpointStore({
  checkpointStoreId,
  rootPath: checkpointRoot,
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
  throw new Error("Durable recovery payload is incomplete");
}
const hash = (content: Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;
const originalHash = hash(original);
const manifestIdentity = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(manifest),
) as {
  readonly artifact?: { readonly contentHash?: string };
};
const runSpecificationBundle = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(runSpecification),
) as {
  readonly evaluationCase?: { readonly provenance?: string };
};
if (
  manifestIdentity.artifact?.contentHash !== originalHash ||
  runSpecificationBundle.evaluationCase?.provenance !== "PRODUCTION" ||
  checkpoints.some(
    ({ taskStateVersion }) =>
      taskStateVersion !== null &&
      taskStateVersion !== undefined &&
      !/@\d+$/.test(taskStateVersion),
  )
) {
  throw new Error("Durable recovery lineage validation failed");
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
  })}\n`,
);
