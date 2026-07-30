import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  FileSystemAttemptCheckpointStore,
  FileSystemImmutableBlobStore,
  registerDurableRoots,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const hash = (content: Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as const;

test("the shipped Doubao recovery CLI rejects a missing retained derivative instead of validating only the original", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "doubao-recovery-cli-missing-derivative-"),
  );
  const registryId =
    `doubao-recovery-cli-${process.pid}-${Date.now()}`;
  const artifactRoot = join(root, "artifact");
  const specificationRoot = join(root, "specification");
  const checkpointRoot = join(root, "checkpoint");
  const artifactStoreId = "doubao-cli-artifact-store";
  const specificationStoreId = "doubao-cli-specification-store";
  const checkpointStoreId = "doubao-cli-checkpoint-store";
  const manifestKey = "artifacts/test/manifest";
  const originalKey = "artifacts/test/original";
  const artifactId = "artifact-test";
  const renderManifestKey =
    `artifacts/${artifactId}/render-manifest`;
  const specificationKey = "run-specifications/test";
  const attemptId = "attempt-doubao-cli-missing-derivative";

  try {
    await registerDurableRoots({
      registryId,
      roots: [
        {
          rootReference: "root:artifact",
          absolutePath: artifactRoot,
        },
        {
          rootReference: "root:specification",
          absolutePath: specificationRoot,
        },
        {
          rootReference: "root:checkpoint",
          absolutePath: checkpointRoot,
        },
      ],
    });
    const artifactStore = new FileSystemImmutableBlobStore({
      storeId: artifactStoreId,
      rootPath: artifactRoot,
    });
    const specificationStore = new FileSystemImmutableBlobStore({
      storeId: specificationStoreId,
      rootPath: specificationRoot,
    });
    const checkpointStore = new FileSystemAttemptCheckpointStore({
      checkpointStoreId,
      rootPath: checkpointRoot,
    });
    const put = async (
      store: FileSystemImmutableBlobStore,
      key: string,
      content: Uint8Array,
    ) =>
      store.putImmutable(key, content, {
        jobId: "job-doubao-cli",
        contentHash: hash(content),
        writeAttemptId: `fixture:${key}`,
        assertWriteAuthorized() {},
      });
    const original = encoder.encode("registered-original");
    const renderManifest = encoder.encode("registered-render-manifest");
    const derivativePayloads = Array.from(
      { length: 33 },
      (_, index) => encoder.encode(`registered-derivative-${index + 1}`),
    );
    const derivatives = derivativePayloads.map((content, index) => {
      const derivativeType =
        index < 16
          ? "static_slide" as const
          : index < 32
            ? "extracted_text" as const
            : "contact_sheet" as const;
      const pageNumber =
        index < 16 ? index + 1 : index < 32 ? index - 15 : null;
      const suffix =
        derivativeType === "static_slide"
          ? `static-slide-${pageNumber}`
          : derivativeType === "extracted_text"
            ? `extracted-text-${pageNumber}`
            : "contact-sheet";
      return {
        derivativeId: `derivative-${index + 1}`,
        derivativeType,
        pageNumber,
        contentHash: hash(content),
        key: `artifacts/${artifactId}/derivatives/${suffix}`,
      };
    });
    const payloadLocations = [
      {
        storeId: artifactStoreId,
        key: renderManifestKey,
        contentHash: hash(renderManifest),
        copyRole: "secondary",
      },
      ...derivatives.map(({ contentHash, key }) => ({
        storeId: artifactStoreId,
        key,
        contentHash,
        copyRole: "secondary",
      })),
    ];
    const manifest = encoder.encode(
      JSON.stringify({
        artifact: {
          artifactId,
          contentHash: hash(original),
          provenance: "PRODUCTION_REPLAY",
        },
        renderManifestHash: hash(renderManifest),
        derivatives,
        payloadLocations,
        productionExecutionEvidence: {
          executionMode: "PRODUCTION_REPLAY",
          captureSource: "REAL_PROVIDER_CAPTURE",
        },
      }),
    );
    const specification = encoder.encode(
      JSON.stringify({
        evaluationCase: { provenance: "PRODUCTION" },
        adapterSpecification: {
          browserDriverEvidence: {
            driverId: "doubao-real-provider-replay",
            provenance: "PRODUCTION_REPLAY",
          },
        },
      }),
    );
    await Promise.all([
      put(artifactStore, manifestKey, manifest),
      put(artifactStore, originalKey, original),
      put(artifactStore, renderManifestKey, renderManifest),
      ...derivativePayloads.slice(0, 32).map((content, index) =>
          put(
            artifactStore,
            derivatives[index]!.key,
            content,
          ),
      ),
      put(specificationStore, specificationKey, specification),
      checkpointStore.append({
        eventId: "event-doubao-cli-1",
        attemptId,
        taskStateVersion: "query_submitted@1",
      } as never),
    ]);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/recover-doubao-production-run.ts",
          registryId,
          "root:artifact",
          "root:specification",
          "root:checkpoint",
          artifactStoreId,
          manifestKey,
          originalKey,
          specificationStoreId,
          specificationKey,
          checkpointStoreId,
          attemptId,
        ],
        { cwd: new URL("..", import.meta.url).pathname },
      ),
      /derivative.*missing|missing.*derivative/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type MalformedLineageCase =
  | "duplicate_id"
  | "missing_page"
  | "wrong_kind"
  | "cross_hash_mismatch";

