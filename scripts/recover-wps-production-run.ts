import {
  loadDurableRootRegistry,
  resolveDurableRootIdentity,
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
const artifactRootIdentity = resolveDurableRootIdentity(
  registry,
  artifactRecoveryRootReference,
);
const runSpecificationRootIdentity = resolveDurableRootIdentity(
  registry,
  runSpecificationRootReference,
);
const checkpointRootIdentity = resolveDurableRootIdentity(
  registry,
  checkpointRootReference,
);
const artifactStore = new FileSystemImmutableBlobStore({
  storeId: artifactStoreId,
  rootPath: artifactRootIdentity.canonicalPath,
  expectedRootIdentity: artifactRootIdentity,
});
const runSpecificationStore = new FileSystemImmutableBlobStore({
  storeId: runSpecificationStoreId,
  rootPath: runSpecificationRootIdentity.canonicalPath,
  expectedRootIdentity: runSpecificationRootIdentity,
});
const checkpointStore = new FileSystemAttemptCheckpointStore({
  checkpointStoreId,
  rootPath: checkpointRootIdentity.canonicalPath,
  expectedRootIdentity: checkpointRootIdentity,
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
