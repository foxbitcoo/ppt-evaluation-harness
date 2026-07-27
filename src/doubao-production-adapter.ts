import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { PRODUCTION_ENVIRONMENT_ORIGIN } from "./environment-origin.ts";
import { VOLCANO_EVALUATION_CASE } from "./fixtures/volcano-case.ts";
import type {
  ObservedProductConfiguration,
  ProductAdapterImplementationPackage,
  ProductAdapterExecutor,
  ProductAdapterObservableEvent,
  ProductAdapterPort,
  ProductEvaluationConfigurationSnapshot,
  ProductAttemptResult,
  ProductRunCommand,
  ProductPackageSnapshot,
} from "./product-adapter.ts";

export const DOUBAO_PRODUCTION_ADAPTER_KIND = "doubao-web-ppt";
export const DOUBAO_PRODUCTION_ADAPTER_VERSION = "doubao-web-ppt@1";
export const DOUBAO_PRODUCTION_SCENARIO =
  "volcano-16-current-account-zero-cost-network-on";
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;

class DoubaoCaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoubaoCaptureValidationError";
  }
}

const encoder = new TextEncoder();
const doubaoAdapterModuleContent = readFileSync(new URL(import.meta.url));

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function frozenPackage(
  packageName: string,
  value: Readonly<Record<string, string>>,
): ProductAdapterImplementationPackage {
  const content = encoder.encode(JSON.stringify(value));
  return Object.freeze({
    packageName,
    contentHash: sha256(content),
    content,
  });
}

function configuredImplementationPackage():
  ProductAdapterImplementationPackage {
  const content = Uint8Array.from(doubaoAdapterModuleContent);
  return Object.freeze({
    packageName:
      "src/doubao-production-adapter.ts#DoubaoProductionProductAdapter",
    contentHash: sha256(content),
    content,
  });
}

function configuredExecutionConfigurationPackage():
  ProductAdapterImplementationPackage {
  return frozenPackage("doubao-production-execution-configuration@1", {
    adapterKind: DOUBAO_PRODUCTION_ADAPTER_KIND,
    scenario: DOUBAO_PRODUCTION_SCENARIO,
    schemaVersion: "product-adapter-execution-configuration-v1",
  });
}

export const DOUBAO_PRODUCTION_IMPLEMENTATION_PACKAGE =
  configuredImplementationPackage();
export const DOUBAO_PRODUCTION_EXECUTION_CONFIGURATION_PACKAGE =
  configuredExecutionConfigurationPackage();

const DOUBAO_EVALUATION_CONFIGURATION =
  Object.freeze<ProductEvaluationConfigurationSnapshot>({
    accountContext: "current_authenticated_account",
    benchmarkProtocol: "best_available_zero_incremental_cost",
    entryUrl: "https://www.doubao.com/",
    modelSelection: "best_available_for_current_account",
    networking: "enabled",
    purchasePolicy: "no_incremental_charge",
    requestedPageCount: 16,
  });

const DOUBAO_PRODUCT_PACKAGE = Object.freeze<ProductPackageSnapshot>({
  packageId: "doubao-web-ppt-current-account-zero-cost-v1",
  vendorId: "doubao",
  displayName: "Doubao Web PPT",
  adapterVersion: DOUBAO_PRODUCTION_ADAPTER_VERSION,
  provenance: "PRODUCTION",
  environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
  egressDestination: Object.freeze({
    targetService: "doubao-web",
    targetAccount: "current-authenticated-doubao-account",
    targetRegion: "cn",
    subprocessors: [],
  }),
  evaluationConfiguration: DOUBAO_EVALUATION_CONFIGURATION,
});

