import type {
  Artifact,
  RenderManifest,
} from "./domain.ts";
import { calculateRenderManifestHash } from "./render-manifest.ts";
import { sha256Bytes } from "./run-specification.ts";

function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}

export function renderedPageNumbers(
  renderManifest: RenderManifest,
): ReadonlySet<number> {
  return new Set(
    renderManifest.slides.map(({ pageNumber }) => pageNumber),
  );
}

export function assertArtifactRenderManifestIntegrity(record: {
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
}): void {
  const { artifact, renderManifest } = record;
  const pages = renderedPageNumbers(renderManifest);
  if (
    artifact.byteSize !== artifact.content.byteLength ||
    sha256Bytes(artifact.content) !== artifact.contentHash
  ) {
    throw new Error(
      "Artifact byte size or content hash is invalid",
    );
  }
  if (
    !Number.isSafeInteger(artifact.pageCount) ||
    artifact.pageCount < 1 ||
    artifact.pageCount !== renderManifest.pageCount ||
    renderManifest.pageCount !== renderManifest.slides.length ||
    pages.size !== renderManifest.slides.length ||
    Array.from(
      { length: renderManifest.pageCount },
      (_, index) => index + 1,
    ).some((pageNumber) => !pages.has(pageNumber))
  ) {
    throw new Error(
      "Artifact and Render Manifest page inventory is inconsistent",
    );
  }
  if (
    renderManifest.slides.some(
      (slide) =>
        sha256Bytes(contentBytes(slide.content)) !==
        slide.contentHash,
    ) ||
    sha256Bytes(contentBytes(renderManifest.contactSheet.content)) !==
      renderManifest.contactSheet.contentHash
  ) {
    throw new Error(
      "Render Manifest slide or contact-sheet content hash is invalid",
    );
  }
  const {
    contentHash: _persistedContentHash,
    ...manifestHashInput
  } = renderManifest;
  if (
    calculateRenderManifestHash(
      artifact.contentHash,
      manifestHashInput,
    ) !== renderManifest.contentHash
  ) {
    throw new Error("Render Manifest content hash is invalid");
  }
}
