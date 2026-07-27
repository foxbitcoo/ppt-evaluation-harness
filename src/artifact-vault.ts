import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Artifact, RenderManifest } from "./domain.ts";
import {
  calculateRenderManifestHash,
  renderManifestBytes,
} from "./render-manifest.ts";
import {
  requireEgressAuthorization,
  type ApprovedEgressAuthorization,
  type EgressDestinationMetadata,
  type EgressAuthorizationPort,
} from "./egress-authorization.ts";
import type { PayloadInventoryPort } from "./retention.ts";

export interface ImmutableBlobWriteContext {
  readonly jobId: string;
  readonly contentHash: `sha256:${string}`;
}

export interface JobTombstoneLookupPort {
  findByJobId(jobId: string): Promise<unknown | null>;
}

export interface ImmutableBlobStorePort {
  readonly storeId: string;
  readonly egressDestination: EgressDestinationMetadata;
  putImmutable(
    key: string,
    content: Uint8Array,
    context: ImmutableBlobWriteContext,
  ): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export interface ArtifactCaptureJournalEvent {
  readonly eventId: string;
  readonly captureAttemptId: string;
  readonly jobId: string;
  readonly artifactId: string;
  readonly eventType:
    | "started"
    | "write_verified"
    | "completed"
    | "failed"
    | "cleanup_verified";
  readonly storeId: string | null;
  readonly key: string | null;
  readonly detail: string;
}

export interface ArtifactCaptureJournalPort {
  append(event: ArtifactCaptureJournalEvent): Promise<void>;
}

export class InMemoryArtifactCaptureJournal
  implements ArtifactCaptureJournalPort
{
  readonly #events: ArtifactCaptureJournalEvent[] = [];

  async append(event: ArtifactCaptureJournalEvent): Promise<void> {
    const existing = this.#events.find(
      ({ eventId }) => eventId === event.eventId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, event)) {
        throw new Error(`Artifact capture journal conflict: ${event.eventId}`);
      }
      return;
    }
    this.#events.push(structuredClone(event));
  }

  list(
    jobId?: string,
    artifactId?: string,
  ): readonly ArtifactCaptureJournalEvent[] {
    return structuredClone(
      this.#events.filter(
        (event) =>
          (jobId === undefined || event.jobId === jobId) &&
          (artifactId === undefined || event.artifactId === artifactId),
      ),
    );
  }
}

export class InMemoryImmutableBlobStore implements ImmutableBlobStorePort {
  readonly storeId: string;
  readonly egressDestination: EgressDestinationMetadata;
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(
    storeId: string,
    private readonly tombstones?: JobTombstoneLookupPort,
    egressDestination?: EgressDestinationMetadata,
  ) {
    if (storeId.trim().length === 0) {
      throw new Error("Immutable blob store requires a stable storeId");
    }
    this.storeId = storeId;
    this.egressDestination = Object.freeze(
      structuredClone(
        egressDestination ?? {
          targetService: storeId,
          targetAccount: `in-memory:${storeId}`,
          targetRegion: "test",
          subprocessors: [],
        },
      ),
    );
  }

