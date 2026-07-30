import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

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
import { parseStrictJson } from "./strict-json.ts";

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
  readonly nativeFrozenEvidenceDirectory?: string;
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
const FROZEN_RENDERER_ENTRYPOINT_MANIFEST_HASH = sha256(
  JSON.stringify(
    FROZEN_RENDERER_TOOLS.map(({ name, path, hash }) => ({
      name,
      path,
      hash,
    })),
  ),
);
const FROZEN_RENDERER_BUNDLE_ROOTS = Object.freeze([
  Object.freeze({
    label: "libreoffice",
    rootPath: FROZEN_LIBREOFFICE_ROOT,
  }),
  Object.freeze({
    label: "poppler",
    rootPath: FROZEN_POPPLER_ROOT,
  }),
  Object.freeze({
    label: "system-fonts",
    rootPath: "/System/Library/Fonts",
  }),
  Object.freeze({
    label: "local-fonts",
    rootPath: "/Library/Fonts",
  }),
  Object.freeze({
    label: "user-fonts",
    rootPath: resolve(
      process.env.HOME ?? "/nonexistent-home",
      "Library/Fonts",
    ),
  }),
  Object.freeze({
    label: "system-color-profiles",
    rootPath: "/System/Library/ColorSync/Profiles",
  }),
  Object.freeze({
    label: "local-color-profiles",
    rootPath: "/Library/ColorSync/Profiles",
  }),
] as const);
const FROZEN_RENDERER_BUNDLE_SHA256 =
  "sha256:4e5ea60511a1d9f11c5bbfd796f634c672d5ec6af23408a43e0a9b7a591d9fdc" as `sha256:${string}`;
const SYSTEM_VERSION_MANIFEST =
  "/System/Library/CoreServices/SystemVersion.plist";
const SYSTEM_DYLD_EXECUTABLE = "/usr/lib/dyld";
const SYSTEM_DYLD_CACHE_ROOT =
  "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld";

export interface RendererSystemRuntimeAttestation {
  readonly platform: string;
  readonly architecture: string;
  readonly osBuildManifestHash: `sha256:${string}`;
  readonly dyldExecutableCodeDirectoryHash: `sha256:${string}`;
  readonly dyldSharedCacheCodeDirectoryHashes: readonly `sha256:${string}`[];
  readonly systemRuntimeClosureHash: `sha256:${string}`;
}

function rendererSystemRuntimeAttestationDigest(
  attestation: RendererSystemRuntimeAttestation,
): `sha256:${string}` {
  return sha256(
    JSON.stringify({
      schemaVersion: "renderer-system-runtime-attestation-v1",
      platform: attestation.platform,
      architecture: attestation.architecture,
      osBuildManifestHash: attestation.osBuildManifestHash,
      dyldExecutableCodeDirectoryHash:
        attestation.dyldExecutableCodeDirectoryHash,
      dyldSharedCacheCodeDirectoryHashes: [
        ...attestation.dyldSharedCacheCodeDirectoryHashes,
      ].sort(),
      systemRuntimeClosureHash:
        attestation.systemRuntimeClosureHash,
    }),
  );
}

export function rendererSystemRuntimeAttestationDigestForTest(
  attestation: RendererSystemRuntimeAttestation,
): `sha256:${string}` {
  return rendererSystemRuntimeAttestationDigest(attestation);
}

function codeDirectoryHash(path: string): `sha256:${string}` {
  const resolvedPath = resolve(path);
  const verified = spawnSync(
    "/usr/bin/codesign",
    [
      "--verify",
      "--strict",
      "--all-architectures",
      "--verbose=2",
      resolvedPath,
    ],
    { encoding: "utf8" },
  );
  if (verified.status !== 0) {
    throw new Error(
      `Frozen Artifact renderer system runtime actual bytes failed strict signature verification for ${path}`,
    );
  }
  const inspected = spawnSync(
    "/usr/bin/codesign",
    ["-dvvv", resolvedPath],
    { encoding: "utf8" },
  );
  const output = `${inspected.stdout ?? ""}\n${inspected.stderr ?? ""}`;
  const match =
    /^CandidateCDHashFull sha256=([a-f0-9]{64})$/m.exec(output);
  if (inspected.status !== 0 || match?.[1] === undefined) {
    throw new Error(
      `Frozen Artifact renderer cannot attest system code directory ${path}`,
    );
  }
  return `sha256:${match[1]}`;
}

