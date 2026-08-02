import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface DurableRootRegistryEntry {
  readonly rootReference: string;
  readonly absolutePath: string;
  readonly backendType: "local-filesystem";
  readonly deviceIdentity: `fs-device:sha256:${string}`;
  readonly deviceId: string;
  readonly inodeId: string;
  readonly ownerUid: number;
  readonly mode: number;
}

export interface DurableRootRegistry {
  readonly schemaVersion: "durable-root-registry-v2";
  readonly registryId: string;
  readonly roots: readonly DurableRootRegistryEntry[];
  readonly registryHash: `sha256:${string}`;
}

const controlledDataRoot = join(
  homedir(),
  ".local",
  "share",
  "ppt-evaluation-harness",
);

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function safeIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(value)) {
    throw new Error(`Durable root registry ${label} is invalid`);
  }
}

function registryPath(registryId: string): string {
  safeIdentifier(registryId, "registryId");
  return join(
    controlledDataRoot,
    "root-registries",
    `${registryId}.json`,
  );
}

function canonicalRegistryPayload(input: {
  readonly registryId: string;
  readonly roots: readonly DurableRootRegistryEntry[];
}): string {
  return JSON.stringify({
    schemaVersion: "durable-root-registry-v2",
    registryId: input.registryId,
    roots: [...input.roots]
      .sort((left, right) =>
        left.rootReference.localeCompare(right.rootReference),
      )
      .map((entry) => ({
        rootReference: entry.rootReference,
        absolutePath: entry.absolutePath,
        backendType: entry.backendType,
        deviceIdentity: entry.deviceIdentity,
        deviceId: entry.deviceId,
        inodeId: entry.inodeId,
        ownerUid: entry.ownerUid,
        mode: entry.mode,
      })),
  });
}

function errorCode(error: unknown): string | null {
  return error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function assertSecureRootOwnership(input: {
  readonly uid: number;
  readonly mode: number;
}): void {
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : null;
  if (currentUid === null || input.uid !== currentUid) {
    throw new Error(
      "Durable root registry root must be owned by the current user",
    );
  }
  if ((input.mode & 0o022) !== 0) {
    throw new Error(
      "Durable root registry root must not be group/other writable",
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function attestRoot(input: {
  readonly rootReference: string;
  readonly absolutePath: string;
}): Promise<DurableRootRegistryEntry> {
  safeIdentifier(input.rootReference, "rootReference");
  const requestedPath = resolve(input.absolutePath);
  if (!isAbsolute(input.absolutePath) || requestedPath === sep) {
    throw new Error(
      "Durable root registry requires narrow absolute paths",
    );
  }
  await mkdir(requestedPath, { recursive: true, mode: 0o700 });
  const requestedMetadata = await lstat(requestedPath);
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(
      "Durable root registry rejects a symbolic link root",
    );
  }
  if (!requestedMetadata.isDirectory()) {
    throw new Error("Durable root registry root is not a directory");
  }
  const canonicalPath = await realpath(requestedPath);
  const metadata = await lstat(canonicalPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== requestedMetadata.dev ||
    metadata.ino !== requestedMetadata.ino
  ) {
    throw new Error(
      "Durable root registry root identity changed during attestation",
    );
  }
  assertSecureRootOwnership(metadata);
  return Object.freeze({
    rootReference: input.rootReference,
    absolutePath: canonicalPath,
    backendType: "local-filesystem" as const,
    deviceIdentity:
      `fs-device:${sha256(String(metadata.dev))}` as const,
    deviceId: String(metadata.dev),
    inodeId: String(metadata.ino),
    ownerUid: metadata.uid,
    mode: metadata.mode,
  });
}

function assertRegistryEntryShape(
  entry: DurableRootRegistryEntry,
): void {
  const keys = Object.keys(entry).sort();
  const expectedKeys = [
    "absolutePath",
    "backendType",
    "deviceId",
    "deviceIdentity",
    "inodeId",
    "mode",
    "ownerUid",
    "rootReference",
  ].sort();
  safeIdentifier(entry.rootReference, "rootReference");
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    !isAbsolute(entry.absolutePath) ||
    resolve(entry.absolutePath) === sep ||
    entry.backendType !== "local-filesystem" ||
    !/^fs-device:sha256:[a-f0-9]{64}$/.test(entry.deviceIdentity) ||
    !/^\d+$/.test(entry.deviceId) ||
    !/^\d+$/.test(entry.inodeId) ||
    !Number.isSafeInteger(entry.ownerUid) ||
    !Number.isSafeInteger(entry.mode)
  ) {
    throw new Error("Durable root registry entry is invalid");
  }
}

async function assertRegistryFileIsRegular(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      "Durable root registry identity sidecar is not a regular file",
    );
  }
  assertSecureRootOwnership(metadata);
}

async function readRegistryPayload(path: string): Promise<string> {
  await assertRegistryFileIsRegular(path);
  const before = await lstat(path);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error(
      "Durable root registry identity sidecar changed during read",
      { cause: error },
    );
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.uid !== opened.uid ||
      before.mode !== opened.mode
    ) {
      throw new Error(
        "Durable root registry identity sidecar changed during read",
      );
    }
    const payload = (await handle.readFile("utf8")).trim();
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid ||
      before.mode !== after.mode
    ) {
      throw new Error(
        "Durable root registry identity sidecar changed during read",
      );
    }
    return payload;
  } finally {
    await handle.close();
  }
}

