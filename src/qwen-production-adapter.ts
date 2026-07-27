import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  type EnvironmentOrigin,
} from "./environment-origin.ts";
import {
  VOLCANO_CASE_ID,
  VOLCANO_EVALUATION_CASE,
} from "./fixtures/volcano-case.ts";
import type {
  Artifact,
  BlockReason,
  ProvenanceLabel,
  SubmissionEvidence,
  TerminalReason,
} from "./domain.ts";
import type {
  ProductAdapterImplementationPackage,
  ProductAdapterExecutionConfiguration,
  ProductAdapterExecutor,
  ProductAdapterPort,
  ProductAttemptResult,
  ProductPackageSnapshot,
  ProductRunCommand,
} from "./product-adapter.ts";

const textEncoder = new TextEncoder();
const implementationContent = readFileSync(new URL(import.meta.url));

export const QWEN_PRODUCTION_ADAPTER_KIND = "qwen-web" as const;
export const QWEN_VOLCANO_SCENARIO =
  "volcano-16-best-zero-added-cost-v1" as const;
export const QWEN_ENTRY_URL = "https://www.qianwen.com/" as const;
export const QWEN_MAX_ATTEMPT_TIMEOUT_MS = 30 * 60 * 1_000;

export interface QwenBrowserExecutionCommand {
  readonly entryUrl: typeof QWEN_ENTRY_URL;
  readonly prompt: string;
  readonly pageCount: 16;
  readonly networking: "enabled";
  readonly packageSelection: "best_available_zero_added_cost";
  readonly modelSelection: "best_available_zero_added_cost";
  readonly expertMode: "best_available_zero_added_cost";
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface QwenObservedConfiguration {
  readonly actualUrl: string;
  readonly accountReference: "current_signed_in_account";
  readonly packageLabel: string;
  readonly addedCost: "zero";
  readonly modelLabel: string;
  readonly expertMode: "enabled" | "disabled" | "unavailable";
  readonly networking: "enabled";
  readonly pageCount: 16;
}

export type QwenBrowserMilestoneType =
  | "page_opened"
  | "package_observed"
  | "configuration_applied"
  | "submission_observed"
  | "generation_ready"
  | "export_ready";

export interface QwenBrowserMilestone {
  readonly eventType: QwenBrowserMilestoneType;
  readonly observedAt: string;
  readonly url: string;
}

export type QwenManualActionType =
  | "confirmed_visible_package"
  | "confirmed_model"
  | "confirmed_networking"
  | "confirmed_page_count"
  | "confirmed_template"
  | "confirmed_export";

export interface QwenManualAction {
  readonly action: QwenManualActionType;
  readonly observedAt: string;
}

export interface QwenDownloadedPresentation {
  readonly filename: string;
  readonly mimeType:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  readonly capturedAt: string;
  readonly content: Uint8Array;
}

export interface QwenStaticRender {
  readonly pageNumber: number;
  readonly filename: string;
  readonly mimeType: "image/png" | "image/svg+xml";
  readonly contentHash: `sha256:${string}`;
  readonly content: Uint8Array;
}

export interface QwenBrowserCompletedExecution {
  readonly status: "completed";
  readonly submissionEvidence: "submitted";
  readonly elapsedMs: number;
  readonly observedConfiguration: QwenObservedConfiguration;
  readonly milestones: readonly QwenBrowserMilestone[];
  readonly manualActions: readonly QwenManualAction[];
  readonly download: QwenDownloadedPresentation;
  readonly staticRenders: readonly QwenStaticRender[];
}

export interface QwenBrowserTerminalExecution {
  readonly status: "terminal";
  readonly terminalReason: Exclude<TerminalReason, "success">;
  readonly blockReason: BlockReason | null;
  readonly submissionEvidence: SubmissionEvidence;
  readonly elapsedMs: number;
  readonly observedAt: string;
  readonly observedConfiguration: QwenObservedConfiguration | null;
  readonly milestones: readonly QwenBrowserMilestone[];
  readonly manualActions: readonly QwenManualAction[];
}

export type QwenBrowserExecution =
  | QwenBrowserCompletedExecution
  | QwenBrowserTerminalExecution;

export interface QwenBrowserDriverPort {
  readonly runtimeProvenance:
    | "TEST"
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY";
  execute(
    command: QwenBrowserExecutionCommand,
  ): Promise<QwenBrowserExecution>;
}

export type QwenTraceEventType =
  | QwenBrowserMilestoneType
  | "terminal_observed"
  | "artifact_downloaded"
  | "artifact_validated"
  | "static_render_validated";

export interface QwenTraceEvent {
  readonly eventType: QwenTraceEventType;
  readonly observedAt: string;
  readonly sourceUrl: string;
  readonly evidenceRef: string;
}

export interface QwenProductAttemptResult
  extends ProductAttemptResult {
  readonly terminalReason: TerminalReason;
  readonly submissionEvidence: SubmissionEvidence;
  readonly observedConfiguration: QwenObservedConfiguration | null;
  readonly trace: readonly QwenTraceEvent[];
  readonly manualActions: readonly string[];
  readonly staticRenders: readonly QwenStaticRender[];
}

export type QwenProductAdapterExecutor = (
  this: void,
  command: ProductRunCommand,
) => Promise<QwenProductAttemptResult>;

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function assertIsoTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`Qwen browser ${field} must be an ISO timestamp`);
  }
}

function safeQwenUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Qwen browser returned an invalid observable URL");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "www.qianwen.com" &&
      url.hostname !== "qianwen.com")
  ) {
    throw new Error("Qwen browser returned an unexpected observable URL");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assertSafeVisibleLabel(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > 80 ||
    /[\r\n]/.test(value) ||
    /cookie|authorization|localstorage|password|token|secret|chain.of.thought/i.test(
      value,
    )
  ) {
    throw new Error(`Qwen browser ${field} is not safe observable evidence`);
  }
}

function countPptxSlides(content: Uint8Array): number {
  if (
    content.byteLength < 4 ||
    content[0] !== 0x50 ||
    content[1] !== 0x4b
  ) {
    throw new Error("Qwen export is not an openable PPTX ZIP package");
  }
  const archiveNames = Buffer.from(content).toString("latin1");
  if (
    /(?:^|\/)vbaProject\.bin|\/activeX\/|\/macros\//i.test(
      archiveNames,
    )
  ) {
    throw new Error(
      "Qwen export failed the unsafe PPTX macro safety gate",
    );
  }
  const pages = new Set<number>();
  for (const match of archiveNames.matchAll(
    /ppt\/slides\/slide([1-9]\d*)\.xml/g,
  )) {
    pages.add(Number(match[1]));
  }
  if (
    pages.size === 0 ||
    [...pages].some(
      (pageNumber) =>
        pageNumber < 1 || pageNumber > pages.size,
    )
  ) {
    throw new Error("Qwen export has an invalid PPTX slide manifest");
  }
  return pages.size;
}

function validateStaticRenders(
  renders: readonly QwenStaticRender[],
  expectedPageCount: number,
): readonly QwenStaticRender[] {
  const pages = new Set<number>();
  for (const render of renders) {
    if (
      render.pageNumber < 1 ||
      render.pageNumber > expectedPageCount ||
      pages.has(render.pageNumber) ||
      render.content.byteLength === 0 ||
      sha256(render.content) !== render.contentHash
    ) {
      throw new Error("Qwen static render package is invalid");
    }
    pages.add(render.pageNumber);
  }
  if (pages.size !== expectedPageCount) {
    throw new Error(
      `Qwen static render package must contain ${expectedPageCount} pages`,
    );
  }
  return Object.freeze(
    [...renders]
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .map((render) =>
        Object.freeze({
          ...render,
          content: Uint8Array.from(render.content),
        }),
      ),
  );
}

