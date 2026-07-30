import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { PRODUCTION_ENVIRONMENT_ORIGIN } from "./environment-origin.ts";
import { VOLCANO_EVALUATION_CASE } from "./fixtures/volcano-case.ts";
import type {
  ObservableAttemptEvent,
} from "./domain.ts";
import type {
  ObservedProductConfiguration,
  ProductAdapterImplementationPackage,
  AttemptCheckpointPort,
  ProductAdapterExecutor,
  ProductAdapterObservableEvent,
  ProductAdapterPort,
  ProductEvaluationConfigurationSnapshot,
  ProductAttemptResult,
  ProductRunCommand,
  ProductPackageSnapshot,
  RealProviderCaptureReceiptEvidence,
  TrustedBrowserDriverEvidence,
} from "./product-adapter.ts";
import { canonicalJsonBytes } from "./run-specification.ts";
import {
  validatedOpenXmlPresentationSlideNames,
} from "./wps-aippt.ts";

export const DOUBAO_PRODUCTION_ADAPTER_KIND = "doubao-web-ppt";
export const DOUBAO_PRODUCTION_ADAPTER_VERSION = "doubao-web-ppt@1";
export const DOUBAO_BROWSER_DRIVER_VERSION =
  "doubao-harness-browser-bridge@2" as const;
export const DOUBAO_PRODUCTION_SCENARIO =
  "volcano-16-current-account-zero-cost-network-on";
export const DOUBAO_PRODUCTION_REPLAY_SCENARIO =
  "volcano-16-real-provider-replay";
export const DOUBAO_VOLCANO_REAL_CAPTURE_ID =
  "doubao-volcano-20260727-1845";
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;

class DoubaoCaptureValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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

function configuredReplayExecutionConfigurationPackage():
  ProductAdapterImplementationPackage {
  return frozenPackage("doubao-production-replay-execution-configuration@1", {
    adapterKind: DOUBAO_PRODUCTION_ADAPTER_KIND,
    scenario: DOUBAO_PRODUCTION_REPLAY_SCENARIO,
    schemaVersion: "product-adapter-execution-configuration-v1",
  });
}

function configuredDriverImplementationPackage():
  ProductAdapterImplementationPackage {
  return Object.freeze({
    packageName:
      "src/doubao-production-adapter.ts#trusted-browser-driver-runtime",
    contentHash: sha256(doubaoAdapterModuleContent),
    content: Uint8Array.from(doubaoAdapterModuleContent),
  });
}

export const DOUBAO_BROWSER_PROFILE_DIGEST = sha256(
  encoder.encode(
    JSON.stringify({
      automationSurface: "codex-external-chrome",
      credentialSource: "existing-user-profile",
      engine: "chrome",
      profileSchemaVersion: "doubao-browser-profile-v1",
    }),
  ),
);

function configuredDriverConfigurationPackage():
  ProductAdapterImplementationPackage {
  return frozenPackage("doubao-browser-driver-configuration@2", {
    browserProfileDigest: DOUBAO_BROWSER_PROFILE_DIGEST,
    driverVersion: DOUBAO_BROWSER_DRIVER_VERSION,
    schemaVersion: "doubao-browser-driver-configuration-v1",
  });
}

export const DOUBAO_PRODUCTION_IMPLEMENTATION_PACKAGE =
  configuredImplementationPackage();
export const DOUBAO_PRODUCTION_EXECUTION_CONFIGURATION_PACKAGE =
  configuredExecutionConfigurationPackage();
export const DOUBAO_PRODUCTION_REPLAY_EXECUTION_CONFIGURATION_PACKAGE =
  configuredReplayExecutionConfigurationPackage();

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
  provenance: "LIVE_PRODUCTION",
  environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
  egressDestination: Object.freeze({
    targetService: "doubao-web",
    targetAccount: "current-authenticated-doubao-account",
    targetRegion: "cn",
    subprocessors: [],
  }),
  evaluationConfiguration: DOUBAO_EVALUATION_CONFIGURATION,
});

