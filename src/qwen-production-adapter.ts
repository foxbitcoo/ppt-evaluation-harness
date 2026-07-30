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
  ObservableAttemptEvent,
  ProvenanceLabel,
  SubmissionEvidence,
  TerminalReason,
} from "./domain.ts";
import type {
  ProductAdapterImplementationPackage,
  AttemptCheckpointPort,
  ProductAdapterExecutionConfiguration,
  ProductAdapterExecutor,
  ProductAdapterPort,
  ProductAttemptResult,
  ProductPackageSnapshot,
  ProductRunCommand,
  TrustedBrowserDriverEvidence,
} from "./product-adapter.ts";
import { validatedOpcSlideNames } from "./wps-aippt.ts";

const textEncoder = new TextEncoder();
const implementationContent = readFileSync(new URL(import.meta.url));

export const QWEN_PRODUCTION_ADAPTER_KIND = "qwen-web" as const;
export const QWEN_VOLCANO_SCENARIO = "production-live" as const;
export const QWEN_ENTRY_URL = "https://www.qianwen.com/" as const;
export const QWEN_MAX_ATTEMPT_TIMEOUT_MS = 30 * 60 * 1_000;
export const QWEN_ADAPTER_VERSION = "qwen-web@1" as const;
export const QWEN_BROWSER_DRIVER_VERSION =
  "qwen-harness-browser-bridge@1" as const;
export const QWEN_BROWSER_PROFILE_DIGEST = sha256(
  textEncoder.encode(
    JSON.stringify({
      automationSurface: "codex-external-browser",
      credentialSource: "existing-user-profile",
      engine: "chrome",
      profileSchemaVersion: "qwen-browser-profile-v1",
    }),
  ),
);

export interface QwenBrowserExecutionCommand {
  readonly attemptSeq: number;
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
  readonly evidenceBindings?: Readonly<{
    readonly package: `ev_${string}`;
    readonly model: `ev_${string}`;
    readonly configuration: `ev_${string}`;
  }>;
}

export type QwenBrowserMilestoneType =
  | "page_opened"
  | "package_observed"
  | "model_observed"
  | "configuration_applied"
  | "submission_observed"
  | "generation_ready"
  | "export_ready";

const QWEN_MILESTONE_PHASE = Object.freeze({
  page_opened: "pre_submit",
  package_observed: "pre_submit",
  model_observed: "pre_submit",
  configuration_applied: "pre_submit",
  submission_observed: "submission",
  generation_ready: "post_submit",
  export_ready: "post_submit",
} satisfies Record<
  QwenBrowserMilestoneType,
  "pre_submit" | "submission" | "post_submit"
>);

export interface QwenBrowserMilestone {
  readonly eventType: QwenBrowserMilestoneType;
  readonly observedAt: string;
  readonly url: string;
  readonly evidenceId?: `ev_${string}`;
  readonly vendorTaskId?: `task_${string}` | null;
  readonly taskStateVersion?: string | null;
}

export type QwenManualActionType =
  | "confirmed_visible_package"
  | "confirmed_model"
  | "confirmed_networking"
  | "confirmed_page_count"
  | "confirmed_template"
  | "confirmed_export";

const QWEN_MANUAL_ACTION_TYPES = new Set<QwenManualActionType>([
  "confirmed_visible_package",
  "confirmed_model",
  "confirmed_networking",
  "confirmed_page_count",
  "confirmed_template",
  "confirmed_export",
]);
const QWEN_SENSITIVE_REPLAY_PATTERN =
  /cookie|authorization|bearer|access[_ -]?token|refresh[_ -]?token|localstorage|sessionstorage|session[_ -]?id|password|secret|qwen[_ -]?sid|chain[_ -]?of[_ -]?thought|hidden[_ -]?(?:reasoning|thought)/i;

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
  readonly driverId?:
    | "qwen-test-fixture"
    | "qwen-real-provider-replay";
  readonly captureSource?:
    | "TEST_FIXTURE"
    | "REAL_PROVIDER_CAPTURE";
  readonly driverVersion?: typeof QWEN_BROWSER_DRIVER_VERSION;
  readonly browserProfileDigest?: typeof QWEN_BROWSER_PROFILE_DIGEST;
  readonly implementationPackage?: ProductAdapterImplementationPackage;
  readonly configurationPackage?: ProductAdapterImplementationPackage;
  readonly captureReceipt?: QwenReplayCaptureReceipt;
  readonly sessions?: readonly QwenBrowserExecution[];
  readonly reconciliations?: readonly QwenTaskReconciliationEvidence[];
  execute(
    command: QwenBrowserExecutionCommand,
  ): Promise<QwenBrowserExecution>;
}

export interface QwenReplayCaptureReceipt {
  readonly captureId: string;
  readonly artifactContentHash: `sha256:${string}` | null;
  readonly traceDigest: `sha256:${string}`;
  readonly renderDigest: `sha256:${string}` | null;
  readonly packageIdentityDigest: `sha256:${string}`;
}

export interface QwenTaskReconciliationQuery {
  readonly vendorTaskId: `task_${string}`;
  readonly taskStateVersion: string;
  readonly eventHistoryHash: `sha256:${string}`;
  readonly artifactContentHash: `sha256:${string}` | null;
}