export class DoubaoProductionProductAdapter
  implements ProductAdapterPort
{
  readonly implementationPackage: ProductAdapterImplementationPackage;
  readonly executionConfigurationPackage:
    ProductAdapterImplementationPackage;
  readonly productPackage: ProductPackageSnapshot;

  constructor() {
    this.implementationPackage = configuredImplementationPackage();
    this.executionConfigurationPackage =
      configuredExecutionConfigurationPackage();
    this.productPackage = Object.freeze({
      ...DOUBAO_PRODUCT_PACKAGE,
      egressDestination: Object.freeze({
        ...DOUBAO_PRODUCT_PACKAGE.egressDestination,
        subprocessors: Object.freeze([
          ...DOUBAO_PRODUCT_PACKAGE.egressDestination.subprocessors,
        ]),
      }),
    });
  }
}

interface DoubaoBrowserOperationCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly signal: AbortSignal;
}

export interface DoubaoPackageObservation {
  readonly observedAt: string;
  readonly sourceUrl: string;
  readonly accountEvidence: "current_account_signed_in";
  readonly planName: string;
  readonly modelName: string;
  readonly modeName: string;
  readonly networking: "enabled";
  readonly requestedPageCount: 16;
  readonly bestAvailableForCurrentAccount: boolean;
  readonly incrementalChargeRequired: boolean;
  readonly evidenceRef: string;
  readonly manualActions: readonly string[];
}

export interface DoubaoSubmitQueryCommand
  extends DoubaoBrowserOperationCommand {
  readonly vendorPrompt: string;
  readonly requestedPageCount: 16;
  readonly networking: "enabled";
}

export type DoubaoSubmissionObservation =
  | {
      readonly status: "submitted";
      readonly vendorTaskId: string;
      readonly observedAt: string;
      readonly evidenceRef: string;
      readonly manualActions: readonly string[];
    }
  | {
      readonly status: "not_submitted" | "unknown";
      readonly observedAt: string;
      readonly evidenceRef: string;
      readonly manualActions: readonly string[];
    };

export interface DoubaoWaitForGenerationCommand
  extends DoubaoBrowserOperationCommand {
  readonly vendorTaskId: string;
  readonly timeoutMs: number;
}

export type DoubaoGenerationObservation =
  | {
      readonly status: "generated";
      readonly observedAt: string;
      readonly completionUrl: string;
      readonly previewPageCount: number;
      readonly evidenceRef: string;
      readonly manualActions: readonly string[];
    }
  | {
      readonly status: "timed_out" | "failed" | "waiting_for_human";
      readonly observedAt: string;
      readonly evidenceRef: string;
      readonly manualActions: readonly string[];
    };

export interface DoubaoExportPresentationCommand
  extends DoubaoBrowserOperationCommand {
  readonly vendorTaskId: string;
}

export type DoubaoExportObservation =
  | {
      readonly status: "exported";
      readonly observedAt: string;
      readonly filename: string;
      readonly mimeType: typeof PPTX_MIME_TYPE;
      readonly pageCount: number;
      readonly content: Uint8Array;
      readonly evidenceRef: string;
      readonly manualActions: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly observedAt: string;
      readonly evidenceRef: string;
      readonly manualActions: readonly string[];
    };

export interface DoubaoRenderPresentationCommand
  extends DoubaoBrowserOperationCommand {
  readonly filename: string;
  readonly mimeType: typeof PPTX_MIME_TYPE;
  readonly pageCount: 16;
  readonly content: Uint8Array;
}

export interface DoubaoRenderedPage {
  readonly pageNumber: number;
  readonly filename: string;
  readonly mimeType: "image/png";
  readonly content: Uint8Array;
}

export type DoubaoRenderObservation =
  | {
      readonly status: "rendered";
      readonly observedAt: string;
      readonly renderer: string;
      readonly pages: readonly DoubaoRenderedPage[];
      readonly evidenceRef: string;
    }
  | {
      readonly status: "failed";
      readonly observedAt: string;
      readonly evidenceRef: string;
    };

