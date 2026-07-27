import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Artifact, RenderManifest } from "./domain.ts";
import type { ProductionDriverExecutionEvidence } from "./product-adapter.ts";
import {
  calculateRenderManifestHash,
  renderManifestBytes,
} from "./render-manifest.ts";
import {
  approvedEgressAuthorizationHash,
  assertApprovedEgressAuthorizationCurrent,
  assertPersistedApprovedEgressAuthorization,
  requireEgressAuthorization,
  SYSTEM_CLOCK,
  type ApprovedEgressAuthorization,
  type ClockPort,
  type EgressAuthorizationAuditPort,
  type EgressDestinationMetadata,
  type EgressAuthorizationPort,
} from "./egress-authorization.ts";
import type { PayloadInventoryPort } from "./retention.ts";

export interface ImmutableBlobWriteContext {
  readonly jobId: string;
  readonly contentHash: `sha256:${string}`;
  readonly writeAttemptId: string;
  readonly assertWriteAuthorized: () => void;
}

export interface JobTombstoneLookupPort {
  findByJobId(jobId: string): Promise<unknown | null>;
  runIfActive<T>(jobId: string, operation: () => Promise<T>): Promise<T>;
}

export interface ImmutableBlobStorePort {
  readonly storeId: string;
  readonly durability?: "ephemeral" | "durable";
  readonly recoveryReferencePrefix?: string;
  readonly egressDestination: EgressDestinationMetadata;
  putImmutable(
    key: string,
    content: Uint8Array,
    context: ImmutableBlobWriteContext,
  ): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  releaseWriteClaim(key: string, writeAttemptId: string): Promise<void>;
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
  readonly journalId: string;
  beginAttempt(input: {
    readonly jobId: string;
    readonly artifactId: string;
    readonly detail: string;
  }): Promise<string>;
  append(event: ArtifactCaptureJournalEvent): Promise<void>;
  verifyCompletedAttempt(input: {
    readonly captureAttemptId: string;
    readonly jobId: string;
    readonly artifactId: string;
    readonly expectedWrites: readonly {
      readonly storeId: string;
      readonly key: string;
      readonly contentHash: `sha256:${string}`;
    }[];
  }): Promise<void>;
}

