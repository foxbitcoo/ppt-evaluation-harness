import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import sharp from "sharp";

import {
  InMemoryArtifactCaptureJournal,
  createArtifactVault,
  type ArtifactVault,
  type JobTombstoneLookupPort,
} from "./artifact-vault.ts";
import {
  FileSystemBrowserProfileLock,
  type BrowserProfileLockPort,
} from "./browser-profile-lock.ts";
import type {
  EgressAuthorizationAuditPort,
  EgressAuthorizationPort,
} from "./egress-authorization.ts";
import { FileSystemImmutableBlobStore } from "./file-system-blob-store.ts";
import { FileSystemAttemptCheckpointStore } from "./file-system-checkpoint-store.ts";
import type {
  AttemptCheckpointPort,
  SafeRasterCandidate,
  SafeRasterRendererPort,
} from "./product-adapter.ts";
import type { PayloadInventoryPort } from "./retention.ts";
import {
  createRunSpecificationVault,
  type RunSpecificationVault,
} from "./run-specification.ts";

interface FailureDomainConfiguration {
  readonly operatorDomainLabel: string;
  readonly rootPath: string;
  readonly rootReference: string;
  readonly storeId: string;
}

export interface HarnessOwnedProductionCapabilityEvidence {
  readonly schemaVersion: "production-capability-evidence-v1";
  readonly capabilityBundleId: string;
  readonly artifactStorageTopology: {
    readonly isolation:
      | "single_failure_domain"
      | "device_separated";
    readonly primaryDeviceIdentity: string;
    readonly recoveryDeviceIdentity: string;
  };
  readonly artifactPrimary: {
    readonly rootReference: string;
    readonly storeId: string;
    readonly backendInstanceIdentity: string;
  };
  readonly artifactRecovery: {
    readonly rootReference: string;
    readonly storeId: string;
    readonly backendInstanceIdentity: string;
  };
  readonly runSpecification: {
    readonly rootReference: string;
    readonly storeId: string;
    readonly backendInstanceIdentity: string;
  };
  readonly checkpoint: {
    readonly rootReference: string;
    readonly storeId: string;
  };
  readonly profileLock: {
    readonly rootReference: string;
    readonly lockId: string;
  };
  readonly rendererId: string;
}

export interface HarnessOwnedProductionCapabilities {
  readonly artifactVault: ArtifactVault;
  readonly runSpecificationVault: RunSpecificationVault;
  readonly attemptCheckpointStore: AttemptCheckpointPort;
  readonly browserProfileLock: BrowserProfileLockPort;
  readonly safeRasterRenderer: SafeRasterRendererPort;
  readonly evidence: HarnessOwnedProductionCapabilityEvidence;
}

const capabilityBundleByObject = new WeakMap<object, string>();

function safeIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(value)) {
    throw new Error(`Production capability ${label} is invalid`);
  }
}

