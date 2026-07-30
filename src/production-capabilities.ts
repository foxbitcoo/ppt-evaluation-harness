import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import sharp from "sharp";

import {
  createArtifactVault,
  type ArtifactVault,
  type JobTombstoneLookupPort,
} from "./artifact-vault.ts";
import { FileSystemArtifactCaptureJournal } from "./file-system-operational-durability.ts";
import {
  FileSystemBrowserProfileLock,
  type BrowserProfileLockPort,
} from "./browser-profile-lock.ts";
import type {
  Artifact,
} from "./domain.ts";
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
import {
  validatedSafePngDimensions,
} from "./safe-raster.ts";

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
  readonly rendererExecutableHash: `sha256:${string}` | null;
  readonly captureJournal: {
    readonly journalId: string;
    readonly rootReference: string;
  };
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

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface ProductionRendererConfiguration {
  readonly rendererId: string;
  readonly slidesDirectory: string;
  readonly extractedTextPrefix: string;
  readonly fontPack: string;
  readonly resolution: string;
  readonly colorProfile: string;
  readonly fidelityNotes: readonly string[];
  readonly fixedRenderer?: "frozen-libreoffice-poppler-v1";
}

export const FROZEN_ARTIFACT_RENDERER_ID =
  "frozen-libreoffice-poppler-artifact-renderer:1" as const;
const FROZEN_LIBREOFFICE_ROOT =
  "/Users/chenyifan/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app";
const FROZEN_SOFFICE_BINARY =
  `${FROZEN_LIBREOFFICE_ROOT}/Contents/MacOS/soffice`;
const FROZEN_SOFFICE_SHA256 =
  "sha256:b4efedd0c18e62c5598ad55a2531756be5b4476bdc8e766c6b4210fa09dc1a91" as const;
const FROZEN_POPPLER_ROOT =
  "/Users/chenyifan/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler";
const FROZEN_PDFTOPPM_BINARY = `${FROZEN_POPPLER_ROOT}/bin/pdftoppm`;
const FROZEN_PDFTOPPM_SHA256 =
  "sha256:98ac4fedc4258b7125ad1048034c1448dccc58503614eb105f19d12cdb3a2d0d" as const;
const FROZEN_PDFINFO_BINARY = `${FROZEN_POPPLER_ROOT}/bin/pdfinfo`;
const FROZEN_PDFINFO_SHA256 =
  "sha256:c5d74274412ae6b98eb2a8e62f70c35e39d6b41539c1c684a561d1a6bc7ca720" as const;
const FROZEN_PDFFONTS_BINARY = `${FROZEN_POPPLER_ROOT}/bin/pdffonts`;
const FROZEN_PDFFONTS_SHA256 =
  "sha256:b364370b9f1f5faa9d598ebbb56d3c9a064a9964ec10b6e8f7ee8d709c3a15db" as const;
const FROZEN_PDFTOTEXT_BINARY = `${FROZEN_POPPLER_ROOT}/bin/pdftotext`;
const FROZEN_PDFTOTEXT_SHA256 =
  "sha256:facaa63884cd1071d5062476443613a9cadc4f0489cfd28da2e4e64c2f8dd4cb" as const;
const FROZEN_SANDBOX_EXEC_BINARY = "/usr/bin/sandbox-exec";
const FROZEN_SANDBOX_EXEC_SHA256 =
  "sha256:8290e4be7387a0df83cd1559e86afd880464f269450573d012795761fe298f16" as const;
