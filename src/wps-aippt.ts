import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";

import type {
  Artifact,
  ObservableAttemptEvent,
  SubmissionEvidence,
  TerminalReason,
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
  type AccountCategoryObservation,
  type CommercialPlanObservation,
  type ProductExperienceConfiguration,
  type ProductPackageSnapshot,
  type ProductionDriverExecutionEvidence,
  type ProductRunCommand,
  type SafeRasterCandidate,
} from "./product-adapter.ts";
import {
  reconcileRegisteredWpsAiPptTask,
  resolveRegisteredWpsAiPptBrowserDriver,
  type WpsAiPptBrowserDriverPort,
} from "./wps-aippt-driver.ts";

export const WPS_AIPPT_URL = "https://aippt.wps.cn/aippt/" as const;
export const WPS_AIPPT_ADAPTER_VERSION = "wps-aippt-browser@1" as const;

const textEncoder = new TextEncoder();
interface StructuredXmlAttribute {
  readonly uri: string;
  readonly local: string;
  readonly value: string;
}
interface StructuredXmlTag {
  readonly uri: string;
  readonly local: string;
  readonly attributes: Record<string, StructuredXmlAttribute>;
}
interface StructuredXmlParser {
  on(event: "opentag", listener: (tag: StructuredXmlTag) => void): void;
  on(event: "closetag", listener: () => void): void;
  write(xml: string): StructuredXmlParser;
  close(): StructuredXmlParser;
}
const { SaxesParser } = createRequire(import.meta.url)("saxes") as {
  readonly SaxesParser: new (options: {
    readonly xmlns: true;
  }) => StructuredXmlParser;
};
const adapterModuleContent = readFileSync(new URL(import.meta.url));
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SENSITIVE_TRACE_PATTERN =
  /cookie|authorization|bearer|access[_ -]?token|refresh[_ -]?token|localstorage|sessionstorage|session[_ -]?id|password|secret|wps[_ -]?sid|chain[_ -]?of[_ -]?thought|hidden[_ -]?(?:reasoning|thought)/i;

