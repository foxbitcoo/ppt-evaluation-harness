import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import type {
  Artifact,
  ObservableAttemptEvent,
  SubmissionEvidence,
} from "./domain.ts";
import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
} from "./environment-origin.ts";
import {
  parseAdapterExecutionConfiguration,
  type AttemptCheckpointPort,
  type ProductAdapterExecutionConfiguration,
  type ProductAdapterExecutor,
  type ProductAdapterImplementationPackage,
  type ProductAdapterPort,
  type ProductExperienceConfiguration,
  type ProductPackageSnapshot,
  type ProductRunCommand,
  type SafeRasterCandidate,
} from "./product-adapter.ts";
import {
  resolveRegisteredWpsAiPptBrowserDriver,
  type WpsAiPptBrowserDriverPort,
} from "./wps-aippt-driver.ts";

export const WPS_AIPPT_URL = "https://aippt.wps.cn/aippt/" as const;
export const WPS_AIPPT_ADAPTER_VERSION = "wps-aippt-browser@1" as const;

const textEncoder = new TextEncoder();
const adapterModuleContent = readFileSync(new URL(import.meta.url));
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SENSITIVE_TRACE_PATTERN =
  /cookie|authorization|bearer|access[_ -]?token|refresh[_ -]?token|localstorage|sessionstorage|session[_ -]?id|password|secret|wps[_ -]?sid|chain[_ -]?of[_ -]?thought|hidden[_ -]?(?:reasoning|thought)/i;

export const WPS_AIPPT_EXPERIENCE_CONFIGURATION:
  ProductExperienceConfiguration = Object.freeze({
    productUrl: WPS_AIPPT_URL,
    accountScope: "current_authenticated_account",
    accountIdentityObservation: "unknown",
    commercialPlanObservation: "unknown",
    packageSelection: "best_available_zero_incremental_cost",
    incrementalCost: 0,
    mode: "professional",
    networking: "enabled",
    pageCount: 16,
  });

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function implementationPackage(): ProductAdapterImplementationPackage {
  const content = Uint8Array.from(adapterModuleContent);
  return Object.freeze({
    packageName: "src/wps-aippt.ts#WpsAiPptProductAdapter",
    contentHash: sha256(content),
    content,
  });
}

function executionConfigurationPackage():
  ProductAdapterImplementationPackage {
  const content = textEncoder.encode(
    JSON.stringify({
      adapterKind: "wps-aippt-browser",
      scenario: "production",
      schemaVersion:
        "product-adapter-execution-configuration-v1",
    }),
  );
  return Object.freeze({
    packageName:
      "wps-aippt-execution-configuration#wps-aippt-browser",
    contentHash: sha256(content),
    content,
  });
}

export interface WpsAiPptObservedConfiguration
  extends ProductExperienceConfiguration {
  readonly evidenceIds: readonly `ev_${string}`[];
}

export interface WpsAiPptBrowserEvent {
  readonly eventType: string;
  readonly sourceAt: string;
  readonly observedAt: string;
  readonly evidenceId: `ev_${string}`;
  readonly sourceUrl: string | null;
  readonly submissionEvidenceAtCheckpoint: SubmissionEvidence;
}

export interface WpsAiPptBrowserCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly evaluationProvenance: "MOCK" | "PRODUCTION";
  readonly url: typeof WPS_AIPPT_URL;
  readonly prompt: string;
  readonly accountScope: "current_authenticated_account";
  readonly packageSelection:
    "best_available_zero_incremental_cost";
  readonly mode: "professional";
  readonly networking: "enabled";
  readonly pageCount: 16;
}

export interface WpsAiPptBrowserArtifactCapture {
  readonly filename: string;
  readonly mimeType: typeof PPTX_MIME_TYPE;
  readonly content: Uint8Array;
  readonly pageCount: 16;
  readonly capturedAt: string;
}

export interface WpsAiPptBrowserStaticSlide {
  readonly pageNumber: number;
  readonly filename: string;
  readonly mimeType: "image/png";
  readonly content: Uint8Array;
  readonly extractedText: string;
}

export interface WpsAiPptBrowserRenderCapture {
  readonly renderer: string;
  readonly fontPack: string;
  readonly resolution: string;
  readonly colorProfile: string;
  readonly redactionStatus: "passed";
  readonly renderOutcome: "faithful" | "degraded";
  readonly fidelity: {
    readonly status: "verified" | "degraded" | "unknown";
    readonly notes: readonly string[];
  };
  readonly slides: readonly WpsAiPptBrowserStaticSlide[];
  readonly contactSheet: {
    readonly filename: string;
    readonly mimeType: "image/png";
    readonly content: Uint8Array;
  };
}