const FROZEN_RENDERER_TOOLS = Object.freeze([
  Object.freeze({
    name: "soffice",
    path: FROZEN_SOFFICE_BINARY,
    hash: FROZEN_SOFFICE_SHA256,
  }),
  Object.freeze({
    name: "pdftoppm",
    path: FROZEN_PDFTOPPM_BINARY,
    hash: FROZEN_PDFTOPPM_SHA256,
  }),
  Object.freeze({
    name: "pdfinfo",
    path: FROZEN_PDFINFO_BINARY,
    hash: FROZEN_PDFINFO_SHA256,
  }),
  Object.freeze({
    name: "pdffonts",
    path: FROZEN_PDFFONTS_BINARY,
    hash: FROZEN_PDFFONTS_SHA256,
  }),
  Object.freeze({
    name: "pdftotext",
    path: FROZEN_PDFTOTEXT_BINARY,
    hash: FROZEN_PDFTOTEXT_SHA256,
  }),
  Object.freeze({
    name: "sandbox-exec",
    path: FROZEN_SANDBOX_EXEC_BINARY,
    hash: FROZEN_SANDBOX_EXEC_SHA256,
  }),
] as const);
const FROZEN_RENDERER_EXECUTABLE_HASH = sha256(
  JSON.stringify(
    FROZEN_RENDERER_TOOLS.map(({ name, path, hash }) => ({
      name,
      path,
      hash,
    })),
  ),
);

function assertFrozenRendererTools(): void {
  for (const tool of FROZEN_RENDERER_TOOLS) {
    const path = resolve(tool.path);
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      sha256(Uint8Array.from(readFileSync(path))) !== tool.hash
    ) {
      throw new Error(
        `Frozen Artifact renderer ${tool.name} executable hash is invalid`,
      );
    }
  }
}

async function readRegularFile(
  path: string,
  label: string,
): Promise<Uint8Array> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return Uint8Array.from(await readFile(path));
}

async function rendererContactSheet(
  slides: readonly { readonly content: Uint8Array }[],
): Promise<Uint8Array> {
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
  return Uint8Array.from(
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
}

async function runSandboxedRendererTool(
  executablePath: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly stdout: string }> {
  return await new Promise((resolveExecution, rejectExecution) => {
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
    ].join(" ");
    const child = spawn(
      FROZEN_SANDBOX_EXEC_BINARY,
      [
        "-p",
        profile,
        executablePath,
        ...args,
      ],
      {
        cwd,
        env: {
          HOME: cwd,
          TMPDIR: cwd,
          PATH: "/usr/bin:/bin",
          DYLD_FALLBACK_LIBRARY_PATH:
            `${FROZEN_POPPLER_ROOT}/lib`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        rejectExecution(error);
      }
    };
    const countOutput = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        rejectOnce(
          new Error("Frozen Artifact renderer output exceeded its limit"),
        );
      }
    };
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      countOutput(Buffer.from(chunk));
    });
    child.stderr!.on("data", countOutput);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOnce(
        new Error("Frozen Artifact renderer timed out"),
      );
    }, 5 * 60 * 1_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectOnce(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        if (!settled) {
          settled = true;
          resolveExecution({ stdout });
        }
      } else {
        rejectOnce(
          new Error(
            `Frozen Artifact renderer failed with code ${code ?? -1} signal ${signal ?? "none"}; output withheld`,
          ),
        );
      }
    });
  });
}

