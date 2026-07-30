import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import sharp from "sharp";

import {
  BUILD_SPEC_COMMIT_SHA,
  BUILD_IDENTITY,
  DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
  FileSystemImmutableBlobStore,
  MockDoubaoProductAdapter,
  MockWpsProductAdapter,
  VENDOR_GENERATION_TIMEOUT_MS,
  VOLCANO_EVALUATION_CASE,
  approvedEgressAuthorizationHash,
  calculateArtifactDerivativeSetHash,
  canonicalJsonBytes,
  currentVerifierRecoveryEvidenceAttestedView,
  doubaoRecoveryResultAttestedView,
  parseAdapterExecutionConfiguration,
  parseDoubaoCurrentVerifierRecoveryEvidence,
  parseDoubaoRecoveryCliResult,
  registerDurableRoots,
  resolveHarnessProductAdapterExecutor,
  trustedDoubaoRecoveryCheckpoint,
  type TrustedDoubaoRecoveryCheckpoint,
} from "../src/index.ts";
import {
  artifactManifestAttestedPayloadHash,
  renderManifestAttestedPayloadHash,
  validateDoubaoRecoveryStoresAgainstCheckpoint,
} from "../scripts/recover-doubao-production-run.ts";

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const hash = (content: Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
const HASH_A =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const HASH_B =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const OFFLINE_RECOVERY_FIXTURE_CHECKPOINT_ID =
  "doubao-offline-recovery-fixture-v1";
const OFFLINE_RENDERER_AUTHORIZATION_DECISION = Object.freeze({
  status: "approved" as const,
  decisionId: "fixture-renderer-authorization-v1",
  policyVersion: "fixture-renderer-policy-v1",
  request: Object.freeze({
    requestId:
      "artifact-rendering:artifact-doubao-lineage",
    jobId: "job-doubao-lineage",
    runId: "run-doubao-lineage",
    attemptId: "attempt-doubao-lineage-1",
    dataClassification: "public_or_synthetic" as const,
    sourceOwner: "ppt-evaluation-harness",
    processingPurpose: "artifact_rendering" as const,
    targetKind: "renderer" as const,
    targetService: "isolated-offline-png-rasterizer",
    targetAccount: "local-sandbox",
    targetRegion: "local",
    subprocessors: Object.freeze([]),
    contentFields: Object.freeze(["artifact_binary"]),
    payloadHash:
      "sha256:fadcc2150e1d5262efa0ba3364c0665b59efd1fd0b536fa65fdc19b7b4613942" as const,
    requiredRedactions: Object.freeze([]),
    requestedAt: "2026-07-27T10:34:46.000Z",
  }),
  legalSecurityBasis: "offline validation fixture",
  approvedAt: "2026-07-27T10:34:46.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
});
const OFFLINE_RECOVERY_FIXTURE_CHECKPOINT =
  Object.freeze<TrustedDoubaoRecoveryCheckpoint>({
    schemaVersion: "doubao-recovery-checkpoint-v1",
    checkpointId: OFFLINE_RECOVERY_FIXTURE_CHECKPOINT_ID,
    purpose: "offline_validation_fixture",
    artifactContentHash:
      "sha256:fadcc2150e1d5262efa0ba3364c0665b59efd1fd0b536fa65fdc19b7b4613942",
    evaluatedSpecCommitSha: BUILD_SPEC_COMMIT_SHA,
    evaluatedBuildIdentitySource:
      "EMBEDDED_VERIFIED_BUILD_MANIFEST",
    rendererAuthorizationDecision:
      OFFLINE_RENDERER_AUTHORIZATION_DECISION,
    rendererAuthorizationAuditDigest:
      approvedEgressAuthorizationHash(
        OFFLINE_RENDERER_AUTHORIZATION_DECISION,
      ),
    checkpointTraceHash:
      "sha256:e2c4eca0f43e2a6e4c557094bf428309b355f30e0aa944911c276b8dc7f41398",
    caseId: "volcano-query-v1",
    caseVersion: 1,
    caseContentHash:
      "sha256:9c2f70e0ef3d5413a0d527475dfd03f29c5feabe17cf719013e2d83af193be18",
    vendorPromptHash:
      "sha256:39fec395e6904ca10346a86b85ecae57a35a9196e9897ccab7fe2ab30ccb6ba4",
    track: "query_generation",
    protocolId: "production-query-default-cost-v1",
    referencePackMode: "off",
    pageCount: 16,
    packageId: "doubao-web-ppt-real-provider-replay-v1",
    adapterVersion: "doubao-web-ppt@1",
    adapterImplementationDigest: HASH_A,
    executionEntrypointDigest: HASH_A,
    executionConfigurationDigest: HASH_A,
    driverId: "doubao-real-provider-replay",
    driverVersion: "doubao-harness-browser-bridge@2",
    browserProfileDigest: HASH_A,
    driverImplementationDigest: HASH_A,
    driverConfigurationDigest: HASH_A,
    vendorTaskId:
      "task_573b17d014bb4759472bda54192ef536",
    taskStateVersion: "artifact_exported@4",
    captureReceipt: Object.freeze({
      captureId: "doubao-volcano-fixture",
      artifactContentHash:
        "sha256:fadcc2150e1d5262efa0ba3364c0665b59efd1fd0b536fa65fdc19b7b4613942",
      traceDigest: HASH_A,
      retainedPageDigest: HASH_B,
      renderDigest:
        "sha256:9ec8a554ad2b9c63f678230b18fab5d907d9e1494774113b8aa062bd3ef362ad",
    }),
    rendererId: "fixture-renderer-v1",
    derivativePipelineVersion: "fixture-renderer-v1",
    slideDimensions: Object.freeze({ width: 1, height: 1 }),
    contactSheetDimensions: Object.freeze({ width: 1, height: 1 }),
  });

type MalformedLineageCase =
  | "valid"
  | "missing_derivative"
  | "duplicate_id"
  | "missing_page"
  | "wrong_kind"
  | "cross_hash_mismatch"
  | "wrong_run_spec"
  | "wrong_attempt"
  | "wrong_artifact"
  | "receipt_digest_mismatch"
  | "provenance"
  | "self_forged_bundle"
  | "wrong_checkpoint"
  | "fake_pptx_signature"
  | "fake_png_signature"
  | "wrong_png_dimensions"
  | "trace_timestamp_tamper"
  | "trace_evidence_tamper"
  | "trace_event_omission"
  | "trace_event_insertion"
  | "trace_extra_authorization_field"
  | "manifest_trace_hash_tamper"
  | "manifest_trace_hash_missing"
  | "manifest_execution_authorization"
  | "manifest_execution_hidden_reasoning"
  | "manifest_receipt_pollution"
  | "manifest_root_hidden_reasoning"
  | "run_spec_hidden_authorization"
  | "run_spec_prompt_swap"
  | "render_manifest_extra_field"
  | "checkpoint_duplicate_evidence_key"
  | "manifest_nested_duplicate_key"
  | "run_spec_nested_duplicate_key"
  | "artifact_metadata_tamper"
  | "render_manifest_metadata_tamper"
  | "run_spec_package_tamper"
  | "render_authorization_decision_tamper";

interface FixtureDerivative {
  derivativeId: string;
  sourceArtifactId: string;
  derivativeType:
    | "static_slide"
    | "extracted_text"
    | "contact_sheet";
  pageNumber: number | null;
  filename: string;
  mimeType: string;
  byteSize: number;
  contentHash: `sha256:${string}`;
  pipelineVersion: string;
}

async function realMinimalPptx(
  variant: "trusted" | "forged",
): Promise<Uint8Array> {
  const adapter =
    variant === "trusted"
      ? new MockWpsProductAdapter()
      : new MockDoubaoProductAdapter();
  const execute = resolveHarnessProductAdapterExecutor(
    adapter.implementationPackage,
    parseAdapterExecutionConfiguration(
      adapter.executionConfigurationPackage,
    ),
  );
  const artifact = await execute({
    jobId: "fixture-job",
    runId: "fixture-run",
    attemptId: "fixture-attempt",
    attemptSeq: 1,
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    signal: new AbortController().signal,
    evaluationCase: VOLCANO_EVALUATION_CASE,
  });
  if ("content" in artifact) {
    return Uint8Array.from(artifact.content);
  }
  assert.ok(
    artifact.artifactCandidates !== undefined &&
      artifact.artifactCandidates.length === 1,
  );
  return Uint8Array.from(
    artifact.artifactCandidates[0]!.artifact.content,
  );
}

async function runRecoveryFixture(malformedCase: MalformedLineageCase) {
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
  const jobId = "job-doubao-lineage";
  const runId = "run-doubao-lineage";
  const caseId = "volcano-query-v1";
  const attemptId = "attempt-doubao-lineage-1";
  const artifactId = "artifact-doubao-lineage";
  const rawVendorTaskId = "38435879568317954";
  const productionVendorTaskId =
    `task_${createHash("sha256")
      .update(rawVendorTaskId)
      .digest("hex")
      .slice(0, 32)}`;
  const adapterVersion = "doubao-web-ppt@1";
  const manifestKey = `artifacts/${artifactId}/manifest`;
  const originalKey = `artifacts/${artifactId}/original`;
  const renderManifestKey =
    `artifacts/${artifactId}/render-manifest`;

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
    const put = async (
      store: FileSystemImmutableBlobStore,
      key: string,
      content: Uint8Array,
    ) =>
      store.putImmutable(key, content, {
        jobId,
        contentHash: hash(content),
        writeAttemptId: `fixture:${key}`,
        assertWriteAuthorized() {},
      });

    let original = await realMinimalPptx(
      malformedCase === "self_forged_bundle"
        ? "forged"
        : "trusted",
    );
    if (malformedCase === "fake_pptx_signature") {
      original = Uint8Array.from(original);
      original[0] = 0x00;
    }
    const minimalPng =
      malformedCase === "wrong_png_dimensions"
        ? Uint8Array.from(
            await sharp({
              create: {
                width: 2,
                height: 1,
                channels: 4,
                background: "#000000",
              },
            })
              .png()
              .toBuffer(),
          )
        : Uint8Array.from(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          );
    const staticPayloads = Array.from({ length: 16 }, () =>
      Uint8Array.from(minimalPng),
    );
    if (malformedCase === "fake_png_signature") {
      staticPayloads[0]![0] = 0x00;
    }
    const textPayloads = Array.from(
      { length: 16 },
      (_, index) => encoder.encode(`text-page-${index + 1}`),
    );
    const contactPayload = Uint8Array.from(minimalPng);
    const renderManifestObject: Record<string, unknown> = {
      schemaVersion: "render-manifest-v1",
      renderManifestId: `${artifactId}-render`,
      artifactHash: hash(original),
      artifactId,
      pageCount: 16,
      renderer: "fixture-renderer-v1",
      rendererAuthorizationDecisionId:
        OFFLINE_RENDERER_AUTHORIZATION_DECISION.decisionId,
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
    };
    let trustedRenderManifestAttestedPayloadHash =
      renderManifestAttestedPayloadHash(renderManifestObject);
    if (malformedCase === "render_manifest_metadata_tamper") {
      renderManifestObject.renderer = "self-asserted-renderer-v99";
    }
    if (malformedCase === "render_manifest_extra_field") {
      renderManifestObject.hiddenReasoning =
        "must-not-survive-schema-validation";
    } else if (
      malformedCase === "render_authorization_decision_tamper"
    ) {
      renderManifestObject.rendererAuthorizationDecisionId =
        "fixture-renderer-authorization-replaced";
      // Simulates an attacker who updates every self-controlled hash while
      // the independent authorization audit remains unchanged.
      trustedRenderManifestAttestedPayloadHash =
        renderManifestAttestedPayloadHash(renderManifestObject);
    }
    const renderManifest = encoder.encode(JSON.stringify(renderManifestObject));
    const derivatives: FixtureDerivative[] = [
      ...staticPayloads.map((content, index) => ({
        derivativeId:
          `${artifactId}:static-slide:${index + 1}`,
        sourceArtifactId: artifactId,
        derivativeType: "static_slide" as const,
        pageNumber: index + 1,
        filename: `slide-${index + 1}.png`,
        mimeType: "image/png",
        byteSize: content.byteLength,
        contentHash: hash(content),
        pipelineVersion: "fixture-renderer-v1",
      })),
      ...textPayloads.map((content, index) => ({
        derivativeId:
          `${artifactId}:extracted-text:${index + 1}`,
        sourceArtifactId: artifactId,
        derivativeType: "extracted_text" as const,
        pageNumber: index + 1,
        filename: `slide-${index + 1}.txt`,
        mimeType: "text/plain; charset=utf-8",
        byteSize: content.byteLength,
        contentHash: hash(content),
        pipelineVersion: "fixture-renderer-v1",
      })),
      {
        derivativeId: `${artifactId}:contact-sheet`,
        sourceArtifactId: artifactId,
        derivativeType: "contact_sheet" as const,
        pageNumber: null,
        filename: "contact-sheet.png",
        mimeType: "image/png",
        byteSize: contactPayload.byteLength,
        contentHash: hash(contactPayload),
        pipelineVersion: "fixture-renderer-v1",
      },
    ];
    const derivativeSetHash = calculateArtifactDerivativeSetHash(
      derivatives.map(({ derivativeId, contentHash }) => ({
        derivativeId,
        contentHash,
      })),
    );
    const selfForged =
      malformedCase === "self_forged_bundle";
    const receipt = {
      captureId: selfForged
        ? "doubao-self-forged-fixture"
        : "doubao-volcano-fixture",
      artifactContentHash: hash(original),
      traceDigest: selfForged
        ? hash(encoder.encode("self-forged-trace"))
        : HASH_A,
      retainedPageDigest: selfForged
        ? hash(encoder.encode("self-forged-pages"))
        : HASH_B,
      renderDigest: derivativeSetHash,
    };
    if (malformedCase === "duplicate_id") {
      derivatives[15] = {
        ...derivatives[15]!,
        derivativeId: derivatives[14]!.derivativeId,
      };
    } else if (malformedCase === "missing_page") {
      derivatives[15] = {
        ...derivatives[15]!,
        pageNumber: 15,
      };
    } else if (malformedCase === "wrong_kind") {
      derivatives[15] = {
        ...derivatives[15]!,
        derivativeType: "extracted_text",
      };
    } else if (malformedCase === "cross_hash_mismatch") {
      const adversarial = encoder.encode("cross-hash-adversarial");
      derivatives[0] = {
        ...derivatives[0]!,
        contentHash: hash(adversarial),
        byteSize: adversarial.byteLength,
      };
      staticPayloads[0] = adversarial;
    }
    const manifestReceipt: Record<string, unknown> =
      malformedCase === "receipt_digest_mismatch"
        ? { ...receipt, renderDigest: HASH_A }
        : receipt;
    if (malformedCase === "manifest_receipt_pollution") {
      manifestReceipt.hiddenAuthorization =
        "must-not-survive-schema-validation";
    }
    const productionExecutionEvidence: Record<string, unknown> = {
      executionMode: "PRODUCTION_REPLAY",
      captureSource: "REAL_PROVIDER_CAPTURE",
      driverSessionId: "session_replay_fixture",
      driverVersion: "doubao-harness-browser-bridge@2",
      adapterVersion,
      outcome: "captured",
      vendorTaskId: productionVendorTaskId,
      taskStateVersion: "artifact_exported@4",
      artifactContentHash: hash(original),
      rasterManifestHash: hash(renderManifest),
      traceHash:
        malformedCase === "manifest_trace_hash_tamper"
          ? HASH_A
          : OFFLINE_RECOVERY_FIXTURE_CHECKPOINT.checkpointTraceHash,
      captureReceipt: manifestReceipt,
    };
    if (malformedCase === "manifest_trace_hash_missing") {
      delete productionExecutionEvidence.traceHash;
    } else if (
      malformedCase === "manifest_execution_authorization"
    ) {
      productionExecutionEvidence.authorization =
        "must-not-survive-schema-validation";
    } else if (
      malformedCase === "manifest_execution_hidden_reasoning"
    ) {
      productionExecutionEvidence.hiddenReasoning =
        "must-not-survive-schema-validation";
    }
    const manifestObject: Record<string, unknown> = {
      schemaVersion: "artifact-package-identity-v1",
      jobId,
      artifact: {
        artifactId,
        runId,
        contentHash: hash(original),
        provenance: "PRODUCTION_REPLAY",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: original.byteLength,
        pageCount: 16,
        capturedAt: "2026-07-27T10:45:58.000Z",
        filename: "doubao-volcano-16.pptx",
      },
      renderManifestId: `${artifactId}-render`,
      renderManifestHash: hash(renderManifest),
      renderOutcome: "degraded",
      derivatives,
      productionExecutionEvidence,
    };
    const trustedArtifactManifestAttestedPayloadHash =
      artifactManifestAttestedPayloadHash(manifestObject);
    if (malformedCase === "artifact_metadata_tamper") {
      const artifactMetadata = manifestObject.artifact as Record<
        string,
        unknown
      >;
      artifactMetadata.capturedAt = "2026-07-28T10:45:58.000Z";
      artifactMetadata.filename = "self-asserted-replacement.pptx";
    }
    if (malformedCase === "manifest_root_hidden_reasoning") {
      manifestObject.hiddenReasoning =
        "must-not-survive-schema-validation";
    }
    let manifestJson = JSON.stringify(manifestObject);
    if (malformedCase === "manifest_nested_duplicate_key") {
      manifestJson = manifestJson.replace(
        '"captureId":"doubao-volcano-fixture"',
        '"captureId":"shadow-capture","captureId":"doubao-volcano-fixture"',
      );
    }
    const manifest = encoder.encode(manifestJson);
    const evaluationCase: Record<string, unknown> = {
      audience: "初中生",
      caseId,
      caseVersion: 1,
      dataClassification: "public_or_synthetic",
      environmentOrigin: {
        environment: "production",
        originId: "production:ppt-evaluation-v1",
      },
      provenance: "PRODUCTION",
      readingMode: "self_reading",
      recordId: "production-case-volcano-query-v1",
      sourceOwner: "ppt-evaluation-harness",
      targetPageCount: 16,
      title: "火山为什么会喷发",
      track: "query_generation",
      vendorPrompt:
        "为初中生制作一份供自主阅读的 16 页《火山为什么会喷发》科普 PPT。共 16 页：第 1 页为封面，第 2 页为目录，第 3–15 页为正文，第 16 页为总结/知识回顾；不要单独的封底或致谢页。",
    };
    if (malformedCase === "run_spec_prompt_swap") {
      evaluationCase.vendorPrompt =
        "为董事会制作一份 16 页企业财报分析 PPT。";
      evaluationCase.title = "企业财报分析";
    }
    const runSpecificationObject: Record<string, unknown> = {
      schemaVersion: "run-specification-bundle-v1",
      jobId,
      runId:
        malformedCase === "wrong_run_spec"
          ? "run-doubao-wrong"
          : runId,
      specCommitSha: BUILD_SPEC_COMMIT_SHA,
      evaluationCase,
      versionReferences: {
        caseContentHash: hash(canonicalJsonBytes(evaluationCase)),
      },
      protocolSnapshot: {
        protocolId: "production-query-default-cost-v1",
        referencePackMode: "off",
        timeoutMs: 1_800_000,
        retryPolicy: "one_if_provably_not_submitted",
        resultSelectionPolicy: "first_policy_compliant_artifact",
        cancellationPolicy: "independent_vendor_runs_continue",
      },
      productPackage: {
        packageId: "doubao-web-ppt-real-provider-replay-v1",
        vendorId: "doubao",
        adapterVersion,
        provenance: "PRODUCTION_REPLAY",
      },
      adapterSpecification: {
        packageId: "doubao-web-ppt-real-provider-replay-v1",
        vendorId: "doubao",
        adapterVersion,
        implementationDigest: HASH_A,
        executionEntrypointDigest: HASH_A,
        executionConfigurationDigest: HASH_A,
        browserDriverEvidence: {
          driverId: "doubao-real-provider-replay",
          provenance:
            malformedCase === "provenance"
              ? "TEST_FAKE"
              : "PRODUCTION_REPLAY",
          captureSource: "REAL_PROVIDER_CAPTURE",
          driverVersion: "doubao-harness-browser-bridge@2",
          browserProfileDigest: HASH_A,
          implementationDigest: HASH_A,
          configurationDigest: HASH_A,
          captureReceipt: receipt,
        },
      },
    };
    const trustedRunSpecificationCanonicalHash = hash(
      canonicalJsonBytes(runSpecificationObject),
    );
    if (malformedCase === "run_spec_package_tamper") {
      const packageMetadata =
        runSpecificationObject.productPackage as Record<
          string,
          unknown
        >;
      packageMetadata.packageId = "self-asserted-package-v99";
    }
    if (malformedCase === "run_spec_hidden_authorization") {
      runSpecificationObject.hiddenAuthorization =
        "must-not-survive-schema-validation";
    }
    let runSpecificationJson = JSON.stringify(runSpecificationObject);
    if (malformedCase === "run_spec_nested_duplicate_key") {
      runSpecificationJson = runSpecificationJson.replace(
        '"vendorPrompt":"',
        '"vendorPrompt":"shadow","vendorPrompt":"',
      );
    }
    const runSpecification = encoder.encode(runSpecificationJson);
    const runSpecificationHash = hash(runSpecification);
    const specificationKey =
      `run-specifications/${runSpecificationHash.slice("sha256:".length)}`;
    const derivativePayloadByKey = new Map<string, Uint8Array>();
    staticPayloads.forEach((content, index) => {
      derivativePayloadByKey.set(
        `artifacts/${artifactId}/derivatives/static-slide-${index + 1}`,
        content,
      );
    });
    textPayloads.forEach((content, index) => {
      derivativePayloadByKey.set(
        `artifacts/${artifactId}/derivatives/extracted-text-${index + 1}`,
        content,
      );
    });
    derivativePayloadByKey.set(
      `artifacts/${artifactId}/derivatives/contact-sheet`,
      contactPayload,
    );
    if (malformedCase === "missing_derivative") {
      derivativePayloadByKey.delete(
        `artifacts/${artifactId}/derivatives/contact-sheet`,
      );
    }
    await Promise.all([
      put(artifactStore, manifestKey, manifest),
      put(artifactStore, originalKey, original),
      put(artifactStore, renderManifestKey, renderManifest),
      ...[...derivativePayloadByKey].map(([key, content]) =>
        put(artifactStore, key, content),
      ),
      put(
        specificationStore,
        specificationKey,
        runSpecification,
      ),
    ]);

    const events = [
      {
        eventType: "preflight_observed",
        observedAt: "2026-07-27T10:34:46.000Z",
        submissionEvidenceAtCheckpoint: "not_submitted",
        vendorTaskId: null,
        taskStateVersion: null,
        artifactId: null,
      },
      {
        eventType: "query_submitted",
        observedAt: "2026-07-27T10:34:46.000Z",
        submissionEvidenceAtCheckpoint: "submitted",
        vendorTaskId: rawVendorTaskId,
        taskStateVersion: "query_submitted@2",
        artifactId: null,
      },
      {
        eventType: "generation_ready",
        observedAt: "2026-07-27T10:45:58.000Z",
        submissionEvidenceAtCheckpoint: "submitted",
        vendorTaskId: rawVendorTaskId,
        taskStateVersion: "generation_ready@3",
        artifactId: null,
      },
      {
        eventType: "artifact_exported",
        observedAt: "2026-07-27T10:45:58.000Z",
        submissionEvidenceAtCheckpoint: "submitted",
        vendorTaskId: rawVendorTaskId,
        taskStateVersion: "artifact_exported@4",
        artifactId:
          malformedCase === "wrong_artifact"
            ? "artifact-doubao-wrong"
            : artifactId,
      },
    ].map((event, index) => ({
      eventId: `${attemptId}-event-${index + 1}`,
      jobId,
      caseId,
      runId,
      attemptId:
        malformedCase === "wrong_attempt" && index === 2
          ? "attempt-doubao-wrong"
          : attemptId,
      attemptSeq: 1,
      eventType: event.eventType,
      sourceAt: event.observedAt,
      observedAt: event.observedAt,
      writerId: adapterVersion,
      evidenceRef: `ui://doubao/event-${index + 1}-audit-anchor`,
      adapterVersion,
      sourceUrl: "https://www.doubao.com/",
      submissionEvidenceAtCheckpoint:
        event.submissionEvidenceAtCheckpoint,
      vendorTaskId: event.vendorTaskId,
      taskStateVersion: event.taskStateVersion,
      artifactId: event.artifactId,
    }));
    if (malformedCase === "trace_timestamp_tamper") {
      events[0]!.sourceAt = "2026-07-27T10:34:45.000Z";
      events[0]!.observedAt = "2026-07-27T10:34:45.000Z";
    } else if (malformedCase === "trace_evidence_tamper") {
      events[2]!.evidenceRef =
        "ui://doubao/generated-substituted-audit-anchor";
    } else if (malformedCase === "trace_event_omission") {
      events.splice(2, 1);
    } else if (malformedCase === "trace_event_insertion") {
      events.splice(2, 0, {
        ...events[1]!,
        eventId: `${attemptId}-event-injected`,
        eventType: "generation_started",
        taskStateVersion: "generation_started@3",
      });
    } else if (
      malformedCase === "trace_extra_authorization_field"
    ) {
      Object.assign(events[1]!, {
        authorization: "credential-material-must-not-be-persisted",
      });
    }
    const checkpointFilename =
      `${createHash("sha256").update(attemptId).digest("hex")}.jsonl`;
    let checkpointJsonl =
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    if (malformedCase === "checkpoint_duplicate_evidence_key") {
      checkpointJsonl = checkpointJsonl.replace(
        '"evidenceRef":"ui://doubao/event-1-audit-anchor"',
        '"evidenceRef":"authorization-material-must-not-be-authenticated","evidence\\u0052ef":"ui://doubao/event-1-audit-anchor"',
      );
    }
    await writeFile(
      join(checkpointRoot, checkpointFilename),
      checkpointJsonl,
      { mode: 0o600 },
    );

    const offlineCheckpointWithCanonicalMetadata = Object.freeze({
      ...OFFLINE_RECOVERY_FIXTURE_CHECKPOINT,
      artifactManifestAttestedPayloadHash:
        trustedArtifactManifestAttestedPayloadHash,
      renderManifestAttestedPayloadHash:
        trustedRenderManifestAttestedPayloadHash,
      runSpecificationCanonicalHash:
        trustedRunSpecificationCanonicalHash,
    });
    const result =
      await validateDoubaoRecoveryStoresAgainstCheckpoint(
        {
          registryId,
          artifactRecoveryRootReference: "root:artifact",
          runSpecificationRootReference: "root:specification",
          checkpointRootReference: "root:checkpoint",
          artifactStoreId,
          manifestKey,
          originalKey,
          runSpecificationStoreId: specificationStoreId,
          runSpecificationKey: specificationKey,
          checkpointStoreId,
          attemptId,
        },
        malformedCase === "wrong_checkpoint"
          ? trustedDoubaoRecoveryCheckpoint(
              DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
            )
          : offlineCheckpointWithCanonicalMetadata,
      );
    return result as {
      readonly jobId: string;
      readonly runId: string;
      readonly caseId: string;
      readonly attemptId: string;
      readonly artifactId: string;
      readonly derivativeCount: number;
      readonly recoveredDerivativeCount: number;
      readonly derivativeSetHash: string;
      readonly checkpointCount: number;
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the shipped Doubao recovery validator accepts a real minimal binary fixture through an injected trusted checkpoint", async () => {
  const result = await runRecoveryFixture("valid");
  assert.deepEqual(
    {
      jobId: result.jobId,
      runId: result.runId,
      caseId: result.caseId,
      attemptId: result.attemptId,
      artifactId: result.artifactId,
      derivativeCount: result.derivativeCount,
      recoveredDerivativeCount: result.recoveredDerivativeCount,
      checkpointCount: result.checkpointCount,
    },
    {
      jobId: "job-doubao-lineage",
      runId: "run-doubao-lineage",
      caseId: "volcano-query-v1",
      attemptId: "attempt-doubao-lineage-1",
      artifactId: "artifact-doubao-lineage",
      derivativeCount: 33,
      recoveredDerivativeCount: 33,
      checkpointCount: 4,
    },
  );
  assert.match(result.derivativeSetHash, /^sha256:[a-f0-9]{64}$/);
});

test("the shipped Doubao recovery validator rejects incomplete or cross-wired production lineage", async (context) => {
  for (const malformedCase of [
    "missing_derivative",
    "duplicate_id",
    "missing_page",
    "wrong_kind",
    "cross_hash_mismatch",
    "wrong_run_spec",
    "wrong_attempt",
    "wrong_artifact",
    "receipt_digest_mismatch",
    "provenance",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runRecoveryFixture(malformedCase),
        /artifact|derivative|render|run specification|checkpoint|receipt|provenance|lineage|PPTX|PNG/i,
      );
    });
  }
});