function validateObservedConfiguration(
  configuration: QwenObservedConfiguration,
): QwenObservedConfiguration {
  const actualUrl = safeQwenUrl(configuration.actualUrl);
  assertSafeVisibleLabel(
    configuration.packageLabel,
    "package label",
  );
  assertSafeVisibleLabel(configuration.modelLabel, "model label");
  if (
    configuration.accountReference !==
      "current_signed_in_account" ||
    configuration.addedCost !== "zero" ||
    configuration.networking !== "enabled" ||
    configuration.pageCount !== 16
  ) {
    throw new Error(
      "Qwen browser did not prove the required zero-added-cost 16-page configuration",
    );
  }
  return Object.freeze({
    ...configuration,
    actualUrl,
  });
}

function artifactFromDownload(
  command: ProductRunCommand,
  download: QwenDownloadedPresentation,
  provenance: ProvenanceLabel,
  environmentOrigin: EnvironmentOrigin,
): Artifact {
  if (
    download.mimeType !==
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    !/\.pptx$/i.test(download.filename) ||
    /[/\\]/.test(download.filename)
  ) {
    throw new Error("Qwen export must be a local PPTX file");
  }
  assertIsoTimestamp(download.capturedAt, "capture time");
  const content = Uint8Array.from(download.content);
  const pageCount = countPptxSlides(content);
  if (pageCount !== 16) {
    throw new Error("Qwen export must contain exactly 16 slides");
  }
  const contentHash = sha256(content);
  return Object.freeze({
    artifactId: `qwen-artifact-${contentHash.slice(7, 23)}`,
    runId: command.runId,
    provenance,
    environmentOrigin,
    filename: download.filename,
    mimeType: download.mimeType,
    byteSize: content.byteLength,
    pageCount,
    contentHash,
    capturedAt: download.capturedAt,
    content,
  });
}

function createTrace(
  execution: QwenBrowserCompletedExecution,
  configuration: QwenObservedConfiguration,
): readonly QwenTraceEvent[] {
  const milestones = execution.milestones.map((milestone) => {
    assertIsoTimestamp(milestone.observedAt, "milestone time");
    const sourceUrl = safeQwenUrl(milestone.url);
    return Object.freeze({
      eventType: milestone.eventType,
      observedAt: milestone.observedAt,
      sourceUrl,
      evidenceRef: `qwen-ui:${milestone.eventType}:${sourceUrl}`,
    });
  });
  const artifactEvents: readonly QwenTraceEvent[] = [
    {
      eventType: "artifact_downloaded",
      observedAt: execution.download.capturedAt,
      sourceUrl: configuration.actualUrl,
      evidenceRef: "qwen-download:pptx",
    },
    {
      eventType: "artifact_validated",
      observedAt: execution.download.capturedAt,
      sourceUrl: configuration.actualUrl,
      evidenceRef: "qwen-artifact:sha256-and-page-count",
    },
    {
      eventType: "static_render_validated",
      observedAt: execution.download.capturedAt,
      sourceUrl: configuration.actualUrl,
      evidenceRef: "qwen-render:16-static-pages",
    },
  ];
  return Object.freeze([...milestones, ...artifactEvents]);
}

function createTerminalTrace(
  execution: QwenBrowserTerminalExecution,
): readonly QwenTraceEvent[] {
  const milestones = execution.milestones.map((milestone) => {
    assertIsoTimestamp(milestone.observedAt, "milestone time");
    const sourceUrl = safeQwenUrl(milestone.url);
    return Object.freeze({
      eventType: milestone.eventType,
      observedAt: milestone.observedAt,
      sourceUrl,
      evidenceRef: `qwen-ui:${milestone.eventType}:${sourceUrl}`,
    });
  });
  const last = milestones.at(-1);
  assertIsoTimestamp(execution.observedAt, "terminal time");
  const sourceUrl =
    last?.sourceUrl ??
    safeQwenUrl(
      execution.observedConfiguration?.actualUrl ?? QWEN_ENTRY_URL,
    );
  return Object.freeze([
    ...milestones,
    Object.freeze({
      eventType: "terminal_observed" as const,
      observedAt: execution.observedAt,
      sourceUrl,
      evidenceRef: `qwen-terminal:${execution.terminalReason}`,
    }),
  ]);
}

