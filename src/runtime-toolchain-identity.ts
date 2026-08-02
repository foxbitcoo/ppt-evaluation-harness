import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeToolchainRoot {
  readonly label: string;
  readonly path: string;
}

export interface RuntimeToolchainArchiveEntry {
  readonly path: string;
  readonly contentHash: `sha256:${string}`;
}

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function entryHash(path: string): `sha256:${string}` {
  const metadata = lstatSync(path);
  const mode = metadata.mode & 0o777;
  if (metadata.isSymbolicLink()) {
    return sha256(
      JSON.stringify({ kind: "symlink", mode, target: readlinkSync(path) }),
    );
  }
  if (metadata.isDirectory()) {
    return sha256(JSON.stringify({ kind: "directory", mode }));
  }
  if (!metadata.isFile()) {
    throw new Error("Runtime toolchain contains an unsupported file kind");
  }
  return sha256(
    Buffer.concat([
      Buffer.from(`${JSON.stringify({ kind: "file", mode })}\n`),
      readFileSync(path),
    ]),
  );
}

export function runtimeToolchainArchiveEntries(
  roots: readonly RuntimeToolchainRoot[],
): readonly RuntimeToolchainArchiveEntry[] {
  const entries: RuntimeToolchainArchiveEntry[] = [];
  const visit = (
    label: string,
    rootPath: string,
    currentPath: string,
  ): void => {
    const metadata = lstatSync(currentPath);
    const childPath = relative(rootPath, currentPath);
    entries.push({
      path:
        childPath.length === 0
          ? `$runtime/${label}`
          : `$runtime/${label}/${childPath}`,
      contentHash: entryHash(currentPath),
    });
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const child of readdirSync(currentPath).sort()) {
        visit(label, rootPath, resolve(currentPath, child));
      }
    }
  };
  for (const root of roots) {
    const rootPath = resolve(root.path);
    visit(root.label, rootPath, rootPath);
  }
  return Object.freeze(
    entries.sort((left, right) => left.path.localeCompare(right.path)),
  );
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export const RUNTIME_TYPESCRIPT_TOOLCHAIN_ROOTS = Object.freeze([
  Object.freeze({
    label: "node_modules/tsx",
    path: resolve(projectRoot, "node_modules/tsx"),
  }),
  Object.freeze({
    label: "node_modules/esbuild",
    path: resolve(projectRoot, "node_modules/esbuild"),
  }),
  Object.freeze({
    label: "node_modules/@esbuild/darwin-arm64",
    path: resolve(projectRoot, "node_modules/@esbuild/darwin-arm64"),
  }),
] as const);

export function currentRuntimeToolchainArchiveEntries(): readonly RuntimeToolchainArchiveEntry[] {
  return runtimeToolchainArchiveEntries(
    RUNTIME_TYPESCRIPT_TOOLCHAIN_ROOTS,
  );
}