function evidenceFor(configuration: FailureDomainConfiguration) {
  return Object.freeze({
    rootReference: configuration.rootReference,
    storeId: configuration.storeId,
  });
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function backendAttestation(
  configuration: FailureDomainConfiguration,
): {
  readonly deviceIdentity: `fs-device:sha256:${string}`;
  readonly backendInstanceIdentity: `fs-backend:sha256:${string}`;
} {
  const root = resolve(configuration.rootPath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = statSync(root);
  return Object.freeze({
    deviceIdentity:
      `fs-device:${sha256(String(stat.dev))}` as const,
    backendInstanceIdentity:
      `fs-backend:${sha256(
        JSON.stringify({
          dev: stat.dev,
          ino: stat.ino,
          root,
          storeId: configuration.storeId,
        }),
      )}` as const,
  });
}

export function createHarnessOwnedProductionCapabilities(input: {
  readonly artifactPrimary: FailureDomainConfiguration;
  readonly artifactRecovery: FailureDomainConfiguration;
  readonly runSpecification: FailureDomainConfiguration;
  readonly checkpoint: {
    readonly rootPath: string;
    readonly rootReference: string;
    readonly storeId: string;
  };
  readonly profileLock: {
    readonly rootPath: string;
    readonly rootReference: string;
    readonly lockId: string;
  };
  readonly renderer: {
    readonly rendererId: string;
    readonly slidesDirectory: string;
    readonly extractedTextPrefix: string;
    readonly fontPack: string;
    readonly resolution: string;
    readonly colorProfile: string;
    readonly fidelityNotes: readonly string[];
  };
  readonly tombstones: JobTombstoneLookupPort;
  readonly payloadInventory: PayloadInventoryPort;
  readonly egressAuthorization: EgressAuthorizationPort;
  readonly egressAudit: EgressAuthorizationAuditPort;
}): HarnessOwnedProductionCapabilities {
  const primaryRoot = resolve(input.artifactPrimary.rootPath);
  const recoveryRoot = resolve(input.artifactRecovery.rootPath);
  if (
    input.artifactPrimary.rootReference ===
      input.artifactRecovery.rootReference ||
    primaryRoot === recoveryRoot
  ) {
    throw new Error(
      "Production Artifact primary and recovery stores require distinct roots",
    );
  }
  for (const configuration of [
    input.artifactPrimary,
    input.artifactRecovery,
    input.runSpecification,
  ]) {
    safeIdentifier(
      configuration.operatorDomainLabel,
      "operatorDomainLabel",
    );
    safeIdentifier(configuration.rootReference, "rootReference");
    safeIdentifier(configuration.storeId, "storeId");
  }
  safeIdentifier(input.checkpoint.rootReference, "checkpoint rootReference");
  safeIdentifier(input.checkpoint.storeId, "checkpoint storeId");
  safeIdentifier(input.profileLock.rootReference, "profile rootReference");
  safeIdentifier(input.profileLock.lockId, "profile lockId");
  safeIdentifier(input.renderer.rendererId, "rendererId");
  const primaryAttestation = backendAttestation(
    input.artifactPrimary,
  );
  const recoveryAttestation = backendAttestation(
    input.artifactRecovery,
  );
  const runSpecificationAttestation = backendAttestation(
    input.runSpecification,
  );

  const primary = new FileSystemImmutableBlobStore({
    storeId: input.artifactPrimary.storeId,
    rootPath: input.artifactPrimary.rootPath,
    tombstones: input.tombstones,
  });
  const secondary = new FileSystemImmutableBlobStore({
    storeId: input.artifactRecovery.storeId,
    rootPath: input.artifactRecovery.rootPath,
    tombstones: input.tombstones,
  });
  const runSpecificationStore = new FileSystemImmutableBlobStore({
    storeId: input.runSpecification.storeId,
    rootPath: input.runSpecification.rootPath,
    tombstones: input.tombstones,
  });
  const artifactVault = createArtifactVault({
    primary,
    secondary,
    egressAuthorization: input.egressAuthorization,
    egressAudit: input.egressAudit,
    captureJournal: new InMemoryArtifactCaptureJournal(
      `production-capability-journal:${randomUUID()}`,
    ),
    payloadInventory: input.payloadInventory,
  });
  const runSpecificationVault = createRunSpecificationVault({
    store: runSpecificationStore,
    egressAuthorization: input.egressAuthorization,
    egressAudit: input.egressAudit,
    payloadInventory: input.payloadInventory,
  });
  const attemptCheckpointStore =
    new FileSystemAttemptCheckpointStore({
      checkpointStoreId: input.checkpoint.storeId,
      rootPath: input.checkpoint.rootPath,
    });
  const browserProfileLock = new FileSystemBrowserProfileLock({
    lockId: input.profileLock.lockId,
    rootPath: input.profileLock.rootPath,
  });
  const safeRasterRenderer: SafeRasterRendererPort = Object.freeze({
    rendererId: input.renderer.rendererId,
    async render({
      authorizationDecisionId,
    }: Parameters<SafeRasterRendererPort["render"]>[0]) {
      if (authorizationDecisionId.trim().length === 0) {
        throw new Error(
          "Harness-owned renderer requires an authorization decision",
        );
      }
      const slides = await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          const pageNumber = index + 1;
          const filename =
            `slide-${String(pageNumber).padStart(2, "0")}.png`;
          let content: Uint8Array;
          try {
            content = Uint8Array.from(
              await readFile(
                join(input.renderer.slidesDirectory, filename),
              ),
            );
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ENOENT"
            ) {
              throw error;
            }
            content = Uint8Array.from(
              await readFile(
                join(
                  input.renderer.slidesDirectory,
                  `slide-${pageNumber}.png`,
                ),
              ),
            );
          }
          return Object.freeze({
            pageNumber,
            filename,
            mimeType: "image/png" as const,
            content,
            extractedText: `${input.renderer.extractedTextPrefix} ${pageNumber}`,
          });
        }),
      );
      const tileWidth = 320;
      const tileHeight = 180;
      const tiles = await Promise.all(
        slides.map(async (slide, index) => ({
          input: await sharp(Buffer.from(slide.content))
            .resize(tileWidth, tileHeight, {
              fit: "contain",
              background: "#ffffff",
            })
            .png()
            .toBuffer(),
          left: (index % 4) * tileWidth,
          top: Math.floor(index / 4) * tileHeight,
        })),
      );
      const contactSheet = Uint8Array.from(
        await sharp({
          create: {
            width: tileWidth * 4,
            height: tileHeight * 4,
            channels: 4,
            background: "#ffffff",
          },
        })
          .composite(tiles)
          .png()
          .toBuffer(),
      );
      const candidate: SafeRasterCandidate = {
        renderer: input.renderer.rendererId,
        fontPack: input.renderer.fontPack,
        resolution: input.renderer.resolution,
        colorProfile: input.renderer.colorProfile,
        renderOutcome: "degraded",
        fidelity: {
          status: "degraded",
          notes: Object.freeze([
            ...input.renderer.fidelityNotes,
          ]),
        },
        slides: Object.freeze(slides),
        contactSheet: {
          filename: "contact-sheet-4x4.png",
          mimeType: "image/png",
          content: contactSheet,
        },
      };
      return Object.freeze(candidate);
    },
  });

  const capabilityBundleId = `capability-${randomUUID()}`;
  for (const capability of [
    artifactVault,
    runSpecificationVault,
    attemptCheckpointStore,
    browserProfileLock,
    safeRasterRenderer,
  ]) {
    capabilityBundleByObject.set(capability, capabilityBundleId);
  }
  return Object.freeze({
    artifactVault,
    runSpecificationVault,
    attemptCheckpointStore,
    browserProfileLock,
    safeRasterRenderer,
    evidence: Object.freeze({
      schemaVersion: "production-capability-evidence-v1",
      capabilityBundleId,
      artifactStorageTopology: Object.freeze({
        isolation:
          primaryAttestation.deviceIdentity ===
          recoveryAttestation.deviceIdentity
            ? "single_failure_domain"
            : "device_separated",
        primaryDeviceIdentity:
          primaryAttestation.deviceIdentity,
        recoveryDeviceIdentity:
          recoveryAttestation.deviceIdentity,
      }),
      artifactPrimary: Object.freeze({
        ...evidenceFor(input.artifactPrimary),
        backendInstanceIdentity:
          primaryAttestation.backendInstanceIdentity,
      }),
      artifactRecovery: Object.freeze({
        ...evidenceFor(input.artifactRecovery),
        backendInstanceIdentity:
          recoveryAttestation.backendInstanceIdentity,
      }),
      runSpecification: Object.freeze({
        ...evidenceFor(input.runSpecification),
        backendInstanceIdentity:
          runSpecificationAttestation.backendInstanceIdentity,
      }),
      checkpoint: Object.freeze({
        rootReference: input.checkpoint.rootReference,
        storeId: input.checkpoint.storeId,
      }),
      profileLock: Object.freeze({
        rootReference: input.profileLock.rootReference,
        lockId: input.profileLock.lockId,
      }),
      rendererId: input.renderer.rendererId,
    }),
  });
}

export function assertHarnessOwnedProductionCapabilities(input: {
  readonly artifactVault: ArtifactVault;
  readonly runSpecificationVault: RunSpecificationVault;
  readonly attemptCheckpointStore: AttemptCheckpointPort;
  readonly browserProfileLock: BrowserProfileLockPort;
  readonly safeRasterRenderer: SafeRasterRendererPort;
}): void {
  const identities = [
    input.artifactVault,
    input.runSpecificationVault,
    input.attemptCheckpointStore,
    input.browserProfileLock,
    input.safeRasterRenderer,
  ].map((capability) => capabilityBundleByObject.get(capability));
  if (
    identities.some((identity) => identity === undefined) ||
    new Set(identities).size !== 1
  ) {
    throw new Error(
      "Production Bakeoff requires harness-owned attested capabilities",
    );
  }
}