export class InMemoryArtifactCaptureJournal
  implements ArtifactCaptureJournalPort
{
  readonly journalId: string;
  readonly #events: ArtifactCaptureJournalEvent[] = [];
  readonly #attemptCounts = new Map<string, number>();

  constructor(
    journalId = `in-memory-artifact-capture-journal:${randomUUID()}`,
  ) {
    this.journalId = journalId;
  }

  async beginAttempt(input: {
    readonly jobId: string;
    readonly artifactId: string;
    readonly detail: string;
  }): Promise<string> {
    const identity = `${input.jobId}\u0000${input.artifactId}`;
    const attemptNumber = (this.#attemptCounts.get(identity) ?? 0) + 1;
    this.#attemptCounts.set(identity, attemptNumber);
    const captureAttemptId =
      `artifact-capture-attempt:${this.journalId}:${input.jobId}:${input.artifactId}:${attemptNumber}`;
    await this.append({
      eventId: `${captureAttemptId}:started`,
      captureAttemptId,
      jobId: input.jobId,
      artifactId: input.artifactId,
      eventType: "started",
      storeId: null,
      key: null,
      detail: input.detail,
    });
    return captureAttemptId;
  }

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

  async verifyCompletedAttempt(input: {
    readonly captureAttemptId: string;
    readonly jobId: string;
    readonly artifactId: string;
    readonly expectedWrites: readonly {
      readonly storeId: string;
      readonly key: string;
      readonly contentHash: `sha256:${string}`;
    }[];
  }): Promise<void> {
    const events = this.#events.filter(
      (event) =>
        event.captureAttemptId === input.captureAttemptId &&
        event.jobId === input.jobId &&
        event.artifactId === input.artifactId,
    );
    const [started, ...remaining] = events;
    const completed = remaining.at(-1);
    const writes = remaining.slice(0, -1);
    const validWrites =
      writes.length === input.expectedWrites.length &&
      writes.every((event, index) => {
        const expected = input.expectedWrites[index];
        return (
          expected !== undefined &&
          event.eventType === "write_verified" &&
          event.storeId === expected.storeId &&
          event.key === expected.key &&
          event.detail === expected.contentHash
        );
      });
    if (
      events.length !== input.expectedWrites.length + 2 ||
      started?.eventType !== "started" ||
      started.detail !== `planned:${input.expectedWrites.length}` ||
      !validWrites ||
      completed?.eventType !== "completed" ||
      completed.detail !== `verified:${input.expectedWrites.length}`
    ) {
      throw new Error(
        `Artifact capture journal trace is incomplete: ${input.captureAttemptId}`,
      );
    }
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
  readonly durability = "ephemeral" as const;
  readonly recoveryReferencePrefix = "unavailable";
  readonly egressDestination: EgressDestinationMetadata;
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #writeClaims = new Map<string, Set<string>>();

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
    const write = async () => {
      context.assertWriteAuthorized();
      const existing = this.#blobs.get(key);
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing, content)) {
          throw new Error(`Immutable blob conflict: ${this.storeId}/${key}`);
        }
        const claims = this.#writeClaims.get(key) ?? new Set<string>();
        claims.add(context.writeAttemptId);
        this.#writeClaims.set(key, claims);
        return;
      }
      this.#blobs.set(key, Uint8Array.from(content));
      this.#writeClaims.set(key, new Set([context.writeAttemptId]));
    };
    if (this.tombstones === undefined) {
      await write();
      return;
    }
    try {
      await this.tombstones.runIfActive(context.jobId, write);
    } catch (error) {
      if (
        error instanceof Error &&
        /Tombstoned Job/i.test(error.message)
      ) {
        throw new Error(
          `Tombstoned Job ${context.jobId} blocked immutable blob write`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    const content = this.#blobs.get(key);
    return content === undefined ? null : Uint8Array.from(content);
  }

  async releaseWriteClaim(
    key: string,
    writeAttemptId: string,
  ): Promise<void> {
    const claims = this.#writeClaims.get(key);
    if (claims === undefined) return;
    claims.delete(writeAttemptId);
    if (claims.size === 0) {
      this.#writeClaims.delete(key);
      this.#blobs.delete(key);
    }
  }

  async delete(key: string): Promise<void> {
    this.#blobs.delete(key);
    this.#writeClaims.delete(key);
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
  readonly artifactIdentityHash: `sha256:${string}`;
  readonly captureJournalId: string;
  readonly captureAttemptId: string;
  readonly jobId: string;
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly artifact: ArtifactMetadata;
  readonly renderManifestId: string;
  readonly renderManifestHash: `sha256:${string}`;
  readonly renderOutcome: RenderManifest["renderOutcome"];
  readonly fidelity: RenderManifest["fidelity"];
  readonly derivatives: readonly ArtifactDerivativeLineage[];
  readonly payloadLocations: readonly RetentionPayloadLocation[];
  readonly egressAuthorizations: readonly ApprovedEgressAuthorization[];
  readonly productionExecutionEvidence?: (ProductionDriverExecutionEvidence & {
    readonly rasterManifestHash: `sha256:${string}`;
  }) | null;
}

export interface CaptureArtifactPackageCommand {
  readonly jobId: string;
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
  readonly productionExecutionEvidence?: ProductionDriverExecutionEvidence & {
    readonly rasterManifestHash: `sha256:${string}`;
  };
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
  readonly storageProfile?: {
    readonly durability: "ephemeral" | "durable";
    readonly primaryStoreId: string;
    readonly secondaryStoreId: string;
    readonly recoveryReferencePrefix: string;
  };
  capture(command: CaptureArtifactPackageCommand): Promise<ArtifactPackageManifest>;
  readFromSecondary(
    manifest: ArtifactPackageManifest,
  ): Promise<RecoveredArtifactPackage>;
}

export interface ArtifactVaultDependencies {
  readonly primary: ImmutableBlobStorePort;
  readonly secondary: ImmutableBlobStorePort;
  readonly egressAuthorization?: EgressAuthorizationPort;
  readonly egressAudit: EgressAuthorizationAuditPort;
  readonly captureJournal: ArtifactCaptureJournalPort;
  readonly payloadInventory: PayloadInventoryPort;
  readonly clock?: ClockPort;
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : Uint8Array.from(content);
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
  readonly renderOutcome: RenderManifest["renderOutcome"];
  readonly fidelity: RenderManifest["fidelity"];
  readonly derivatives: readonly ArtifactDerivativeLineage[];
  readonly productionExecutionEvidence:
    | (ProductionDriverExecutionEvidence & {
        readonly rasterManifestHash: `sha256:${string}`;
      })
    | null;
}) {
  return {
    schemaVersion: "artifact-package-identity-v1" as const,
    jobId: input.jobId,
    artifact: input.artifact,
    renderManifestId: input.renderManifestId,
    renderManifestHash: input.renderManifestHash,
    renderOutcome: input.renderOutcome,
    fidelity: input.fidelity,
    derivatives: input.derivatives,
    productionExecutionEvidence: input.productionExecutionEvidence,
  };
}

function captureEnvelopeIdentity(input: {
  readonly artifactIdentityHash: `sha256:${string}`;
  readonly captureJournalId: string;
  readonly captureAttemptId: string;
  readonly jobId: string;
  readonly artifactId: string;
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly primaryStoreId: string;
  readonly secondaryStoreId: string;
}) {
  return {
    schemaVersion: "artifact-package-capture-envelope-v1" as const,
    ...input,
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
  readonly captureAttemptId: string;
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly storeId: string;
  readonly key: string;
  readonly contentHash: `sha256:${string}`;
  readonly contentField: string;
  readonly destination: EgressDestinationMetadata;
}) {
  return Object.freeze({
    requestId: `artifact-storage:${input.captureAttemptId}:${input.storeId}:${input.key}`,
    jobId: input.jobId,
    runId: input.runId,
    attemptId: input.captureAttemptId,
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
  egressAudit,
  captureJournal,
  payloadInventory,
  clock = SYSTEM_CLOCK,
}: ArtifactVaultDependencies): ArtifactVault {
  if (primary.storeId === secondary.storeId) {
    throw new Error("ArtifactVault requires two distinct controlled stores");
  }
  return {
    storageProfile: Object.freeze({
      durability:
        primary.durability === "durable" &&
        secondary.durability === "durable"
          ? "durable"
          : "ephemeral",
      primaryStoreId: primary.storeId,
      secondaryStoreId: secondary.storeId,
      recoveryReferencePrefix:
        secondary.recoveryReferencePrefix ?? "unavailable",
    }),
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
        renderOutcome: renderManifest.renderOutcome,
        fidelity: renderManifest.fidelity,
        derivatives,
        productionExecutionEvidence:
          command.productionExecutionEvidence ?? null,
      });
      const frozenIdentity = identityBytes(identity);
      const artifactIdentityHash = sha256(frozenIdentity);

      const payloads = [
        {
          key: `artifacts/${artifact.artifactId}/manifest`,
          content: frozenIdentity,
          contentHash: artifactIdentityHash,
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
        payloadLocations.push({
          storeId: planned.store.storeId,
          key: planned.key,
          contentHash: planned.contentHash,
          copyRole: planned.copyRole,
        });
      }
      const captureAttemptId = await captureJournal.beginAttempt({
        jobId: command.jobId,
        artifactId: artifact.artifactId,
        detail: `planned:${writePlan.length}`,
      });
      let verifiedWrites = 0;
      const createdLocations = new Set<string>();
      try {
        await payloadInventory.register(command.jobId, payloadLocations);
        for (const planned of writePlan) {
          const authorization =
            await requireEgressAuthorization(
              egressAuthorization,
              storageRequest({
                jobId: command.jobId,
                runId: artifact.runId,
                artifactId: artifact.artifactId,
                captureAttemptId,
                dataClassification: command.dataClassification,
                sourceOwner: command.sourceOwner,
                storeId: planned.store.storeId,
                key: planned.key,
                contentHash: planned.contentHash,
                contentField: planned.contentField,
                destination: planned.store.egressDestination,
              }),
              clock,
            );
          await egressAudit.append(authorization);
          authorizations.push(authorization);
          const locationIdentity =
            `${planned.store.storeId}\u0000${planned.key}`;
          createdLocations.add(locationIdentity);
          await planned.store.putImmutable(planned.key, planned.content, {
            jobId: command.jobId,
            contentHash: planned.contentHash,
            writeAttemptId: captureAttemptId,
            assertWriteAuthorized: () =>
              assertApprovedEgressAuthorizationCurrent(
                authorization,
                clock,
              ),
          });
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
            await planned.store.releaseWriteClaim(
              planned.key,
              captureAttemptId,
            );
            const remaining = await planned.store.read(planned.key);
            if (
              remaining !== null &&
              sha256(remaining) !== planned.contentHash
            ) {
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
          detail: `claims-released:${createdLocations.size}`,
        });
        throw error;
      }

      const manifestHash = sha256(
        identityBytes(
          captureEnvelopeIdentity({
            artifactIdentityHash,
            captureJournalId: captureJournal.journalId,
            captureAttemptId,
            jobId: command.jobId,
            artifactId: artifact.artifactId,
            dataClassification: command.dataClassification,
            sourceOwner: command.sourceOwner,
            primaryStoreId: primary.storeId,
            secondaryStoreId: secondary.storeId,
          }),
        ),
      );
      return Object.freeze({
        schemaVersion: "artifact-package-manifest-v1",
        manifestHash,
        artifactIdentityHash,
        captureJournalId: captureJournal.journalId,
        captureAttemptId,
        jobId: command.jobId,
        dataClassification: command.dataClassification,
        sourceOwner: command.sourceOwner,
        artifact: artifactMetadata,
        renderManifestId: renderManifest.renderManifestId,
        renderManifestHash: renderManifest.contentHash,
        renderOutcome: renderManifest.renderOutcome,
        fidelity: renderManifest.fidelity,
        derivatives: Object.freeze(derivatives),
        payloadLocations: Object.freeze(payloadLocations),
        egressAuthorizations: Object.freeze(authorizations),
        productionExecutionEvidence:
          command.productionExecutionEvidence ?? null,
      });
    },

    async readFromSecondary(manifest) {
      if (
        manifest.schemaVersion !== "artifact-package-manifest-v1" ||
        manifest.captureJournalId !== captureJournal.journalId ||
        manifest.captureAttemptId.trim().length === 0 ||
        manifest.dataClassification === undefined ||
        manifest.sourceOwner?.trim().length === 0
      ) {
        throw new Error("Artifact package manifest envelope is invalid");
      }
      const expectedManifestHash = sha256(
        identityBytes(
          captureEnvelopeIdentity({
            artifactIdentityHash: manifest.artifactIdentityHash,
            captureJournalId: manifest.captureJournalId,
            captureAttemptId: manifest.captureAttemptId,
            jobId: manifest.jobId,
            artifactId: manifest.artifact.artifactId,
            dataClassification: manifest.dataClassification,
            sourceOwner: manifest.sourceOwner,
            primaryStoreId: primary.storeId,
            secondaryStoreId: secondary.storeId,
          }),
        ),
      );
      if (expectedManifestHash !== manifest.manifestHash) {
        throw new Error("Artifact package manifest envelope hash mismatch");
      }
      const payloadDescriptors = [
        {
          key: `artifacts/${manifest.artifact.artifactId}/manifest`,
          contentHash: manifest.artifactIdentityHash,
          contentField: "artifact_package_identity_manifest",
        },
        {
          key: `artifacts/${manifest.artifact.artifactId}/original`,
          contentHash: manifest.artifact.contentHash,
          contentField: "original_artifact_binary",
        },
        {
          key: `artifacts/${manifest.artifact.artifactId}/render-manifest`,
          contentHash: manifest.renderManifestHash,
          contentField: "full_render_manifest",
        },
        ...manifest.derivatives.map((lineage) => ({
          key: derivativeKey(manifest.artifact.artifactId, lineage),
          contentHash: lineage.contentHash,
          contentField: lineage.derivativeType,
        })),
      ];
      const expectedWritePlan = payloadDescriptors.flatMap((payload) =>
        ([
          [primary, "primary"],
          [secondary, "secondary"],
        ] as const).map(([store, copyRole]) => ({
          ...payload,
          store,
          copyRole,
        })),
      );
      const expectedLocations = expectedWritePlan.map((planned) => ({
        storeId: planned.store.storeId,
        key: planned.key,
        contentHash: planned.contentHash,
        copyRole: planned.copyRole,
      }));
      if (
        !isDeepStrictEqual(manifest.payloadLocations, expectedLocations) ||
        manifest.egressAuthorizations.length !== expectedWritePlan.length
      ) {
        throw new Error("Artifact package storage envelope is invalid");
      }
      await captureJournal.verifyCompletedAttempt({
        captureAttemptId: manifest.captureAttemptId,
        jobId: manifest.jobId,
        artifactId: manifest.artifact.artifactId,
        expectedWrites: expectedWritePlan.map((planned) => ({
          storeId: planned.store.storeId,
          key: planned.key,
          contentHash: planned.contentHash,
        })),
      });
      for (const [index, planned] of expectedWritePlan.entries()) {
        const authorization = manifest.egressAuthorizations[index];
        if (authorization === undefined) {
          throw new Error("Artifact package authorization is missing");
        }
        await egressAudit.assertRecorded(authorization);
        assertPersistedApprovedEgressAuthorization(
          authorization,
          {
            ...storageRequest({
              jobId: manifest.jobId,
              runId: manifest.artifact.runId,
              artifactId: manifest.artifact.artifactId,
              captureAttemptId: manifest.captureAttemptId,
              dataClassification: manifest.dataClassification,
              sourceOwner: manifest.sourceOwner,
              storeId: planned.store.storeId,
              key: planned.key,
              contentHash: planned.contentHash,
              contentField: planned.contentField,
              destination: planned.store.egressDestination,
            }),
            requestedAt: authorization.request.requestedAt,
          },
          approvedEgressAuthorizationHash(authorization),
        );
      }
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
          renderOutcome: manifest.renderOutcome,
          fidelity: manifest.fidelity,
          derivatives: manifest.derivatives,
          productionExecutionEvidence:
            manifest.productionExecutionEvidence ?? null,
        }),
      );
      if (sha256(expectedIdentity) !== manifest.artifactIdentityHash) {
        throw new Error("Artifact package identity hash mismatch");
      }
      const storedIdentity =
        identityLocation === undefined
          ? null
          : await secondary.read(identityLocation.key);
      if (
        identityLocation === undefined ||
        identityLocation.storeId !== secondary.storeId ||
        identityLocation.contentHash !== manifest.artifactIdentityHash ||
        storedIdentity === null ||
        sha256(storedIdentity) !== manifest.artifactIdentityHash ||
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