export interface QwenTaskReconciliationEvidence {
  readonly query: QwenTaskReconciliationQuery;
  readonly observedState:
    | "unknown"
    | "submitted"
    | "artifact_ready"
    | "failed";
  readonly observedAt: string;
  readonly evidenceId: `ev_${string}`;
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

function qwenDriverImplementationPackage():
  ProductAdapterImplementationPackage {
  const content = textEncoder.encode(
    JSON.stringify({
      driverVersion: QWEN_BROWSER_DRIVER_VERSION,
      executionPolicy:
        "harness-owned-live-or-retained-real-provider-replay",
      schemaVersion: "qwen-browser-driver-implementation-v1",
    }),
  );
  return Object.freeze({
    packageName:
      "qwen-browser-driver#harness-owned-or-replay-runtime",
    contentHash: sha256(content),
    content,
  });
}

function qwenDriverConfigurationPackage():
  ProductAdapterImplementationPackage {
  const content = textEncoder.encode(
    JSON.stringify({
      browserProfileDigest: QWEN_BROWSER_PROFILE_DIGEST,
      driverVersion: QWEN_BROWSER_DRIVER_VERSION,
      schemaVersion: "qwen-browser-driver-configuration-v1",
    }),
  );
  return Object.freeze({
    packageName:
      "qwen-browser-driver-configuration#harness-owned-bridge",
    contentHash: sha256(content),
    content,
  });
}

function assertQwenDriverPackage(
  actual: ProductAdapterImplementationPackage | undefined,
  expected: ProductAdapterImplementationPackage,
  label: string,
): void {
  if (
    actual === undefined ||
    actual.packageName !== expected.packageName ||
    actual.contentHash !== expected.contentHash ||
    sha256(actual.content) !== expected.contentHash ||
    !Buffer.from(actual.content).equals(Buffer.from(expected.content))
  ) {
    throw new Error(`Qwen browser driver ${label} is not allowlisted`);
  }
}

export interface QwenBrowserDriverEvidence
  extends TrustedBrowserDriverEvidence {
  readonly driverId:
    | "qwen-harness-browser-bridge"
    | "qwen-real-provider-replay";
  readonly provenance:
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY";
  readonly captureSource:
    | "LIVE_BROWSER_AUTOMATION"
    | "REAL_PROVIDER_CAPTURE";
  readonly driverVersion: typeof QWEN_BROWSER_DRIVER_VERSION;
  readonly browserProfileDigest: typeof QWEN_BROWSER_PROFILE_DIGEST;
  readonly captureReceipt?: QwenReplayCaptureReceipt;
}

const HARNESS_OWNED_QWEN_CAPTURE_RECEIPTS = new Map<
  string,
  QwenReplayCaptureReceipt
>();
const harnessOwnedQwenReplayPackages = new WeakSet<object>();

function qwenReplayPackageIdentityDigest(): `sha256:${string}` {
  return sha256(
    textEncoder.encode(
      JSON.stringify({
        configurationDigest:
          qwenDriverConfigurationPackage().contentHash,
        driverVersion: QWEN_BROWSER_DRIVER_VERSION,
        browserProfileDigest: QWEN_BROWSER_PROFILE_DIGEST,
      }),
    ),
  );
}

function qwenReplayTraceDigest(input: {
  readonly sessions: readonly QwenBrowserExecution[];
  readonly reconciliations: readonly QwenTaskReconciliationEvidence[];
}): `sha256:${string}` {
  return sha256(
    textEncoder.encode(
      JSON.stringify({
        sessionTraces: input.sessions.map((session) =>
          session.status === "completed"
            ? session.milestones
            : {
                milestones: session.milestones,
                observedAt: session.observedAt,
                terminalReason: session.terminalReason,
              },
        ),
        reconciliations: input.reconciliations,
      }),
    ),
  );
}

function qwenReplayRenderDigest(
  session: QwenBrowserExecution,
): `sha256:${string}` | null {
  if (session.status !== "completed") return null;
  return sha256(
    textEncoder.encode(
      JSON.stringify(
        session.staticRenders.map(
          ({ pageNumber, filename, mimeType, contentHash }) => ({
            pageNumber,
            filename,
            mimeType,
            contentHash,
          }),
        ),
      ),
    ),
  );
}

const HARNESS_OWNED_QWEN_DRIVER_EVIDENCE:
  QwenBrowserDriverEvidence = Object.freeze({
    driverId: "qwen-harness-browser-bridge",
    provenance: "LIVE_PRODUCTION",
    captureSource: "LIVE_BROWSER_AUTOMATION",
    driverVersion: QWEN_BROWSER_DRIVER_VERSION,
    browserProfileDigest: QWEN_BROWSER_PROFILE_DIGEST,
    implementationDigest:
      qwenDriverImplementationPackage().contentHash,
    configurationDigest:
      qwenDriverConfigurationPackage().contentHash,
  });

export function registeredQwenBrowserDriverEvidence(
  driver: QwenBrowserDriverPort | undefined,
): QwenBrowserDriverEvidence {
  if (driver === undefined) {
    return HARNESS_OWNED_QWEN_DRIVER_EVIDENCE;
  }
  assertQwenDriverPackage(
    driver.implementationPackage,
    qwenDriverImplementationPackage(),
    "implementation package",
  );
  assertQwenDriverPackage(
    driver.configurationPackage,
    qwenDriverConfigurationPackage(),
    "configuration package",
  );
  if (
    driver.driverId !== "qwen-real-provider-replay" ||
    driver.runtimeProvenance !== "PRODUCTION_REPLAY" ||
    driver.captureSource !== "REAL_PROVIDER_CAPTURE" ||
    driver.driverVersion !== QWEN_BROWSER_DRIVER_VERSION ||
    driver.browserProfileDigest !== QWEN_BROWSER_PROFILE_DIGEST ||
    (driver.sessions?.length ?? 0) === 0 &&
    (driver.reconciliations?.length ?? 0) === 0
  ) {
    throw new Error(
      "Production registry requires an allowlisted Qwen browser driver package",
    );
  }
  if (
    !harnessOwnedQwenReplayPackages.has(driver) ||
    driver.captureReceipt === undefined ||
    HARNESS_OWNED_QWEN_CAPTURE_RECEIPTS.get(
      driver.captureReceipt.captureId,
    ) !== driver.captureReceipt
  ) {
    throw new Error(
      "Qwen production replay requires an immutable harness-owned capture receipt",
    );
  }
  return Object.freeze({
    driverId: driver.driverId,
    provenance: driver.runtimeProvenance,
    captureSource: driver.captureSource,
    driverVersion: driver.driverVersion,
    browserProfileDigest: driver.browserProfileDigest,
    implementationDigest:
      qwenDriverImplementationPackage().contentHash,
    configurationDigest:
      qwenDriverConfigurationPackage().contentHash,
    captureReceipt: driver.captureReceipt,
  });
}

function registeredProductionQwenDriver(
  driver: QwenBrowserDriverPort | undefined,
): QwenBrowserDriverPort & {
  readonly runtimeProvenance:
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY";
} {
  if (driver === undefined) {
    return Object.freeze({
      runtimeProvenance: "LIVE_PRODUCTION" as const,
      async execute() {
        throw new Error(
          "Harness-owned Qwen live executable is not embedded; production execution fails closed",
        );
      },
    });
  }
  registeredQwenBrowserDriverEvidence(driver);
  const sessions = driver.sessions ?? [];
  const frozenSessions = Object.freeze(
    sessions.map((session) =>
      Object.freeze(structuredClone(session)),
    ),
  );
  return Object.freeze({
    runtimeProvenance: "PRODUCTION_REPLAY" as const,
    async execute(command: QwenBrowserExecutionCommand) {
      const session = frozenSessions[command.attemptSeq - 1];
      if (session === undefined) {
        throw new Error(
          `Qwen replay driver has no retained session for attempt ${command.attemptSeq}`,
        );
      }
      return Object.freeze(structuredClone(session));
    },
  });
}

export function createQwenRealProviderReplayPackage(input: {
  readonly captureId: string;
  readonly sessions: readonly QwenBrowserExecution[];
  readonly reconciliations?: readonly QwenTaskReconciliationEvidence[];
}): QwenBrowserDriverPort {
  if (
    input.sessions.length === 0 &&
    (input.reconciliations?.length ?? 0) === 0
  ) {
    throw new Error(
      "Qwen replay ingest requires retained real-provider evidence",
    );
  }
  const receipt =
    HARNESS_OWNED_QWEN_CAPTURE_RECEIPTS.get(input.captureId);
  if (receipt === undefined) {
    throw new Error(
      "Qwen replay ingest requires a harness-owned capture receipt; the capture is unregistered",
    );
  }
  const reconciliations = input.reconciliations ?? [];
  if (
    receipt.packageIdentityDigest !==
    qwenReplayPackageIdentityDigest()
  ) {
    throw new Error(
      "Qwen harness-owned capture receipt package binding is invalid",
    );
  }
  if (
    qwenReplayTraceDigest({
      sessions: input.sessions,
      reconciliations,
    }) !== receipt.traceDigest
  ) {
    throw new Error(
      "Qwen trace does not match the harness-owned capture receipt",
    );
  }
  const completedSessions = input.sessions.filter(
    (
      session,
    ): session is QwenBrowserCompletedExecution =>
      session.status === "completed",
  );
  if (
    completedSessions.length > 1 ||
    (completedSessions[0] === undefined
      ? receipt.artifactContentHash !== null ||
        receipt.renderDigest !== null
      : sha256(completedSessions[0].download.content) !==
          receipt.artifactContentHash ||
        qwenReplayRenderDigest(completedSessions[0]) !==
          receipt.renderDigest)
  ) {
    throw new Error(
      "Qwen Artifact or Render does not match the harness-owned capture receipt",
    );
  }
  const sessions = Object.freeze(
    input.sessions.map((session) =>
      Object.freeze(structuredClone(session)),
    ),
  );
  const replayPackage = Object.freeze({
    driverId: "qwen-real-provider-replay",
    runtimeProvenance: "PRODUCTION_REPLAY",
    captureSource: "REAL_PROVIDER_CAPTURE",
    driverVersion: QWEN_BROWSER_DRIVER_VERSION,
    browserProfileDigest: QWEN_BROWSER_PROFILE_DIGEST,
    implementationPackage: qwenDriverImplementationPackage(),
    configurationPackage: qwenDriverConfigurationPackage(),
    captureReceipt: receipt,
    sessions,
    reconciliations: Object.freeze(
      reconciliations.map((entry) =>
        Object.freeze(structuredClone(entry)),
      ),
    ),
    async execute() {
      throw new Error(
        "Caller-supplied Qwen replay execute closures are never trusted",
      );
    },
  });
  harnessOwnedQwenReplayPackages.add(replayPackage);
  return replayPackage;
}

function reconcileRegisteredQwenTask(
  driver: QwenBrowserDriverPort | undefined,
  query: QwenTaskReconciliationQuery,
): QwenTaskReconciliationEvidence {
  registeredQwenBrowserDriverEvidence(driver);
  if (driver === undefined) {
    throw new Error(
      "Harness-owned Qwen live reconciliation executable is unavailable",
    );
  }
  const evidence = driver.reconciliations?.find(
    (candidate) =>
      JSON.stringify(candidate.query) === JSON.stringify(query),
  );
  if (evidence === undefined) {
    throw new Error(
      "Qwen reconciliation API has no task/history/hash match",
    );
  }
  assertIsoTimestamp(evidence.observedAt, "reconciliation time");
  if (!/^ev_[a-f0-9]{16,64}$/.test(evidence.evidenceId)) {
    throw new Error("Qwen reconciliation evidence ID must be opaque");
  }
  return Object.freeze(structuredClone(evidence));
}

function reconcileTestQwenTask(
  driver: QwenBrowserDriverPort,
  query: QwenTaskReconciliationQuery,
): QwenTaskReconciliationEvidence {
  if (driver.runtimeProvenance !== "TEST") {
    throw new Error(
      "Qwen test reconciliation requires a TEST browser driver",
    );
  }
  const evidence = driver.reconciliations?.find(
    (candidate) =>
      JSON.stringify(candidate.query) === JSON.stringify(query),
  );
  if (evidence === undefined) {
    throw new Error(
      "Qwen test reconciliation fixture has no task/history/hash match",
    );
  }
  assertIsoTimestamp(evidence.observedAt, "reconciliation time");
  if (!/^ev_[a-f0-9]{16,64}$/.test(evidence.evidenceId)) {
    throw new Error("Qwen reconciliation evidence ID must be opaque");
  }
  return Object.freeze(structuredClone(evidence));
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
  if (url.pathname !== "/") {
    url.pathname = "/chat/redacted";
  }
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
  return validatedOpcSlideNames(content).length;
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
  production: boolean,
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
  if (
    production &&
    (configuration.evidenceBindings === undefined ||
      Object.keys(configuration.evidenceBindings).sort().join(",") !==
        "configuration,model,package" ||
      new Set(
        Object.values(configuration.evidenceBindings),
      ).size !== 3 ||
      Object.values(configuration.evidenceBindings).some(
        (evidenceId) =>
          !/^ev_[a-f0-9]{16,64}$/.test(evidenceId) ||
          QWEN_SENSITIVE_REPLAY_PATTERN.test(evidenceId),
      ))
  ) {
    throw new Error(
      "Production Qwen configuration requires three distinct opaque evidence bindings",
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
): readonly QwenTraceEvent[] {
  const milestones = execution.milestones.map((milestone) => {
    assertIsoTimestamp(milestone.observedAt, "milestone time");
    safeQwenUrl(milestone.url);
    const evidenceId =
      milestone.evidenceId ??
      opaqueEvidenceId({
        eventType: milestone.eventType,
        observedAt: milestone.observedAt,
      });
    return Object.freeze({
      eventType: milestone.eventType,
      observedAt: milestone.observedAt,
      sourceUrl: `urn:qwen-evidence:${evidenceId}`,
      evidenceRef: evidenceId,
    });
  });
  const artifactEvents: readonly QwenTraceEvent[] = [
    {
      eventType: "artifact_downloaded",
      observedAt: execution.download.capturedAt,
      sourceUrl: "urn:qwen-evidence:artifact-download",
      evidenceRef: opaqueEvidenceId({
        eventType: "artifact_downloaded",
        observedAt: execution.download.capturedAt,
      }),
    },
    {
      eventType: "artifact_validated",
      observedAt: execution.download.capturedAt,
      sourceUrl: "urn:qwen-evidence:artifact-validation",
      evidenceRef: opaqueEvidenceId({
        eventType: "artifact_validated",
        observedAt: execution.download.capturedAt,
      }),
    },
    ...(execution.staticRenders.length === 0
      ? []
      : [{
          eventType: "static_render_validated" as const,
          observedAt: execution.download.capturedAt,
          sourceUrl: "urn:qwen-evidence:static-render",
          evidenceRef: opaqueEvidenceId({
            eventType: "static_render_validated",
            observedAt: execution.download.capturedAt,
          }),
        }]),
  ];
  return Object.freeze([...milestones, ...artifactEvents]);
}

function createTerminalTrace(
  execution: QwenBrowserTerminalExecution,
): readonly QwenTraceEvent[] {
  const milestones = execution.milestones.map((milestone) => {
    assertIsoTimestamp(milestone.observedAt, "milestone time");
    safeQwenUrl(milestone.url);
    const evidenceId =
      milestone.evidenceId ??
      opaqueEvidenceId({
        eventType: milestone.eventType,
        observedAt: milestone.observedAt,
      });
    return Object.freeze({
      eventType: milestone.eventType,
      observedAt: milestone.observedAt,
      sourceUrl: `urn:qwen-evidence:${evidenceId}`,
      evidenceRef: evidenceId,
    });
  });
  const last = milestones.at(-1);
  assertIsoTimestamp(execution.observedAt, "terminal time");
  if (last === undefined) {
    safeQwenUrl(
      execution.observedConfiguration?.actualUrl ?? QWEN_ENTRY_URL,
    );
  }
  const terminalEvidenceId = opaqueEvidenceId({
    eventType: "terminal_observed",
    observedAt: execution.observedAt,
    terminalReason: execution.terminalReason,
  });
  return Object.freeze([
    ...milestones,
    Object.freeze({
      eventType: "terminal_observed" as const,
      observedAt: execution.observedAt,
      sourceUrl: `urn:qwen-evidence:${terminalEvidenceId}`,
      evidenceRef: terminalEvidenceId,
    }),
  ]);
}

function opaqueEvidenceId(
  value: unknown,
): `ev_${string}` {
  return `ev_${sha256(textEncoder.encode(JSON.stringify(value))).slice(7, 39)}`;
}

async function persistedObservableEvents(
  command: ProductRunCommand,
  execution: QwenBrowserExecution,
  checkpointStore: AttemptCheckpointPort | undefined,
  production: boolean,
): Promise<readonly ObservableAttemptEvent[]> {
  const events: ObservableAttemptEvent[] = [];
  let submitted = false;
  for (const [index, milestone] of execution.milestones.entries()) {
    assertIsoTimestamp(milestone.observedAt, "milestone time");
    safeQwenUrl(milestone.url);
    const evidenceId =
      milestone.evidenceId ??
      opaqueEvidenceId({
        attemptId: command.attemptId,
        eventType: milestone.eventType,
        index,
        observedAt: milestone.observedAt,
      });
    if (!/^ev_[a-f0-9]{16,64}$/.test(evidenceId)) {
      throw new Error("Qwen browser evidence ID must be opaque");
    }
    if (
      QWEN_MILESTONE_PHASE[milestone.eventType] !== "pre_submit"
    ) {
      submitted = true;
    }
    if (
      production &&
      submitted &&
      (milestone.vendorTaskId === undefined ||
        milestone.vendorTaskId === null ||
        milestone.taskStateVersion === undefined ||
        milestone.taskStateVersion === null)
    ) {
      throw new Error(
        "Production Qwen checkpoints require vendor task identity and state version",
      );
    }
    const event = Object.freeze({
      eventId: `${command.attemptId}-qwen-event-${index + 1}`,
      jobId: command.jobId,
      caseId: command.evaluationCase.caseId,
      runId: command.runId,
      attemptId: command.attemptId,
      attemptSeq: command.attemptSeq,
      eventType: milestone.eventType,
      sourceAt: milestone.observedAt,
      observedAt: milestone.observedAt,
      writerId: QWEN_ADAPTER_VERSION,
      evidenceRef: evidenceId,
      sourceUrl: `urn:qwen-evidence:${evidenceId}`,
      submissionEvidenceAtCheckpoint: submitted
        ? "submitted" as const
        : "not_submitted" as const,
      vendorTaskId: milestone.vendorTaskId ?? null,
      taskStateVersion: milestone.taskStateVersion ?? null,
      adapterVersion: QWEN_ADAPTER_VERSION,
      artifactId: null,
    });
    await checkpointStore?.append(event);
    events.push(event);
  }
  return Object.freeze(events);
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
  assertSubmissionEvidenceMatchesMilestones(execution);
}

function assertSubmissionEvidenceMatchesMilestones(
  execution: QwenBrowserExecution,
): void {
  const submissionObserved = execution.milestones.some(
    ({ eventType }) =>
      QWEN_MILESTONE_PHASE[eventType] !== "pre_submit",
  );
  if (
    (execution.submissionEvidence === "submitted" &&
      !submissionObserved) ||
    (execution.submissionEvidence !== "submitted" &&
      submissionObserved)
  ) {
    throw new Error(
      "Qwen post-submit milestone submission evidence contradicts observable checkpoints",
    );
  }
}

function assertSafeQwenReplayInput(
  execution: QwenBrowserExecution,
): void {
  for (const action of execution.manualActions) {
    if (
      typeof action.action !== "string" ||
      !QWEN_MANUAL_ACTION_TYPES.has(
        action.action as QwenManualActionType,
      ) ||
      QWEN_SENSITIVE_REPLAY_PATTERN.test(action.action)
    ) {
      throw new Error(
        "Qwen replay manual action is not allowlisted safe evidence",
      );
    }
    assertIsoTimestamp(action.observedAt, "manual-action time");
  }
  for (const milestone of execution.milestones) {
    if (
      typeof milestone.eventType !== "string" ||
      !Object.hasOwn(QWEN_MILESTONE_PHASE, milestone.eventType)
    ) {
      throw new Error(
        "Qwen replay milestone type is not allowlisted safe evidence",
      );
    }
    assertIsoTimestamp(milestone.observedAt, "milestone time");
    safeQwenUrl(milestone.url);
    if (
      milestone.evidenceId !== undefined &&
      (!/^ev_[a-f0-9]{16,64}$/.test(milestone.evidenceId) ||
        QWEN_SENSITIVE_REPLAY_PATTERN.test(milestone.evidenceId))
    ) {
      throw new Error(
        "Qwen replay evidence reference must be opaque safe evidence",
      );
    }
    if (
      milestone.vendorTaskId !== undefined &&
      milestone.vendorTaskId !== null &&
      (!/^task_[a-z0-9][a-z0-9_-]{7,123}$/.test(
        milestone.vendorTaskId,
      ) ||
        QWEN_SENSITIVE_REPLAY_PATTERN.test(
          milestone.vendorTaskId,
        ))
    ) {
      throw new Error(
        "Qwen replay vendor task ID is unsafe structured evidence",
      );
    }
    if (
      milestone.taskStateVersion !== undefined &&
      milestone.taskStateVersion !== null &&
      (!/^[A-Za-z0-9._:@/-]{1,128}$/.test(
        milestone.taskStateVersion,
      ) ||
        QWEN_SENSITIVE_REPLAY_PATTERN.test(
          milestone.taskStateVersion,
        ))
    ) {
      throw new Error(
        "Qwen replay task state version is unsafe structured evidence",
      );
    }
  }
}

function terminalReasonForQwenReconciliation(
  observedState: ObservableAttemptEvent["reconciliationObservedState"],
): "task_state_unknown" | "download_failure" | "technical_failure" {
  if (observedState === "artifact_ready") return "download_failure";
  if (observedState === "failed") return "technical_failure";
  return "task_state_unknown";
}

function artifactReferenceForQwenReconciliation(
  observedState: ObservableAttemptEvent["reconciliationObservedState"],
  vendorTaskId: string,
): string | null {
  return observedState === "artifact_ready"
    ? `qwen-task:${vendorTaskId}`
    : null;
}

function assertDurableQwenReconciliation(
  event: ObservableAttemptEvent,
): void {
  const observedState = event.reconciliationObservedState;
  if (
    observedState === undefined ||
    !["unknown", "submitted", "artifact_ready", "failed"].includes(
      observedState,
    ) ||
    event.vendorTaskId === null ||
    event.vendorTaskId === undefined ||
    event.taskStateVersion === null ||
    event.taskStateVersion === undefined
  ) {
    throw new Error(
      "Durable Qwen reconciliation result is structurally incomplete",
    );
  }
  if (
    event.reconciliationTerminalReason !==
      terminalReasonForQwenReconciliation(observedState) ||
    (event.reconciliationArtifactReference ?? null) !==
      artifactReferenceForQwenReconciliation(
        observedState,
        event.vendorTaskId,
      )
  ) {
    throw new Error(
      "Durable Qwen reconciliation result is internally inconsistent",
    );
  }
}

function qwenExecutor(
  driver: QwenBrowserDriverPort,
  provenance: "MOCK" | "LIVE_PRODUCTION" | "PRODUCTION_REPLAY",
  environmentOrigin: EnvironmentOrigin,
  checkpointStore?: AttemptCheckpointPort,
  reconciliationDriver?: QwenBrowserDriverPort,
  testOnlyReconciliation = false,
  testOnlyProductionValidation = false,
): QwenProductAdapterExecutor {
  const productionValidation =
    provenance !== "MOCK" || testOnlyProductionValidation;
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
    const recoveredEvents =
      (await checkpointStore?.readAttempt?.(command.attemptId)) ?? [];
    if (recoveredEvents.length > 0) {
      for (const event of recoveredEvents) {
        if (
          event.jobId !== command.jobId ||
          event.caseId !== command.evaluationCase.caseId ||
          event.runId !== command.runId ||
          event.attemptId !== command.attemptId ||
          event.attemptSeq !== command.attemptSeq ||
          event.adapterVersion !== QWEN_ADAPTER_VERSION
        ) {
          throw new Error(
            "Recovered Qwen checkpoint lineage does not match the Attempt",
          );
        }
      }
      const latestDurableReconciliation = [...recoveredEvents]
        .reverse()
        .find(
          ({ eventType }) =>
            eventType === "task_reconciliation_result",
        );
      if (latestDurableReconciliation !== undefined) {
        assertDurableQwenReconciliation(
          latestDurableReconciliation,
        );
        const restoredEvents = Object.freeze(
          recoveredEvents.map((event) =>
            Object.freeze(structuredClone(event)),
          ),
        );
        return Object.freeze({
          terminalReason:
            latestDurableReconciliation.reconciliationTerminalReason!,
          blockReason: null,
          submissionEvidence: restoredEvents.some(
            ({ submissionEvidenceAtCheckpoint }) =>
              submissionEvidenceAtCheckpoint === "submitted",
          )
            ? "submitted"
            : "unknown",
          elapsedMs: 0,
          artifactCandidates: Object.freeze([]),
          observableEvents: restoredEvents,
          observedConfiguration: null,
          trace: Object.freeze([]),
          manualActions: Object.freeze([]),
          staticRenders: Object.freeze([]),
        });
      }
      const latestTaskCheckpoint = [...recoveredEvents].reverse().find(
        (event) =>
          event.vendorTaskId !== null &&
          event.vendorTaskId !== undefined &&
          event.taskStateVersion !== null &&
          event.taskStateVersion !== undefined,
      );
      if (latestTaskCheckpoint === undefined) {
        throw new Error(
          "Recovered Qwen checkpoints require vendor task identity and state version",
        );
      }
      const reconciliationQuery = {
          vendorTaskId:
            latestTaskCheckpoint.vendorTaskId as `task_${string}`,
          taskStateVersion:
            latestTaskCheckpoint.taskStateVersion as string,
          eventHistoryHash: sha256(
            textEncoder.encode(JSON.stringify(recoveredEvents)),
          ),
          artifactContentHash: null,
        };
      const reconciliation = testOnlyReconciliation
        ? reconcileTestQwenTask(
            reconciliationDriver!,
            reconciliationQuery,
          )
        : reconcileRegisteredQwenTask(
            reconciliationDriver,
            reconciliationQuery,
          );
      const reconciliationEvent = Object.freeze({
        eventId: `${command.attemptId}-qwen-reconciliation-${recoveredEvents.length + 1}`,
        jobId: command.jobId,
        caseId: command.evaluationCase.caseId,
        runId: command.runId,
        attemptId: command.attemptId,
        attemptSeq: command.attemptSeq,
        eventType: "task_reconciliation_result",
        sourceAt: reconciliation.observedAt,
        observedAt: reconciliation.observedAt,
        writerId: QWEN_ADAPTER_VERSION,
        evidenceRef: reconciliation.evidenceId,
        sourceUrl:
          `urn:qwen-evidence:${reconciliation.evidenceId}`,
        submissionEvidenceAtCheckpoint: recoveredEvents.some(
          ({ submissionEvidenceAtCheckpoint }) =>
            submissionEvidenceAtCheckpoint === "submitted",
        )
          ? "submitted" as const
          : "unknown" as const,
        vendorTaskId: reconciliation.query.vendorTaskId,
        taskStateVersion: reconciliation.query.taskStateVersion,
        adapterVersion: QWEN_ADAPTER_VERSION,
        artifactId: null,
        reconciliationObservedState: reconciliation.observedState,
        reconciliationTerminalReason:
          terminalReasonForQwenReconciliation(
            reconciliation.observedState,
          ),
        reconciliationArtifactReference:
          artifactReferenceForQwenReconciliation(
            reconciliation.observedState,
            reconciliation.query.vendorTaskId,
          ),
      });
      await checkpointStore?.append(reconciliationEvent);
      const reconciledEvents = Object.freeze([
        ...recoveredEvents.map((event) =>
          Object.freeze(structuredClone(event)),
        ),
        reconciliationEvent,
      ]);
      return Object.freeze({
        terminalReason:
          reconciliationEvent.reconciliationTerminalReason,
        blockReason: null,
        submissionEvidence: recoveredEvents.some(
          ({ submissionEvidenceAtCheckpoint }) =>
            submissionEvidenceAtCheckpoint === "submitted",
        )
          ? "submitted"
          : "unknown",
        elapsedMs: 0,
        artifactCandidates: Object.freeze([]),
        observableEvents: reconciledEvents,
        observedConfiguration: null,
        trace: Object.freeze([]),
        manualActions: Object.freeze([]),
        staticRenders: Object.freeze([]),
      });
    }
    const execution = await driver.execute({
      attemptSeq: command.attemptSeq,
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
    assertSafeQwenReplayInput(execution);
    const observableEvents = await persistedObservableEvents(
      command,
      execution,
      checkpointStore,
      productionValidation,
    );
    if (execution.status === "terminal") {
      validateTerminalExecution(execution);
      return Object.freeze({
        terminalReason: execution.terminalReason,
        blockReason: execution.blockReason,
        submissionEvidence: execution.submissionEvidence,
        elapsedMs: execution.elapsedMs,
        artifactCandidates: Object.freeze([]),
        observableEvents,
        observedConfiguration:
          execution.observedConfiguration === null
            ? null
            : validateObservedConfiguration(
                execution.observedConfiguration,
                productionValidation,
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
    assertSubmissionEvidenceMatchesMilestones(execution);
    const observedConfiguration =
      validateObservedConfiguration(
        execution.observedConfiguration,
        productionValidation,
      );
    if (productionValidation) {
      const evidenceBindings =
        observedConfiguration.evidenceBindings!;
      const dedicatedMilestones = [
        ["package", "package_observed"],
        ["model", "model_observed"],
        ["configuration", "configuration_applied"],
      ] as const;
      if (
        dedicatedMilestones.some(
          ([binding, eventType]) =>
            !execution.milestones.some(
              (milestone) =>
                milestone.eventType === eventType &&
                milestone.evidenceId === evidenceBindings[binding],
            ),
        )
      ) {
        throw new Error(
          "Production Qwen configuration evidence requires dedicated package, model, and configuration milestones",
        );
      }
    }
    const artifact = artifactFromDownload(
      command,
      execution.download,
      provenance,
      environmentOrigin,
    );
    if (
      productionValidation &&
      execution.staticRenders.length > 0
    ) {
      throw new Error(
        "Production Qwen driver cannot submit raster output before renderer authorization",
      );
    }
    const staticRenders =
      provenance === "MOCK"
        ? validateStaticRenders(
            execution.staticRenders,
            artifact.pageCount,
          )
        : Object.freeze([] as QwenStaticRender[]);
    for (const action of execution.manualActions) {
      assertIsoTimestamp(action.observedAt, "manual-action time");
    }
    return Object.freeze({
      terminalReason: "success",
      blockReason: null,
      submissionEvidence: execution.submissionEvidence,
      elapsedMs: execution.elapsedMs,
      artifactCandidates: Object.freeze([
        Object.freeze({
          artifact,
          ...(provenance === "MOCK"
            ? {}
            : {
                productionExecutionEvidence: (() => {
                  const latest = [...observableEvents].reverse().find(
                    (event) =>
                      event.vendorTaskId !== null &&
                      event.vendorTaskId !== undefined &&
                      event.taskStateVersion !== null &&
                      event.taskStateVersion !== undefined,
                  );
                  if (latest === undefined) {
                    throw new Error(
                      "Production Qwen Artifact requires retained task lineage",
                    );
                  }
                  return Object.freeze({
                    executionMode: provenance,
                    captureSource:
                      provenance === "LIVE_PRODUCTION"
                        ? "LIVE_BROWSER_AUTOMATION" as const
                        : "REAL_PROVIDER_CAPTURE" as const,
                    driverSessionId:
                      `session_${provenance === "LIVE_PRODUCTION" ? "live" : "replay"}_${artifact.contentHash.slice(7, 39)}` as `session_${string}`,
                    vendorTaskId:
                      latest.vendorTaskId as `task_${string}`,
                    taskStateVersion:
                      latest.taskStateVersion as string,
                    driverVersion: QWEN_BROWSER_DRIVER_VERSION,
                    adapterVersion: QWEN_ADAPTER_VERSION,
                    outcome: "captured" as const,
                    artifactContentHash: artifact.contentHash,
                    traceHash: sha256(
                      textEncoder.encode(
                        JSON.stringify(observableEvents),
                      ),
                    ),
                    ...(provenance === "LIVE_PRODUCTION"
                      ? {
                          liveBridgeTranscriptHash: sha256(
                            textEncoder.encode(
                              JSON.stringify(observableEvents),
                            ),
                          ),
                        }
                      : {}),
                  });
                })(),
              }),
          policyCompliant: true,
        }),
      ]),
      observableEvents,
      observedConfiguration,
      trace: createTrace(execution),
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

export function createQwenReplayBehaviorExecutorForTest(input: {
  readonly sessions: readonly QwenBrowserExecution[];
  readonly reconciliations?: readonly QwenTaskReconciliationEvidence[];
  readonly checkpointStore?: AttemptCheckpointPort;
}): QwenProductAdapterExecutor {
  const sessions = Object.freeze(
    input.sessions.map((session) =>
      Object.freeze(structuredClone(session)),
    ),
  );
  const driver: QwenBrowserDriverPort = Object.freeze({
    runtimeProvenance: "TEST",
    reconciliations: Object.freeze(
      (input.reconciliations ?? []).map((entry) =>
        Object.freeze(structuredClone(entry)),
      ),
    ),
    async execute(command: QwenBrowserExecutionCommand) {
      const session = sessions[command.attemptSeq - 1];
      if (session === undefined) {
        throw new Error(
          `Qwen TEST replay fixture has no session for attempt ${command.attemptSeq}`,
        );
      }
      return Object.freeze(structuredClone(session));
    },
  });
  return qwenExecutor(
    driver,
    "MOCK",
    MOCK_TEST_ENVIRONMENT_ORIGIN,
    input.checkpointStore,
    driver,
    true,
    true,
  );
}

export function resolveQwenProductionAdapterExecutor(
  implementation: ProductAdapterImplementationPackage,
  executionConfiguration: ProductAdapterExecutionConfiguration,
  driver: QwenBrowserDriverPort | undefined,
  checkpointStore?: AttemptCheckpointPort,
): ProductAdapterExecutor {
  if (
    executionConfiguration.adapterKind !==
      QWEN_PRODUCTION_ADAPTER_KIND ||
    !["production-live", "production-replay"].includes(
      executionConfiguration.scenario,
    )
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
  const registeredDriver = registeredProductionQwenDriver(driver);
  if (
    (executionConfiguration.scenario === "production-live" &&
      registeredDriver.runtimeProvenance !== "LIVE_PRODUCTION") ||
    (executionConfiguration.scenario === "production-replay" &&
      registeredDriver.runtimeProvenance !== "PRODUCTION_REPLAY")
  ) {
    throw new Error(
      "Qwen live and replay execution lineage must match the frozen driver provenance",
    );
  }
  return qwenExecutor(
    registeredDriver,
    registeredDriver.runtimeProvenance,
    PRODUCTION_ENVIRONMENT_ORIGIN,
    checkpointStore,
    driver,
  );
}

function implementationPackage(): ProductAdapterImplementationPackage {
  return Object.freeze({
    packageName: "src/qwen-production-adapter.ts#QwenProductionProductAdapter",
    contentHash: sha256(implementationContent),
    content: Uint8Array.from(implementationContent),
  });
}

function executionConfigurationPackage(
  scenario: "production-live" | "production-replay",
): ProductAdapterImplementationPackage {
  const content = textEncoder.encode(
    JSON.stringify({
      adapterKind: QWEN_PRODUCTION_ADAPTER_KIND,
      scenario,
      schemaVersion:
        "product-adapter-execution-configuration-v1",
    }),
  );
  return Object.freeze({
    packageName:
      `qwen-production-execution-configuration#${scenario}`,
    contentHash: sha256(content),
    content,
  });
}

const QWEN_PRODUCT_PACKAGE: ProductPackageSnapshot = Object.freeze({
  packageId: "qwen-web-best-zero-added-cost-volcano-16-v1",
  vendorId: "qwen",
  displayName: "千问网页 PPT",
  adapterVersion: QWEN_ADAPTER_VERSION,
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

const QWEN_REPLAY_PRODUCT_PACKAGE: ProductPackageSnapshot =
  Object.freeze({
    ...QWEN_PRODUCT_PACKAGE,
    packageId: "qwen-web-real-provider-replay-v1",
    displayName: "千问网页 PPT retained real-provider replay",
    provenance: "PRODUCTION_REPLAY",
    egressDestination: Object.freeze({
      targetService: "qwen-replay-ingest",
      targetAccount: "retained-real-provider-capture",
      targetRegion: "local",
      subprocessors: [],
    }),
  });

export class QwenProductionProductAdapter implements ProductAdapterPort {
  readonly implementationPackage = implementationPackage();
  readonly executionConfigurationPackage =
    executionConfigurationPackage("production-live");
  readonly productPackage = QWEN_PRODUCT_PACKAGE;
}

export class QwenReplayProductAdapter implements ProductAdapterPort {
  readonly implementationPackage = implementationPackage();
  readonly executionConfigurationPackage =
    executionConfigurationPackage("production-replay");
  readonly productPackage = QWEN_REPLAY_PRODUCT_PACKAGE;
}

export function expectedQwenProductionImplementationPackage():
  ProductAdapterImplementationPackage {
  return implementationPackage();
}
