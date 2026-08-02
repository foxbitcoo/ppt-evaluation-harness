import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EMBEDDED_BUILD_MANIFEST } from "./embedded-build-manifest.ts";
import { currentRuntimeToolchainArchiveEntries } from "./runtime-toolchain-identity.ts";

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const projectRootUrl = new URL("../", import.meta.url);
const projectRootPath = fileURLToPath(projectRootUrl);

function sourceFiles(directory: URL): readonly URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry) => {
      const child = new URL(
        entry.isDirectory() ? `${entry.name}/` : entry.name,
        directory,
      );
      if (entry.isDirectory()) return sourceFiles(child);
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".ts") ||
        entry.name === "embedded-build-manifest.ts"
      ) {
        return [];
      }
      return [child];
    },
  );
}

const archiveEntries = Object.freeze(
  [
    ...sourceFiles(new URL("./", import.meta.url)),
    ...sourceFiles(new URL("../scripts/", import.meta.url)),
    new URL("../package.json", import.meta.url),
    new URL("../package-lock.json", import.meta.url),
  ]
    .map((url) => ({
      path: relative(projectRootPath, fileURLToPath(url)),
      contentHash: sha256(readFileSync(url)),
    }))
    .concat(currentRuntimeToolchainArchiveEntries())
    .sort((left, right) => left.path.localeCompare(right.path)),
);
const sourceArchiveDigest = sha256(JSON.stringify(archiveEntries));
if (
  sourceArchiveDigest !== EMBEDDED_BUILD_MANIFEST.sourceArchiveDigest
) {
  throw new Error(
    "Executable source archive does not match embedded build manifest",
  );
}
const runtimeOverride =
  process.env.PPT_EVALUATION_BUILD_SPEC_COMMIT_SHA;
if (
  runtimeOverride !== undefined &&
  runtimeOverride !== EMBEDDED_BUILD_MANIFEST.specCommitSha
) {
  throw new Error(
    "Runtime source revision does not match embedded build manifest",
  );
}

export const BUILD_SPEC_COMMIT_SHA =
  EMBEDDED_BUILD_MANIFEST.specCommitSha;
export const BUILD_IDENTITY_SOURCE =
  "EMBEDDED_VERIFIED_BUILD_MANIFEST" as const;

export const BUILD_IDENTITY = Object.freeze({
  schemaVersion: "ppt-evaluation-build-identity-v1" as const,
  specCommitSha: BUILD_SPEC_COMMIT_SHA,
  source: BUILD_IDENTITY_SOURCE,
  sourceArchiveDigest,
  sourceArchiveEntryCount: archiveEntries.length,
  embeddedManifestHash: sha256(
    JSON.stringify(EMBEDDED_BUILD_MANIFEST),
  ),
  manifestHash: sha256(
    JSON.stringify({
      schemaVersion: "ppt-evaluation-build-identity-v1",
      specCommitSha: BUILD_SPEC_COMMIT_SHA,
      source: BUILD_IDENTITY_SOURCE,
      sourceArchiveDigest,
      sourceArchiveEntryCount: archiveEntries.length,
      embeddedManifestHash: sha256(
        JSON.stringify(EMBEDDED_BUILD_MANIFEST),
      ),
    }),
  ),
});
