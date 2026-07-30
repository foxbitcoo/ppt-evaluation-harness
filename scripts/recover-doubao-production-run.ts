import { createHash } from "node:crypto";

import {
  FileSystemAttemptCheckpointStore,
  FileSystemImmutableBlobStore,
  calculateArtifactDerivativeSetHash,
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
  `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
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
    readonly artifactId?: string;
    readonly contentHash?: string;
    readonly provenance?: string;
  };
  readonly renderManifestHash?: string;
  readonly derivatives?: readonly {
    readonly derivativeId?: string;
    readonly sourceArtifactId?: string;
    readonly derivativeType?:
      | "static_slide"
      | "extracted_text"
      | "contact_sheet";
    readonly pageNumber?: number | null;
    readonly contentHash?: `sha256:${string}`;
  }[];
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
const artifactId = manifestIdentity.artifact?.artifactId;
const derivatives = manifestIdentity.derivatives;
if (
  artifactId === undefined ||
  manifestIdentity.renderManifestHash === undefined ||
  derivatives === undefined ||
  derivatives.length !== 33
) {
  throw new Error(
    "Durable Doubao recovery render manifest or 33-derivative lineage is incomplete",
  );
}
const renderManifestKey =
  `artifacts/${artifactId}/render-manifest`;
const renderManifest = await artifactStore.read(renderManifestKey);
if (
  renderManifest === null ||
  hash(renderManifest) !== manifestIdentity.renderManifestHash
) {
  throw new Error("Durable Doubao recovery render manifest hash mismatch");
}
const renderManifestIdentity = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(renderManifest),
) as {
  readonly schemaVersion?: string;
  readonly artifactHash?: string;
  readonly artifactId?: string;
  readonly pageCount?: number;
  readonly slides?: readonly {
    readonly pageNumber?: number;
    readonly contentHash?: `sha256:${string}`;
    readonly extractedTextHash?: `sha256:${string}`;
  }[];
  readonly contactSheet?: {
    readonly contentHash?: `sha256:${string}`;
  };
};
const renderSlides = renderManifestIdentity.slides;
if (
  renderManifestIdentity.schemaVersion !== "render-manifest-v1" ||
  renderManifestIdentity.artifactId !== artifactId ||
  renderManifestIdentity.artifactHash !==
    manifestIdentity.artifact?.contentHash ||
  renderManifestIdentity.pageCount !== 16 ||
  renderSlides === undefined ||
  renderSlides.length !== 16 ||
  renderManifestIdentity.contactSheet?.contentHash === undefined
) {
  throw new Error(
    "Durable Doubao recovery render manifest lineage is invalid",
  );
}
const slideByPage = new Map(
  renderSlides.map((slide) => [slide.pageNumber, slide]),
);
if (
  slideByPage.size !== 16 ||
  Array.from({ length: 16 }, (_, index) => index + 1).some(
    (pageNumber) => {
      const slide = slideByPage.get(pageNumber);
      return (
        slide?.contentHash === undefined ||
        slide.extractedTextHash === undefined
      );
    },
  )
) {
  throw new Error(
    "Durable Doubao recovery render manifest page lineage is incomplete",
  );
}
const derivativeIds = new Set(
  derivatives.map(({ derivativeId }) => derivativeId),
);
if (
  derivativeIds.size !== 33 ||
  derivativeIds.has(undefined)
) {
  throw new Error(
    "Durable Doubao recovery derivative IDs are incomplete or duplicated",
  );
}
const expectedDerivative = (
  derivativeType: "static_slide" | "extracted_text",
  pageNumber: number,
) => {
  const matches = derivatives.filter(
    (lineage) =>
      lineage.derivativeType === derivativeType &&
      lineage.pageNumber === pageNumber,
  );
  const slide = slideByPage.get(pageNumber)!;
  const expectedId =
    derivativeType === "static_slide"
      ? `${artifactId}:static-slide:${pageNumber}`
      : `${artifactId}:extracted-text:${pageNumber}`;
  const expectedHash =
    derivativeType === "static_slide"
      ? slide.contentHash
      : slide.extractedTextHash;
  if (
    matches.length !== 1 ||
    matches[0]?.derivativeId !== expectedId ||
    matches[0].sourceArtifactId !== artifactId ||
    matches[0].contentHash !== expectedHash
  ) {
    throw new Error(
      `Durable Doubao recovery derivative lineage mismatch: ${derivativeType}:${pageNumber}`,
    );
  }
  return matches[0];
};
const validatedDerivatives = Array.from(
  { length: 16 },
  (_, index) => index + 1,
).flatMap((pageNumber) => [
  expectedDerivative("static_slide", pageNumber),
  expectedDerivative("extracted_text", pageNumber),
]);
const contactSheetDerivatives = derivatives.filter(
  ({ derivativeType }) => derivativeType === "contact_sheet",
);
if (
  contactSheetDerivatives.length !== 1 ||
  contactSheetDerivatives[0]?.derivativeId !==
    `${artifactId}:contact-sheet` ||
  contactSheetDerivatives[0].sourceArtifactId !== artifactId ||
  contactSheetDerivatives[0].pageNumber !== null ||
  contactSheetDerivatives[0].contentHash !==
    renderManifestIdentity.contactSheet.contentHash
) {
  throw new Error(
    "Durable Doubao recovery contact-sheet derivative lineage mismatch",
  );
}
validatedDerivatives.push(contactSheetDerivatives[0]);
const derivativeLocations = derivatives.map((lineage) => {
  let suffix: string;
  if (
    lineage.derivativeType === "static_slide" &&
    lineage.pageNumber !== null &&
    lineage.pageNumber !== undefined
  ) {
    suffix = `static-slide-${lineage.pageNumber}`;
  } else if (
    lineage.derivativeType === "extracted_text" &&
    lineage.pageNumber !== null &&
    lineage.pageNumber !== undefined
  ) {
    suffix = `extracted-text-${lineage.pageNumber}`;
  } else if (lineage.derivativeType === "contact_sheet") {
    suffix = "contact-sheet";
  } else {
    throw new Error(
      `Durable Doubao recovery derivative lineage is invalid: ${lineage.derivativeId ?? "unknown"}`,
    );
  }
  if (
    lineage.derivativeId === undefined ||
    lineage.contentHash === undefined
  ) {
    throw new Error("Durable Doubao recovery derivative lineage is incomplete");
  }
  return {
    lineage,
    key: `artifacts/${artifactId}/derivatives/${suffix}`,
  };
});
const recoveredDerivatives = await Promise.all(
  derivativeLocations.map(async ({ lineage, key }) => ({
    derivativeId: lineage.derivativeId!,
    expectedHash: lineage.contentHash!,
    content: await artifactStore.read(key),
  })),
);
for (const derivative of recoveredDerivatives) {
  if (
    derivative.content === null ||
    hash(derivative.content) !== derivative.expectedHash
  ) {
    throw new Error(
      `Durable Doubao recovery derivative is missing or hash-mismatched: ${derivative.derivativeId}`,
    );
  }
}
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
    renderManifestHash: hash(renderManifest),
    derivativeCount: derivatives.length,
    recoveredDerivativeCount: recoveredDerivatives.length,
    derivativeSetHash: calculateArtifactDerivativeSetHash(
      validatedDerivatives.map(({ derivativeId, contentHash }) => ({
        derivativeId: derivativeId!,
        contentHash: contentHash!,
      })),
    ),
    runSpecificationHash: hash(runSpecification),
    checkpointCount: checkpoints.length,
    browserDriverId:
      runSpecificationBundle.adapterSpecification
        ?.browserDriverEvidence?.driverId,
  })}\n`,
);
