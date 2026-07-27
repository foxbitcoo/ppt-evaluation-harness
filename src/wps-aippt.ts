import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type {
  Artifact,
  ObservableAttemptEvent,
  RenderManifest,
  StaticSlideRender,
  SubmissionEvidence,
} from "./domain.ts";
import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
} from "./environment-origin.ts";
import {
  parseAdapterExecutionConfiguration,
  type ProductAdapterExecutionConfiguration,
  type ProductAdapterExecutor,
  type ProductAdapterImplementationPackage,
  type ProductAdapterPort,
  type ProductExperienceConfiguration,
  type ProductPackageSnapshot,
  type ProductRunCommand,
} from "./product-adapter.ts";
import { calculateRenderManifestHash } from "./render-manifest.ts";

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
  readonly evidenceRefs: readonly string[];
}

export interface WpsAiPptBrowserEvent {
  readonly eventType: string;
  readonly sourceAt: string;
  readonly observedAt: string;
  readonly evidenceRef: string;
}

export interface WpsAiPptBrowserCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
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
  readonly mimeType: "image/svg+xml";
  readonly content: string;
  readonly extractedText: string;
}

export interface WpsAiPptBrowserRenderCapture {
  readonly renderer: string;
  readonly fontPack: string;
  readonly resolution: string;
  readonly colorProfile: string;
  readonly redactionStatus: "passed";
  readonly slides: readonly WpsAiPptBrowserStaticSlide[];
  readonly contactSheet: {
    readonly filename: string;
    readonly mimeType: "image/svg+xml";
    readonly content: string;
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
    | "human_wait";
}

export type WpsAiPptBrowserResult =
  | WpsAiPptCapturedBrowserResult
  | WpsAiPptFailedBrowserResult;

export interface WpsAiPptBrowserDriverPort {
  readonly driverId: string;
  readonly provenance: "PRODUCTION" | "TEST_FAKE";
  run(
    command: WpsAiPptBrowserCommand,
  ): Promise<WpsAiPptBrowserResult>;
}

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

function observableEvents(
  command: ProductRunCommand,
  events: readonly WpsAiPptBrowserEvent[],
): readonly ObservableAttemptEvent[] {
  return Object.freeze(
    events.map((event, index) => {
      assertSafeTraceValue(event.eventType, "event type");
      assertSafeTraceValue(event.evidenceRef, "evidence reference");
      if (
        !Number.isFinite(Date.parse(event.sourceAt)) ||
        !Number.isFinite(Date.parse(event.observedAt))
      ) {
        throw new Error("WPS browser event timestamps are invalid");
      }
      return Object.freeze({
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
        evidenceRef: event.evidenceRef,
      });
    }),
  );
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
  const { evidenceRefs, ...configuration } = observed;
  if (
    JSON.stringify(configuration) !==
      JSON.stringify(WPS_AIPPT_EXPERIENCE_CONFIGURATION) ||
    evidenceRefs.length === 0
  ) {
    throw new Error(
      "WPS browser did not prove the frozen production configuration",
    );
  }
  for (const evidenceRef of evidenceRefs) {
    assertSafeTraceValue(evidenceRef, "configuration evidence");
  }
}

function centralDirectoryEntryNames(content: Uint8Array): string[] {
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
  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const names: string[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > content.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new Error("WPS Artifact central directory is invalid");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > content.byteLength) {
      throw new Error("WPS Artifact central directory is truncated");
    }
    names.push(
      new TextDecoder("utf-8", { fatal: true }).decode(
        content.subarray(nameStart, nameEnd),
      ),
    );
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
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
  const slideNames = centralDirectoryEntryNames(artifact.content).filter(
    (name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name),
  );
  if (slideNames.length !== 16) {
    throw new Error(
      `WPS Artifact page count mismatch: expected 16, found ${slideNames.length}`,
    );
  }
}

function staticSlide(
  slide: WpsAiPptBrowserStaticSlide,
  expectedPage: number,
): StaticSlideRender {
  if (
    slide.pageNumber !== expectedPage ||
    slide.mimeType !== "image/svg+xml" ||
    slide.content.trim().length === 0 ||
    slide.extractedText.trim().length === 0
  ) {
    throw new Error(
      `WPS static render page ${expectedPage} is invalid`,
    );
  }
  return Object.freeze({
    ...slide,
    contentHash: sha256(textEncoder.encode(slide.content)),
  });
}

function capturedResult(
  command: ProductRunCommand,
  driver: WpsAiPptBrowserDriverPort,
  result: WpsAiPptCapturedBrowserResult,
): {
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
} {
  assertObservedConfiguration(result.observedConfiguration);
  assertOpenableSixteenPagePptx(result.artifact);
  if (
    result.render.redactionStatus !== "passed" ||
    result.render.slides.length !== 16 ||
    result.render.renderer.trim().length === 0
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
  const slides = Object.freeze(
    result.render.slides.map((slide, index) =>
      staticSlide(slide, index + 1),
    ),
  );
  const contactSheetContent = result.render.contactSheet.content;
  if (
    result.render.contactSheet.mimeType !== "image/svg+xml" ||
    contactSheetContent.trim().length === 0
  ) {
    throw new Error("WPS static render contact sheet is invalid");
  }
  const manifestWithoutHash: Omit<RenderManifest, "contentHash"> = {
    renderManifestId: `${artifact.artifactId}-render`,
    artifactId: artifact.artifactId,
    provenance,
    environmentOrigin,
    renderer: result.render.renderer,
    pageCount: 16,
    renderPolicy: {
      fontPack: result.render.fontPack,
      resolution: result.render.resolution,
      colorProfile: result.render.colorProfile,
      animationPolicy: "first_frame",
      externalAssetPolicy: "network_disabled",
    },
    contactSheet: {
      filename: result.render.contactSheet.filename,
      mimeType: "image/svg+xml",
      contentHash: sha256(textEncoder.encode(contactSheetContent)),
      content: contactSheetContent,
    },
    slides,
  };
  return {
    artifact,
    renderManifest: Object.freeze({
      ...manifestWithoutHash,
      contentHash: calculateRenderManifestHash(
        artifact.contentHash,
        manifestWithoutHash,
      ),
    }),
  };
}

export function resolveWpsAiPptProductAdapterExecutor(
  implementation: ProductAdapterImplementationPackage,
  executionConfiguration: ProductAdapterExecutionConfiguration,
  browserDriver: WpsAiPptBrowserDriverPort | undefined,
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
  assertSafeTraceValue(browserDriver.driverId, "driver id");
  return Object.freeze(async (command: ProductRunCommand) => {
    if (
      command.evaluationCase.targetPageCount !== 16 ||
      command.timeoutMs > 30 * 60 * 1_000
    ) {
      throw new Error(
        "WPS production adapter supports only the frozen 16-page, 30-minute protocol",
      );
    }
    const result = await browserDriver.run({
      jobId: command.jobId,
      runId: command.runId,
      attemptId: command.attemptId,
      attemptSeq: command.attemptSeq,
      timeoutMs: command.timeoutMs,
      signal: command.signal,
      url: WPS_AIPPT_URL,
      prompt: command.evaluationCase.vendorPrompt,
      accountScope: "current_authenticated_account",
      packageSelection: "best_available_zero_incremental_cost",
      mode: "professional",
      networking: "enabled",
      pageCount: 16,
    });
    const events = observableEvents(command, result.events);
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
    const { artifact, renderManifest } = capturedResult(
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
          renderManifest,
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