function assertArtifactRendererInput(artifact: Artifact): void {
  if (
    artifact.mimeType !==
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    artifact.pageCount !== 16 ||
    artifact.byteSize !== artifact.content.byteLength ||
    sha256(artifact.content) !== artifact.contentHash
  ) {
    throw new Error(
      "Production renderer requires one hash-bound 16-page PPTX Artifact",
    );
  }
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
  readonly renderer: ProductionRendererConfiguration;
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
  const rendererKeys = Object.keys(
    input.renderer as unknown as Record<string, unknown>,
  );
  const allowedRendererKeys = new Set([
    "rendererId",
    "slidesDirectory",
    "extractedTextPrefix",
    "fontPack",
    "resolution",
    "colorProfile",
    "fidelityNotes",
    "fixedRenderer",
  ]);
  if (rendererKeys.some((key) => !allowedRendererKeys.has(key))) {
    throw new Error(
      "Production renderer rejects caller-supplied executable identity or unknown configuration",
    );
  }
  if (
    input.renderer.fixedRenderer !== undefined &&
    (input.renderer.fixedRenderer !==
      "frozen-libreoffice-poppler-v1" ||
      input.renderer.rendererId !== FROZEN_ARTIFACT_RENDERER_ID)
  ) {
    throw new Error(
      "Production faithful rendering requires the source-reviewed frozen renderer identity",
    );
  }
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
    captureJournal: new FileSystemArtifactCaptureJournal({
      journalId:
        `production-capability-journal:${input.artifactPrimary.storeId}`,
      rootPath: join(input.checkpoint.rootPath, "artifact-capture-journal"),
    }),
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
  const fixedRendererExecutable =
    input.renderer.fixedRenderer === undefined
      ? null
      : (assertFrozenRendererTools(), FROZEN_RENDERER_EXECUTABLE_HASH);
  const rendererIdentity =
    fixedRendererExecutable === null
      ? input.renderer.rendererId
      : `${FROZEN_ARTIFACT_RENDERER_ID}:${fixedRendererExecutable}`;
  const safeRasterRenderer: SafeRasterRendererPort = Object.freeze({
    rendererId: rendererIdentity,
    async render({
      artifact,
      authorizationDecisionId,
    }: Parameters<SafeRasterRendererPort["render"]>[0]) {
      if (authorizationDecisionId.trim().length === 0) {
        throw new Error(
          "Harness-owned renderer requires an authorization decision",
        );
      }
      assertArtifactRendererInput(artifact);
      if (fixedRendererExecutable === null) {
        const artifactDirectory = join(
          resolve(input.renderer.slidesDirectory),
          artifact.contentHash.slice("sha256:".length),
        );
        const slides = Object.freeze(
          await Promise.all(
            Array.from({ length: 16 }, async (_, index) => {
              const pageNumber = index + 1;
              const filename =
                `slide-${String(pageNumber).padStart(2, "0")}.png`;
              let content: Uint8Array;
              try {
                content = await readRegularFile(
                  join(artifactDirectory, filename),
                  `Artifact-specific legacy slide ${pageNumber}`,
                );
              } catch (error) {
                throw new Error(
                  `Artifact-specific pre-rendered slides are unavailable for ${artifact.contentHash}`,
                  { cause: error },
                );
              }
              return Object.freeze({
                pageNumber,
                filename,
                mimeType: "image/png" as const,
                content,
                extractedText:
                  `${input.renderer.extractedTextPrefix} ${pageNumber}`,
              });
            }),
          ),
        );
        return Object.freeze({
          renderer: rendererIdentity,
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
          slides,
          contactSheet: {
            filename: "contact-sheet-4x4.png",
            mimeType: "image/png",
            content: await rendererContactSheet(slides),
          },
        } satisfies SafeRasterCandidate);
      }

      const invocationRoot = await mkdtemp(
        join(tmpdir(), "ppt-artifact-specific-render-"),
      );
      try {
        assertFrozenRendererTools();
        const inputPath = join(invocationRoot, "source.pptx");
        const outputPath = join(invocationRoot, "output");
        const profilePath = join(invocationRoot, "libreoffice-profile");
        await mkdir(outputPath, { mode: 0o700 });
        await mkdir(profilePath, { mode: 0o700 });
        await writeFile(inputPath, artifact.content, { mode: 0o600 });
        await runSandboxedRendererTool(
          FROZEN_SOFFICE_BINARY,
          [
            "--headless",
            "--nologo",
            "--nodefault",
            "--nofirststartwizard",
            `-env:UserInstallation=file://${profilePath}`,
            "--convert-to",
            "pdf",
            "--outdir",
            outputPath,
            inputPath,
          ],
          invocationRoot,
        );
        const retainedInput = await readRegularFile(
          inputPath,
          "Artifact-specific renderer input",
        );
        if (sha256(retainedInput) !== artifact.contentHash) {
          throw new Error(
            "Artifact-specific renderer mutated or replaced its PPTX input",
          );
        }
        const pdfPath = join(outputPath, "source.pdf");
        await readRegularFile(
          pdfPath,
          "Frozen Artifact renderer PDF",
        );
        const pdfInfo = await runSandboxedRendererTool(
          FROZEN_PDFINFO_BINARY,
          [pdfPath],
          invocationRoot,
        );
        const pageCount =
          Number(/^Pages:\s+(\d+)$/m.exec(pdfInfo.stdout)?.[1] ?? 0);
        const pageSize =
          /^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts$/m.exec(
            pdfInfo.stdout,
          );
        const pageWidth = Number(pageSize?.[1] ?? 0);
        const pageHeight = Number(pageSize?.[2] ?? 0);
        const pageGeometryVerified =
          pageCount === artifact.pageCount &&
          Number.isFinite(pageWidth) &&
          Number.isFinite(pageHeight) &&
          pageWidth > 0 &&
          pageHeight > 0 &&
          Math.abs(pageWidth / pageHeight - 16 / 9) < 0.001;
        const fontSubstitutions = await runSandboxedRendererTool(
          FROZEN_PDFFONTS_BINARY,
          ["-subst", pdfPath],
          invocationRoot,
        );
        const substitutionRows = fontSubstitutions.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(2);
        const noFontSubstitutions = substitutionRows.length === 0;
        const slides = Object.freeze(
          await Promise.all(
            Array.from({ length: 16 }, async (_, index) => {
              const pageNumber = index + 1;
              const stem =
                `slide-${String(pageNumber).padStart(2, "0")}`;
              await runSandboxedRendererTool(
                FROZEN_PDFTOPPM_BINARY,
                [
                  "-f",
                  String(pageNumber),
                  "-l",
                  String(pageNumber),
                  "-singlefile",
                  "-png",
                  "-scale-to-x",
                  "1920",
                  "-scale-to-y",
                  "1080",
                  pdfPath,
                  join(outputPath, stem),
                ],
                invocationRoot,
              );
              const content = await readRegularFile(
                join(outputPath, `${stem}.png`),
                `Artifact-specific rendered slide ${pageNumber}`,
              );
              const extracted = await runSandboxedRendererTool(
                FROZEN_PDFTOTEXT_BINARY,
                [
                  "-f",
                  String(pageNumber),
                  "-l",
                  String(pageNumber),
                  "-layout",
                  pdfPath,
                  "-",
                ],
                invocationRoot,
              );
              const extractedText =
                extracted.stdout.trim().length === 0
                  ? `[No extractable text detected on page ${pageNumber}]`
                  : extracted.stdout;
              const dimensions =
                await validatedSafePngDimensions(
                  content,
                  `Artifact-specific rendered slide ${pageNumber}`,
                );
              return Object.freeze({
                pageNumber,
                filename: `${stem}.png`,
                mimeType: "image/png" as const,
                content,
                extractedText,
                contentHash: sha256(content),
                dimensions,
              });
            }),
          ),
        );
        const fidelityVerified =
          pageGeometryVerified &&
          noFontSubstitutions &&
          slides.every(
            ({ dimensions }) =>
              dimensions.width === 1920 &&
              dimensions.height === 1080,
          );
        const publicSlides = Object.freeze(
          slides.map(
            ({
              contentHash: _contentHash,
              dimensions: _dimensions,
              ...slide
            }) => Object.freeze(slide),
          ),
        );
        return Object.freeze({
          renderer: rendererIdentity,
          fontPack:
            "libreoffice-pdffonts-no-substitution-audit:1",
          resolution: "1920x1080",
          colorProfile: "sRGB",
          renderOutcome: fidelityVerified
            ? "faithful"
            : "degraded",
          fidelity: fidelityVerified
            ? {
                status: "verified",
                notes: Object.freeze([
                  "Current Artifact hash, source-reviewed LibreOffice/Poppler executables, sandboxed offline conversion, 16-page PDF geometry, zero reported font substitutions, and 1920x1080 page rasters were verified.",
                ]),
              }
            : {
                status: "degraded",
                notes: Object.freeze([
                  "Frozen renderer fidelity proof was incomplete or reported font substitution; visual scoring is prohibited.",
                ]),
              },
          slides: publicSlides,
          contactSheet: {
            filename: "contact-sheet-4x4.png",
            mimeType: "image/png",
            content: await rendererContactSheet(publicSlides),
          },
        } satisfies SafeRasterCandidate);
      } finally {
        await rm(invocationRoot, { recursive: true, force: true });
      }
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
      rendererId: rendererIdentity,
      rendererExecutableHash:
        fixedRendererExecutable,
      captureJournal: Object.freeze({
        journalId:
          `production-capability-journal:${input.artifactPrimary.storeId}`,
        rootReference:
          `${input.checkpoint.rootReference}:artifact-capture-journal`,
      }),
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
