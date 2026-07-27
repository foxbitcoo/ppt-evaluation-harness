import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Artifact, RenderManifest } from "./domain.ts";
import {
  requireEgressAuthorization,
  type ApprovedEgressAuthorization,
  type EgressAuthorizationPort,
} from "./egress-authorization.ts";

export interface ImmutableBlobStorePort {
  readonly storeId: string;
  putImmutable(key: string, content: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export class InMemoryImmutableBlobStore implements ImmutableBlobStorePort {
  readonly storeId: string;
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(storeId: string) {
    if (storeId.trim().length === 0) {
      throw new Error("Immutable blob store requires a stable storeId");
    }
    this.storeId = storeId;
  }

  async putImmutable(key: string, content: Uint8Array): Promise<void> {
    const existing = this.#blobs.get(key);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, content)) {
        throw new Error(`Immutable blob conflict: ${this.storeId}/${key}`);
      }
      return;
    }
    this.#blobs.set(key, Uint8Array.from(content));
  }

  async read(key: string): Promise<Uint8Array | null> {
    const content = this.#blobs.get(key);
    return content === undefined ? null : Uint8Array.from(content);
  }

  async delete(key: string): Promise<void> {
    this.#blobs.delete(key);
  }

  listKeys(): readonly string[] {
    return [...this.#blobs.keys()].sort();
  }
}

export interface ArtifactMetadata {
  readonly artifactId: string;
  readonly runId: string;
  readonly contentHash: `sha256:${string}`;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly capturedAt: string;
  readonly filename: string;
}

export interface ArtifactDerivativeLineage {
  readonly derivativeId: string;
  readonly sourceArtifactId: string;
  readonly derivativeType: "static_slide";
  readonly pageNumber: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHash: `sha256:${string}`;
  readonly pipelineVersion: string;
}

export interface RetentionPayloadLocation {
  readonly storeId: string;
  readonly key: string;
  readonly contentHash: `sha256:${string}`;
  readonly copyRole:
    | "primary"
    | "secondary"
    | "recovery_export"
    | "run_specification"
    | "quarantine";
}

export interface ArtifactPackageManifest {
  readonly schemaVersion: "artifact-package-manifest-v1";
  readonly manifestHash: `sha256:${string}`;
  readonly jobId: string;
  readonly artifact: ArtifactMetadata;
  readonly renderManifestId: string;
  readonly renderManifestHash: `sha256:${string}`;
  readonly derivatives: readonly ArtifactDerivativeLineage[];
  readonly payloadLocations: readonly RetentionPayloadLocation[];
  readonly egressAuthorizations: readonly ApprovedEgressAuthorization[];
}

export interface CaptureArtifactPackageCommand {
  readonly jobId: string;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
}

export interface RecoveredArtifactPackage {
  readonly manifest: ArtifactPackageManifest;
  readonly original: Uint8Array;
  readonly derivatives: readonly {
    readonly lineage: ArtifactDerivativeLineage;
    readonly content: Uint8Array;
  }[];
}

export interface ArtifactVault {
  capture(command: CaptureArtifactPackageCommand): Promise<ArtifactPackageManifest>;
  readFromSecondary(
    manifest: ArtifactPackageManifest,
  ): Promise<RecoveredArtifactPackage>;
}

export interface ArtifactVaultDependencies {
  readonly primary: ImmutableBlobStorePort;
  readonly secondary: ImmutableBlobStorePort;
  readonly egressAuthorization?: EgressAuthorizationPort;
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function contentBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function manifestIdentity(input: {
  readonly jobId: string;
  readonly artifact: ArtifactMetadata;
  readonly renderManifestId: string;
  readonly renderManifestHash: `sha256:${string}`;
  readonly derivatives: readonly ArtifactDerivativeLineage[];
}) {
  return {
    schemaVersion: "artifact-package-identity-v1" as const,
    jobId: input.jobId,
    artifact: input.artifact,
    renderManifestId: input.renderManifestId,
    renderManifestHash: input.renderManifestHash,
    derivatives: input.derivatives,
  };
}

function identityBytes(identity: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalValue(identity)));
}

function assertSha256(
  content: Uint8Array,
  expected: `sha256:${string}`,
  label: string,
): void {
  if (sha256(content) !== expected) {
    throw new Error(`${label} content hash mismatch`);
  }
}

