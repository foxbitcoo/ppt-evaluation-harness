import { createHash } from "node:crypto";
import sharp from "sharp";

import type { Artifact, RenderManifest } from "./domain.ts";
import type { SafeRasterCandidate } from "./product-adapter.ts";
import { calculateRenderManifestHash } from "./render-manifest.ts";

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value =
      (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
  }
  return value >>> 0;
});

function crc32(content: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of content) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertSafePng(content: Uint8Array, label: string): void {
  if (
    content.byteLength < 33 ||
    content[0] !== 0x89 ||
    content[1] !== 0x50 ||
    content[2] !== 0x4e ||
    content[3] !== 0x47 ||
    content[4] !== 0x0d ||
    content[5] !== 0x0a ||
    content[6] !== 0x1a ||
    content[7] !== 0x0a ||
    new TextDecoder().decode(content.subarray(12, 16)) !== "IHDR"
  ) {
    throw new Error(`${label} must be a decoded, safe PNG raster`);
  }
  const view = new DataView(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (
    width < 1 ||
    height < 1 ||
    width > 8_192 ||
    height > 8_192 ||
    width * height > 33_554_432
  ) {
    throw new Error(`${label} raster dimensions are unsafe`);
  }
  const allowedChunkTypes = new Set([
    "IHDR",
    "PLTE",
    "IDAT",
    "IEND",
    "cHRM",
    "gAMA",
    "sRGB",
    "pHYs",
    "tRNS",
  ]);
  let offset = 8;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 12 <= content.byteLength) {
    const length = view.getUint32(offset, false);
    const typeStart = offset + 4;
    const typeEnd = typeStart + 4;
    const dataEnd = typeEnd + length;
    const crcOffset = dataEnd;
    if (length > 32 * 1024 * 1024 || crcOffset + 4 > content.byteLength) {
      throw new Error(`${label} PNG chunk is unsafe`);
    }
    const type = new TextDecoder("ascii", { fatal: true }).decode(
      content.subarray(typeStart, typeEnd),
    );
    if (!allowedChunkTypes.has(type)) {
      throw new Error(`${label} PNG chunk ${type} is not allowlisted`);
    }
    if (
      crc32(content.subarray(typeStart, dataEnd)) !==
      view.getUint32(crcOffset, false)
    ) {
      throw new Error(`${label} PNG CRC mismatch`);
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      sawIend = true;
      if (length !== 0 || crcOffset + 4 !== content.byteLength) {
        throw new Error(`${label} PNG terminator is invalid`);
      }
    }
    offset = crcOffset + 4;
  }
  if (!sawIdat || !sawIend || offset !== content.byteLength) {
    throw new Error(`${label} PNG is incomplete`);
  }
}

async function decodeAndNormalizePng(
  content: Uint8Array,
  label: string,
): Promise<Uint8Array> {
  assertSafePng(content, label);
  try {
    const image = sharp(Buffer.from(content), {
      animated: false,
      failOn: "error",
      limitInputPixels: 33_554_432,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      metadata.pages !== undefined && metadata.pages !== 1 ||
      metadata.width === undefined ||
      metadata.height === undefined
    ) {
      throw new Error("unexpected decoded PNG metadata");
    }
    const normalized = Uint8Array.from(
      await image
        .png({
          adaptiveFiltering: false,
          compressionLevel: 9,
          force: true,
          palette: false,
        })
        .toBuffer(),
    );
    assertSafePng(normalized, `${label} normalized output`);
    return normalized;
  } catch (error) {
    throw new Error(`${label} PNG decode failed`, { cause: error });
  }
}

export async function createAuthorizedSafeRasterManifest(input: {
  readonly artifact: Artifact;
  readonly candidate: SafeRasterCandidate;
  readonly renderManifestId: string;
  readonly rendererAuthorizationDecisionId: string;
}): Promise<RenderManifest> {
  const { artifact, candidate } = input;
  if (
    candidate.slides.length !== artifact.pageCount ||
    candidate.renderOutcome === "failed" ||
    candidate.renderer.trim().length === 0 ||
    input.rendererAuthorizationDecisionId.trim().length === 0
  ) {
    throw new Error("Safe raster candidate is incomplete");
  }
  if (
    (candidate.renderOutcome === "faithful" &&
      candidate.fidelity.status !== "verified") ||
    (candidate.renderOutcome === "degraded" &&
      candidate.fidelity.status === "verified")
  ) {
    throw new Error(
      "Safe raster has contradictory render outcome and fidelity",
    );
  }
  const slides = Object.freeze(
    await Promise.all(candidate.slides.map(async (slide, index) => {
      if (
        slide.pageNumber !== index + 1 ||
        slide.mimeType !== "image/png" ||
        slide.extractedText.trim().length === 0
      ) {
        throw new Error(`Safe raster page ${index + 1} is invalid`);
      }
      const normalizedContent = await decodeAndNormalizePng(
        slide.content,
        `Safe raster page ${index + 1}`,
      );
      return Object.freeze({
        ...slide,
        content: normalizedContent,
        contentHash: sha256(normalizedContent),
      });
    })),
  );
  if (candidate.contactSheet.mimeType !== "image/png") {
    throw new Error("Safe raster contact sheet must be PNG");
  }
  const normalizedContactSheet = await decodeAndNormalizePng(
    candidate.contactSheet.content,
    "Safe raster contact sheet",
  );
  const withoutHash: Omit<RenderManifest, "contentHash"> = {
    renderManifestId: input.renderManifestId,
    artifactId: artifact.artifactId,
    provenance: artifact.provenance,
    environmentOrigin: artifact.environmentOrigin,
    renderer: candidate.renderer,
    rendererAuthorizationDecisionId:
      input.rendererAuthorizationDecisionId,
    renderOutcome: candidate.renderOutcome,
    fidelity: Object.freeze({
      status: candidate.fidelity.status,
      notes: Object.freeze([...candidate.fidelity.notes]),
    }),
    pageCount: artifact.pageCount,
    renderPolicy: {
      fontPack: candidate.fontPack,
      resolution: candidate.resolution,
      colorProfile: candidate.colorProfile,
      animationPolicy: "first_frame",
      externalAssetPolicy: "network_disabled",
    },
    slides,
    contactSheet: Object.freeze({
      ...candidate.contactSheet,
      content: normalizedContactSheet,
      contentHash: sha256(normalizedContactSheet),
    }),
  };
  return Object.freeze({
    ...withoutHash,
    contentHash: calculateRenderManifestHash(
      artifact.contentHash,
      withoutHash,
    ),
  });
}