test("the recovery validator rejects a complete self-consistent bundle not anchored by its independent checkpoint", async () => {
  await assert.rejects(
    runRecoveryFixture("self_forged_bundle"),
    /does not match the harness-owned trusted checkpoint|egress authorization decision is invalid/i,
  );
});

test("the recovery validator rejects a valid bundle presented under the wrong trusted checkpoint", async () => {
  await assert.rejects(
    runRecoveryFixture("wrong_checkpoint"),
    /trusted checkpoint|not allowlisted|schema/i,
  );
});

test("the recovery validator rejects a self-hashed payload with a fake PPTX signature", async () => {
  await assert.rejects(
    runRecoveryFixture("fake_pptx_signature"),
    /OPC|ZIP|PPTX|Artifact/i,
  );
});

test("the recovery validator rejects a self-hashed render with a fake PNG signature", async () => {
  await assert.rejects(
    runRecoveryFixture("fake_png_signature"),
    /must be a decoded, safe PNG raster/i,
  );
});

test("the recovery validator rejects decoded PNG dimensions outside the trusted render checkpoint", async () => {
  await assert.rejects(
    runRecoveryFixture("wrong_png_dimensions"),
    /PNG dimensions do not match the trusted checkpoint/i,
  );
});

test("the recovery validator binds the complete ordered Trace to the independent trusted checkpoint", async (context) => {
  for (const malformedCase of [
    "trace_timestamp_tamper",
    "trace_evidence_tamper",
    "trace_event_omission",
    "trace_event_insertion",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runRecoveryFixture(malformedCase),
        /checkpoint|Trace|trusted/i,
      );
    });
  }
});