interface WpsAiPptBrowserResultBase {
  readonly submissionEvidence: SubmissionEvidence;
  readonly elapsedMs: number;
  readonly events: readonly WpsAiPptBrowserEvent[];
  readonly manualActions: readonly string[];
}

export interface WpsAiPptCapturedBrowserResult
  extends WpsAiPptBrowserResultBase {
  readonly outcome: "captured";
  readonly observedConfiguration: WpsAiPptObservedConfiguration;
  readonly artifact: WpsAiPptBrowserArtifactCapture;
  readonly render: WpsAiPptBrowserRenderCapture;
}

export interface WpsAiPptFailedBrowserResult
  extends WpsAiPptBrowserResultBase {
  readonly outcome:
    | "vendor_timeout"
    | "technical_failure"
    | "payment"
    | "quota"
    | "authentication"
    | "captcha"
    | "capacity"
    | "ui_drift"
    | "export_failure"
    | "download_failure"
    | "task_state_unknown"
    | "human_wait";
}

export type WpsAiPptBrowserResult =
  | WpsAiPptCapturedBrowserResult
  | WpsAiPptFailedBrowserResult;

function assertRegisteredImplementationPackage(
  implementation: ProductAdapterImplementationPackage,
): void {
  const expected = implementationPackage();
  if (
    implementation.packageName !== expected.packageName ||
    implementation.contentHash !== expected.contentHash ||
    !Buffer.from(implementation.content).equals(
      Buffer.from(expected.content),
    )
  ) {
    throw new Error(
      "Product Adapter implementation package is not registered for wps-aippt-browser:production",
    );
  }
}

function assertSafeTraceValue(value: string, label: string): void {
  if (
    value.trim().length === 0 ||
    value.length > 512 ||
    SENSITIVE_TRACE_PATTERN.test(value)
  ) {
    throw new Error(`WPS browser ${label} is not safe to persist`);
  }
}