const DOUBAO_REPLAY_PRODUCT_PACKAGE =
  Object.freeze<ProductPackageSnapshot>({
    ...DOUBAO_PRODUCT_PACKAGE,
    packageId: "doubao-web-ppt-real-provider-replay-v1",
    displayName: "Doubao Web PPT (Real Provider Replay)",
    provenance: "PRODUCTION_REPLAY",
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

export class DoubaoProductionReplayAdapter
  implements ProductAdapterPort
{
  readonly implementationPackage: ProductAdapterImplementationPackage;
  readonly executionConfigurationPackage:
    ProductAdapterImplementationPackage;
  readonly productPackage: ProductPackageSnapshot;

  constructor() {
    this.implementationPackage = configuredImplementationPackage();
    this.executionConfigurationPackage =
      configuredReplayExecutionConfigurationPackage();
    this.productPackage = Object.freeze({
      ...DOUBAO_REPLAY_PRODUCT_PACKAGE,
      environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
      egressDestination: Object.freeze({
        ...DOUBAO_REPLAY_PRODUCT_PACKAGE.egressDestination,
        subprocessors: Object.freeze([
          ...DOUBAO_REPLAY_PRODUCT_PACKAGE.egressDestination.subprocessors,
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
  readonly pageCount: number;
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
  readonly driverId?: "doubao-test-fixture" | "doubao-real-provider-replay";
  readonly provenance?: "TEST_FAKE" | "PRODUCTION_REPLAY";
  readonly captureSource?: "TEST_FIXTURE" | "REAL_PROVIDER_CAPTURE";
  readonly driverVersion?: typeof DOUBAO_BROWSER_DRIVER_VERSION;
  readonly browserProfileDigest?: typeof DOUBAO_BROWSER_PROFILE_DIGEST;
  readonly implementationPackage?: ProductAdapterImplementationPackage;
  readonly configurationPackage?: ProductAdapterImplementationPackage;
  readonly captureReceipt?: DoubaoRealProviderCaptureReceipt;
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
  reconcileTask?(
    query: DoubaoTaskReconciliationQuery,
  ): Promise<DoubaoTaskReconciliationEvidence>;
}

export interface DoubaoTaskReconciliationQuery {
  readonly vendorTaskId: string;
  readonly taskStateVersion: string;
  readonly eventHistoryHash: `sha256:${string}`;
  readonly artifactContentHash: `sha256:${string}` | null;
}

export interface DoubaoTaskReconciliationEvidence {
  readonly query: DoubaoTaskReconciliationQuery;
  readonly observedState: "unknown" | "submitted" | "artifact_ready" | "failed";
  readonly observedAt: string;
  readonly evidenceRef: string;
}

export interface DoubaoRealProviderCapture {
  readonly packageObservation: DoubaoPackageObservation;
  readonly submission: Extract<
    DoubaoSubmissionObservation,
    { status: "submitted" }
  >;
  readonly generation: Extract<
    DoubaoGenerationObservation,
    { status: "generated" }
  >;
  readonly artifact: Extract<
    DoubaoExportObservation,
    { status: "exported" }
  >;
}

export interface DoubaoRealProviderCaptureReceipt
  extends RealProviderCaptureReceiptEvidence {}

export interface DoubaoBrowserDriverEvidence
  extends TrustedBrowserDriverEvidence {
  readonly captureReceipt?: DoubaoRealProviderCaptureReceipt;
}

const HARNESS_OWNED_DOUBAO_CAPTURE_RECEIPTS =
  new Map<string, DoubaoRealProviderCaptureReceipt>([
    [
      DOUBAO_VOLCANO_REAL_CAPTURE_ID,
      Object.freeze({
        captureId: DOUBAO_VOLCANO_REAL_CAPTURE_ID,
        artifactContentHash:
          "sha256:ca1235d230e2b61ce083bebadaeaa5e434df985e7e81cfb1e41e068cba3a08a4",
        traceDigest:
          "sha256:594d9b94d81d98e4b8a1986db7353f6852ac17201076d85e5d6f64df505d40ad",
        retainedPageDigest:
          "sha256:8f9453b0cf3b88525d2ad69d7f0d854efd24cc7e86108fcafb82727912b46c3f",
        renderDigest:
          "sha256:047f33568528b87be6abc3ce17898fdb98d36ed5f38742eed3d4b05db7e26826",
      }),
    ],
  ]);
const registeredReplayDrivers = new WeakSet<object>();

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneValue(entry),
      ]),
    ) as T;
  }
  return value;
}

function captureTraceDigest(
  capture: DoubaoRealProviderCapture,
): `sha256:${string}` {
  const { content, ...artifactMetadata } = capture.artifact;
  return sha256(
    canonicalJsonBytes({
      packageObservation: capture.packageObservation,
      submission: capture.submission,
      generation: capture.generation,
      artifact: {
        ...artifactMetadata,
        contentHash: sha256(content),
      },
    }),
  );
}

function capturedRenderDigest(
  pages: readonly DoubaoRenderedPage[],
): `sha256:${string}` {
  if (
    pages.length !== 16 ||
    new Set(pages.map(({ pageNumber }) => pageNumber)).size !== 16 ||
    pages.some(
      ({ pageNumber, filename, mimeType, content }) =>
        pageNumber < 1 ||
        pageNumber > 16 ||
        filename !== `slide-${pageNumber}.png` ||
        mimeType !== "image/png" ||
        content.byteLength === 0,
    )
  ) {
    throw new Error(
      "Doubao registered immutable capture receipt requires 16 retained PNG renders",
    );
  }
  return sha256(
    canonicalJsonBytes(
      [...pages]
        .sort((left, right) => left.pageNumber - right.pageNumber)
        .map(({ pageNumber, filename, mimeType, content }) => ({
          pageNumber,
          filename,
          mimeType,
          contentHash: sha256(content),
        })),
    ),
  );
}

export function createDoubaoRealProviderReplayPackage(input: {
  readonly captureId: string;
  readonly renderedPages: readonly DoubaoRenderedPage[];
  readonly captures: readonly DoubaoRealProviderCapture[];
  readonly reconciliations?: readonly DoubaoTaskReconciliationEvidence[];
}): DoubaoBrowserDriverPort {
  if (
    input.captures.length !== 1
  ) {
    throw new Error(
      "Doubao registered immutable capture receipt requires one retained real-provider capture",
    );
  }
  const receipt =
    HARNESS_OWNED_DOUBAO_CAPTURE_RECEIPTS.get(input.captureId);
  const capture = input.captures[0]!;
  if (
    receipt === undefined ||
    sha256(capture.artifact.content) !==
      receipt.artifactContentHash ||
    captureTraceDigest(capture) !== receipt.traceDigest ||
    capturedRenderDigest(input.renderedPages) !==
      receipt.retainedPageDigest
  ) {
    throw new Error(
      "Doubao replay requires a registered immutable capture receipt",
    );
  }
  const captures = input.captures.map((capture) =>
    Object.freeze(cloneValue(capture)),
  );
  const reconciliations = (input.reconciliations ?? []).map((entry) =>
    Object.freeze(cloneValue(entry)),
  );
  const captureFor = (attemptSeq: number) => {
    const capture = captures[attemptSeq - 1];
    if (capture === undefined) {
      throw new Error(
        `Doubao replay has no captured session for attempt ${attemptSeq}`,
      );
    }
    return capture;
  };
  const driver = Object.freeze({
    driverId: "doubao-real-provider-replay",
    provenance: "PRODUCTION_REPLAY",
    captureSource: "REAL_PROVIDER_CAPTURE",
    driverVersion: DOUBAO_BROWSER_DRIVER_VERSION,
    browserProfileDigest: DOUBAO_BROWSER_PROFILE_DIGEST,
    implementationPackage: configuredDriverImplementationPackage(),
    configurationPackage: configuredDriverConfigurationPackage(),
    captureReceipt: Object.freeze(cloneValue(receipt)),
    async inspectCurrentPackage(command: DoubaoBrowserOperationCommand) {
      return cloneValue(captureFor(command.attemptSeq).packageObservation);
    },
    async submitFrozenQuery(command: DoubaoSubmitQueryCommand) {
      return cloneValue(captureFor(command.attemptSeq).submission);
    },
    async waitForGeneration(command: DoubaoWaitForGenerationCommand) {
      return cloneValue(captureFor(command.attemptSeq).generation);
    },
    async exportPresentation(command: DoubaoExportPresentationCommand) {
      return cloneValue(captureFor(command.attemptSeq).artifact);
    },
    async renderPresentation() {
      throw new Error(
        "Production replay rasterization belongs to the authorized safe renderer",
      );
    },
    async reconcileTask(query: DoubaoTaskReconciliationQuery) {
      const evidence = reconciliations.find(
        (candidate) =>
          JSON.stringify(candidate.query) === JSON.stringify(query),
      );
      if (evidence === undefined) {
        throw new Error(
          "Doubao replay reconciliation has no task/history/hash match",
        );
      }
      return cloneValue(evidence);
    },
  });
  registeredReplayDrivers.add(driver);
  return driver;
}

function assertDriverPackage(
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
    throw new Error(`Doubao browser driver ${label} is not allowlisted`);
  }
}

export function registeredDoubaoBrowserDriverEvidence(
  driver: DoubaoBrowserDriverPort | undefined,
): DoubaoBrowserDriverEvidence {
  if (driver === undefined) {
    return Object.freeze({
      driverId: "doubao-harness-browser-bridge",
      provenance: "LIVE_PRODUCTION",
      captureSource: "LIVE_BROWSER_AUTOMATION",
      driverVersion: DOUBAO_BROWSER_DRIVER_VERSION,
      browserProfileDigest: DOUBAO_BROWSER_PROFILE_DIGEST,
      implementationDigest:
        configuredDriverImplementationPackage().contentHash,
      configurationDigest:
        configuredDriverConfigurationPackage().contentHash,
    });
  }
  if (
    driver.driverId === "doubao-real-provider-replay" ||
    driver.provenance === "PRODUCTION_REPLAY" ||
    driver.captureSource === "REAL_PROVIDER_CAPTURE"
  ) {
    if (!registeredReplayDrivers.has(driver)) {
      throw new Error(
        "Doubao replay requires a registered immutable capture receipt",
      );
    }
    assertDriverPackage(
      driver.implementationPackage,
      configuredDriverImplementationPackage(),
      "implementation package",
    );
    assertDriverPackage(
      driver.configurationPackage,
      configuredDriverConfigurationPackage(),
      "configuration package",
    );
    if (
      driver.driverId !== "doubao-real-provider-replay" ||
      driver.provenance !== "PRODUCTION_REPLAY" ||
      driver.captureSource !== "REAL_PROVIDER_CAPTURE" ||
      driver.driverVersion !== DOUBAO_BROWSER_DRIVER_VERSION ||
      driver.browserProfileDigest !== DOUBAO_BROWSER_PROFILE_DIGEST
    ) {
      throw new Error(
        "Doubao real-provider replay identity is not allowlisted",
      );
    }
    return Object.freeze({
      driverId: driver.driverId,
      provenance: driver.provenance,
      captureSource: driver.captureSource,
      driverVersion: driver.driverVersion,
      browserProfileDigest: driver.browserProfileDigest,
      implementationDigest: driver.implementationPackage!.contentHash,
      configurationDigest: driver.configurationPackage!.contentHash,
      captureReceipt: Object.freeze(cloneValue(driver.captureReceipt!)),
    });
  }
  return Object.freeze({
    driverId: "doubao-test-fixture",
    provenance: "TEST_FAKE",
    captureSource: "TEST_FIXTURE",
    driverVersion: DOUBAO_BROWSER_DRIVER_VERSION,
    browserProfileDigest: DOUBAO_BROWSER_PROFILE_DIGEST,
    implementationDigest:
      configuredDriverImplementationPackage().contentHash,
    configurationDigest:
      configuredDriverConfigurationPackage().contentHash,
  });
}

const FORBIDDEN_TRACE_FIELD =
  /cookie|authorization|password|localstorage|sessionstorage|chain.?of.?thought|hidden.?thought|reasoning|思维链|隐藏思考|推理过程/i;
const FORBIDDEN_TRACE_VALUE =
  /(?:bearer\s+[a-z0-9._-]+|cookie\s*[:=]|authorization\s*[:=]|password\s*[:=]|localstorage|sessionstorage|chain.?of.?thought|hidden.?thought|思维链|隐藏思考|推理过程|\/Users\/|\/tmp\/|[a-z]:\\Users\\)/i;

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

function sanitizedDoubaoUrl(value: string, field: string): string {
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
  let fragment: string;
  try {
    fragment = decodeURIComponent(url.hash.slice(1).replace(/\+/g, "%20"));
  } catch {
    fragment = url.hash.slice(1);
  }
  if (
    /(?:^|[&;])(?:[^&;=]*(?:token|auth|session|cookie|password|key)[^&;=]*)\s*=/i.test(
      fragment,
    ) ||
    /bearer(?:\s+|%20)[a-z0-9._~-]+/i.test(fragment)
  ) {
    throw new Error(`Doubao ${field} contains sensitive URL fragment`);
  }
  return `${url.origin}/`;
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
    readonly command: ProductRunCommand;
    readonly terminalReason: ProductAttemptResult["terminalReason"];
    readonly blockReason: ProductAttemptResult["blockReason"];
    readonly submissionEvidence: ProductAttemptResult["submissionEvidence"];
    readonly startedAt: string;
    readonly endedAt: string;
    readonly observableEvents: readonly ProductAdapterObservableEvent[];
    readonly manualActions: readonly string[];
    readonly observedConfiguration?: ObservedProductConfiguration;
    readonly vendorTaskId?: string;
    readonly artifactId?: string;
  },
): ProductAttemptResult {
  return Object.freeze({
    terminalReason: input.terminalReason,
    blockReason: input.blockReason,
    submissionEvidence: input.submissionEvidence,
    elapsedMs: elapsedMs(input.startedAt, input.endedAt),
    artifactCandidates: [],
    observableEvents: materializeObservableEvents(
      input.command,
      input.observableEvents,
      input.vendorTaskId,
      input.artifactId,
    ),
    manualActions: Object.freeze([...input.manualActions]),
    ...(input.observedConfiguration === undefined
      ? {}
      : { observedConfiguration: input.observedConfiguration }),
  });
}

function materializeObservableEvents(
  command: ProductRunCommand,
  events: readonly ProductAdapterObservableEvent[],
  vendorTaskId?: string,
  artifactId?: string,
): readonly ObservableAttemptEvent[] {
  const submittedIndex = events.findIndex(
    ({ eventType }) => eventType === "query_submitted",
  );
  return Object.freeze(
    events.map((event, index) => {
      const eventVendorTaskId =
        vendorTaskId !== undefined &&
        submittedIndex >= 0 &&
        index >= submittedIndex
          ? vendorTaskId
          : undefined;
      return Object.freeze({
        eventId: `${command.attemptId}-event-${index + 1}`,
        jobId: command.jobId,
        caseId: command.evaluationCase.caseId,
        runId: command.runId,
        attemptId: command.attemptId,
        attemptSeq: command.attemptSeq,
        eventType: event.eventType,
        sourceAt: event.observedAt,
        observedAt: event.observedAt,
        writerId: DOUBAO_PRODUCTION_ADAPTER_VERSION,
        evidenceRef: event.evidenceRef,
        adapterVersion: DOUBAO_PRODUCTION_ADAPTER_VERSION,
        sourceUrl: "https://www.doubao.com/",
        submissionEvidenceAtCheckpoint:
          eventVendorTaskId === undefined
            ? "not_submitted"
            : "submitted",
        vendorTaskId: eventVendorTaskId ?? null,
        taskStateVersion:
          eventVendorTaskId === undefined
            ? null
            : `${event.eventType}@${index + 1}`,
        artifactId:
          event.eventType === "artifact_exported"
            ? artifactId ?? null
            : null,
      });
    }),
  );
}

function observedConfiguration(
  observation: DoubaoPackageObservation,
): ObservedProductConfiguration | null {
  assertSecretFree(observation, "preflight");
  assertIsoTimestamp(observation.observedAt, "preflight.observedAt");
  const sourceUrl = sanitizedDoubaoUrl(
    observation.sourceUrl,
    "sourceUrl",
  );
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
    sourceUrl,
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
): number {
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
    exported.content.byteLength < 4 ||
    exported.content[0] !== 0x50 ||
    exported.content[1] !== 0x4b ||
    exported.content[2] !== 0x03 ||
    exported.content[3] !== 0x04
  ) {
    throw new DoubaoCaptureValidationError(
      "Doubao export must be a real PPTX Artifact",
    );
  }
  try {
    const actualPageCount =
      validatedOpenXmlPresentationSlideNames(exported.content).length;
    if (
      exported.pageCount !== 16 ||
      actualPageCount !== 16
    ) {
      throw new DoubaoCaptureValidationError(
        "Doubao export metadata and openable OPC presentation must both contain exactly 16 pages",
      );
    }
    return actualPageCount;
  } catch (error) {
    if (error instanceof DoubaoCaptureValidationError) throw error;
    throw new DoubaoCaptureValidationError(
      "Doubao export must be an openable, inactive-content OPC presentation",
      { cause: error },
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
  checkpointStore?: AttemptCheckpointPort,
  executionMode: "live" | "replay" = "live",
): ProductAdapterExecutor {
  assertRegisteredImplementationPackage(implementationPackage);
  const driverEvidence = registeredDoubaoBrowserDriverEvidence(driver);
  const executor: ProductAdapterExecutor = async (command) => {
    assertExecutionCommand(command);
    const isProduction =
      command.evaluationCase.provenance === "PRODUCTION";
    if (isProduction && executionMode === "live") {
      if (driver !== undefined) {
        throw new Error(
          "Production Doubao Run rejects caller-supplied browser sessions",
        );
      }
      throw new Error(
        "Trusted live Doubao bridge executable is unavailable",
      );
    }
    if (
      executionMode === "replay" &&
      (!isProduction ||
        driver?.provenance !== "PRODUCTION_REPLAY" ||
        driver.captureSource !== "REAL_PROVIDER_CAPTURE")
    ) {
      throw new Error(
        "Doubao production replay requires a REAL_PROVIDER_CAPTURE replay package",
      );
    }
    if (!isProduction && driver === undefined) {
      throw new Error("Doubao test execution requires a browser fixture");
    }
    const operation = operationCommand(command);
    const events: ProductAdapterObservableEvent[] = [];
    const manualActions: string[] = [];
    const persistLatest = async (
      vendorTaskId?: string,
      artifactId?: string,
    ) => {
      const latest = materializeObservableEvents(
        command,
        events,
        vendorTaskId,
        artifactId,
      ).at(-1);
      if (latest !== undefined) await checkpointStore?.append(latest);
    };
    const recovered =
      (await checkpointStore?.readAttempt?.(command.attemptId)) ?? [];
    if (recovered.length > 0) {
      if (
        recovered.some(
          (event) =>
            event.jobId !== command.jobId ||
            event.runId !== command.runId ||
            event.attemptId !== command.attemptId ||
            event.caseId !== command.evaluationCase.caseId ||
            event.adapterVersion !==
              DOUBAO_PRODUCTION_ADAPTER_VERSION,
        )
      ) {
        throw new Error(
          "Recovered Doubao checkpoint lineage does not match the Attempt",
        );
      }
      const latestTask = [...recovered].reverse().find(
        ({ vendorTaskId, taskStateVersion }) =>
          vendorTaskId !== null &&
          vendorTaskId !== undefined &&
          taskStateVersion !== null &&
          taskStateVersion !== undefined,
      );
      if (latestTask !== undefined) {
        if (driver?.reconcileTask === undefined) {
          throw new Error(
            "Recovered submitted Doubao Attempt requires durable reconciliation",
          );
        }
        const query: DoubaoTaskReconciliationQuery = {
          vendorTaskId: latestTask.vendorTaskId!,
          taskStateVersion: latestTask.taskStateVersion!,
          eventHistoryHash: sha256(
            encoder.encode(JSON.stringify(recovered)),
          ),
          artifactContentHash: null,
        };
        const reconciliation = await driver.reconcileTask(query);
        assertIsoTimestamp(
          reconciliation.observedAt,
          "reconciliation.observedAt",
        );
        assertSafeEvidenceRef(reconciliation.evidenceRef);
        const reconciliationEvent: ObservableAttemptEvent =
          Object.freeze({
            ...latestTask,
            eventId: `${command.attemptId}-reconciliation-${recovered.length + 1}`,
            eventType: "task_reconciliation_result",
            sourceAt: reconciliation.observedAt,
            observedAt: reconciliation.observedAt,
            evidenceRef: reconciliation.evidenceRef,
            reconciliationObservedState:
              reconciliation.observedState,
            reconciliationTerminalReason:
              reconciliation.observedState === "artifact_ready"
                ? "download_failure"
                : reconciliation.observedState === "failed"
                  ? "technical_failure"
                : "task_state_unknown",
            reconciliationArtifactReference: null,
          });
        await checkpointStore?.append(reconciliationEvent);
        return Object.freeze({
          terminalReason:
            reconciliation.observedState === "artifact_ready"
              ? "download_failure"
              : reconciliation.observedState === "failed"
                ? "technical_failure"
              : "task_state_unknown",
          blockReason: null,
          submissionEvidence: "submitted",
          elapsedMs: 0,
          artifactCandidates: Object.freeze([]),
          observableEvents: Object.freeze([
            ...recovered,
            reconciliationEvent,
          ]),
          manualActions: Object.freeze([
            "reconciled retained submitted Doubao task before browser reuse",
          ]),
        });
      }
    }
    const activeDriver = driver!;
    const preflight = await activeDriver.inspectCurrentPackage(operation);
    events.push(
      traceEvent(
        "preflight_observed",
        preflight.observedAt,
        preflight.evidenceRef,
      ),
    );
    await persistLatest();
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
      await persistLatest();
      return failedAttempt({
        command,
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
    const submission = await activeDriver.submitFrozenQuery({
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
      await persistLatest();
      return failedAttempt({
        command,
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
    await persistLatest(submission.vendorTaskId);
    const generation = await activeDriver.waitForGeneration({
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
      await persistLatest(submission.vendorTaskId);
      return failedAttempt({
        command,
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
        vendorTaskId: submission.vendorTaskId,
      });
    }
    sanitizedDoubaoUrl(generation.completionUrl, "completionUrl");
    if (generation.previewPageCount !== 16) {
      manualActions.push(
        `page-count-deviation: preview=${generation.previewPageCount} requested=16`,
      );
    }
    events.push(
      traceEvent(
        "generation_ready",
        generation.observedAt,
        generation.evidenceRef,
      ),
    );
    await persistLatest(submission.vendorTaskId);
    if (command.signal.aborted) {
      return failedAttempt({
        command,
        terminalReason: "task_state_unknown",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: generation.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
        vendorTaskId: submission.vendorTaskId,
      });
    }
    const exported = await activeDriver.exportPresentation({
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
      await persistLatest(submission.vendorTaskId);
      return failedAttempt({
        command,
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: exported.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
        vendorTaskId: submission.vendorTaskId,
      });
    }
    let actualPageCount: number;
    try {
      actualPageCount = assertPptxExport(exported);
    } catch (error) {
      if (!(error instanceof DoubaoCaptureValidationError)) throw error;
      events.push(
        traceEvent(
          "export_failed",
          exported.observedAt,
          exported.evidenceRef,
        ),
      );
      await persistLatest(submission.vendorTaskId);
      return failedAttempt({
        command,
        terminalReason: "technical_failure",
        blockReason: null,
        submissionEvidence: "submitted",
        startedAt: preflight.observedAt,
        endedAt: exported.observedAt,
        observableEvents: events,
        manualActions,
        observedConfiguration: configuration,
        vendorTaskId: submission.vendorTaskId,
      });
    }
    manualActions.push(...exported.manualActions);
    if (actualPageCount !== 16) {
      manualActions.push(
        `page-count-deviation: artifact=${actualPageCount} requested=16`,
      );
    }
    const content = Uint8Array.from(exported.content);
    const contentHash = sha256(content);
    const artifactId = `artifact-doubao-${contentHash.slice(
      "sha256:".length,
      "sha256:".length + 32,
    )}`;
    events.push(
      traceEvent(
        "artifact_exported",
        exported.observedAt,
        exported.evidenceRef,
      ),
    );
    await persistLatest(submission.vendorTaskId, artifactId);
    const observableEvents = materializeObservableEvents(
      command,
      events,
      submission.vendorTaskId,
      artifactId,
    );
    const provenance =
      isProduction
        ? executionMode === "replay"
          ? "PRODUCTION_REPLAY"
          : "LIVE_PRODUCTION"
        : "MOCK";
    const artifact = Object.freeze({
      artifactId,
      runId: command.runId,
      provenance,
      environmentOrigin: isProduction
        ? PRODUCTION_ENVIRONMENT_ORIGIN
        : command.evaluationCase.environmentOrigin,
      filename: exported.filename,
      mimeType: exported.mimeType,
      byteSize: content.byteLength,
      pageCount: actualPageCount,
      contentHash,
      capturedAt: exported.observedAt,
      content,
    });
    const productionExecutionEvidence =
      isProduction
        ? Object.freeze({
            executionMode:
              executionMode === "replay"
                ? "PRODUCTION_REPLAY" as const
                : "LIVE_PRODUCTION" as const,
            captureSource:
              executionMode === "replay"
                ? "REAL_PROVIDER_CAPTURE" as const
                : "LIVE_BROWSER_AUTOMATION" as const,
            driverSessionId:
              `session_${executionMode}_${contentHash.slice(7, 39)}` as const,
            vendorTaskId:
              (/^task_[a-z0-9_-]+$/i.test(submission.vendorTaskId)
                ? submission.vendorTaskId
                : `task_${sha256(
                    encoder.encode(submission.vendorTaskId),
                  ).slice(7, 39)}`) as `task_${string}`,
            taskStateVersion:
              observableEvents.at(-1)?.taskStateVersion ??
              "artifact_exported@4",
            driverVersion: driverEvidence.driverVersion,
            adapterVersion: DOUBAO_PRODUCTION_ADAPTER_VERSION,
            outcome: "captured" as const,
            artifactContentHash: contentHash,
            traceHash: sha256(
              encoder.encode(JSON.stringify(observableEvents)),
            ),
            ...(driverEvidence.captureReceipt === undefined
              ? {}
              : {
                  captureReceipt: Object.freeze(
                    cloneValue(driverEvidence.captureReceipt),
                  ),
                }),
          })
        : undefined;
    const artifactCandidate = Object.freeze({
      artifact,
      policyCompliant: true,
      ...(productionExecutionEvidence === undefined
        ? {}
        : { productionExecutionEvidence }),
    });
    if (isProduction) {
      return Object.freeze({
        terminalReason: "success" as const,
        blockReason: null,
        submissionEvidence: "submitted" as const,
        elapsedMs: elapsedMs(
          preflight.observedAt,
          exported.observedAt,
        ),
        artifactCandidates: Object.freeze([artifactCandidate]),
        observableEvents,
        manualActions: Object.freeze(manualActions),
        observedConfiguration: configuration,
      });
    }
    const rendered = await activeDriver.renderPresentation({
      ...operation,
      filename: exported.filename,
      mimeType: exported.mimeType,
      pageCount: actualPageCount,
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
      return Object.freeze({
        terminalReason: "success" as const,
        blockReason: null,
        submissionEvidence: "submitted" as const,
        elapsedMs: elapsedMs(preflight.observedAt, rendered.observedAt),
        artifactCandidates: Object.freeze([artifactCandidate]),
        observableEvents:
          materializeObservableEvents(
            command,
            events,
            submission.vendorTaskId,
            artifactId,
          ),
        manualActions: Object.freeze(manualActions),
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
      return Object.freeze({
        terminalReason: "success" as const,
        blockReason: null,
        submissionEvidence: "submitted" as const,
        elapsedMs: elapsedMs(preflight.observedAt, rendered.observedAt),
        artifactCandidates: Object.freeze([artifactCandidate]),
        observableEvents:
          materializeObservableEvents(
            command,
            events,
            submission.vendorTaskId,
            artifactId,
          ),
        manualActions: Object.freeze(manualActions),
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
    return Object.freeze({
      terminalReason: "success" as const,
      blockReason: null,
      submissionEvidence: "submitted" as const,
      elapsedMs: elapsedMs(preflight.observedAt, rendered.observedAt),
      artifactCandidates: Object.freeze([
        artifactCandidate,
      ]),
      observableEvents: materializeObservableEvents(
        command,
        events,
        submission.vendorTaskId,
        artifactId,
      ),
      manualActions: Object.freeze(manualActions),
      observedConfiguration: configuration,
      captureEvidence: Object.freeze({
        renderer: rendered.renderer,
        artifactContentHash: contentHash,
        artifactPageCount: actualPageCount,
        staticRenders,
      }),
    });
  };
  return Object.freeze(executor);
}