test("the recovery validator rejects non-schema checkpoint fields before they can persist credentials or hidden reasoning", async () => {
  await assert.rejects(
    runRecoveryFixture("trace_extra_authorization_field"),
    /checkpoint.*schema|unexpected.*field/i,
  );
});

test("the recovery validator requires manifest execution traceHash to equal the actual persisted checkpoint Trace", async (context) => {
  for (const malformedCase of [
    "manifest_trace_hash_tamper",
    "manifest_trace_hash_missing",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runRecoveryFixture(malformedCase),
        /traceHash|checkpoint Trace|schema/i,
      );
    });
  }
});

test("the recovery validator rejects unknown fields throughout authenticated manifest evidence", async (context) => {
  for (const malformedCase of [
    "manifest_execution_authorization",
    "manifest_execution_hidden_reasoning",
    "manifest_receipt_pollution",
    "manifest_root_hidden_reasoning",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runRecoveryFixture(malformedCase),
        /schema|unexpected field|canonical hash|attested payload hash/i,
      );
    });
  }
});

test("the recovery validator rejects a self-hashed replacement Query and unknown Run Specification fields", async (context) => {
  for (const malformedCase of [
    "run_spec_prompt_swap",
    "run_spec_hidden_authorization",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runRecoveryFixture(malformedCase),
        /Run Specification|evaluation Case|trusted checkpoint|schema/i,
      );
    });
  }
});