function validateTerminalExecution(
  execution: QwenBrowserTerminalExecution,
): void {
  const isBlocked =
    execution.terminalReason === "payment" ||
    execution.terminalReason === "quota" ||
    execution.terminalReason === "authentication";
  if (
    !Number.isFinite(execution.elapsedMs) ||
    execution.elapsedMs < 0 ||
    (isBlocked &&
      execution.blockReason !== execution.terminalReason) ||
    (!isBlocked && execution.blockReason !== null)
  ) {
    throw new Error("Qwen browser returned an inconsistent terminal result");
  }
  for (const action of execution.manualActions) {
    assertIsoTimestamp(action.observedAt, "manual-action time");
  }
}

function qwenExecutor(
  driver: QwenBrowserDriverPort,
  provenance: ProvenanceLabel,
  environmentOrigin: EnvironmentOrigin,
): QwenProductAdapterExecutor {
  const executor: QwenProductAdapterExecutor = async (command) => {
    if (
      command.evaluationCase.caseId !== VOLCANO_CASE_ID ||
      command.evaluationCase.vendorPrompt !==
        VOLCANO_EVALUATION_CASE.vendorPrompt ||
      command.evaluationCase.targetPageCount !== 16
    ) {
      throw new Error(
        "Qwen production adapter supports only the frozen 16-page volcano Query",
      );
    }
    if (
      command.timeoutMs <= 0 ||
      command.timeoutMs > QWEN_MAX_ATTEMPT_TIMEOUT_MS
    ) {
      throw new Error(
        "Qwen production adapter requires an attempt deadline within 30 minutes",
      );
    }
    const execution = await driver.execute({
      entryUrl: QWEN_ENTRY_URL,
      prompt: command.evaluationCase.vendorPrompt,
      pageCount: 16,
      networking: "enabled",
      packageSelection: "best_available_zero_added_cost",
      modelSelection: "best_available_zero_added_cost",
      expertMode: "best_available_zero_added_cost",
      timeoutMs: command.timeoutMs,
      signal: command.signal,
    });
    if (execution.status === "terminal") {
      validateTerminalExecution(execution);
      return Object.freeze({
        terminalReason: execution.terminalReason,
        blockReason: execution.blockReason,
        submissionEvidence: execution.submissionEvidence,
        elapsedMs: execution.elapsedMs,
        artifactCandidates: Object.freeze([]),
        observedConfiguration:
          execution.observedConfiguration === null
            ? null
            : validateObservedConfiguration(
                execution.observedConfiguration,
              ),
        trace: createTerminalTrace(execution),
        manualActions: Object.freeze(
          execution.manualActions.map((action) =>
            `${action.observedAt} ${action.action}`,
          ),
        ),
        staticRenders: Object.freeze([]),
      });
    }
    const observedConfiguration =
      validateObservedConfiguration(
        execution.observedConfiguration,
      );
    const artifact = artifactFromDownload(
      command,
      execution.download,
      provenance,
      environmentOrigin,
    );
    const staticRenders = validateStaticRenders(
      execution.staticRenders,
      artifact.pageCount,
    );
    for (const action of execution.manualActions) {
      assertIsoTimestamp(action.observedAt, "manual-action time");
    }
    return Object.freeze({
      terminalReason: "success",
      blockReason: null,
      submissionEvidence: execution.submissionEvidence,
      elapsedMs: execution.elapsedMs,
      artifactCandidates: Object.freeze([
        Object.freeze({ artifact, policyCompliant: true }),
      ]),
      observedConfiguration,
      trace: createTrace(execution, observedConfiguration),
      manualActions: Object.freeze(
        execution.manualActions.map((action) =>
          `${action.observedAt} ${action.action}`,
        ),
      ),
      staticRenders,
    });
  };
  return Object.freeze(executor);
}

