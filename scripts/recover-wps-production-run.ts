import {
  loadDurableRootRegistry,
  resolveDurableRoot,
} from "../src/durable-root-registry.ts";
import {
  FileSystemImmutableBlobStore,
} from "../src/file-system-blob-store.ts";
import {
  FileSystemAttemptCheckpointStore,
} from "../src/file-system-checkpoint-store.ts";
import {
  validateWpsProductionRecoveryPayloads,
  type WpsProductionRecoveryCommand,
} from "../src/wps-production-recovery.ts";

const values = process.argv.slice(2);
if (values.length !== 11 || values.some((value) => value.length === 0)) {
  throw new Error(
    "Recovery command requires exactly 11 non-empty arguments",
  );
}

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
] = values as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const command: WpsProductionRecoveryCommand = Object.freeze({
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
});
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
  throw new Error("Durable WPS recovery payload is incomplete");
}

const result = await validateWpsProductionRecoveryPayloads({
  command,
  registryHash: registry.registryHash,
  manifest,
  original,
  runSpecification,
  checkpoints,
  readArtifactPayload: (key) => artifactStore.read(key),
});

process.stdout.write(`${JSON.stringify(result)}\n`);