async function runMalformedLineageRecovery(
  malformedCase: MalformedLineageCase,
) {
  const root = await mkdtemp(
    join(tmpdir(), `doubao-recovery-cli-${malformedCase}-`),
  );
  const registryId =
    `doubao-recovery-${malformedCase}-${process.pid}-${Date.now()}`;
  const artifactRoot = join(root, "artifact");
  const specificationRoot = join(root, "specification");
  const checkpointRoot = join(root, "checkpoint");
  const artifactStoreId = `artifact-store-${malformedCase}`;
  const specificationStoreId = `specification-store-${malformedCase}`;
  const checkpointStoreId = `checkpoint-store-${malformedCase}`;
  const artifactId = "artifact-doubao-lineage";
  const manifestKey = `artifacts/${artifactId}/manifest`;
  const originalKey = `artifacts/${artifactId}/original`;
  const renderManifestKey =
    `artifacts/${artifactId}/render-manifest`;
  const specificationKey = "run-specifications/doubao-lineage";
  const attemptId = `attempt-${malformedCase}`;

  try {
    await registerDurableRoots({
      registryId,
      roots: [
        {
          rootReference: "root:artifact",
          absolutePath: artifactRoot,
        },
        {
          rootReference: "root:specification",
          absolutePath: specificationRoot,
        },
        {
          rootReference: "root:checkpoint",
          absolutePath: checkpointRoot,
        },
      ],
    });
    const artifactStore = new FileSystemImmutableBlobStore({
      storeId: artifactStoreId,
      rootPath: artifactRoot,
    });
    const specificationStore = new FileSystemImmutableBlobStore({
      storeId: specificationStoreId,
      rootPath: specificationRoot,
    });
    const checkpointStore = new FileSystemAttemptCheckpointStore({
      checkpointStoreId,
      rootPath: checkpointRoot,
    });
    const put = async (
      store: FileSystemImmutableBlobStore,
      key: string,
      content: Uint8Array,
    ) =>
      store.putImmutable(key, content, {
        jobId: "job-doubao-lineage",
        contentHash: hash(content),
        writeAttemptId: `fixture:${key}`,
        assertWriteAuthorized() {},
      });
    const original = encoder.encode("registered-original");
    const staticPayloads = Array.from(
      { length: 16 },
      (_, index) => encoder.encode(`static-page-${index + 1}`),
    );
    const textPayloads = Array.from(
      { length: 16 },
      (_, index) => encoder.encode(`text-page-${index + 1}`),
    );
    const contactPayload = encoder.encode("contact-sheet");
    const renderManifest = encoder.encode(
      JSON.stringify({
        schemaVersion: "render-manifest-v1",
        artifactHash: hash(original),
        artifactId,
        pageCount: 16,
        contactSheet: {
          contentHash: hash(contactPayload),
          filename: "contact-sheet.png",
          mimeType: "image/png",
        },
        slides: staticPayloads.map((content, index) => ({
          pageNumber: index + 1,
          filename: `slide-${index + 1}.png`,
          mimeType: "image/png",
          contentHash: hash(content),
          extractedTextHash: hash(textPayloads[index]!),
        })),
      }),
    );
    const derivatives = [
      ...staticPayloads.map((content, index) => ({
        derivativeId:
          `${artifactId}:static-slide:${index + 1}`,
        sourceArtifactId: artifactId,
        derivativeType: "static_slide" as const,
        pageNumber: index + 1,
        contentHash: hash(content),
      })),
      ...textPayloads.map((content, index) => ({
        derivativeId:
          `${artifactId}:extracted-text:${index + 1}`,
        sourceArtifactId: artifactId,
        derivativeType: "extracted_text" as const,
        pageNumber: index + 1,
        contentHash: hash(content),
      })),
      {
        derivativeId: `${artifactId}:contact-sheet`,
        sourceArtifactId: artifactId,
        derivativeType: "contact_sheet" as const,
        pageNumber: null,
        contentHash: hash(contactPayload),
      },
    ];
    if (malformedCase === "duplicate_id") {
      derivatives[15] = {
        ...derivatives[15]!,
        derivativeId: derivatives[14]!.derivativeId,
      };
    } else if (malformedCase === "missing_page") {
      derivatives[15] = {
        ...derivatives[0]!,
        derivativeId: `${artifactId}:static-slide:duplicate-page`,
      };
    } else if (malformedCase === "wrong_kind") {
      derivatives[15] = {
        ...derivatives[31]!,
        derivativeId: `${artifactId}:wrong-kind:16`,
      };
    } else {
      const adversarial = encoder.encode("cross-hash-adversarial");
      derivatives[0] = {
        ...derivatives[0]!,
        contentHash: hash(adversarial),
      };
      staticPayloads[0] = adversarial;
    }
    const derivativeKey = (
      derivative: typeof derivatives[number],
    ) =>
      derivative.derivativeType === "static_slide"
        ? `artifacts/${artifactId}/derivatives/static-slide-${derivative.pageNumber}`
        : derivative.derivativeType === "extracted_text"
          ? `artifacts/${artifactId}/derivatives/extracted-text-${derivative.pageNumber}`
          : `artifacts/${artifactId}/derivatives/contact-sheet`;
    const manifest = encoder.encode(
      JSON.stringify({
        artifact: {
          artifactId,
          contentHash: hash(original),
          provenance: "PRODUCTION_REPLAY",
        },
        renderManifestHash: hash(renderManifest),
        derivatives,
        productionExecutionEvidence: {
          executionMode: "PRODUCTION_REPLAY",
          captureSource: "REAL_PROVIDER_CAPTURE",
        },
      }),
    );
    const specification = encoder.encode(
      JSON.stringify({
        evaluationCase: { provenance: "PRODUCTION" },
        adapterSpecification: {
          browserDriverEvidence: {
            driverId: "doubao-real-provider-replay",
            provenance: "PRODUCTION_REPLAY",
          },
        },
      }),
    );
    const payloadByKey = new Map<string, Uint8Array>();
    derivatives.forEach((derivative) => {
      const content =
        derivative.derivativeType === "static_slide"
          ? staticPayloads[(derivative.pageNumber ?? 1) - 1]!
          : derivative.derivativeType === "extracted_text"
            ? textPayloads[(derivative.pageNumber ?? 1) - 1]!
            : contactPayload;
      payloadByKey.set(derivativeKey(derivative), content);
    });
    await Promise.all([
      put(artifactStore, manifestKey, manifest),
      put(artifactStore, originalKey, original),
      put(artifactStore, renderManifestKey, renderManifest),
      ...[...payloadByKey].map(([key, content]) =>
        put(artifactStore, key, content),
      ),
      put(specificationStore, specificationKey, specification),
      checkpointStore.append({
        eventId: `event-${malformedCase}`,
        attemptId,
        taskStateVersion: "query_submitted@1",
      } as never),
    ]);
    return await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/recover-doubao-production-run.ts",
        registryId,
        "root:artifact",
        "root:specification",
        "root:checkpoint",
        artifactStoreId,
        manifestKey,
        originalKey,
        specificationStoreId,
        specificationKey,
        checkpointStoreId,
        attemptId,
      ],
      { cwd: new URL("..", import.meta.url).pathname },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the shipped Doubao recovery CLI rejects malformed 33-item derivative lineages", async (context) => {
  for (const malformedCase of [
    "duplicate_id",
    "missing_page",
    "wrong_kind",
    "cross_hash_mismatch",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runMalformedLineageRecovery(malformedCase),
        /derivative|render manifest|lineage/i,
      );
    });
  }
});