  async putImmutable(
    key: string,
    content: Uint8Array,
    context: ImmutableBlobWriteContext,
  ): Promise<void> {
    if (sha256(content) !== context.contentHash) {
      throw new Error(
        `Immutable blob write context hash mismatch: ${this.storeId}/${key}`,
      );
    }
    if (
      this.tombstones !== undefined &&
      (await this.tombstones.findByJobId(context.jobId)) !== null
    ) {
      throw new Error(
        `Tombstoned Job ${context.jobId} blocked immutable blob write`,
      );
    }
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
  readonly derivativeType:
    | "static_slide"
    | "extracted_text"
    | "contact_sheet";
  readonly pageNumber: number | null;
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
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
}

export interface RecoveredArtifactPackage {
  readonly manifest: ArtifactPackageManifest;
  readonly renderManifest: Uint8Array;
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
  readonly captureJournal?: ArtifactCaptureJournalPort;
  readonly payloadInventory: PayloadInventoryPort;
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

function derivativeKey(
  artifactId: string,
  lineage: ArtifactDerivativeLineage,
): string {
  switch (lineage.derivativeType) {
    case "static_slide":
      return `artifacts/${artifactId}/derivatives/static-slide-${lineage.pageNumber}`;
    case "extracted_text":
      return `artifacts/${artifactId}/derivatives/extracted-text-${lineage.pageNumber}`;
    case "contact_sheet":
      return `artifacts/${artifactId}/derivatives/contact-sheet`;
  }
}

function storageRequest(input: {
  readonly jobId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly storeId: string;
  readonly key: string;
  readonly contentHash: `sha256:${string}`;
  readonly contentField: string;
  readonly destination: EgressDestinationMetadata;
}) {
  return Object.freeze({
    requestId: `artifact-storage:${input.artifactId}:${input.storeId}:${input.key}`,
    jobId: input.jobId,
    runId: input.runId,
    attemptId: null,
    dataClassification: input.dataClassification,
    sourceOwner: input.sourceOwner,
    processingPurpose: "artifact_storage" as const,
    targetKind: "storage" as const,
    targetService: input.destination.targetService,
    targetAccount: input.destination.targetAccount,
    targetRegion: input.destination.targetRegion,
    subprocessors: Object.freeze([...input.destination.subprocessors]),
    contentFields: Object.freeze([input.contentField]),
    payloadHash: input.contentHash,
    requiredRedactions: Object.freeze([]),
  });
}

export function createArtifactVault({
  primary,
  secondary,
  egressAuthorization,
  captureJournal = new InMemoryArtifactCaptureJournal(),
  payloadInventory,
}: ArtifactVaultDependencies): ArtifactVault {
  if (primary.storeId === secondary.storeId) {
    throw new Error("ArtifactVault requires two distinct controlled stores");
  }
  const attemptCounts = new Map<string, number>();
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

      const expectedRenderManifestHash = calculateRenderManifestHash(
        artifact.contentHash,
        renderManifest,
      );
      if (expectedRenderManifestHash !== renderManifest.contentHash) {
        throw new Error("Render manifest content hash mismatch");
      }
      const frozenRenderManifest = renderManifestBytes(
        artifact.contentHash,
        renderManifest,
      );

      const slideDerivatives = renderManifest.slides.flatMap((slide) => {
        const content = contentBytes(slide.content);
        assertSha256(content, slide.contentHash, `Slide ${slide.pageNumber}`);
        const extractedText = contentBytes(slide.extractedText);
        return [
          Object.freeze<ArtifactDerivativeLineage>({
            derivativeId: `${artifact.artifactId}:static-slide:${slide.pageNumber}`,
            sourceArtifactId: artifact.artifactId,
            derivativeType: "static_slide",
            pageNumber: slide.pageNumber,
            filename: slide.filename,
            mimeType: slide.mimeType,
            byteSize: content.byteLength,
            contentHash: slide.contentHash,
            pipelineVersion: renderManifest.renderer,
          }),
          Object.freeze<ArtifactDerivativeLineage>({
            derivativeId: `${artifact.artifactId}:extracted-text:${slide.pageNumber}`,
            sourceArtifactId: artifact.artifactId,
            derivativeType: "extracted_text",
            pageNumber: slide.pageNumber,
            filename: `slide-${slide.pageNumber}.txt`,
            mimeType: "text/plain; charset=utf-8",
            byteSize: extractedText.byteLength,
            contentHash: sha256(extractedText),
            pipelineVersion: renderManifest.renderer,
          }),
        ];
      });
      const pageNumbers = slideDerivatives
        .filter(({ derivativeType }) => derivativeType === "static_slide")
        .map(({ pageNumber }) => pageNumber);
      if (
        new Set(pageNumbers).size !== pageNumbers.length ||
        pageNumbers.some((pageNumber, index) => pageNumber !== index + 1)
      ) {
        throw new Error("Artifact derivative page lineage is incomplete");
      }
      const contactSheetContent = contentBytes(
        renderManifest.contactSheet.content,
      );
      assertSha256(
        contactSheetContent,
        renderManifest.contactSheet.contentHash,
        "Contact sheet",
      );
      const derivatives = [
        ...slideDerivatives,
        Object.freeze<ArtifactDerivativeLineage>({
          derivativeId: `${artifact.artifactId}:contact-sheet`,
          sourceArtifactId: artifact.artifactId,
          derivativeType: "contact_sheet",
          pageNumber: null,
          filename: renderManifest.contactSheet.filename,
          mimeType: renderManifest.contactSheet.mimeType,
          byteSize: contactSheetContent.byteLength,
          contentHash: renderManifest.contactSheet.contentHash,
          pipelineVersion: renderManifest.renderer,
        }),
      ];
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
          contentField: "artifact_package_identity_manifest",
        },
        {
          key: `artifacts/${artifact.artifactId}/original`,
          content: artifact.content,
          contentHash: artifact.contentHash,
          contentField: "original_artifact_binary",
        },
        {
          key: `artifacts/${artifact.artifactId}/render-manifest`,
          content: frozenRenderManifest,
          contentHash: renderManifest.contentHash,
          contentField: "full_render_manifest",
        },
        ...derivatives.map((lineage) => {
          const slide =
            lineage.pageNumber === null
              ? null
              : renderManifest.slides[lineage.pageNumber - 1];
          const content =
            lineage.derivativeType === "static_slide"
              ? contentBytes(slide?.content ?? "")
              : lineage.derivativeType === "extracted_text"
                ? contentBytes(slide?.extractedText ?? "")
                : contactSheetContent;
          return {
            key: derivativeKey(artifact.artifactId, lineage),
            content,
            contentHash: lineage.contentHash,
            contentField: lineage.derivativeType,
          };
        }),
      ];
      const authorizations: ApprovedEgressAuthorization[] = [];
      const payloadLocations: RetentionPayloadLocation[] = [];
      const writePlan = payloads.flatMap((payload) =>
        ([
          [primary, "primary"],
          [secondary, "secondary"],
        ] as const).map(([store, copyRole]) => ({
          ...payload,
          store,
          copyRole,
        })),
      );
      for (const planned of writePlan) {
        authorizations.push(
          await requireEgressAuthorization(
            egressAuthorization,
            storageRequest({
              jobId: command.jobId,
              runId: artifact.runId,
              artifactId: artifact.artifactId,
              dataClassification: command.dataClassification,
              sourceOwner: command.sourceOwner,
              storeId: planned.store.storeId,
              key: planned.key,
              contentHash: planned.contentHash,
              contentField: planned.contentField,
              destination: planned.store.egressDestination,
            }),
          ),
        );
        payloadLocations.push({
          storeId: planned.store.storeId,
          key: planned.key,
          contentHash: planned.contentHash,
          copyRole: planned.copyRole,
        });
      }
      const attemptIdentity = `${command.jobId}\u0000${artifact.artifactId}`;
      const attemptNumber = (attemptCounts.get(attemptIdentity) ?? 0) + 1;
      attemptCounts.set(attemptIdentity, attemptNumber);
      const captureAttemptId =
        `artifact-capture-attempt:${command.jobId}:${artifact.artifactId}:${attemptNumber}`;
      await captureJournal.append({
        eventId: `${captureAttemptId}:started`,
        captureAttemptId,
        jobId: command.jobId,
        artifactId: artifact.artifactId,
        eventType: "started",
        storeId: null,
        key: null,
        detail: `planned:${writePlan.length}`,
      });
      await payloadInventory.register(command.jobId, payloadLocations);
      let verifiedWrites = 0;
      const createdLocations = new Set<string>();
      try {
        for (const planned of writePlan) {
          const locationIdentity =
            `${planned.store.storeId}\u0000${planned.key}`;
          const before = await planned.store.read(planned.key);
          if (before === null) {
            await planned.store.putImmutable(planned.key, planned.content, {
              jobId: command.jobId,
              contentHash: planned.contentHash,
            });
            createdLocations.add(locationIdentity);
          } else if (sha256(before) !== planned.contentHash) {
            throw new Error(
              `Immutable blob conflict: ${planned.store.storeId}/${planned.key}`,
            );
          }
          const readback = await planned.store.read(planned.key);
          if (
            readback === null ||
            sha256(readback) !== planned.contentHash
          ) {
            throw new Error(
              `${planned.copyRole} upload readback hash mismatch for ${planned.key}`,
            );
          }
          verifiedWrites += 1;
          await captureJournal.append({
            eventId: `${captureAttemptId}:write:${verifiedWrites}`,
            captureAttemptId,
            jobId: command.jobId,
            artifactId: artifact.artifactId,
            eventType: "write_verified",
            storeId: planned.store.storeId,
            key: planned.key,
            detail: planned.contentHash,
          });
        }
        await captureJournal.append({
          eventId: `${captureAttemptId}:completed`,
          captureAttemptId,
          jobId: command.jobId,
          artifactId: artifact.artifactId,
          eventType: "completed",
          storeId: null,
          key: null,
          detail: `verified:${verifiedWrites}`,
        });
      } catch (error) {
        const cleanupFailures: string[] = [];
        for (const planned of writePlan) {
          const locationIdentity =
            `${planned.store.storeId}\u0000${planned.key}`;
          if (!createdLocations.has(locationIdentity)) continue;
          try {
            await planned.store.delete(planned.key);
            if ((await planned.store.read(planned.key)) !== null) {
              cleanupFailures.push(
                `${planned.store.storeId}/${planned.key}`,
              );
            }
          } catch {
            cleanupFailures.push(`${planned.store.storeId}/${planned.key}`);
          }
        }
        const appendRecoveryJournal = async (
          event: ArtifactCaptureJournalEvent,
        ): Promise<void> => {
          try {
            await captureJournal.append(event);
          } catch {
            // Cleanup is the security boundary; journal outages are reported
            // by the original failure and cannot prevent rollback.
          }
        };
        await appendRecoveryJournal({
          eventId: `${captureAttemptId}:failed`,
          captureAttemptId,
          jobId: command.jobId,
          artifactId: artifact.artifactId,
          eventType: "failed",
          storeId: null,
          key: null,
          detail: error instanceof Error ? error.message : String(error),
        });
        if (cleanupFailures.length > 0) {
          throw new Error(
            `Artifact capture failed and cleanup was incomplete: ${cleanupFailures.join(", ")}`,
            { cause: error },
          );
        }
        await appendRecoveryJournal({
          eventId: `${captureAttemptId}:cleanup`,
          captureAttemptId,
          jobId: command.jobId,
          artifactId: artifact.artifactId,
          eventType: "cleanup_verified",
          storeId: null,
          key: null,
          detail: `absent:${writePlan.length}`,
        });
        throw error;
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
      const renderManifestLocation = manifest.payloadLocations.find(
        ({ copyRole, key, contentHash }) =>
          copyRole === "secondary" &&
          key.endsWith("/render-manifest") &&
          contentHash === manifest.renderManifestHash,
      );
      if (renderManifestLocation === undefined) {
        throw new Error("Artifact secondary render manifest location is missing");
      }
      const renderManifest = await secondary.read(renderManifestLocation.key);
      if (
        renderManifest === null ||
        sha256(renderManifest) !== manifest.renderManifestHash
      ) {
        throw new Error("Artifact secondary render manifest hash mismatch");
      }
      const recoveredDerivatives = [];
      for (const lineage of manifest.derivatives) {
        const expectedKey = derivativeKey(
          manifest.artifact.artifactId,
          lineage,
        );
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
        renderManifest,
        original,
        derivatives: recoveredDerivatives,
      };
    },
  };
}