function sanitizedSourceUrl(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error("WPS browser event URL must use HTTPS");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function observableEvents(
  command: ProductRunCommand,
  events: readonly WpsAiPptBrowserEvent[],
  checkpointStore: AttemptCheckpointPort | undefined,
): Promise<readonly ObservableAttemptEvent[]> {
  const persisted: ObservableAttemptEvent[] = [];
  for (const [index, event] of events.entries()) {
      assertSafeTraceValue(event.eventType, "event type");
      if (!/^ev_[a-f0-9]{16,64}$/.test(event.evidenceId)) {
        throw new Error("WPS browser evidence ID must be opaque");
      }
      if (
        !Number.isFinite(Date.parse(event.sourceAt)) ||
        !Number.isFinite(Date.parse(event.observedAt))
      ) {
        throw new Error("WPS browser event timestamps are invalid");
      }
      const checkpoint = Object.freeze({
        eventId: `${command.attemptId}-wps-event-${index + 1}`,
        jobId: command.jobId,
        caseId: command.evaluationCase.caseId,
        runId: command.runId,
        attemptId: command.attemptId,
        attemptSeq: command.attemptSeq,
        eventType: event.eventType,
        sourceAt: event.sourceAt,
        observedAt: event.observedAt,
        writerId: WPS_AIPPT_ADAPTER_VERSION,
        evidenceRef: event.evidenceId,
        sourceUrl: sanitizedSourceUrl(event.sourceUrl),
        submissionEvidenceAtCheckpoint:
          event.submissionEvidenceAtCheckpoint,
      });
      await checkpointStore?.append(checkpoint);
      persisted.push(checkpoint);
  }
  return Object.freeze(persisted);
}

function checkedManualActions(
  manualActions: readonly string[],
): readonly string[] {
  return Object.freeze(
    manualActions.map((action) => {
      assertSafeTraceValue(action, "manual action");
      return action;
    }),
  );
}

function assertObservedConfiguration(
  observed: WpsAiPptObservedConfiguration,
): void {
  const { evidenceIds, ...configuration } = observed;
  if (
    JSON.stringify(configuration) !==
      JSON.stringify(WPS_AIPPT_EXPERIENCE_CONFIGURATION) ||
    evidenceIds.length === 0
  ) {
    throw new Error(
      "WPS browser did not prove the frozen production configuration",
    );
  }
  for (const evidenceId of evidenceIds) {
    if (!/^ev_[a-f0-9]{16,64}$/.test(evidenceId)) {
      throw new Error("WPS configuration evidence ID must be opaque");
    }
  }
}

interface ValidatedZipEntry {
  readonly name: string;
  readonly content: Uint8Array;
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

function validatedZipEntries(content: Uint8Array): readonly ValidatedZipEntry[] {
  const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
  const MAX_ENTRY_COUNT = 4_096;
  const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
  const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
  const MAX_COMPRESSION_RATIO = 200;
  if (content.byteLength < 22 || content.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("WPS Artifact ZIP size is outside the safe limit");
  }
  const view = new DataView(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  let endOffset = -1;
  const lowerBound = Math.max(0, content.byteLength - 65_557);
  for (let offset = content.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) {
    throw new Error("WPS Artifact is not an openable PPTX ZIP");
  }
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true);
  const diskEntryCount = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectorySize = view.getUint32(endOffset + 12, true);
  let offset = view.getUint32(endOffset + 16, true);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0 ||
    entryCount > MAX_ENTRY_COUNT ||
    offset + centralDirectorySize > endOffset
  ) {
    throw new Error("WPS Artifact ZIP central directory is unsafe");
  }
  const entries: ValidatedZipEntry[] = [];
  const names = new Set<string>();
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > content.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new Error("WPS Artifact central directory is invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > content.byteLength) {
      throw new Error("WPS Artifact central directory is truncated");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      content.subarray(nameStart, nameEnd),
    );
    if (
      name.length === 0 ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      names.has(name) ||
      (flags & 0x1) !== 0 ||
      (compressionMethod !== 0 && compressionMethod !== 8) ||
      uncompressedSize > MAX_ENTRY_BYTES ||
      totalUncompressedBytes + uncompressedSize >
        MAX_TOTAL_UNCOMPRESSED_BYTES ||
      (compressedSize === 0
        ? uncompressedSize !== 0
        : uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO)
    ) {
      throw new Error(`WPS Artifact ZIP entry is unsafe: ${name}`);
    }
    names.add(name);
    if (
      localHeaderOffset + 30 > content.byteLength ||
      view.getUint32(localHeaderOffset, true) !== 0x04034b50
    ) {
      throw new Error(`WPS Artifact local ZIP header is invalid: ${name}`);
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const localNameStart = localHeaderOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(
      content.subarray(localNameStart, localNameEnd),
    );
    const compressedStart = localNameEnd + localExtraLength;
    const compressedEnd = compressedStart + compressedSize;
    if (
      localFlags !== flags ||
      localMethod !== compressionMethod ||
      localName !== name ||
      compressedEnd > content.byteLength ||
      compressedEnd > offset
    ) {
      throw new Error(`WPS Artifact local ZIP header mismatch: ${name}`);
    }
    const compressed = content.subarray(compressedStart, compressedEnd);
    let uncompressed: Uint8Array;
    try {
      uncompressed =
        compressionMethod === 0
          ? Uint8Array.from(compressed)
          : Uint8Array.from(
              inflateRawSync(compressed, {
                maxOutputLength: MAX_ENTRY_BYTES,
              }),
            );
    } catch {
      throw new Error(`WPS Artifact ZIP entry cannot be opened: ${name}`);
    }
    if (
      uncompressed.byteLength !== uncompressedSize ||
      crc32(uncompressed) !== expectedCrc
    ) {
      throw new Error(`WPS Artifact ZIP CRC mismatch: ${name}`);
    }
    totalUncompressedBytes += uncompressed.byteLength;
    entries.push(Object.freeze({ name, content: uncompressed }));
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== view.getUint32(endOffset + 16, true) + centralDirectorySize) {
    throw new Error("WPS Artifact ZIP central directory length mismatch");
  }
  return Object.freeze(entries);
}

function validatedOpcSlideNames(
  content: Uint8Array,
): readonly string[] {
  const entries = validatedZipEntries(content);
  const byName = new Map(entries.map((entry) => [entry.name, entry.content]));
  const required = [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
  ];
  if (required.some((name) => !byName.has(name))) {
    throw new Error("WPS Artifact OPC package is missing required parts");
  }
  if (
    entries.some(({ name }) =>
      /(?:^|\/)(?:vbaproject\.bin|vbaData\.xml)$/i.test(name),
    ) ||
    entries.some(({ name }) => /^ppt\/embeddings\//i.test(name))
  ) {
    throw new Error("WPS Artifact OPC package contains active content");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const contentTypes = decoder.decode(byName.get("[Content_Types].xml"));
  if (
    !contentTypes.includes(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    ) ||
    /macroEnabled|vbaProject/i.test(contentTypes)
  ) {
    throw new Error("WPS Artifact OPC content types are unsafe");
  }
  for (const entry of entries.filter(({ name }) => /\.rels$/i.test(name))) {
    const relationships = decoder.decode(entry.content);
    if (
      /TargetMode\s*=\s*["']External["']/i.test(relationships) ||
      /Target\s*=\s*["'](?:https?|file|ftp):/i.test(relationships)
    ) {
      throw new Error("WPS Artifact OPC external relationship is forbidden");
    }
  }
  const presentationRelationships = decoder.decode(
    byName.get("ppt/_rels/presentation.xml.rels"),
  );
  const slideTargets = [
    ...presentationRelationships.matchAll(
      /<Relationship\b(?=[^>]*\bType=["'][^"']*\/slide["'])(?=[^>]*\bTarget=["']slides\/(slide\d+\.xml)["'])[^>]*\/?>/gi,
    ),
  ].map((match) => `ppt/slides/${match[1]}`);
  if (
    slideTargets.length !== 16 ||
    new Set(slideTargets).size !== 16 ||
    slideTargets.some((name) => !byName.has(name))
  ) {
    throw new Error(
      "WPS Artifact OPC presentation relationships do not resolve exactly 16 slides",
    );
  }
  return Object.freeze(slideTargets);
}

function assertOpenableSixteenPagePptx(
  artifact: WpsAiPptBrowserArtifactCapture,
): void {
  if (
    artifact.mimeType !== PPTX_MIME_TYPE ||
    !/\.pptx$/i.test(artifact.filename) ||
    artifact.content.byteLength === 0 ||
    artifact.pageCount !== 16 ||
    !Number.isFinite(Date.parse(artifact.capturedAt))
  ) {
    throw new Error("WPS Artifact metadata is invalid");
  }
  const slideNames = validatedOpcSlideNames(artifact.content);
  if (slideNames.length !== 16) {
    throw new Error(
      `WPS Artifact page count mismatch: expected 16, found ${slideNames.length}`,
    );
  }
}

function capturedResult(
  command: ProductRunCommand,
  driver: WpsAiPptBrowserDriverPort,
  result: WpsAiPptCapturedBrowserResult,
): {
  readonly artifact: Artifact;
  readonly safeRasterCandidate: SafeRasterCandidate;
} {
  assertObservedConfiguration(result.observedConfiguration);
  assertOpenableSixteenPagePptx(result.artifact);
  if (
    result.render.redactionStatus !== "passed" ||
    result.render.slides.length !== 16 ||
    result.render.renderer.trim().length === 0 ||
    result.render.contactSheet.mimeType !== "image/png"
  ) {
    throw new Error("WPS static render capture is invalid");
  }
  const contentHash = sha256(result.artifact.content);
  const provenance =
    driver.provenance === "PRODUCTION" ? "PRODUCTION" : "MOCK";
  const environmentOrigin =
    driver.provenance === "PRODUCTION"
      ? PRODUCTION_ENVIRONMENT_ORIGIN
      : MOCK_TEST_ENVIRONMENT_ORIGIN;
  const artifact: Artifact = Object.freeze({
    artifactId: `${command.attemptId}-artifact-${contentHash.slice(7, 23)}`,
    runId: command.runId,
    provenance,
    environmentOrigin,
    filename: result.artifact.filename,
    mimeType: result.artifact.mimeType,
    byteSize: result.artifact.content.byteLength,
    pageCount: result.artifact.pageCount,
    contentHash,
    capturedAt: result.artifact.capturedAt,
    content: Uint8Array.from(result.artifact.content),
  });
  const safeRasterCandidate: SafeRasterCandidate = Object.freeze({
    renderer: result.render.renderer,
    fontPack: result.render.fontPack,
    resolution: result.render.resolution,
    colorProfile: result.render.colorProfile,
    renderOutcome: result.render.renderOutcome,
    fidelity: Object.freeze({
      status: result.render.fidelity.status,
      notes: Object.freeze([...result.render.fidelity.notes]),
    }),
    slides: Object.freeze(
      result.render.slides.map((slide) =>
        Object.freeze({
          ...slide,
          content: Uint8Array.from(slide.content),
        }),
      ),
    ),
    contactSheet: {
      filename: result.render.contactSheet.filename,
      mimeType: "image/png" as const,
      content: Uint8Array.from(result.render.contactSheet.content),
    },
  });
  return {
    artifact,
    safeRasterCandidate,
  };
}

export function resolveWpsAiPptProductAdapterExecutor(
  implementation: ProductAdapterImplementationPackage,
  executionConfiguration: ProductAdapterExecutionConfiguration,
  browserDriver: WpsAiPptBrowserDriverPort | undefined,
  checkpointStore?: AttemptCheckpointPort,
): ProductAdapterExecutor {
  if (
    executionConfiguration.adapterKind !== "wps-aippt-browser" ||
    executionConfiguration.scenario !== "production"
  ) {
    throw new Error("WPS adapter execution configuration is invalid");
  }
  assertRegisteredImplementationPackage(implementation);
  if (browserDriver === undefined) {
    throw new Error(
      "WPS production adapter requires an explicit browser driver",
    );
  }
  const runBrowser = resolveRegisteredWpsAiPptBrowserDriver(browserDriver);
  return Object.freeze(async (command: ProductRunCommand) => {
    if (
      command.evaluationCase.targetPageCount !== 16 ||
      command.timeoutMs > 30 * 60 * 1_000
    ) {
      throw new Error(
        "WPS production adapter supports only the frozen 16-page, 30-minute protocol",
      );
    }
    const result = await runBrowser({
      jobId: command.jobId,
      runId: command.runId,
      attemptId: command.attemptId,
      attemptSeq: command.attemptSeq,
      timeoutMs: command.timeoutMs,
      signal: command.signal,
      evaluationProvenance: command.evaluationCase.provenance,
      url: WPS_AIPPT_URL,
      prompt: command.evaluationCase.vendorPrompt,
      accountScope: "current_authenticated_account",
      packageSelection: "best_available_zero_incremental_cost",
      mode: "professional",
      networking: "enabled",
      pageCount: 16,
    });
    const events = await observableEvents(
      command,
      result.events,
      checkpointStore,
    );
    if (
      result.outcome === "task_state_unknown" &&
      !events.some(
        ({ eventType, submissionEvidenceAtCheckpoint }) =>
          eventType === "task_reconciliation_checked" &&
          submissionEvidenceAtCheckpoint === "unknown",
      )
    ) {
      throw new Error(
        "WPS unknown task state requires an explicit reconciliation checkpoint",
      );
    }
    const manualActions = checkedManualActions(result.manualActions);
    if (result.outcome !== "captured") {
      return {
        terminalReason: result.outcome,
        blockReason:
          result.outcome === "payment" ||
          result.outcome === "quota" ||
          result.outcome === "authentication"
            ? result.outcome
            : null,
        submissionEvidence: result.submissionEvidence,
        elapsedMs: result.elapsedMs,
        artifactCandidates: [],
        observableEvents: events,
        manualActions,
      };
    }
    if (result.submissionEvidence !== "submitted") {
      throw new Error(
        "WPS captured Artifact requires submitted evidence",
      );
    }
    const { artifact, safeRasterCandidate } = capturedResult(
      command,
      browserDriver,
      result,
    );
    return {
      terminalReason: "success",
      blockReason: null,
      submissionEvidence: result.submissionEvidence,
      elapsedMs: result.elapsedMs,
      artifactCandidates: [
        {
          artifact,
          safeRasterCandidate,
          policyCompliant: true,
        },
      ],
      observableEvents: events,
      manualActions,
    };
  });
}

export class WpsAiPptProductAdapter implements ProductAdapterPort {
  readonly implementationPackage = implementationPackage();
  readonly executionConfigurationPackage =
    executionConfigurationPackage();
  readonly executionConfiguration: ProductAdapterExecutionConfiguration =
    parseAdapterExecutionConfiguration(
      this.executionConfigurationPackage,
    );
  readonly productPackage: ProductPackageSnapshot = Object.freeze({
    packageId: "wps-aippt-best-zero-incremental-cost-v1",
    vendorId: "wps",
    displayName: "WPS AI PPT",
    adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
    provenance: "PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    egressDestination: {
      targetService: "wps-aippt-web",
      targetAccount: "current-authenticated-account",
      targetRegion: "cn",
      subprocessors: [],
    },
    experienceConfiguration: WPS_AIPPT_EXPERIENCE_CONFIGURATION,
  });
}
