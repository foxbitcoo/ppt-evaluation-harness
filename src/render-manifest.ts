import { createHash } from "node:crypto";

import type { RenderManifest } from "./domain.ts";

export type RenderManifestHashInput = Omit<RenderManifest, "contentHash">;

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

function descriptor(
  artifactHash: `sha256:${string}`,
  manifest: RenderManifestHashInput,
) {
  return {
    schemaVersion: "render-manifest-v1" as const,
    artifactHash,
    renderManifestId: manifest.renderManifestId,
    artifactId: manifest.artifactId,
    provenance: manifest.provenance,
    environmentOrigin: manifest.environmentOrigin,
    renderer: manifest.renderer,
    pageCount: manifest.pageCount,
    renderPolicy: manifest.renderPolicy,
    slides: manifest.slides.map((slide) => ({
      pageNumber: slide.pageNumber,
      filename: slide.filename,
      mimeType: slide.mimeType,
      contentHash: slide.contentHash,
      extractedTextHash: sha256Bytes(
        new TextEncoder().encode(slide.extractedText),
      ),
    })),
    contactSheet: {
      filename: manifest.contactSheet.filename,
      mimeType: manifest.contactSheet.mimeType,
      contentHash: manifest.contactSheet.contentHash,
    },
  };
}

export function sha256Bytes(
  content: Uint8Array,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function renderManifestBytes(
  artifactHash: `sha256:${string}`,
  manifest: RenderManifestHashInput,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(canonicalValue(descriptor(artifactHash, manifest))),
  );
}

export function calculateRenderManifestHash(
  artifactHash: `sha256:${string}`,
  manifest: RenderManifestHashInput,
): `sha256:${string}` {
  return sha256Bytes(renderManifestBytes(artifactHash, manifest));
}