function storageRequest(input: {
  readonly jobId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly storeId: string;
  readonly key: string;
  readonly requestedAt: string;
  readonly targetRegion: string;
}) {
  return Object.freeze({
    requestId: `artifact-storage:${input.artifactId}:${input.storeId}:${input.key}`,
    jobId: input.jobId,
    runId: input.runId,
    attemptId: null,
    dataClassification: "public_or_synthetic" as const,
    sourceOwner: "ppt-evaluation-harness",
    processingPurpose: "artifact_storage" as const,
    targetKind: "storage" as const,
    targetService: input.storeId,
    targetAccount: "controlled-artifact-store",
    targetRegion: input.targetRegion,
    subprocessors: Object.freeze([]),
    contentFields: Object.freeze(["artifact_binary"]),
    requiredRedactions: Object.freeze([]),
    requestedAt: input.requestedAt,
  });
}

async function writeAndVerify(input: {
  readonly store: ImmutableBlobStorePort;
  readonly key: string;
  readonly content: Uint8Array;
  readonly expectedHash: `sha256:${string}`;
  readonly copyRole: "primary" | "secondary";
  readonly jobId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly requestedAt: string;
  readonly targetRegion: string;
  readonly egressAuthorization: EgressAuthorizationPort | undefined;
}): Promise<ApprovedEgressAuthorization> {
  const authorization = await requireEgressAuthorization(
    input.egressAuthorization,
    storageRequest({
      jobId: input.jobId,
      runId: input.runId,
      artifactId: input.artifactId,
      storeId: input.store.storeId,
      key: input.key,
      requestedAt: input.requestedAt,
      targetRegion: input.targetRegion,
    }),
  );
  await input.store.putImmutable(input.key, input.content);
  const readback = await input.store.read(input.key);
  if (readback === null || sha256(readback) !== input.expectedHash) {
    throw new Error(
      `${input.copyRole} upload readback hash mismatch for ${input.key}`,
    );
  }
  return authorization;
}