test("the recovery validator rejects unknown render-manifest fields", async () => {
  await assert.rejects(
    runRecoveryFixture("render_manifest_extra_field"),
    /render manifest.*(?:schema|canonical hash|attested payload hash)|unexpected field/i,
  );
});

test("the recovery validator recursively rejects duplicate keys in every authenticated JSON or JSONL input", async (context) => {
  for (const malformedCase of [
    "checkpoint_duplicate_evidence_key",
    "manifest_nested_duplicate_key",
    "run_spec_nested_duplicate_key",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runRecoveryFixture(malformedCase),
        /duplicate object key|JSON is invalid|checkpoint line/i,
      );
    });
  }
});

test("the recovery validator rejects self-hashed authenticated metadata changes not attested by checkpoint policy", async (context) => {
  for (const malformedCase of [
    "artifact_metadata_tamper",
    "render_manifest_metadata_tamper",
    "run_spec_package_tamper",
  ] as const) {
    await context.test(malformedCase, async () => {
      await assert.rejects(
        runRecoveryFixture(malformedCase),
        /attested payload hash|canonical hash|trusted checkpoint/i,
      );
    });
  }
});

test("the recovery validator rejects a safely formatted replacement renderer decision even when manifest hashes are recomputed", async () => {
  await assert.rejects(
    runRecoveryFixture("render_authorization_decision_tamper"),
    /renderer authorization decision.*trusted checkpoint audit/i,
  );
});