export function rendererVerifiedCodeDirectoryHashForTest(
  path: string,
): `sha256:${string}` {
  return codeDirectoryHash(path);
}

function currentRendererSystemRuntimeAttestation():
  RendererSystemRuntimeAttestation {
  if (platform() !== "darwin") {
    throw new Error(
      "Frozen Artifact renderer requires an attested macOS runtime",
    );
  }
  const architecture = arch();
  const cachePrefix =
    architecture === "arm64"
      ? "dyld_shared_cache_arm64e"
      : `dyld_shared_cache_${architecture}`;
  const cacheHashes = readdirSync(SYSTEM_DYLD_CACHE_ROOT)
    .filter(
      (name) =>
        name === cachePrefix ||
        (name.startsWith(`${cachePrefix}.`) &&
          !name.endsWith(".map") &&
          !name.endsWith(".atlas")),
    )
    .sort()
    .map((name) =>
      sha256(
        JSON.stringify({
          name,
          byteSize: statSync(
            join(SYSTEM_DYLD_CACHE_ROOT, name),
          ).size,
          codeDirectoryHash: codeDirectoryHash(
            join(SYSTEM_DYLD_CACHE_ROOT, name),
          ),
        }),
      ),
    );
  if (cacheHashes.length === 0) {
    throw new Error(
      "Frozen Artifact renderer cannot attest the dyld shared cache",
    );
  }
  return Object.freeze({
    platform: platform(),
    architecture,
    osBuildManifestHash: sha256(
      Uint8Array.from(readFileSync(SYSTEM_VERSION_MANIFEST)),
    ),
    dyldExecutableCodeDirectoryHash:
      codeDirectoryHash(SYSTEM_DYLD_EXECUTABLE),
    dyldSharedCacheCodeDirectoryHashes:
      Object.freeze(cacheHashes),
    systemRuntimeClosureHash: sha256(
      JSON.stringify({
        dyldExecutableCodeDirectoryHash:
          codeDirectoryHash(SYSTEM_DYLD_EXECUTABLE),
        dyldSharedCacheCodeDirectoryHashes: cacheHashes,
      }),
    ),
  });
}

function frozenRendererExecutableHash(
  runtimeAttestationDigest: `sha256:${string}`,
): `sha256:${string}` {
  return sha256(
    JSON.stringify({
      entrypointManifestHash:
        FROZEN_RENDERER_ENTRYPOINT_MANIFEST_HASH,
      bundleClosureHash: FROZEN_RENDERER_BUNDLE_SHA256,
      runtimeAttestationDigest,
    }),
  );
}

interface RendererBundleRoot {
  readonly label: string;
  readonly rootPath: string;
}

function rendererBundleClosureDigest(
  roots: readonly RendererBundleRoot[],
): `sha256:${string}` {
  const entries: {
    readonly path: string;
    readonly kind: "directory" | "file" | "symlink";
    readonly mode: number;
    readonly contentHash?: `sha256:${string}`;
    readonly target?: string;
  }[] = [];
  const visit = (
    rootLabel: string,
    rootPath: string,
    currentPath: string,
  ): void => {
    const metadata = lstatSync(currentPath);
    const relativePath = relative(rootPath, currentPath);
    const path =
      relativePath.length === 0
        ? rootLabel
        : `${rootLabel}/${relativePath}`;
    const mode = metadata.mode & 0o777;
    if (metadata.isSymbolicLink()) {
      entries.push({
        path,
        kind: "symlink",
        mode,
        target: readlinkSync(currentPath),
      });
      return;
    }
    if (metadata.isDirectory()) {
      entries.push({ path, kind: "directory", mode });
      for (const name of readdirSync(currentPath).sort()) {
        visit(rootLabel, rootPath, join(currentPath, name));
      }
      return;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `Frozen renderer bundle contains unsupported entry ${path}`,
      );
    }
    entries.push({
      path,
      kind: "file",
      mode,
      contentHash: sha256(
        Uint8Array.from(readFileSync(currentPath)),
      ),
    });
  };
  for (const { label, rootPath } of roots) {
    const root = resolve(rootPath);
    visit(label, root, root);
  }
  return sha256(
    JSON.stringify(
      entries.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    ),
  );
}