export function createArtifactVault({
  primary,
  secondary,
  egressAuthorization,
}: ArtifactVaultDependencies): ArtifactVault {
  if (primary.storeId === secondary.storeId) {
    throw new Error("ArtifactVault requires two distinct controlled stores");
  }
  return {
    async capture(command) {
      const { artifact, renderManifest } = command;
      if (
        renderManifest.artifactId !== artifact.artifactId ||
        renderManifest.pageCount !== artifact.pageCount ||
        renderManifest.slides.length !== artifact.pageCount
      ) {
        throw new Error("Artifact package contains inconsistent lineage");
      }
      if (
        artifact.byteSize !== artifact.content.byteLength ||
        artifact.pageCount < 1 ||
        !Number.isFinite(Date.parse(artifact.capturedAt))
      ) {
        throw new Error("Artifact metadata is invalid");
      }
      assertSha256(artifact.content, artifact.contentHash, "Artifact");

      const derivatives = renderManifest.slides.map((slide) => {
        const content = contentBytes(slide.content);
        assertSha256(content, slide.contentHash, `Slide ${slide.pageNumber}`);
        return Object.freeze<ArtifactDerivativeLineage>({
          derivativeId: `${artifact.artifactId}:static-slide:${slide.pageNumber}`,
          sourceArtifactId: artifact.artifactId,
          derivativeType: "static_slide",
          pageNumber: slide.pageNumber,
          filename: slide.filename,
          mimeType: slide.mimeType,
          byteSize: content.byteLength,
          contentHash: slide.contentHash,
          pipelineVersion: renderManifest.renderer,
        });
      });
      const pageNumbers = derivatives.map(({ pageNumber }) => pageNumber);
      if (
        new Set(pageNumbers).size !== pageNumbers.length ||
        pageNumbers.some((pageNumber, index) => pageNumber !== index + 1)
      ) {
        throw new Error("Artifact derivative page lineage is incomplete");
      }
      const artifactMetadata = Object.freeze<ArtifactMetadata>({
        artifactId: artifact.artifactId,
        runId: artifact.runId,
        contentHash: artifact.contentHash,
        mimeType: artifact.mimeType,
        byteSize: artifact.byteSize,
        pageCount: artifact.pageCount,
        capturedAt: artifact.capturedAt,
        filename: artifact.filename,
      });
      const identity = manifestIdentity({
        jobId: command.jobId,
        artifact: artifactMetadata,
        renderManifestId: renderManifest.renderManifestId,
        renderManifestHash: renderManifest.contentHash,
        derivatives,
      });
      const frozenIdentity = identityBytes(identity);
      const manifestHash = sha256(frozenIdentity);

      const payloads = [
        {
          key: `artifacts/${artifact.artifactId}/manifest`,
          content: frozenIdentity,
          contentHash: manifestHash,
        },
        {
          key: `artifacts/${artifact.artifactId}/original`,
          content: artifact.content,
          contentHash: artifact.contentHash,
        },
        ...derivatives.map((lineage, index) => ({
          key: `artifacts/${artifact.artifactId}/derivatives/static-slide-${lineage.pageNumber}`,
          content: contentBytes(renderManifest.slides[index]?.content ?? ""),
          contentHash: lineage.contentHash,
        })),
      ];
      const authorizations: ApprovedEgressAuthorization[] = [];
      const payloadLocations: RetentionPayloadLocation[] = [];
      for (const payload of payloads) {
        for (const [store, copyRole] of [
          [primary, "primary"],
          [secondary, "secondary"],
        ] as const) {
          authorizations.push(
            await writeAndVerify({
              store,
              key: payload.key,
              content: payload.content,
              expectedHash: payload.contentHash,
              copyRole,
              jobId: command.jobId,
              runId: artifact.runId,
              artifactId: artifact.artifactId,
              requestedAt: artifact.capturedAt,
              targetRegion: artifact.environmentOrigin.environment,
              egressAuthorization,
            }),
          );
          payloadLocations.push({
            storeId: store.storeId,
            key: payload.key,
            contentHash: payload.contentHash,
            copyRole,
          });
        }
      }

      return Object.freeze({
        schemaVersion: "artifact-package-manifest-v1",
        manifestHash,
        jobId: command.jobId,
        artifact: artifactMetadata,
        renderManifestId: renderManifest.renderManifestId,
        renderManifestHash: renderManifest.contentHash,
        derivatives: Object.freeze(derivatives),
        payloadLocations: Object.freeze(payloadLocations),
        egressAuthorizations: Object.freeze(authorizations),
      });
    },

    async readFromSecondary(manifest) {
      const identityLocation = manifest.payloadLocations.find(
        ({ copyRole, key }) =>
          copyRole === "secondary" && key.endsWith("/manifest"),
      );
      const expectedIdentity = identityBytes(
        manifestIdentity({
          jobId: manifest.jobId,
          artifact: manifest.artifact,
          renderManifestId: manifest.renderManifestId,
          renderManifestHash: manifest.renderManifestHash,
          derivatives: manifest.derivatives,
        }),
      );
      const storedIdentity =
        identityLocation === undefined
          ? null
          : await secondary.read(identityLocation.key);
      if (
        identityLocation === undefined ||
        identityLocation.contentHash !== manifest.manifestHash ||
        storedIdentity === null ||
        sha256(storedIdentity) !== manifest.manifestHash ||
        !isDeepStrictEqual(storedIdentity, expectedIdentity)
      ) {
        throw new Error("Artifact secondary immutable manifest mismatch");
      }
      const originalLocation = manifest.payloadLocations.find(
        ({ copyRole, key }) =>
          copyRole === "secondary" && key.endsWith("/original"),
      );
      if (originalLocation === undefined) {
        throw new Error("Artifact secondary original location is missing");
      }
      const original = await secondary.read(originalLocation.key);
      if (
        original === null ||
        sha256(original) !== manifest.artifact.contentHash
      ) {
        throw new Error("Artifact secondary original hash mismatch");
      }
      const recoveredDerivatives = [];
      for (const lineage of manifest.derivatives) {
        const expectedKey = `artifacts/${manifest.artifact.artifactId}/derivatives/static-slide-${lineage.pageNumber}`;
        const location = manifest.payloadLocations.find(
          ({ copyRole, contentHash, key }) =>
            copyRole === "secondary" &&
            key === expectedKey &&
            contentHash === lineage.contentHash,
        );
        if (location === undefined) {
          throw new Error(
            `Artifact secondary derivative location is missing: ${lineage.derivativeId}`,
          );
        }
        const content = await secondary.read(location.key);
        if (content === null || sha256(content) !== lineage.contentHash) {
          throw new Error(
            `Artifact secondary derivative hash mismatch: ${lineage.derivativeId}`,
          );
        }
        recoveredDerivatives.push({ lineage, content });
      }
      return {
        manifest,
        original,
        derivatives: recoveredDerivatives,
      };
    },
  };
}