test("the production CLI rejects the offline fixture checkpoint before reading recovery stores", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/recover-doubao-production-run.ts",
        "unused-registry",
        "root:artifact",
        "root:specification",
        "root:checkpoint",
        "unused-artifact-store",
        "artifacts/unused/manifest",
        "artifacts/unused/original",
        "unused-specification-store",
        "run-specifications/unused",
        "unused-checkpoint-store",
        "unused-attempt",
        OFFLINE_RECOVERY_FIXTURE_CHECKPOINT_ID,
      ],
      { cwd: new URL("..", import.meta.url).pathname },
    ),
    /requires the real-provider trusted checkpoint/i,
  );
});

test("checked-in evidence records a successful allowlisted v30 replay under the current verifier", async () => {
  const evidenceSource = await readFile(
    new URL(
      "../evidence/doubao-v30-current-verifier-recovery.json",
      import.meta.url,
    ),
    "utf8",
  );
  const evidence =
    parseDoubaoCurrentVerifierRecoveryEvidence(evidenceSource);
  const rawRecoveryCliResultSource = (
    await readFile(
      new URL(
        "../evidence/doubao-v30-final-recovery-cli-result.json",
        import.meta.url,
      ),
      "utf8",
    )
  ).trim();
  const rawRecoveryCliResult = parseDoubaoRecoveryCliResult(
    rawRecoveryCliResultSource,
  );
  const trustedCheckpoint = trustedDoubaoRecoveryCheckpoint(
    DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
  );

  assert.deepEqual(evidence, {
    schemaVersion:
      "doubao-current-verifier-trusted-recovery-evidence-v1",
    status: "recovery_succeeded",
    recordedOn: "2026-07-31",
    timingBasis: "date_only_unobserved_exact_time",
    registryId: "doubao-real-provider-20260730-t09-v30",
    checkpointId: DOUBAO_REAL_PROVIDER_RECOVERY_CHECKPOINT_ID,
    artifactContentHash:
      "sha256:ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4",
    artifactManifestHash:
      "sha256:1697e0128db2880c3bf7de7dc7fc03d376582d0bc16b3e293fbe68229c12a53a",
    renderManifestHash:
      "sha256:6daf8702f7007148336931dca858f1b01dc288832545f9ae5bf534a3be2c32f0",
    runSpecificationHash:
      "sha256:4ede5e5c3f8b3ce1e17163658d742004fd7436136b715f6046689bef2c872b3b",
    checkpointTraceHash:
      "sha256:f2b51f7de6b15d9676ee3d345ba406be0f7aeb42a10443e2c0d562fe2508ca0d",
    evaluatedRunIdentity: {
      specCommitSha: trustedCheckpoint.evaluatedSpecCommitSha,
      buildIdentitySource:
        trustedCheckpoint.evaluatedBuildIdentitySource,
      runnerCodeDigest: trustedCheckpoint.runnerCodeDigest,
      runSpecificationCanonicalHash:
        trustedCheckpoint.runSpecificationCanonicalHash,
    },
    verifierBuildIdentity: BUILD_IDENTITY,
    rendererAuthorizationEvidence: {
      decisionId:
        trustedCheckpoint.rendererAuthorizationDecision.decisionId,
      authorizationAuditDigest:
        trustedCheckpoint.rendererAuthorizationAuditDigest,
      requestId:
        trustedCheckpoint.rendererAuthorizationDecision.request
          .requestId,
      targetService:
        trustedCheckpoint.rendererAuthorizationDecision.request
          .targetService,
      targetAccount:
        trustedCheckpoint.rendererAuthorizationDecision.request
          .targetAccount,
      targetRegion:
        trustedCheckpoint.rendererAuthorizationDecision.request
          .targetRegion,
      payloadHash:
        trustedCheckpoint.rendererAuthorizationDecision.request
          .payloadHash,
      policyVersion:
        trustedCheckpoint.rendererAuthorizationDecision.policyVersion,
      approvedAt:
        trustedCheckpoint.rendererAuthorizationDecision.approvedAt,
      expiresAt:
        trustedCheckpoint.rendererAuthorizationDecision.expiresAt,
    },
    binaryValidation: {
      pptxSlideCount: 16,
      staticPngCount: 16,
      contactSheetPngCount: 1,
    },
    recoveryCliEvidence: {
      schemaVersion: "doubao-recovery-cli-evidence-v1",
      rawResultReference:
        "evidence/doubao-v30-final-recovery-cli-result.json",
      rawResultHash:
        "sha256:REPLACE_AFTER_POST_FREEZE_REAL_CLI_RUN",
      rawResultVerifierBuildIdentity: BUILD_IDENTITY,
      attestedResultSchemaVersion:
        "doubao-recovery-result-attestation-v1",
      attestedResultHash:
        "sha256:REPLACE_AFTER_POST_FREEZE_REAL_CLI_RUN",
      attestedResultVerifierBuildIdentity: BUILD_IDENTITY,
    },
    resultHash:
      "sha256:cb58b001e4eb7523e0bfe2b172e64bdf0b7cbd59943a543b57727a79f912358a",
  });
  assert.notEqual(
    evidence.evaluatedRunIdentity.specCommitSha,
    evidence.verifierBuildIdentity.specCommitSha,
  );
  assert.deepEqual(
    rawRecoveryCliResult.verifierBuildIdentity,
    evidence.recoveryCliEvidence.rawResultVerifierBuildIdentity,
  );
  assert.deepEqual(
    rawRecoveryCliResult.verifierBuildIdentity,
    evidence.recoveryCliEvidence
      .attestedResultVerifierBuildIdentity,
  );
  assert.equal(
    evidence.recoveryCliEvidence.rawResultHash,
    hash(encoder.encode(rawRecoveryCliResultSource)),
  );
  assert.equal(
    evidence.recoveryCliEvidence.attestedResultHash,
    hash(
      canonicalJsonBytes(
        doubaoRecoveryResultAttestedView(rawRecoveryCliResult),
      ),
    ),
  );
  assert.equal(
    evidence.resultHash,
    hash(
      canonicalJsonBytes(
        currentVerifierRecoveryEvidenceAttestedView(evidence),
      ),
    ),
  );
});

