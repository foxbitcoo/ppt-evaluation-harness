import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface DurableRootRegistryEntry {
  readonly rootReference: string;
  readonly absolutePath: string;
  readonly backendType: "local-filesystem";
  readonly deviceIdentity: `fs-device:sha256:${string}`;
}

export interface DurableRootRegistry {
  readonly schemaVersion: "durable-root-registry-v1";
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
    schemaVersion: "durable-root-registry-v1",
    registryId: input.registryId,
    roots: [...input.roots].sort((left, right) =>
      left.rootReference.localeCompare(right.rootReference),
    ),
  });
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
  const roots = await Promise.all(
    input.roots.map(async ({ rootReference, absolutePath }) => {
      safeIdentifier(rootReference, "rootReference");
      if (!isAbsolute(absolutePath) || resolve(absolutePath) === sep) {
        throw new Error(
          "Durable root registry requires narrow absolute paths",
        );
      }
      await mkdir(absolutePath, { recursive: true, mode: 0o700 });
      const canonicalPath = await realpath(absolutePath);
      const metadata = await stat(canonicalPath);
      return Object.freeze({
        rootReference,
        absolutePath: canonicalPath,
        backendType: "local-filesystem" as const,
        deviceIdentity:
          `fs-device:${sha256(String(metadata.dev))}` as const,
      });
    }),
  );
  const payload = canonicalRegistryPayload({
    registryId: input.registryId,
    roots,
  });
  const registry: DurableRootRegistry = Object.freeze({
    ...JSON.parse(payload),
    registryHash: sha256(payload),
  });
  const path = registryPath(input.registryId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${payload}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    const existingPayload = (
      await readFile(path, "utf8")
    ).trim();
    if (existingPayload !== payload) {
      throw new Error(
        "Durable root registry already maps different roots",
      );
    }
  }
  return registry;
}

export async function loadDurableRootRegistry(
  registryId: string,
): Promise<DurableRootRegistry> {
  const payload = (await readFile(registryPath(registryId), "utf8")).trim();
  const parsed = JSON.parse(payload) as {
    readonly schemaVersion?: unknown;
    readonly registryId?: unknown;
    readonly roots?: unknown;
  };
  if (
    parsed.schemaVersion !== "durable-root-registry-v1" ||
    parsed.registryId !== registryId ||
    !Array.isArray(parsed.roots)
  ) {
    throw new Error("Durable root registry payload is invalid");
  }
  const roots = parsed.roots as DurableRootRegistryEntry[];
  const canonical = canonicalRegistryPayload({ registryId, roots });
  if (canonical !== payload) {
    throw new Error("Durable root registry is not canonical");
  }
  for (const entry of roots) {
    const metadata = await stat(entry.absolutePath);
    if (
      entry.backendType !== "local-filesystem" ||
      entry.deviceIdentity !==
        `fs-device:${sha256(String(metadata.dev))}`
    ) {
      throw new Error(
        "Durable root registry backend attestation changed",
      );
    }
  }
  return Object.freeze({
    schemaVersion: "durable-root-registry-v1",
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