export function createQwenProductAdapterExecutorForTest(
  driver: QwenBrowserDriverPort,
): QwenProductAdapterExecutor {
  if (driver.runtimeProvenance !== "TEST") {
    throw new Error("Qwen test executor requires a TEST browser driver");
  }
  return qwenExecutor(
    driver,
    "MOCK",
    MOCK_TEST_ENVIRONMENT_ORIGIN,
  );
}

export function resolveQwenProductionAdapterExecutor(
  implementation: ProductAdapterImplementationPackage,
  executionConfiguration: ProductAdapterExecutionConfiguration,
  driver: QwenBrowserDriverPort | undefined,
): ProductAdapterExecutor {
  if (
    executionConfiguration.adapterKind !==
      QWEN_PRODUCTION_ADAPTER_KIND ||
    executionConfiguration.scenario !== QWEN_VOLCANO_SCENARIO
  ) {
    throw new Error(
      "Qwen production adapter execution configuration is not registered",
    );
  }
  const expected = expectedQwenProductionImplementationPackage();
  if (
    implementation.packageName !== expected.packageName ||
    implementation.contentHash !== expected.contentHash ||
    !Buffer.from(implementation.content).equals(
      Buffer.from(expected.content),
    )
  ) {
    throw new Error(
      `Product Adapter implementation package is not registered for ${QWEN_PRODUCTION_ADAPTER_KIND}:${QWEN_VOLCANO_SCENARIO}`,
    );
  }
  if (driver === undefined) {
    throw new Error(
      "Harness registry requires a production Qwen browser driver",
    );
  }
  if (
    driver.runtimeProvenance !== "LIVE_PRODUCTION" &&
    driver.runtimeProvenance !== "PRODUCTION_REPLAY"
  ) {
    throw new Error(
      "Harness registry requires a LIVE_PRODUCTION or PRODUCTION_REPLAY browser driver for Qwen",
    );
  }
  return qwenExecutor(
    driver,
    driver.runtimeProvenance,
    PRODUCTION_ENVIRONMENT_ORIGIN,
  );
}

function implementationPackage(): ProductAdapterImplementationPackage {
  return Object.freeze({
    packageName: "src/qwen-production-adapter.ts#QwenProductionProductAdapter",
    contentHash: sha256(implementationContent),
    content: Uint8Array.from(implementationContent),
  });
}

function executionConfigurationPackage(): ProductAdapterImplementationPackage {
  const content = textEncoder.encode(
    JSON.stringify({
      adapterKind: QWEN_PRODUCTION_ADAPTER_KIND,
      scenario: QWEN_VOLCANO_SCENARIO,
      schemaVersion:
        "product-adapter-execution-configuration-v1",
    }),
  );
  return Object.freeze({
    packageName:
      "qwen-production-execution-configuration#volcano-16-best-zero-added-cost-v1",
    contentHash: sha256(content),
    content,
  });
}

const QWEN_PRODUCT_PACKAGE: ProductPackageSnapshot = Object.freeze({
  packageId: "qwen-web-best-zero-added-cost-volcano-16-v1",
  vendorId: "qwen",
  displayName: "千问网页 PPT",
  adapterVersion: "qwen-web@1",
  provenance: "LIVE_PRODUCTION",
  environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
  egressDestination: Object.freeze({
    targetService: "qwen-web",
    targetAccount: "current-signed-in-account",
    targetRegion: "cn",
    subprocessors: [],
  }),
  experienceConfiguration: Object.freeze({
    productUrl: QWEN_ENTRY_URL,
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
  }),
});

export class QwenProductionProductAdapter implements ProductAdapterPort {
  readonly implementationPackage = implementationPackage();
  readonly executionConfigurationPackage =
    executionConfigurationPackage();
  readonly productPackage = QWEN_PRODUCT_PACKAGE;
}

export function expectedQwenProductionImplementationPackage():
  ProductAdapterImplementationPackage {
  return implementationPackage();
}