test("current-verifier recovery evidence rejects duplicate and unknown authenticated fields", async () => {
  const evidenceSource = await readFile(
    new URL(
      "../evidence/doubao-v30-current-verifier-recovery.json",
      import.meta.url,
    ),
    "utf8",
  );
  const duplicateRootKey = evidenceSource.replace(
    "{",
    '{\n  "status": "recovery_succeeded",',
  );
  const unknownRootField = evidenceSource.replace(
    "{",
    '{\n  "unexpectedRoot": "untrusted",',
  );
  const unknownNestedField = evidenceSource.replace(
    '"evaluatedRunIdentity": {',
    '"evaluatedRunIdentity": {\n    "unexpectedNested": "untrusted",',
  );
  const unknownRecoveryCliEvidenceField = evidenceSource.replace(
    '"recoveryCliEvidence": {',
    '"recoveryCliEvidence": {\n    "unexpectedNested": "untrusted",',
  );

  assert.throws(
    () =>
      parseDoubaoCurrentVerifierRecoveryEvidence(duplicateRootKey),
    /duplicate object key "status"/i,
  );
  assert.throws(
    () =>
      parseDoubaoCurrentVerifierRecoveryEvidence(unknownRootField),
    /unexpected field "unexpectedRoot".*recovery evidence/i,
  );
  assert.throws(
    () =>
      parseDoubaoCurrentVerifierRecoveryEvidence(unknownNestedField),
    /unexpected field "unexpectedNested".*evaluatedRunIdentity/i,
  );
  assert.throws(
    () =>
      parseDoubaoCurrentVerifierRecoveryEvidence(
        unknownRecoveryCliEvidenceField,
      ),
    /unexpected field "unexpectedNested".*recoveryCliEvidence/i,
  );
});