export const WPS_AIPPT_EXPERIENCE_CONFIGURATION:
  ProductExperienceConfiguration = Object.freeze({
    productUrl: WPS_AIPPT_URL,
    accountScope: "current_authenticated_account",
    accountObservationPolicy:
      "observe_category_or_record_ui_unavailable",
    commercialPlanObservationPolicy:
      "observe_plan_name_or_record_ui_unavailable",
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

function executionConfigurationPackage(
  scenario: "production-live" | "production-replay",
):
  ProductAdapterImplementationPackage {
  const content = textEncoder.encode(
    JSON.stringify({
      adapterKind: "wps-aippt-browser",
      scenario,
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
  readonly accountCategoryObservation: AccountCategoryObservation;
  readonly commercialPlanObservation: CommercialPlanObservation;
}

export interface WpsAiPptBrowserEvent {
  readonly eventType: string;
  readonly sourceAt: string;
  readonly observedAt: string;
  readonly evidenceId: `ev_${string}`;
  readonly sourceUrl: string | null;
  readonly submissionEvidenceAtCheckpoint: SubmissionEvidence;
  readonly vendorTaskId: `task_${string}` | null;
  readonly taskStateVersion: string | null;
  readonly adapterVersion: typeof WPS_AIPPT_ADAPTER_VERSION;
  readonly artifactId: string | null;
  readonly reconciliationObservedState?:
    | "unknown"
    | "submitted"
    | "artifact_ready"
    | "failed";
  readonly reconciliationTerminalReason?: TerminalReason;
  readonly reconciliationArtifactReference?: string | null;
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
  readonly productionExecutionEvidence?: ProductionDriverExecutionEvidence;
}

export interface WpsAiPptCapturedBrowserResult
  extends WpsAiPptBrowserResultBase {
  readonly outcome: "captured";
  readonly observedConfiguration: WpsAiPptObservedConfiguration;
  readonly artifact: WpsAiPptBrowserArtifactCapture;
  readonly render?: WpsAiPptBrowserRenderCapture;
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
  if (/^urn:wps-evidence:ev_[a-f0-9]{16,64}$/.test(value)) {
    return value;
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error("WPS browser event URL must use HTTPS");
  }
  if (
    /(?:^|\/)[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\/|$)/.test(
      parsed.pathname,
    )
  ) {
    throw new Error("WPS browser event URL contains a JWT-like path");
  }
  const allowed =
    (parsed.origin === "https://aippt.wps.cn" &&
      /^\/aippt\/?$/.test(parsed.pathname)) ||
    (parsed.origin === "https://365.kdocs.cn" &&
      parsed.pathname === "/l/redacted");
  if (!allowed) {
    throw new Error(
      "WPS browser event URL is not an allowlisted WPS URL",
    );
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function observableEvent(
  command: ProductRunCommand,
  event: WpsAiPptBrowserEvent,
  index: number,
  checkpointStore: AttemptCheckpointPort | undefined,
): Promise<ObservableAttemptEvent> {
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
      if (
        (event.vendorTaskId !== null &&
          !/^task_[a-z0-9_-]{8,128}$/.test(event.vendorTaskId)) ||
        (event.taskStateVersion !== null &&
          (event.taskStateVersion.length > 128 ||
            event.taskStateVersion.trim().length === 0)) ||
        event.adapterVersion !== WPS_AIPPT_ADAPTER_VERSION ||
        (event.artifactId !== null &&
          !/^[a-z0-9][a-z0-9._:-]{7,255}$/i.test(event.artifactId))
      ) {
        throw new Error(
          "WPS browser checkpoint task, adapter, or Artifact identity is invalid",
        );
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
        vendorTaskId: event.vendorTaskId,
        taskStateVersion: event.taskStateVersion,
        adapterVersion: event.adapterVersion,
        artifactId: event.artifactId,
        ...(event.reconciliationObservedState === undefined
          ? {}
          : {
              reconciliationObservedState:
                event.reconciliationObservedState,
            }),
        ...(event.reconciliationTerminalReason === undefined
          ? {}
          : {
              reconciliationTerminalReason:
                event.reconciliationTerminalReason,
            }),
        ...(event.reconciliationArtifactReference === undefined
          ? {}
          : {
              reconciliationArtifactReference:
                event.reconciliationArtifactReference,
            }),
      });
      await checkpointStore?.append(checkpoint);
      return checkpoint;
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

function terminalReasonForReconciliation(
  observedState: WpsAiPptBrowserEvent["reconciliationObservedState"],
): "task_state_unknown" | "download_failure" | "technical_failure" {
  if (observedState === "artifact_ready") return "download_failure";
  if (observedState === "failed") return "technical_failure";
  return "task_state_unknown";
}

function artifactReferenceForReconciliation(
  observedState: WpsAiPptBrowserEvent["reconciliationObservedState"],
  vendorTaskId: string,
): string | null {
  return observedState === "artifact_ready"
    ? `wps-task:${vendorTaskId}`
    : null;
}

function assertObservedConfiguration(
  observed: WpsAiPptObservedConfiguration,
): void {
  const {
    evidenceIds,
    accountCategoryObservation,
    commercialPlanObservation,
    ...configuration
  } = observed;
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
  for (const observation of [
    accountCategoryObservation,
    commercialPlanObservation,
  ]) {
    if (
      !evidenceIds.includes(observation.evidenceId) ||
      !/^ev_[a-f0-9]{16,64}$/.test(observation.evidenceId)
    ) {
      throw new Error(
        "WPS account and plan observations require opaque evidence",
      );
    }
    if (observation.status === "ui_unavailable") {
      assertSafeTraceValue(observation.reason, "UI unavailable reason");
    }
  }
  if (
    commercialPlanObservation.status === "observed" &&
    (commercialPlanObservation.planName.length > 64 ||
      SENSITIVE_TRACE_PATTERN.test(commercialPlanObservation.planName))
  ) {
    throw new Error("WPS commercial plan observation is unsafe");
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
    const localCrc = view.getUint32(localHeaderOffset + 14, true);
    const localCompressedSize = view.getUint32(
      localHeaderOffset + 18,
      true,
    );
    const localUncompressedSize = view.getUint32(
      localHeaderOffset + 22,
      true,
    );
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
      (flags & 0x8) !== 0 ||
      localMethod !== compressionMethod ||
      localCrc !== expectedCrc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
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

interface ParsedRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly targetMode: string | null;
}

function parseRelationships(xml: string): readonly ParsedRelationship[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("WPS Artifact OPC XML declarations are unsafe");
  }
  const relationshipNamespace =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  const stack: Array<{ readonly uri: string; readonly local: string }> = [];
  const relationships: ParsedRelationship[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    stack.push({ uri: tag.uri, local: tag.local });
    if (
      stack.length !== 2 ||
      stack[0]?.uri !== relationshipNamespace ||
      stack[0]?.local !== "Relationships" ||
      stack[1]?.uri !== relationshipNamespace ||
      stack[1]?.local !== "Relationship"
    ) {
      return;
    }
    const attributes = Object.values(tag.attributes);
    const value = (name: string) =>
      attributes.find(
        (attribute) =>
          attribute.uri === "" && attribute.local === name,
      )?.value;
    const id = value("Id");
    const type = value("Type");
    const target = value("Target");
    if (id === undefined || type === undefined || target === undefined) {
      throw new Error("WPS Artifact OPC relationship is malformed");
    }
    relationships.push(
      Object.freeze({
        id,
        type,
        target,
        targetMode: value("TargetMode") ?? null,
      }),
    );
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (relationships.length === 0) {
    throw new Error("WPS Artifact OPC relationships are missing");
  }
  return Object.freeze(relationships);
}

function parsePresentationSlideIds(
  xml: string,
): readonly { readonly id: string; readonly relationshipId: string }[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("WPS Artifact OPC XML declarations are unsafe");
  }
  const presentationNamespace =
    "http://schemas.openxmlformats.org/presentationml/2006/main";
  const relationshipNamespace =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const stack: Array<{ readonly uri: string; readonly local: string }> = [];
  const slideIds: Array<{
    readonly id: string;
    readonly relationshipId: string;
  }> = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    stack.push({ uri: tag.uri, local: tag.local });
    if (
      stack.length !== 3 ||
      stack[0]?.uri !== presentationNamespace ||
      stack[0]?.local !== "presentation" ||
      stack[1]?.uri !== presentationNamespace ||
      stack[1]?.local !== "sldIdLst" ||
      stack[2]?.uri !== presentationNamespace ||
      stack[2]?.local !== "sldId"
    ) {
      return;
    }
    const attributes = Object.values(tag.attributes);
    const id = attributes.find(
      (attribute) => attribute.uri === "" && attribute.local === "id",
    )?.value;
    const relationshipId = attributes.find(
      (attribute) =>
        attribute.uri === relationshipNamespace &&
        attribute.local === "id",
    )?.value;
    if (
      id === undefined ||
      relationshipId === undefined ||
      !/^\d+$/.test(id)
    ) {
      throw new Error(
        "WPS Artifact OPC presentation slide IDs are malformed",
      );
    }
    slideIds.push({ id, relationshipId });
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  return Object.freeze(slideIds);
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
    const relationships = parseRelationships(decoder.decode(entry.content));
    if (
      relationships.some(
        ({ target, targetMode }) =>
          targetMode?.toLowerCase() === "external" ||
          /^(?:https?|file|ftp):/i.test(target.trim()),
      )
    ) {
      throw new Error("WPS Artifact OPC external relationship is forbidden");
    }
  }
  const presentationRelationships = parseRelationships(
    decoder.decode(
      byName.get("ppt/_rels/presentation.xml.rels"),
    ),
  );
  const slideRelationships = presentationRelationships.filter(
    ({ type }) => /\/slide$/i.test(type),
  );
  const byRelationshipId = new Map(
    slideRelationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );
  const presentationSlideIds = parsePresentationSlideIds(
    decoder.decode(byName.get("ppt/presentation.xml")),
  );
  if (
    presentationSlideIds.length !== 16 ||
    new Set(presentationSlideIds.map(({ id }) => id)).size !== 16 ||
    new Set(
      presentationSlideIds.map(({ relationshipId }) => relationshipId),
    ).size !== 16 ||
    presentationSlideIds.some(
      ({ relationshipId }) => !byRelationshipId.has(relationshipId),
    )
  ) {
    throw new Error(
      "WPS Artifact OPC presentation slide IDs do not match relationships",
    );
  }
  const slideTargets = presentationSlideIds.map(({ relationshipId }) => {
    const target = byRelationshipId.get(relationshipId)!.target;
    const match = /^slides\/(slide\d+\.xml)$/i.exec(target);
    if (match === null) {
      throw new Error(
        "WPS Artifact OPC presentation slide relationship target is unsafe",
      );
    }
    return `ppt/slides/${match[1]}`;
  });
  if (
    slideRelationships.length !== 16 ||
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
  driver: WpsAiPptBrowserDriverPort | undefined,
  result: WpsAiPptCapturedBrowserResult,
  executionMode: "live" | "replay",
): {
  readonly artifact: Artifact;
  readonly safeRasterCandidate: SafeRasterCandidate | undefined;
  readonly productionExecutionEvidence:
    ProductionDriverExecutionEvidence | undefined;
} {
  assertObservedConfiguration(result.observedConfiguration);
  assertOpenableSixteenPagePptx(result.artifact);
  if (
    (executionMode === "live" || executionMode === "replay") &&
    command.evaluationCase.provenance === "PRODUCTION" &&
    result.render !== undefined
  ) {
    throw new Error(
      "Production WPS capture cannot submit raster output before renderer authorization",
    );
  }
  if (
    driver?.provenance === "TEST_FAKE" &&
    result.render === undefined
  ) {
    throw new Error("WPS TEST_FAKE captured result requires a static render");
  }
  const render = result.render;
  if (
    render !== undefined &&
    (render.redactionStatus !== "passed" ||
      render.slides.length !== 16 ||
      render.renderer.trim().length === 0 ||
      render.contactSheet.mimeType !== "image/png")
  ) {
    throw new Error("WPS static render capture is invalid");
  }
  const contentHash = sha256(result.artifact.content);
  const provenance =
    command.evaluationCase.provenance === "PRODUCTION"
      ? executionMode === "live"
        ? "LIVE_PRODUCTION"
        : "PRODUCTION_REPLAY"
      : "MOCK";
  const environmentOrigin =
    command.evaluationCase.provenance === "PRODUCTION"
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
  const safeRasterCandidate: SafeRasterCandidate | undefined =
    render === undefined
      ? undefined
      : Object.freeze({
          renderer: render.renderer,
          fontPack: render.fontPack,
          resolution: render.resolution,
          colorProfile: render.colorProfile,
          renderOutcome: render.renderOutcome,
          fidelity: Object.freeze({
            status: render.fidelity.status,
            notes: Object.freeze([...render.fidelity.notes]),
          }),
          slides: Object.freeze(
            render.slides.map((slide) =>
              Object.freeze({
                ...slide,
                content: Uint8Array.from(slide.content),
              }),
            ),
          ),
          contactSheet: {
            filename: render.contactSheet.filename,
            mimeType: "image/png" as const,
            content: Uint8Array.from(render.contactSheet.content),
          },
        });
  return {
    artifact,
    safeRasterCandidate,
    productionExecutionEvidence: result.productionExecutionEvidence,
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
    !["production-live", "production-replay"].includes(
      executionConfiguration.scenario,
    )
  ) {
    throw new Error("WPS adapter execution configuration is invalid");
  }
  const executionMode =
    executionConfiguration.scenario === "production-replay"
      ? "replay"
      : "live";
  assertRegisteredImplementationPackage(implementation);
  return Object.freeze(async (command: ProductRunCommand) => {
    if (
      command.evaluationCase.targetPageCount !== 16 ||
      command.timeoutMs > 30 * 60 * 1_000
    ) {
      throw new Error(
        "WPS production adapter supports only the frozen 16-page, 30-minute protocol",
      );
    }
    const persistedEvents: ObservableAttemptEvent[] = [];
    const recoveredEvents =
      (await checkpointStore?.readAttempt?.(command.attemptId)) ?? [];
    const stateVersionByTask = new Map<string, number>();
    for (const event of recoveredEvents) {
      if (
        event.jobId !== command.jobId ||
        event.runId !== command.runId ||
        event.attemptId !== command.attemptId ||
        event.attemptSeq !== command.attemptSeq ||
        event.caseId !== command.evaluationCase.caseId ||
        event.adapterVersion !== WPS_AIPPT_ADAPTER_VERSION
      ) {
        throw new Error(
          "Recovered WPS checkpoint lineage does not match the Attempt",
        );
      }
      if (
        event.vendorTaskId !== null &&
        event.vendorTaskId !== undefined &&
        event.taskStateVersion !== null &&
        event.taskStateVersion !== undefined
      ) {
        const match = /@(\d+)$/.exec(event.taskStateVersion);
        if (match === null) {
          throw new Error(
            "Recovered WPS checkpoint stateVersion is not ordered",
          );
        }
        const version = Number(match[1]);
        const prior = stateVersionByTask.get(event.vendorTaskId) ?? -1;
        if (version < prior) {
          throw new Error(
            "Recovered WPS checkpoint stateVersion regressed",
          );
        }
        stateVersionByTask.set(event.vendorTaskId, version);
      }
      persistedEvents.push(
        Object.freeze(structuredClone(event)),
      );
    }
    if (persistedEvents.length > 0) {
      const latestReconciliation = [...persistedEvents].reverse().find(
        ({ eventType }) =>
          eventType === "task_reconciliation_result",
      );
      const alreadyReconciled = latestReconciliation !== undefined;
      const latestTaskCheckpoint = [...persistedEvents].reverse().find(
        (event) =>
          event.vendorTaskId !== null &&
          event.vendorTaskId !== undefined &&
          event.taskStateVersion !== null &&
          event.taskStateVersion !== undefined,
      );
      if (latestTaskCheckpoint !== undefined && !alreadyReconciled) {
        const reconciliation =
          await reconcileRegisteredWpsAiPptTask(browserDriver, {
            vendorTaskId:
              latestTaskCheckpoint.vendorTaskId as `task_${string}`,
            taskStateVersion:
              latestTaskCheckpoint.taskStateVersion as string,
            eventHistoryHash: sha256(
              textEncoder.encode(JSON.stringify(persistedEvents)),
            ),
            artifactContentHash: null,
          }, executionMode);
        persistedEvents.push(
          await observableEvent(
            command,
            {
              eventType: "task_reconciliation_result",
              sourceAt: reconciliation.observedAt,
              observedAt: reconciliation.observedAt,
              evidenceId: reconciliation.evidenceId,
              sourceUrl: null,
              submissionEvidenceAtCheckpoint:
                persistedEvents.some(
                  (event) =>
                    event.submissionEvidenceAtCheckpoint ===
                    "submitted",
                )
                  ? "submitted"
                  : "unknown",
              vendorTaskId: reconciliation.query.vendorTaskId,
              taskStateVersion:
                reconciliation.query.taskStateVersion,
              adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
              artifactId: null,
              reconciliationObservedState:
                reconciliation.observedState,
              reconciliationTerminalReason:
                terminalReasonForReconciliation(
                  reconciliation.observedState,
                ),
              reconciliationArtifactReference:
                artifactReferenceForReconciliation(
                  reconciliation.observedState,
                  reconciliation.query.vendorTaskId,
                ),
            },
            persistedEvents.length,
            checkpointStore,
          ),
        );
      }
      if (
        latestTaskCheckpoint !== undefined ||
        alreadyReconciled
      ) {
        const submitted = persistedEvents.some(
          (event) =>
            event.submissionEvidenceAtCheckpoint === "submitted",
        );
        return {
          terminalReason:
            [...persistedEvents].reverse().find(
              ({ eventType }) =>
                eventType === "task_reconciliation_result",
            )?.reconciliationTerminalReason ??
            "task_state_unknown",
          blockReason: null,
          submissionEvidence: submitted ? "submitted" : "unknown",
          elapsedMs: 0,
          artifactCandidates: [],
          observableEvents: Object.freeze([...persistedEvents]),
          manualActions: Object.freeze([]),
        };
      }
    }
    const runBrowser = resolveRegisteredWpsAiPptBrowserDriver(
      browserDriver,
      async (event) => {
        const checkpoint = await observableEvent(
          command,
          event,
          persistedEvents.length,
          checkpointStore,
        );
        persistedEvents.push(checkpoint);
        return checkpoint;
      },
      executionMode,
    );
    let result: WpsAiPptBrowserResult;
    try {
      result = await runBrowser({
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
    } catch (error) {
      const latestTaskCheckpoint = [...persistedEvents].reverse().find(
        (event) =>
          event.vendorTaskId !== null &&
          event.vendorTaskId !== undefined &&
          event.taskStateVersion !== null &&
          event.taskStateVersion !== undefined,
      );
      const submitted = persistedEvents.some(
        (event) =>
          event.submissionEvidenceAtCheckpoint === "submitted",
      );
      if (!submitted || latestTaskCheckpoint === undefined) {
        throw error;
      }
      const reconciliation =
        await reconcileRegisteredWpsAiPptTask(browserDriver, {
          vendorTaskId:
            latestTaskCheckpoint.vendorTaskId as `task_${string}`,
          taskStateVersion:
            latestTaskCheckpoint.taskStateVersion as string,
          eventHistoryHash: sha256(
            textEncoder.encode(JSON.stringify(persistedEvents)),
          ),
          artifactContentHash: null,
        }, executionMode);
      persistedEvents.push(
        await observableEvent(
          command,
          {
            eventType: "task_reconciliation_result",
            sourceAt: reconciliation.observedAt,
            observedAt: reconciliation.observedAt,
            evidenceId: reconciliation.evidenceId,
            sourceUrl: null,
            submissionEvidenceAtCheckpoint: "submitted",
            vendorTaskId: reconciliation.query.vendorTaskId,
            taskStateVersion:
              reconciliation.query.taskStateVersion,
            adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
            artifactId: null,
            reconciliationObservedState:
              reconciliation.observedState,
            reconciliationTerminalReason:
              terminalReasonForReconciliation(
                reconciliation.observedState,
              ),
            reconciliationArtifactReference:
              artifactReferenceForReconciliation(
                reconciliation.observedState,
                reconciliation.query.vendorTaskId,
              ),
          },
          persistedEvents.length,
          checkpointStore,
        ),
      );
      return {
        terminalReason: terminalReasonForReconciliation(
          reconciliation.observedState,
        ),
        blockReason: null,
        submissionEvidence: "submitted",
        elapsedMs: 0,
        artifactCandidates: [],
        observableEvents: Object.freeze([...persistedEvents]),
        manualActions: Object.freeze([]),
      };
    }
    const events = Object.freeze([...persistedEvents]);
    if (events.length !== result.events.length) {
      throw new Error(
        "WPS browser driver did not stream every observable event",
      );
    }
    let reconciledTerminalReason:
      | "task_state_unknown"
      | "download_failure"
      | "technical_failure"
      | null = null;
    if (result.outcome === "task_state_unknown") {
      const latest = result.events.at(-1);
      if (
        latest?.vendorTaskId === null ||
        latest?.vendorTaskId === undefined ||
        latest.taskStateVersion === null
      ) {
        throw new Error(
          "WPS unknown task state requires a vendor task identity and state version",
        );
      }
      const eventHistoryHash = sha256(
        textEncoder.encode(JSON.stringify(result.events)),
      );
      const reconciliation =
        await reconcileRegisteredWpsAiPptTask(browserDriver, {
          vendorTaskId: latest.vendorTaskId,
          taskStateVersion: latest.taskStateVersion,
          eventHistoryHash,
          artifactContentHash: null,
        }, executionMode);
      if (!Number.isFinite(Date.parse(reconciliation.observedAt))) {
        throw new Error(
          "WPS reconciliation API returned inconsistent task state",
        );
      }
      reconciledTerminalReason = terminalReasonForReconciliation(
        reconciliation.observedState,
      );
      persistedEvents.push(
        await observableEvent(
          command,
          {
            eventType: "task_reconciliation_result",
            sourceAt: reconciliation.observedAt,
            observedAt: reconciliation.observedAt,
            evidenceId: reconciliation.evidenceId,
            sourceUrl: null,
            submissionEvidenceAtCheckpoint:
              result.submissionEvidence,
            vendorTaskId: latest.vendorTaskId,
            taskStateVersion: latest.taskStateVersion,
            adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
            artifactId: null,
            reconciliationObservedState:
              reconciliation.observedState,
            reconciliationTerminalReason:
              reconciledTerminalReason,
            reconciliationArtifactReference:
              artifactReferenceForReconciliation(
                reconciliation.observedState,
                latest.vendorTaskId,
              ),
          },
          persistedEvents.length,
          checkpointStore,
        ),
      );
    }
    const manualActions = checkedManualActions(result.manualActions);
    if (result.outcome !== "captured") {
      return {
        terminalReason:
          reconciledTerminalReason ?? result.outcome,
        blockReason:
          result.outcome === "payment" ||
          result.outcome === "quota" ||
          result.outcome === "authentication"
            ? result.outcome
            : null,
        submissionEvidence: result.submissionEvidence,
        elapsedMs: result.elapsedMs,
        artifactCandidates: [],
        observableEvents: Object.freeze([...persistedEvents]),
        manualActions,
      };
    }
    if (result.submissionEvidence !== "submitted") {
      throw new Error(
        "WPS captured Artifact requires submitted evidence",
      );
    }
    const {
      artifact,
      safeRasterCandidate,
      productionExecutionEvidence,
    } = capturedResult(
      command,
      browserDriver,
      result,
      executionMode,
    );
    return {
      terminalReason: "success",
      blockReason: null,
      submissionEvidence: result.submissionEvidence,
      elapsedMs: result.elapsedMs,
      artifactCandidates: [
        {
          artifact,
          ...(safeRasterCandidate === undefined
            ? {}
            : { safeRasterCandidate }),
          ...(productionExecutionEvidence === undefined
            ? {}
            : { productionExecutionEvidence }),
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
    executionConfigurationPackage("production-live");
  readonly executionConfiguration: ProductAdapterExecutionConfiguration =
    parseAdapterExecutionConfiguration(
      this.executionConfigurationPackage,
    );
  readonly productPackage: ProductPackageSnapshot = Object.freeze({
    packageId: "wps-aippt-best-zero-incremental-cost-v1",
    vendorId: "wps",
    displayName: "WPS AI PPT",
    adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
    provenance: "LIVE_PRODUCTION",
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

export class WpsAiPptReplayAdapter implements ProductAdapterPort {
  readonly implementationPackage = implementationPackage();
  readonly executionConfigurationPackage =
    executionConfigurationPackage("production-replay");
  readonly executionConfiguration: ProductAdapterExecutionConfiguration =
    parseAdapterExecutionConfiguration(
      this.executionConfigurationPackage,
    );
  readonly productPackage: ProductPackageSnapshot = Object.freeze({
    packageId: "wps-aippt-real-provider-replay-v1",
    vendorId: "wps",
    displayName: "WPS AI PPT retained real-provider replay",
    adapterVersion: WPS_AIPPT_ADAPTER_VERSION,
    provenance: "PRODUCTION_REPLAY",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
    egressDestination: {
      targetService: "wps-aippt-replay-ingest",
      targetAccount: "retained-real-provider-capture",
      targetRegion: "local",
      subprocessors: [],
    },
    experienceConfiguration: WPS_AIPPT_EXPERIENCE_CONFIGURATION,
  });
}