export function rendererBundleClosureDigestForTest(
  roots: readonly RendererBundleRoot[],
): `sha256:${string}` {
  return rendererBundleClosureDigest(roots);
}

function seatbeltLiteral(path: string): string {
  return JSON.stringify(resolve(path));
}

function frozenRendererSandboxProfile(input: {
  readonly invocationRoot: string;
  readonly executablePath: string;
}): string {
  const invocationRoot = realpathSync(resolve(input.invocationRoot));
  const executablePath = realpathSync(resolve(input.executablePath));
  const libreOfficeRoot = realpathSync(FROZEN_LIBREOFFICE_ROOT);
  const processExecFilters = [
    `(literal ${seatbeltLiteral(executablePath)})`,
    ...(executablePath.startsWith(`${libreOfficeRoot}/`)
      ? [`(subpath ${seatbeltLiteral(libreOfficeRoot)})`]
      : []),
  ];
  const readableRoots = [
    invocationRoot,
    FROZEN_LIBREOFFICE_ROOT,
    FROZEN_POPPLER_ROOT,
    "/usr/lib",
    "/System/Library/Frameworks",
    "/System/Library/PrivateFrameworks",
    "/System/Library/CoreServices",
    "/System/Library/Fonts",
    "/System/Library/ColorSync/Profiles",
    "/Library/Fonts",
    "/Library/ColorSync/Profiles",
    SYSTEM_DYLD_CACHE_ROOT,
    "/usr/share/locale",
    resolve(process.env.HOME ?? "/nonexistent-home", "Library/Fonts"),
  ];
  const runtimeDirectoryLiterals = [
    "/",
    "/System",
    "/System/Volumes",
    "/System/Volumes/Preboot",
    "/System/Volumes/Preboot/Cryptexes",
    "/System/Volumes/Preboot/Cryptexes/OS",
    "/System/Volumes/Preboot/Cryptexes/OS/System",
    "/System/Volumes/Preboot/Cryptexes/OS/System/Library",
  ];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-info*)",
    "(allow process-fork)",
    "(allow sysctl*)",
    "(allow signal (target self))",
    "(allow mach*)",
    "(allow ipc*)",
    `(allow process-exec ${processExecFilters.join(" ")})`,
    "(allow file-read-metadata)",
    `(allow file-read* ${readableRoots
      .map((root) => `(subpath ${seatbeltLiteral(root)})`)
      .join(" ")} ${runtimeDirectoryLiterals
      .map((root) => `(literal ${seatbeltLiteral(root)})`)
      .join(" ")} (literal ${seatbeltLiteral(executablePath)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/etc/localtime"))`,
    `(allow file-write* (subpath ${seatbeltLiteral(invocationRoot)}) (literal "/dev/null"))`,
  ].join(" ");
}