export interface DoubaoBrowserDriverPort {
  inspectCurrentPackage(
    command: DoubaoBrowserOperationCommand,
  ): Promise<DoubaoPackageObservation>;
  submitFrozenQuery(
    command: DoubaoSubmitQueryCommand,
  ): Promise<DoubaoSubmissionObservation>;
  waitForGeneration(
    command: DoubaoWaitForGenerationCommand,
  ): Promise<DoubaoGenerationObservation>;
  exportPresentation(
    command: DoubaoExportPresentationCommand,
  ): Promise<DoubaoExportObservation>;
  renderPresentation(
    command: DoubaoRenderPresentationCommand,
  ): Promise<DoubaoRenderObservation>;
}

const FORBIDDEN_TRACE_FIELD =
  /cookie|authorization|password|localstorage|sessionstorage|chain.?of.?thought|hidden.?thought|reasoning|思维链|隐藏思考|推理过程/i;
const FORBIDDEN_TRACE_VALUE =
  /(?:bearer\s+[a-z0-9._-]+|cookie\s*[:=]|authorization\s*[:=]|password\s*[:=]|localstorage|sessionstorage|chain.?of.?thought|hidden.?thought|思维链|隐藏思考|推理过程)/i;

function assertSecretFree(value: unknown, path = "doubao"): void {
  if (value instanceof Uint8Array) return;
  if (typeof value === "string") {
    if (FORBIDDEN_TRACE_VALUE.test(value)) {
      throw new Error(`Doubao observable evidence is not secret-safe: ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretFree(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_TRACE_FIELD.test(key)) {
      throw new Error(`Doubao observable evidence is not secret-safe: ${path}`);
    }
    assertSecretFree(entry, `${path}.${key}`);
  }
}

function assertIsoTimestamp(value: string, field: string): void {
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`Doubao ${field} must be an ISO timestamp`);
  }
}

function assertSafeDoubaoUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Doubao ${field} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "doubao.com" &&
      !url.hostname.endsWith(".doubao.com")) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`Doubao ${field} must use a credential-free Doubao URL`);
  }
  for (const key of url.searchParams.keys()) {
    if (/token|auth|session|cookie|password|key/i.test(key)) {
      throw new Error(`Doubao ${field} contains sensitive URL parameters`);
    }
  }
}

function assertSafeEvidenceRef(value: string): void {
  if (
    !/^(?:screenshot|download|render|ui):\/\/[a-z0-9][a-z0-9./_-]*$/i.test(
      value,
    )
  ) {
    throw new Error("Doubao evidenceRef must be a safe opaque reference");
  }
  assertSecretFree(value, "evidenceRef");
}

function assertSafeText(value: string, field: string): void {
  if (
    value.trim().length === 0 ||
    value.length > 256 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  ) {
    throw new Error(`Doubao ${field} is invalid`);
  }
  assertSecretFree(value, field);
}

function assertRegisteredImplementationPackage(
  implementationPackage: ProductAdapterImplementationPackage,
): void {
  const expected = configuredImplementationPackage();
  if (
    implementationPackage.packageName !== expected.packageName ||
    implementationPackage.contentHash !== expected.contentHash ||
    sha256(implementationPackage.content) !==
      implementationPackage.contentHash ||
    !Buffer.from(implementationPackage.content).equals(
      Buffer.from(expected.content),
    )
  ) {
    throw new Error(
      "Product Adapter implementation package is not registered for doubao-web-ppt",
    );
  }
}

function operationCommand(
  command: ProductRunCommand,
): DoubaoBrowserOperationCommand {
  return {
    jobId: command.jobId,
    runId: command.runId,
    attemptId: command.attemptId,
    attemptSeq: command.attemptSeq,
    signal: command.signal,
  };
}

function traceEvent(
  eventType: ProductAdapterObservableEvent["eventType"],
  observedAt: string,
  evidenceRef: string,
): ProductAdapterObservableEvent {
  assertIsoTimestamp(observedAt, `${eventType}.observedAt`);
  assertSafeEvidenceRef(evidenceRef);
  return Object.freeze({ eventType, observedAt, evidenceRef });
}

function elapsedMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function failedAttempt(
  input: {
    readonly terminalReason: ProductAttemptResult["terminalReason"];
    readonly blockReason: ProductAttemptResult["blockReason"];
    readonly submissionEvidence: ProductAttemptResult["submissionEvidence"];
    readonly startedAt: string;
    readonly endedAt: string;
    readonly observableEvents: readonly ProductAdapterObservableEvent[];
    readonly manualActions: readonly string[];
    readonly observedConfiguration?: ObservedProductConfiguration;
  },
): ProductAttemptResult {
  return Object.freeze({
    terminalReason: input.terminalReason,
    blockReason: input.blockReason,
    submissionEvidence: input.submissionEvidence,
    elapsedMs: elapsedMs(input.startedAt, input.endedAt),
    artifactCandidates: [],
    observableEvents: Object.freeze([...input.observableEvents]),
    manualActions: Object.freeze([...input.manualActions]),
    ...(input.observedConfiguration === undefined
      ? {}
      : { observedConfiguration: input.observedConfiguration }),
  });
}

function observedConfiguration(
  observation: DoubaoPackageObservation,
): ObservedProductConfiguration | null {
  assertSecretFree(observation, "preflight");
  assertIsoTimestamp(observation.observedAt, "preflight.observedAt");
  assertSafeDoubaoUrl(observation.sourceUrl, "sourceUrl");
  assertSafeEvidenceRef(observation.evidenceRef);
  assertSafeText(observation.planName, "planName");
  assertSafeText(observation.modelName, "modelName");
  assertSafeText(observation.modeName, "modeName");
  observation.manualActions.forEach((action) =>
    assertSafeText(action, "manualAction"),
  );
  if (
    observation.networking !== "enabled" ||
    observation.requestedPageCount !== 16 ||
    !observation.bestAvailableForCurrentAccount ||
    observation.incrementalChargeRequired
  ) {
    return null;
  }
  return Object.freeze({
    sourceUrl: observation.sourceUrl,
    accountEvidence: observation.accountEvidence,
    planName: observation.planName,
    modelName: observation.modelName,
    modeName: observation.modeName,
    networking: observation.networking,
    requestedPageCount: observation.requestedPageCount,
    bestAvailableForCurrentAccount: true,
    incrementalChargeRequired: false,
  });
}

function assertExecutionCommand(command: ProductRunCommand): void {
  if (
    command.timeoutMs <= 0 ||
    command.timeoutMs > MAX_TIMEOUT_MS ||
    command.evaluationCase.caseId !== VOLCANO_EVALUATION_CASE.caseId ||
    command.evaluationCase.vendorPrompt !==
      VOLCANO_EVALUATION_CASE.vendorPrompt ||
    command.evaluationCase.targetPageCount !== 16
  ) {
    throw new Error(
      "Doubao production adapter supports only the frozen 16-page Volcano Query within the 30-minute policy",
    );
  }
}

function assertPptxExport(
  exported: Extract<DoubaoExportObservation, { status: "exported" }>,
): void {
  assertSecretFree(exported, "export");
  assertIsoTimestamp(exported.observedAt, "export.observedAt");
  assertSafeEvidenceRef(exported.evidenceRef);
  assertSafeText(exported.filename, "filename");
  exported.manualActions.forEach((action) =>
    assertSafeText(action, "manualAction"),
  );
  if (
    !exported.filename.toLowerCase().endsWith(".pptx") ||
    exported.mimeType !== PPTX_MIME_TYPE ||
    exported.pageCount !== 16 ||
    exported.content.byteLength < 4 ||
    exported.content[0] !== 0x50 ||
    exported.content[1] !== 0x4b ||
    exported.content[2] !== 0x03 ||
    exported.content[3] !== 0x04
  ) {
    throw new DoubaoCaptureValidationError(
      "Doubao export must be a real 16-page PPTX Artifact",
    );
  }
}

function validatedStaticRenders(
  rendered: Extract<DoubaoRenderObservation, { status: "rendered" }>,
) {
  assertSecretFree(rendered, "render");
  assertIsoTimestamp(rendered.observedAt, "render.observedAt");
  assertSafeEvidenceRef(rendered.evidenceRef);
  assertSafeText(rendered.renderer, "renderer");
  if (rendered.pages.length !== 16) {
    throw new DoubaoCaptureValidationError(
      "Doubao Artifact must have 16 static page renders",
    );
  }
  return Object.freeze(
    rendered.pages.map((page, index) => {
      assertSafeText(page.filename, "render.filename");
      if (
        page.pageNumber !== index + 1 ||
        page.mimeType !== "image/png" ||
        page.content.byteLength === 0
      ) {
        throw new DoubaoCaptureValidationError(
          "Doubao static render pages must be complete and sequential",
        );
      }
      return Object.freeze({
        pageNumber: page.pageNumber,
        filename: page.filename,
        mimeType: page.mimeType,
        byteSize: page.content.byteLength,
        contentHash: sha256(page.content),
      });
    }),
  );
}

export function resolveDoubaoProductionExecutor(
  implementationPackage: ProductAdapterImplementationPackage,
  driver: DoubaoBrowserDriverPort | undefined,
): ProductAdapterExecutor {
  assertRegisteredImplementationPackage(implementationPackage);
  if (driver === undefined) {
    throw new Error(
      "Doubao production adapter requires the trusted browser driver boundary",
    );
  }
  const executor: ProductAdapterExecutor = async (command) => {
    assertExecutionCommand(command);
    const operation = operationCommand(command);
    const events: ProductAdapterObservableEvent[] = [];
    const manualActions: string[] = [];
    const preflight = await driver.inspectCurrentPackage(operation);
    events.push(
      traceEvent(
        "preflight_observed",
        preflight.observedAt,
        preflight.evidenceRef,
      ),
    );
    manualActions.push(...preflight.manualActions);
    const configuration = observedConfiguration(preflight);
    if (configuration === null) {
      events.push(
        traceEvent(
          "query_not_submitted",
          preflight.observedAt,
          preflight.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason: preflight.incrementalChargeRequired
          ? "payment"
          : "technical_failure",
        blockReason: preflight.incrementalChargeRequired
          ? "payment"
          : null,
        submissionEvidence: "not_submitted",
        startedAt: preflight.observedAt,
        endedAt: preflight.observedAt,
        observableEvents: events,
        manualActions,
      });
    }
    const submission = await driver.submitFrozenQuery({
      ...operation,
      vendorPrompt: VOLCANO_EVALUATION_CASE.vendorPrompt,
      requestedPageCount: 16,
      networking: "enabled",
    });
    assertSecretFree(submission, "submission");
    assertIsoTimestamp(submission.observedAt, "submission.observedAt");
    assertSafeEvidenceRef(submission.evidenceRef);
    submission.manualActions.forEach((action) =>
      assertSafeText(action, "manualAction"),
    );
    manualActions.push(...submission.manualActions);
    if (submission.status !== "submitted") {
      events.push(
        traceEvent(
          submission.status === "not_submitted"
            ? "query_not_submitted"
            : "query_submission_unknown",
          submission.observedAt,
          submission.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: submission.status,
        startedAt: preflight.observedAt,
        endedAt: submission.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
      });
    }
    assertSafeText(submission.vendorTaskId, "vendorTaskId");
    events.push(
      traceEvent(
        "query_submitted",
        submission.observedAt,
        submission.evidenceRef,
      ),
    );
    const generation = await driver.waitForGeneration({
      ...operation,
      vendorTaskId: submission.vendorTaskId,
      timeoutMs: command.timeoutMs,
    });
    assertSecretFree(generation, "generation");
    assertIsoTimestamp(generation.observedAt, "generation.observedAt");
    assertSafeEvidenceRef(generation.evidenceRef);
    generation.manualActions.forEach((action) =>
      assertSafeText(action, "manualAction"),
    );
    manualActions.push(...generation.manualActions);
    if (generation.status !== "generated") {
      const eventType =
        generation.status === "timed_out"
          ? "generation_timed_out"
          : generation.status === "waiting_for_human"
            ? "waiting_for_human"
            : "generation_failed";
      events.push(
        traceEvent(
          eventType,
          generation.observedAt,
          generation.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason:
          generation.status === "timed_out"
            ? "vendor_timeout"
            : generation.status === "waiting_for_human"
              ? "human_wait"
              : "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: generation.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
      });
    }
    assertSafeDoubaoUrl(generation.completionUrl, "completionUrl");
    if (generation.previewPageCount !== 16) {
      events.push(
        traceEvent(
          "generation_failed",
          generation.observedAt,
          generation.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: generation.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
      });
    }
    events.push(
      traceEvent(
        "generation_ready",
        generation.observedAt,
        generation.evidenceRef,
      ),
    );
    const exported = await driver.exportPresentation({
      ...operation,
      vendorTaskId: submission.vendorTaskId,
    });
    if (exported.status !== "exported") {
      assertSecretFree(exported, "export");
      assertIsoTimestamp(exported.observedAt, "export.observedAt");
      assertSafeEvidenceRef(exported.evidenceRef);
      exported.manualActions.forEach((action) =>
        assertSafeText(action, "manualAction"),
      );
      manualActions.push(...exported.manualActions);
      events.push(
        traceEvent(
          "export_failed",
          exported.observedAt,
          exported.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: exported.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
      });
    }
    try {
      assertPptxExport(exported);
    } catch (error) {
      if (!(error instanceof DoubaoCaptureValidationError)) throw error;
      events.push(
        traceEvent(
          "export_failed",
          exported.observedAt,
          exported.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: exported.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
      });
    }
    manualActions.push(...exported.manualActions);
    events.push(
      traceEvent(
        "artifact_exported",
        exported.observedAt,
        exported.evidenceRef,
      ),
    );
    const rendered = await driver.renderPresentation({
      ...operation,
      filename: exported.filename,
      mimeType: exported.mimeType,
      pageCount: 16,
      content: Uint8Array.from(exported.content),
    });
    if (rendered.status !== "rendered") {
      assertSecretFree(rendered, "render");
      assertIsoTimestamp(rendered.observedAt, "render.observedAt");
      assertSafeEvidenceRef(rendered.evidenceRef);
      events.push(
        traceEvent(
          "render_failed",
          rendered.observedAt,
          rendered.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: rendered.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
      });
    }
    let staticRenders: ReturnType<typeof validatedStaticRenders>;
    try {
      staticRenders = validatedStaticRenders(rendered);
    } catch (error) {
      if (!(error instanceof DoubaoCaptureValidationError)) throw error;
      events.push(
        traceEvent(
          "render_failed",
          rendered.observedAt,
          rendered.evidenceRef,
        ),
      );
      return failedAttempt({
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: rendered.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
      });
    }
    events.push(
      traceEvent(
        "static_render_completed",
        rendered.observedAt,
        rendered.evidenceRef,
      ),
    );
    const content = Uint8Array.from(exported.content);
    const contentHash = sha256(content);
    const artifact = Object.freeze({
      artifactId: `artifact-doubao-${contentHash.slice(
        "sha256:".length,
        "sha256:".length + 32,
      )}`,
      runId: command.runId,
      provenance: "PRODUCTION" as const,
      environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
      filename: exported.filename,
      mimeType: exported.mimeType,
      byteSize: content.byteLength,
      pageCount: 16,
      contentHash,
      capturedAt: exported.observedAt,
      content,
    });
    return Object.freeze({
      terminalReason: "success" as const,
      blockReason: null,
      submissionEvidence: "submitted" as const,
      elapsedMs: elapsedMs(preflight.observedAt, rendered.observedAt),
      artifactCandidates: Object.freeze([
        Object.freeze({ artifact, policyCompliant: true }),
      ]),
      observableEvents: Object.freeze(events),
      manualActions: Object.freeze(manualActions),
      observedConfiguration: configuration,
      captureEvidence: Object.freeze({
        renderer: rendered.renderer,
        artifactContentHash: contentHash,
        artifactPageCount: 16 as const,
        staticRenders,
      }),
    });
  };
  return Object.freeze(executor);
}