export async function registerDurableRoots(input: {
  readonly registryId: string;
  readonly roots: readonly {
    readonly rootReference: string;
    readonly absolutePath: string;
  }[];
}): Promise<DurableRootRegistry> {
  safeIdentifier(input.registryId, "registryId");
  if (
    input.roots.length === 0 ||
    new Set(input.roots.map(({ rootReference }) => rootReference))
      .size !== input.roots.length
  ) {
    throw new Error("Durable root registry roots are invalid");
  }
  const roots = await Promise.all(input.roots.map(attestRoot));
  if (
    new Set(roots.map(({ deviceId, inodeId }) => `${deviceId}:${inodeId}`))
      .size !== roots.length
  ) {
    throw new Error(
      "Durable root registry roots require distinct filesystem identities",
    );
  }
  const payload = canonicalRegistryPayload({
    registryId: input.registryId,
    roots,
  });
  const registry: DurableRootRegistry = Object.freeze({
    ...JSON.parse(payload),
    registryHash: sha256(payload),
  });
  const path = registryPath(input.registryId);
  const registryDirectory = dirname(path);
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    registryDirectory,
    `.${input.registryId}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${payload}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
    await syncDirectory(registryDirectory);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    const existingPayload = await readRegistryPayload(path);
    let existingSchemaVersion: unknown;
    try {
      existingSchemaVersion = (
        JSON.parse(existingPayload) as { readonly schemaVersion?: unknown }
      ).schemaVersion;
    } catch {
      throw new Error("Durable root registry payload is invalid");
    }
    if (existingSchemaVersion === "durable-root-registry-v1") {
      throw new Error(
        "Legacy durable-root-registry-v1 requires explicit migration",
      );
    }
    if (existingPayload !== payload) {
      throw new Error(
        "Durable root registry already maps different roots",
      );
    }
  } finally {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true });
      await syncDirectory(registryDirectory);
    }
  }
  return registry;
}

export async function loadDurableRootRegistry(
  registryId: string,
): Promise<DurableRootRegistry> {
  const path = registryPath(registryId);
  const payload = await readRegistryPayload(path);
  const parsed = JSON.parse(payload) as {
    readonly schemaVersion?: unknown;
    readonly registryId?: unknown;
    readonly roots?: unknown;
  };
  if (parsed.schemaVersion === "durable-root-registry-v1") {
    throw new Error(
      "Legacy durable-root-registry-v1 requires explicit migration",
    );
  }
  if (
    parsed.schemaVersion !== "durable-root-registry-v2" ||
    parsed.registryId !== registryId ||
    !Array.isArray(parsed.roots)
  ) {
    throw new Error("Durable root registry payload is invalid");
  }
  const roots = parsed.roots as DurableRootRegistryEntry[];
  if (
    roots.length === 0 ||
    new Set(roots.map(({ rootReference }) => rootReference)).size !==
      roots.length
  ) {
    throw new Error("Durable root registry roots are invalid");
  }
  roots.forEach(assertRegistryEntryShape);
  const canonical = canonicalRegistryPayload({ registryId, roots });
  if (canonical !== payload) {
    throw new Error("Durable root registry is not canonical");
  }
  for (const entry of roots) {
    const requestedMetadata = await lstat(entry.absolutePath);
    if (
      requestedMetadata.isSymbolicLink() ||
      !requestedMetadata.isDirectory()
    ) {
      throw new Error("Durable root registry root identity changed");
    }
    const canonicalPath = await realpath(entry.absolutePath);
    const metadata = await lstat(canonicalPath);
    assertSecureRootOwnership(metadata);
    if (
      entry.backendType !== "local-filesystem" ||
      canonicalPath !== entry.absolutePath ||
      entry.deviceIdentity !==
        `fs-device:${sha256(String(metadata.dev))}` ||
      entry.deviceId !== String(metadata.dev) ||
      entry.inodeId !== String(metadata.ino) ||
      entry.ownerUid !== metadata.uid ||
      entry.mode !== metadata.mode ||
      requestedMetadata.dev !== metadata.dev ||
      requestedMetadata.ino !== metadata.ino
    ) {
      throw new Error(
        "Durable root registry root identity changed",
      );
    }
  }
  if (
    new Set(roots.map(({ deviceId, inodeId }) => `${deviceId}:${inodeId}`))
      .size !== roots.length
  ) {
    throw new Error(
      "Durable root registry roots require distinct filesystem identities",
    );
  }
  return Object.freeze({
    schemaVersion: "durable-root-registry-v2",
    registryId,
    roots: Object.freeze(
      roots.map((entry) => Object.freeze({ ...entry })),
    ),
    registryHash: sha256(payload),
  });
}

export function resolveDurableRoot(
  registry: DurableRootRegistry,
  rootReference: string,
): string {
  const entry = registry.roots.find(
    (candidate) => candidate.rootReference === rootReference,
  );
  if (entry === undefined) {
    throw new Error(
      `Durable root registry has no mapping for ${rootReference}`,
    );
  }
  return entry.absolutePath;
}

export function retainedRehearsalRoot(registryId: string): string {
  safeIdentifier(registryId, "registryId");
  return join(controlledDataRoot, "rehearsals", registryId);
}