export function frozenRendererSandboxProfileForTest(input: {
  readonly invocationRoot: string;
  readonly executablePath: string;
}): string {
  return frozenRendererSandboxProfile(input);
}

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
  if (
    rendererBundleClosureDigest(
      FROZEN_RENDERER_BUNDLE_ROOTS,
    ) !== FROZEN_RENDERER_BUNDLE_SHA256
  ) {
    throw new Error(
      "Frozen Artifact renderer bundle dependency closure hash is invalid",
    );
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

interface NativeFrozenCaptureReceipt {
  readonly captureId: string;
  readonly artifactContentHash: `sha256:${string}`;
  readonly nativeToolIdentity: string;
  readonly pageContentHashes: readonly `sha256:${string}`[];
  readonly surfaceContractDigest: `sha256:${string}`;
}

const HARNESS_OWNED_NATIVE_FROZEN_CAPTURE_RECEIPTS = new Map<
  string,
  NativeFrozenCaptureReceipt
>();

const NATIVE_FROZEN_SURFACE_CONTRACT = Object.freeze({
  animationFramePolicy: "completion_state",
  colorProfile: "sRGB",
  cropPolicy: "native_completion_view",
  resolution: "1920x1080",
  schemaVersion: "native-frozen-render-evidence-v1",
  surfaceClass: "native_frozen",
  viewport: "1920x1080",
});
const NATIVE_FROZEN_SURFACE_CONTRACT_DIGEST = sha256(
  JSON.stringify(NATIVE_FROZEN_SURFACE_CONTRACT),
);

async function verifyNativeFrozenEvidence(input: {
  readonly evidenceRoot: string | undefined;
  readonly artifact: Artifact;
  readonly slides: readonly {
    readonly pageNumber: number;
    readonly content: Uint8Array;
    readonly contentHash: `sha256:${string}`;
    readonly dimensions: {
      readonly width: number;
      readonly height: number;
    };
  }[];
}): Promise<{
  readonly verified: boolean;
  readonly evidenceHash: `sha256:${string}` | null;
}> {
  if (input.evidenceRoot === undefined) {
    return Object.freeze({
      verified: false,
      evidenceHash: null,
    });
  }
  const root = resolve(input.evidenceRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(
      "Native-frozen evidence root must be a non-symlink directory",
    );
  }
  const evidenceDirectory = join(
    root,
    input.artifact.contentHash.slice("sha256:".length),
  );
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(evidenceDirectory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return Object.freeze({
        verified: false,
        evidenceHash: null,
      });
    }
    throw error;
  }
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink()
  ) {
    throw new Error(
      "Native-frozen evidence directory must be content-addressed and non-symlink",
    );
  }
  const manifestBytes = await readRegularFile(
    join(evidenceDirectory, "manifest.json"),
    "Native-frozen evidence manifest",
  );
  const parsed = parseStrictJson(
    new TextDecoder().decode(manifestBytes),
    "native-frozen evidence manifest",
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "Native-frozen evidence manifest must be an object",
    );
  }
  const manifest = parsed as Record<string, unknown>;
  const expectedKeys = [
    "animationFramePolicy",
    "artifactContentHash",
    "captureId",
    "colorProfile",
    "cropPolicy",
    "nativeToolIdentity",
    "resolution",
    "schemaVersion",
    "slides",
    "surfaceClass",
    "viewport",
  ];
  if (
    Object.keys(manifest).sort().join("\n") !==
      expectedKeys.sort().join("\n") ||
    manifest.schemaVersion !==
      "native-frozen-render-evidence-v1" ||
    manifest.artifactContentHash !== input.artifact.contentHash ||
    manifest.surfaceClass !== "native_frozen" ||
    manifest.viewport !== "1920x1080" ||
    manifest.resolution !== "1920x1080" ||
    manifest.colorProfile !== "sRGB" ||
    manifest.cropPolicy !== "native_completion_view" ||
    manifest.animationFramePolicy !== "completion_state" ||
    typeof manifest.captureId !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(manifest.captureId) ||
    typeof manifest.nativeToolIdentity !== "string" ||
    !/^[a-z0-9][a-z0-9._:@/+-]{2,255}$/i.test(
      manifest.nativeToolIdentity,
    ) ||
    !Array.isArray(manifest.slides) ||
    manifest.slides.length !== input.slides.length
  ) {
    throw new Error(
      "Native-frozen evidence manifest does not match the canonical render contract",
    );
  }
  const pageContentHashes: `sha256:${string}`[] = [];
  for (const [index, canonical] of input.slides.entries()) {
    const candidate = manifest.slides[index];
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error(
        "Native-frozen evidence slide entry is invalid",
      );
    }
    const slide = candidate as Record<string, unknown>;
    const expectedFilename =
      `native-slide-${String(index + 1).padStart(2, "0")}.png`;
    if (
      Object.keys(slide).sort().join("\n") !==
        ["contentHash", "filename", "pageNumber"].join("\n") ||
      slide.pageNumber !== index + 1 ||
      slide.filename !== expectedFilename ||
      typeof slide.contentHash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(slide.contentHash)
    ) {
      throw new Error(
        "Native-frozen evidence slide lineage is invalid",
      );
    }
    const content = await readRegularFile(
      join(evidenceDirectory, expectedFilename),
      `Native-frozen evidence slide ${index + 1}`,
    );
    const contentHash = sha256(content);
    const dimensions = await validatedSafePngDimensions(
      content,
      `Native-frozen evidence slide ${index + 1}`,
    );
    if (
      contentHash !== slide.contentHash ||
      contentHash !== canonical.contentHash ||
      canonical.pageNumber !== index + 1 ||
      canonical.dimensions.width !== 1920 ||
      canonical.dimensions.height !== 1080 ||
      dimensions.width !== 1920 ||
      dimensions.height !== 1080
    ) {
      throw new Error(
        "Native-frozen evidence content hash or visual surface does not match the canonical render",
      );
    }
    pageContentHashes.push(contentHash);
  }
  const receipt =
    HARNESS_OWNED_NATIVE_FROZEN_CAPTURE_RECEIPTS.get(
      manifest.captureId,
    );
  if (receipt === undefined) {
    return Object.freeze({
      verified: false,
      evidenceHash: null,
    });
  }
  if (
    receipt.artifactContentHash !== input.artifact.contentHash ||
    receipt.nativeToolIdentity !== manifest.nativeToolIdentity ||
    receipt.surfaceContractDigest !==
      NATIVE_FROZEN_SURFACE_CONTRACT_DIGEST ||
    receipt.pageContentHashes.length !==
      pageContentHashes.length ||
    receipt.pageContentHashes.some(
      (contentHash, index) =>
        contentHash !== pageContentHashes[index],
    )
  ) {
    throw new Error(
      "Native-frozen evidence does not match its harness-owned capture receipt",
    );
  }
  return Object.freeze({
    verified: true,
    evidenceHash: sha256(manifestBytes),
  });
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
    const profile = frozenRendererSandboxProfile({
      invocationRoot: cwd,
      executablePath,
    });
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
            `Frozen Artifact renderer ${basename(executablePath)} failed with code ${code ?? -1} signal ${signal ?? "none"}; output withheld`,
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
    "nativeFrozenEvidenceDirectory",
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
  const fixedRendererRuntimeAttestation =
    input.renderer.fixedRenderer === undefined
      ? null
      : rendererSystemRuntimeAttestationDigest(
          currentRendererSystemRuntimeAttestation(),
        );
  const fixedRendererExecutable =
    fixedRendererRuntimeAttestation === null
      ? null
      : (
          assertFrozenRendererTools(),
          frozenRendererExecutableHash(
            fixedRendererRuntimeAttestation,
          )
        );
  let nativeFrozenEvidenceRoot: string | undefined;
  if (input.renderer.nativeFrozenEvidenceDirectory !== undefined) {
    mkdirSync(
      resolve(input.renderer.nativeFrozenEvidenceDirectory),
      { recursive: true, mode: 0o700 },
    );
    const requestedRoot = resolve(
      input.renderer.nativeFrozenEvidenceDirectory,
    );
    const metadata = lstatSync(requestedRoot);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined &&
        metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error(
        "Native-frozen evidence root must be a harness-owned private directory",
      );
    }
    nativeFrozenEvidenceRoot = realpathSync(requestedRoot);
  }
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

      const invocationRoot = await realpath(
        await mkdtemp(
          join(tmpdir(), "ppt-artifact-specific-render-"),
        ),
      );
      try {
        assertFrozenRendererTools();
        if (
          rendererSystemRuntimeAttestationDigest(
            currentRendererSystemRuntimeAttestation(),
          ) !== fixedRendererRuntimeAttestation
        ) {
          throw new Error(
            "Frozen Artifact renderer system runtime attestation drifted after capability creation",
          );
        }
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
        const canonicalStructuralChecksVerified =
          pageGeometryVerified &&
          noFontSubstitutions &&
          slides.every(
            ({ dimensions }) =>
              dimensions.width === 1920 &&
              dimensions.height === 1080,
          );
        const nativeFrozenEvidence =
          await verifyNativeFrozenEvidence({
            evidenceRoot:
              nativeFrozenEvidenceRoot,
            artifact,
            slides,
          });
        const nativeFrozenEvidenceVerified =
          nativeFrozenEvidence.verified;
        const fidelityVerified =
          canonicalStructuralChecksVerified &&
          nativeFrozenEvidenceVerified;
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
                  `Current Artifact hash, complete renderer bundle closure, sandboxed offline conversion, 16-page PDF geometry, zero reported font substitutions, 1920x1080 page rasters, and byte-identical native-frozen evidence ${nativeFrozenEvidence.evidenceHash} were verified.`,
                ]),
              }
            : {
                status: "degraded",
                notes: Object.freeze([
                  "Frozen renderer structural checks are insufficient without byte-identical content-addressed native-frozen evidence; visual scoring is prohibited.",
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
