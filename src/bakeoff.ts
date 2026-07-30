import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  Artifact,
  ArtifactScorecard,
  BakeoffProtocolSnapshot,
  BakeoffJobOutcome,
  BakeoffJobSummary,
  CaptureOnlyBakeoffJobOutcome,
  BlockReason,
  FeishuReport,
  JudgeFailureLineage,
  ObservableAttemptEvent,
  RenderManifest,
  RunRecord,
  RunStatus,
  StartBakeoffJobCommand,
  SubmissionEvidence,
  TerminalReason,
} from "./domain.ts";
import {
  InMemoryArtifactCaptureJournal,
  InMemoryImmutableBlobStore,
  createArtifactVault,
  type ArtifactPackageManifest,
  type ArtifactVault,
} from "./artifact-vault.ts";
import {
  BUILD_IDENTITY_SOURCE,
  BUILD_SPEC_COMMIT_SHA,
} from "./build-identity.ts";
import {
  InProcessBrowserProfileLock,
  type BrowserProfileLockPort,
} from "./browser-profile-lock.ts";
import {
  createComparisonReportService,
  planCompatibleComparisonPairs,
} from "./comparison-report.ts";
import {
  expectedComparisonCompatibilityFingerprint,
} from "./comparison-compatibility.ts";
import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
  assertEnvironmentOriginAllowed,
} from "./environment-origin.ts";
import {
  assertApprovedEgressAuthorizationCurrent,
  requireEgressAuthorization,
  SYSTEM_CLOCK,
  InMemoryEgressAuthorizationAudit,
  type ApprovedEgressAuthorization,
  type ClockPort,
  type EgressDestinationMetadata,
  type EgressAuthorizationPort,
  type EgressAuthorizationAuditPort,
} from "./egress-authorization.ts";
import type {
  ComparisonReportSource,
  FeishuProjectionPort,
} from "./feishu.ts";
import { InMemoryFeishuProjection } from "./feishu.ts";
import {
  abortHarnessOwnedLarkProductionJobBeforeSubmission,
  assertHarnessOwnedLarkBaseProjection,
  claimHarnessOwnedLarkProductionJob,
  preflightHarnessOwnedLarkBaseProjection,
  readHarnessOwnedLarkProductionJobState,
} from "./lark-base-projection.ts";
import {
  assertHarnessOwnedDurableEgressAuthorizationAudit,
  assertHarnessOwnedDurableReferencePackStore,
} from "./file-system-operational-durability.ts";
import {
  PRODUCTION_VOLCANO_EVALUATION_CASE,
  VOLCANO_CASE_ID,
  VOLCANO_EVALUATION_CASE,
} from "./fixtures/volcano-case.ts";
import {
  renderStaticArtifact,
  resolveCanonicalProductPackage,
  resolveHarnessProductAdapterExecutor,
  resolveHarnessProductAdapterExecutorForTest,
} from "./mock-wps.ts";
import {
  DOUBAO_PRODUCTION_REPLAY_SCENARIO,
  DOUBAO_PRODUCTION_SCENARIO,
  registeredDoubaoBrowserDriverEvidence,
  type DoubaoBrowserDriverPort,
} from "./doubao-production-adapter.ts";
import { createMockReportDraft } from "./mock-report.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";
import { scoreRenderedArtifact } from "./mock-score.ts";
import {
  OpenAiJudgeEvaluationError,
  type OpenAiJudgePort,
} from "./openai-judge.ts";
import {
  assertHarnessOwnedProductionJudge,
  preflightHarnessOwnedProductionJudge,
} from "./codex-cli-judge.ts";
import {
  assertHarnessOwnedWpsLiveBridgeReady,
} from "./wps-aippt-live-bridge.ts";
import {
  attemptSubmissionState,
  createHarnessProviderExecutionNotStartedCheckpoint,
  InMemoryAttemptCheckpointStore,
  parseAdapterExecutionConfiguration,
  type AttemptCheckpointPort,
  type ProductAdapterExecutionConfiguration,
  type ProductAdapterExecutor,
  type ProductAdapterImplementationPackage,
  type ProductAdapterPort,
  type ProductAttemptResult,
  type ProductPackageSnapshot,
  type SafeRasterRendererPort,
  type TrustedBrowserDriverEvidence,
} from "./product-adapter.ts";
import {
  registeredQwenBrowserDriverEvidence,
  type QwenBrowserDriverPort,
} from "./qwen-production-adapter.ts";
import { assertHarnessOwnedProductionCapabilities } from "./production-capabilities.ts";
import {
  InMemoryReferencePackStore,
  ReviewedReferencePackGenerator,
  resolveReferencePackForCase,
  type ReferencePack,
  type ReferencePackGeneratorPort,
  type ReferencePackStorePort,
} from "./reference-pack.ts";
import {
  canonicalJsonBytes,
  createRunSpecificationVault,
  sha256Bytes,
  type RunSpecificationReference,
  type RunSpecificationVault,
} from "./run-specification.ts";
import {
  InMemoryPayloadInventory,
  InMemoryTombstoneLedger,
  type PayloadInventoryPort,
  type TombstoneLedgerPort,
} from "./retention.ts";
import {
  createAuthorizedSafeRasterManifest,
  createFailedSafeRasterManifest,
} from "./safe-raster.ts";
import {
  registeredWpsAiPptBrowserDriverEvidence,
  type WpsAiPptBrowserDriverPort,
} from "./wps-aippt-driver.ts";

export const VENDOR_GENERATION_TIMEOUT_MS = 30 * 60 * 1_000;
const MOCK_RENDERER_DESTINATION: EgressDestinationMetadata = Object.freeze({
  targetService: "mock-static-svg-renderer",
  targetAccount: "mock-renderer-sandbox",
  targetRegion: "test",
  subprocessors: [],
});
export const ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION:
  EgressDestinationMetadata = Object.freeze({
    targetService: "isolated-offline-png-rasterizer",
    targetAccount: "local-sandbox",
    targetRegion: "local",
    subprocessors: [],
  });
const MOCK_JUDGE_DESTINATION: EgressDestinationMetadata = Object.freeze({
  targetService: "mock-openai-judge",
  targetAccount: "mock-openai-judge-account",
  targetRegion: "test",
  subprocessors: [],
});
const DEFAULT_TEST_EGRESS_AUTHORIZATION: EgressAuthorizationPort = {
  async authorize(request) {
    return {
      status: "approved",
      decisionId: `mock-approved:${request.requestId}:${request.requestedAt}`,
      policyVersion: "mock-public-synthetic-egress-policy-v1",
      request,
      legalSecurityBasis: "synthetic test fixture",
      approvedAt: request.requestedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
};

const MOCK_BAKEOFF_PROTOCOL_SNAPSHOT: BakeoffProtocolSnapshot =
  Object.freeze({
    protocolId: "MOCK-query-default-cost-v1",
    referencePackMode: "automatic",
    timeoutMs: VENDOR_GENERATION_TIMEOUT_MS,
    retryPolicy: "one_if_provably_not_submitted",
    resultSelectionPolicy: "first_policy_compliant_artifact",
    cancellationPolicy: "independent_vendor_runs_continue",
  });

interface BakeoffExecutionContext {
  readonly jobId: string;
  readonly evaluationCase: typeof VOLCANO_EVALUATION_CASE;
  readonly provenance: "MOCK" | "PRODUCTION";
  readonly environmentOrigin:
    | typeof MOCK_TEST_ENVIRONMENT_ORIGIN
    | typeof PRODUCTION_ENVIRONMENT_ORIGIN;
  readonly fixedTime: string;
}

function executionContext(
  environment: "test" | "production",
  fixedTime: string,
  executionMode: "evaluate" | "capture_only" = "evaluate",
): BakeoffExecutionContext {
  return environment === "production"
    ? Object.freeze({
        jobId:
          executionMode === "capture_only"
            ? "production-capture-volcano-v1"
            : "production-job-volcano-wps-v1",
        evaluationCase: PRODUCTION_VOLCANO_EVALUATION_CASE,
        provenance: "PRODUCTION",
        environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
        fixedTime,
      })
    : Object.freeze({
        jobId: MOCK_SCENARIO.jobId,
        evaluationCase: VOLCANO_EVALUATION_CASE,
        provenance: "MOCK",
        environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
        fixedTime: MOCK_SCENARIO.fixedTime,
      });
}

function bakeoffProtocolSnapshot(
  referencePackMode: NonNullable<
    StartBakeoffJobCommand["referencePackMode"]
  >,
  environment: "test" | "production" = "test",
): BakeoffProtocolSnapshot {
  const base =
    environment === "production"
      ? Object.freeze({
          ...MOCK_BAKEOFF_PROTOCOL_SNAPSHOT,
          protocolId: "production-query-default-cost-v1",
        })
      : MOCK_BAKEOFF_PROTOCOL_SNAPSHOT;
  if (referencePackMode === "automatic") {
    return base;
  }
  return Object.freeze({
    ...base,
    referencePackMode,
  });
}

export type AttemptDeadlineResult<T> =
  | {
      readonly timedOut: false;
      readonly value: T;
      readonly elapsedMs: number;
    }
  | {
      readonly timedOut: true;
      readonly elapsedMs: number;
      readonly shutdownCompleted: true;
      readonly shutdownValue?: T;
    };

export interface AttemptDeadlinePort {
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<AttemptDeadlineResult<T>>;
}

const ADAPTER_SHUTDOWN_GRACE_MS = 10_000;

const WALL_CLOCK_ATTEMPT_DEADLINE: AttemptDeadlinePort = {
  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<AttemptDeadlineResult<T>> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const operationSettlement = operation(controller.signal).then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const first = await Promise.race([
      operationSettlement,
      new Promise<{ readonly kind: "timeout" }>((resolveTimeout) => {
        timeoutHandle = setTimeout(
          () => resolveTimeout({ kind: "timeout" }),
          timeoutMs,
        );
      }),
    ]);
    if (first.kind === "value") {
      clearTimeout(timeoutHandle);
      return {
        timedOut: false,
        value: first.value,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
    }
    if (first.kind === "error") {
      clearTimeout(timeoutHandle);
      throw first.error;
    }
    controller.abort();
    let graceHandle!: ReturnType<typeof setTimeout>;
    const shutdown = await Promise.race([
      operationSettlement,
      new Promise<never>((_, rejectGrace) => {
        graceHandle = setTimeout(
          () =>
            rejectGrace(
              new Error(
                "Adapter shutdown and durable reconciliation did not complete within the bounded grace period",
              ),
            ),
          ADAPTER_SHUTDOWN_GRACE_MS,
        );
      }),
    ]);
    clearTimeout(graceHandle);
    return shutdown.kind === "value"
      ? {
          timedOut: true,
          elapsedMs: timeoutMs,
          shutdownCompleted: true,
          shutdownValue: shutdown.value,
        }
      : {
          timedOut: true,
          elapsedMs: timeoutMs,
          shutdownCompleted: true,
        };
  },
};

export interface BakeoffHarness {
  startBakeoffJob(
    command: StartBakeoffJobCommand & {
      readonly executionMode: "capture_only";
    },
  ): Promise<CaptureOnlyBakeoffJobOutcome>;
  startBakeoffJob(command: StartBakeoffJobCommand): Promise<BakeoffJobOutcome>;
}

export interface BakeoffHarnessDependencies {
  readonly feishu: FeishuProjectionPort;
  readonly productAdapter?: ProductAdapterPort;
  readonly productAdapters?: readonly ProductAdapterPort[];
  readonly attemptDeadline?: AttemptDeadlinePort;
  readonly referencePackStore?: ReferencePackStorePort;
  readonly referencePackGenerator?: ReferencePackGeneratorPort;
  readonly judge?: OpenAiJudgePort;
  readonly egressAuthorization?: EgressAuthorizationPort;
  readonly artifactVault?: ArtifactVault;
  readonly runSpecificationVault?: RunSpecificationVault;
  readonly payloadInventory?: PayloadInventoryPort;
  readonly clock?: ClockPort;
  readonly rendererDestination?: EgressDestinationMetadata;
  readonly judgeDestination?: EgressDestinationMetadata;
  readonly tombstones?: TombstoneLedgerPort;
  readonly egressAudit?: EgressAuthorizationAuditPort;
  readonly wpsAiPptBrowserDriver?: WpsAiPptBrowserDriverPort;
  readonly qwenBrowserDriver?: QwenBrowserDriverPort;
  readonly attemptCheckpointStore?: AttemptCheckpointPort;
  readonly browserProfileLock?: BrowserProfileLockPort;
  readonly safeRasterRenderer?: SafeRasterRendererPort;
  readonly doubaoBrowserDriver?: DoubaoBrowserDriverPort;
}

interface InFlightBakeoffJob {
  readonly jobIdentity: string;
  readonly outcome: Promise<
    BakeoffJobOutcome | CaptureOnlyBakeoffJobOutcome
  >;
}

const IN_FLIGHT_BAKEOFF_JOBS = new WeakMap<
  FeishuProjectionPort,
  Map<string, InFlightBakeoffJob>
>();
const DEFAULT_REFERENCE_PACK_GENERATOR =
  new ReviewedReferencePackGenerator();
const DEFAULT_REFERENCE_PACK_STORES = new WeakMap<
  FeishuProjectionPort,
  ReferencePackStorePort
>();
const DEFAULT_ARTIFACT_VAULTS = new WeakMap<
  FeishuProjectionPort,
  ArtifactVault
>();
const DEFAULT_RUN_SPECIFICATION_VAULTS = new WeakMap<
  FeishuProjectionPort,
  RunSpecificationVault
>();
const DEFAULT_PAYLOAD_INVENTORIES = new WeakMap<
  FeishuProjectionPort,
  PayloadInventoryPort
>();
const DEFAULT_TOMBSTONE_LEDGERS = new WeakMap<
  FeishuProjectionPort,
  TombstoneLedgerPort
>();
const DEFAULT_EGRESS_AUDITS = new WeakMap<
  FeishuProjectionPort,
  EgressAuthorizationAuditPort
>();
const DEFAULT_ATTEMPT_CHECKPOINT_STORES = new WeakMap<
  FeishuProjectionPort,
  AttemptCheckpointPort
>();
const DEFAULT_ARTIFACT_CAPTURE_JOURNALS = new WeakMap<
  FeishuProjectionPort,
  InMemoryArtifactCaptureJournal
>();
const DEPENDENCY_IDENTITIES = new WeakMap<object, string>();
let nextDependencyIdentity = 1;
function defaultReferencePackStore(
  feishu: FeishuProjectionPort,
): ReferencePackStorePort {
  const existing = DEFAULT_REFERENCE_PACK_STORES.get(feishu);
  if (existing !== undefined) return existing;
  const created = new InMemoryReferencePackStore(
    () => MOCK_SCENARIO.fixedTime,
  );
  DEFAULT_REFERENCE_PACK_STORES.set(feishu, created);
  return created;
}

function defaultArtifactVault(
  feishu: FeishuProjectionPort,
): ArtifactVault {
  const existing = DEFAULT_ARTIFACT_VAULTS.get(feishu);
  if (existing !== undefined) return existing;
  const identity = dependencyIdentity(feishu);
  const tombstones = defaultTombstoneLedger(feishu);
  let captureJournal = DEFAULT_ARTIFACT_CAPTURE_JOURNALS.get(feishu);
  if (captureJournal === undefined) {
    captureJournal = new InMemoryArtifactCaptureJournal(
      `mock-artifact-capture-journal:${identity}`,
    );
    DEFAULT_ARTIFACT_CAPTURE_JOURNALS.set(feishu, captureJournal);
  }
  const created = createArtifactVault({
    primary: new InMemoryImmutableBlobStore(
      `mock-primary-artifact-store:${identity}`,
      tombstones,
    ),
    secondary: new InMemoryImmutableBlobStore(
      `mock-secondary-artifact-store:${identity}`,
      tombstones,
    ),
    egressAuthorization: DEFAULT_TEST_EGRESS_AUTHORIZATION,
    egressAudit: defaultEgressAudit(feishu),
    captureJournal,
    payloadInventory: defaultPayloadInventory(feishu),
  });
  DEFAULT_ARTIFACT_VAULTS.set(feishu, created);
  return created;
}

function defaultRunSpecificationVault(
  feishu: FeishuProjectionPort,
): RunSpecificationVault {
  const existing = DEFAULT_RUN_SPECIFICATION_VAULTS.get(feishu);
  if (existing !== undefined) return existing;
  const tombstones = defaultTombstoneLedger(feishu);
  const created = createRunSpecificationVault({
    store: new InMemoryImmutableBlobStore(
      `mock-recovery-store:${dependencyIdentity(feishu)}`,
      tombstones,
    ),
    egressAuthorization: DEFAULT_TEST_EGRESS_AUTHORIZATION,
    egressAudit: defaultEgressAudit(feishu),
    payloadInventory: defaultPayloadInventory(feishu),
  });
  DEFAULT_RUN_SPECIFICATION_VAULTS.set(feishu, created);
  return created;
}

function defaultPayloadInventory(
  feishu: FeishuProjectionPort,
): PayloadInventoryPort {
  const existing = DEFAULT_PAYLOAD_INVENTORIES.get(feishu);
  if (existing !== undefined) return existing;
  const created = new InMemoryPayloadInventory(
    defaultTombstoneLedger(feishu),
  );
  DEFAULT_PAYLOAD_INVENTORIES.set(feishu, created);
  return created;
}

function defaultTombstoneLedger(
  feishu: FeishuProjectionPort,
): TombstoneLedgerPort {
  const existing = DEFAULT_TOMBSTONE_LEDGERS.get(feishu);
  if (existing !== undefined) return existing;
  const created = new InMemoryTombstoneLedger();
  DEFAULT_TOMBSTONE_LEDGERS.set(feishu, created);
  return created;
}

function defaultEgressAudit(
  feishu: FeishuProjectionPort,
): EgressAuthorizationAuditPort {
  const existing = DEFAULT_EGRESS_AUDITS.get(feishu);
  if (existing !== undefined) return existing;
  const created = new InMemoryEgressAuthorizationAudit();
  DEFAULT_EGRESS_AUDITS.set(feishu, created);
  return created;
}

function defaultAttemptCheckpointStore(
  feishu: FeishuProjectionPort,
): AttemptCheckpointPort {
  const existing = DEFAULT_ATTEMPT_CHECKPOINT_STORES.get(feishu);
  if (existing !== undefined) return existing;
  const created = new InMemoryAttemptCheckpointStore(
    `attempt-checkpoints:${dependencyIdentity(feishu)}`,
  );
  DEFAULT_ATTEMPT_CHECKPOINT_STORES.set(feishu, created);
  return created;
}

function dependencyIdentity(dependency: object | undefined): string | null {
  if (dependency === undefined) return null;
  const existing = DEPENDENCY_IDENTITIES.get(dependency);
  if (existing !== undefined) return existing;
  const created = `dependency-${nextDependencyIdentity}`;
  nextDependencyIdentity += 1;
  DEPENDENCY_IDENTITIES.set(dependency, created);
  return created;
}

function snapshotBakeoffCommand(
  command: StartBakeoffJobCommand,
): Readonly<StartBakeoffJobCommand> {
  return Object.freeze({
    environment: command.environment,
    caseId: command.caseId,
    referencePackMode: command.referencePackMode ?? "automatic",
    executionMode: command.executionMode ?? "evaluate",
  });
}

function bakeoffJobIdentity(
  command: StartBakeoffJobCommand,
  selections: readonly SelectedProductAdapter[],
  dependencies: {
    readonly attemptDeadline: AttemptDeadlinePort;
    readonly referencePackStore: ReferencePackStorePort;
    readonly referencePackGenerator: ReferencePackGeneratorPort;
    readonly judge: OpenAiJudgePort | undefined;
    readonly egressAuthorization: EgressAuthorizationPort | undefined;
    readonly artifactVault: ArtifactVault;
    readonly runSpecificationVault: RunSpecificationVault;
    readonly payloadInventory: PayloadInventoryPort;
    readonly tombstones: TombstoneLedgerPort;
    readonly clock: ClockPort;
    readonly rendererDestination: EgressDestinationMetadata;
    readonly judgeDestination: EgressDestinationMetadata;
    readonly egressAudit: EgressAuthorizationAuditPort;
    readonly specCommitSha: string;
    readonly wpsAiPptBrowserDriver:
      | WpsAiPptBrowserDriverPort
      | undefined;
    readonly qwenBrowserDriver:
      | QwenBrowserDriverPort
      | undefined;
    readonly attemptCheckpointStore: AttemptCheckpointPort;
    readonly browserProfileLock: BrowserProfileLockPort;
    readonly safeRasterRenderer: SafeRasterRendererPort | undefined;
    readonly doubaoBrowserDriver: DoubaoBrowserDriverPort | undefined;
  },
): string {
  return JSON.stringify({
    environment: command.environment,
    caseId: command.caseId,
    referencePackMode: command.referencePackMode ?? "automatic",
    executionMode: command.executionMode ?? "evaluate",
    protocol: bakeoffProtocolSnapshot(
      command.referencePackMode ?? "automatic",
      command.environment,
    ),
    selections: selections.map(
      ({
        browserDriverEvidence,
        executionConfiguration,
        executionConfigurationPackage,
        executionEntrypointDigest,
        implementationPackage,
        productPackage,
        runId,
      }) => ({
        runId,
        packageId: productPackage.packageId,
        vendorId: productPackage.vendorId,
        displayName: productPackage.displayName,
        adapterVersion: productPackage.adapterVersion,
        provenance: productPackage.provenance,
        environmentOriginId: productPackage.environmentOrigin.originId,
        environment: productPackage.environmentOrigin.environment,
        egressDestination: productPackage.egressDestination,
        ...adapterImplementationEvidence(
          implementationPackage,
          executionEntrypointDigest,
          executionConfigurationPackage,
          executionConfiguration,
          productPackage.packageId,
          browserDriverEvidence,
        ),
      }),
    ),
    dependencies: {
      attemptDeadline: dependencyIdentity(dependencies.attemptDeadline),
      referencePackStore: dependencyIdentity(
        dependencies.referencePackStore,
      ),
      referencePackGenerator: dependencyIdentity(
        dependencies.referencePackGenerator,
      ),
      judge: dependencyIdentity(dependencies.judge),
      egressAuthorization: dependencyIdentity(
        dependencies.egressAuthorization,
      ),
      artifactVault: dependencyIdentity(dependencies.artifactVault),
      runSpecificationVault: dependencyIdentity(
        dependencies.runSpecificationVault,
      ),
      payloadInventory: dependencyIdentity(dependencies.payloadInventory),
      tombstones: dependencyIdentity(dependencies.tombstones),
      clock: dependencyIdentity(dependencies.clock),
      rendererDestination: dependencies.rendererDestination,
      judgeDestination: dependencies.judgeDestination,
      egressAudit: dependencyIdentity(dependencies.egressAudit),
      specCommitSha: dependencies.specCommitSha,
      wpsAiPptBrowserDriver: dependencyIdentity(
        dependencies.wpsAiPptBrowserDriver,
      ),
      qwenBrowserDriver: dependencyIdentity(
        dependencies.qwenBrowserDriver,
      ),
      attemptCheckpointStore:
        dependencies.attemptCheckpointStore.checkpointStoreId,
      browserProfileLock: {
        lockId: dependencies.browserProfileLock.lockId,
        isolation: dependencies.browserProfileLock.isolation,
      },
      safeRasterRenderer: dependencyIdentity(
        dependencies.safeRasterRenderer,
      ),
      doubaoBrowserDriver: dependencyIdentity(
        dependencies.doubaoBrowserDriver,
      ),
    },
  });
}

function coalesceBakeoffJob(
  feishu: FeishuProjectionPort,
  jobId: string,
  jobIdentity: string,
  operation: () => Promise<
    BakeoffJobOutcome | CaptureOnlyBakeoffJobOutcome
  >,
): Promise<BakeoffJobOutcome | CaptureOnlyBakeoffJobOutcome> {
  let jobs = IN_FLIGHT_BAKEOFF_JOBS.get(feishu);
  if (jobs === undefined) {
    jobs = new Map();
    IN_FLIGHT_BAKEOFF_JOBS.set(feishu, jobs);
  }
  const existing = jobs.get(jobId);
  if (existing !== undefined) {
    if (existing.jobIdentity !== jobIdentity) {
      return Promise.reject(
        new Error(`Bakeoff Job identity conflict: ${jobId}`),
      );
    }
    return existing.outcome;
  }

  let outcome!: Promise<
    BakeoffJobOutcome | CaptureOnlyBakeoffJobOutcome
  >;
  outcome = operation().finally(() => {
    const current = jobs?.get(jobId);
    if (current?.outcome === outcome) {
      jobs?.delete(jobId);
    }
  });
  jobs.set(jobId, { jobIdentity, outcome });
  return outcome;
}

interface CapturedVendorResult {
  readonly productPackage: ProductPackageSnapshot;
  readonly runId: string;
  readonly status: RunStatus;
  readonly terminalReason: TerminalReason;
  readonly blockReason: BlockReason | null;
  readonly artifact: Artifact | null;
  readonly renderManifest: RenderManifest | null;
  readonly scorecard: ArtifactScorecard | null;
  readonly judgeFailure?: JudgeFailureLineage | null;
  readonly artifactPackageManifest: ArtifactPackageManifest | null;
  readonly egressAuthorizations: readonly ApprovedEgressAuthorization[];
  readonly attemptRecords: readonly RunRecord[];
}

interface SelectedProductAdapter {
  readonly execute: ProductAdapterExecutor;
  readonly executionConfiguration: ProductAdapterExecutionConfiguration;
  readonly executionEntrypointDigest: `sha256:${string}`;
  readonly executionConfigurationPackage: ProductAdapterImplementationPackage;
  readonly implementationPackage: ProductAdapterImplementationPackage;
  readonly productPackage: ProductPackageSnapshot;
  readonly browserDriverEvidence: TrustedBrowserDriverEvidence | null;
  readonly runId: string;
}

function assertProductionAdapterExecutionReadiness(
  selections: readonly SelectedProductAdapter[],
): void {
  for (const { executionConfiguration, productPackage } of selections) {
    const { adapterKind, scenario } = executionConfiguration;
    if (
      ![
        "wps-aippt-browser",
        "qwen-web",
        "doubao-web-ppt",
      ].includes(adapterKind)
    ) {
      continue;
    }
    const expectedScenario =
      productPackage.provenance === "LIVE_PRODUCTION"
        ? adapterKind === "doubao-web-ppt"
          ? DOUBAO_PRODUCTION_SCENARIO
          : "production-live"
        : productPackage.provenance === "PRODUCTION_REPLAY"
          ? adapterKind === "doubao-web-ppt"
            ? DOUBAO_PRODUCTION_REPLAY_SCENARIO
            : "production-replay"
          : null;
    if (expectedScenario === null || scenario !== expectedScenario) {
      throw new Error(
        `Production ${adapterKind} execution mode does not match Product Package provenance`,
      );
    }
    if (
      expectedScenario === "production-replay" ||
      expectedScenario === DOUBAO_PRODUCTION_REPLAY_SCENARIO
    ) {
      continue;
    }
    if (adapterKind === "wps-aippt-browser") {
      assertHarnessOwnedWpsLiveBridgeReady();
      continue;
    }
    if (adapterKind === "qwen-web") {
      throw new Error(
        "Harness-owned Qwen live executable is not embedded; production preflight fails closed",
      );
    }
    throw new Error(
      "Trusted Doubao live bridge executable is unavailable; production preflight fails closed",
    );
  }
}

class ArtifactPackageIdentityConflictError extends Error {
  readonly artifactId: string;

  constructor(artifactId: string, cause: unknown) {
    super(`Artifact package identity conflict: ${artifactId}`, { cause });
    this.name = "ArtifactPackageIdentityConflictError";
    this.artifactId = artifactId;
  }
}

class UnresolvedAttemptShutdownError extends Error {
  constructor(
    attemptId: string,
    reason =
      "submitted checkpoint durable reconciliation is incomplete",
    cause?: unknown,
  ) {
    super(
      `Attempt ${attemptId} shutdown is unresolved: ${reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "UnresolvedAttemptShutdownError";
  }
}

const MAX_PROVIDER_ATTEMPTS = 2;

export interface ProductionAttemptSubmissionSummary {
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly runId: string;
  readonly submissionState: SubmissionEvidence;
}

interface ProductionAttemptScope {
  readonly jobId: string;
  readonly caseId: string;
  readonly runIds: readonly string[];
}

async function ensureProductionAttemptControlCheckpoints(
  scope: ProductionAttemptScope,
  checkpointStore: AttemptCheckpointPort,
): Promise<void> {
  await Promise.all(
    scope.runIds.flatMap((runId) =>
      Array.from(
        { length: MAX_PROVIDER_ATTEMPTS },
        (_, offset) => offset + 1,
      ).map(async (attemptSeq) => {
        const attemptId = `${runId}-attempt-${attemptSeq}`;
        await checkpointStore.append(
          createHarnessProviderExecutionNotStartedCheckpoint({
            jobId: scope.jobId,
            caseId: scope.caseId,
            runId,
            attemptId,
            attemptSeq,
          }),
        );
      }),
    ),
  );
}

async function readProductionAttemptSubmissionSummary(
  scope: ProductionAttemptScope,
  checkpointStore: AttemptCheckpointPort,
): Promise<readonly ProductionAttemptSubmissionSummary[]> {
  if (checkpointStore.readAttempt === undefined) {
    throw new Error("durable checkpoint read is unavailable");
  }
  return Object.freeze(
    await Promise.all(
      scope.runIds.flatMap((runId) =>
        Array.from(
          { length: MAX_PROVIDER_ATTEMPTS },
          (_, offset) => offset + 1,
        ).map(async (attemptSeq) => {
          const attemptId = `${runId}-attempt-${attemptSeq}`;
          const events =
            await checkpointStore.readAttempt!(attemptId);
          if (
            events.length === 0 ||
            events.some(
              (event) =>
                event.jobId !== scope.jobId ||
                event.caseId !== scope.caseId ||
                event.runId !== runId ||
                event.attemptId !== attemptId ||
                event.attemptSeq !== attemptSeq,
            )
          ) {
            throw new Error(
              `Production Attempt checkpoint lineage is incomplete: ${attemptId}`,
            );
          }
          return Object.freeze({
            attemptId,
            attemptSeq,
            runId,
            submissionState: attemptSubmissionState(events),
          });
        }),
      ),
    ),
  );
}

function assertProductionAttemptSummarySafe(
  summary: readonly ProductionAttemptSubmissionSummary[],
): void {
  const unresolved = summary.find(
    ({ submissionState }) =>
      submissionState !== "not_submitted",
  );
  if (unresolved !== undefined) {
    throw new UnresolvedAttemptShutdownError(
      unresolved.attemptId,
      `production restart found ${unresolved.submissionState} attempt state; provider retry suppressed`,
    );
  }
}

export async function acquireProductionClaimBoundToAttemptState<T>(
  input: {
    readonly scope: ProductionAttemptScope;
    readonly protocolSnapshot: BakeoffProtocolSnapshot;
    readonly securityContextHash: `sha256:${string}`;
    readonly checkpointStore: AttemptCheckpointPort;
    readonly acquireClaim: (claim: {
      readonly claimHash: `sha256:${string}`;
      readonly attemptSubmissionSummaryHash: `sha256:${string}`;
      readonly attemptSubmissionSummary:
        readonly ProductionAttemptSubmissionSummary[];
    }) => Promise<T>;
  },
): Promise<{
  readonly claimHash: `sha256:${string}`;
  readonly attemptSubmissionSummary:
    readonly ProductionAttemptSubmissionSummary[];
  readonly result: T;
}> {
  await ensureProductionAttemptControlCheckpoints(
    input.scope,
    input.checkpointStore,
  );
  let attemptSubmissionSummary:
    readonly ProductionAttemptSubmissionSummary[];
  try {
    attemptSubmissionSummary =
      await readProductionAttemptSubmissionSummary(
        input.scope,
        input.checkpointStore,
      );
  } catch (error) {
    throw new UnresolvedAttemptShutdownError(
      `${input.scope.runIds[0] ?? "unknown-run"}-attempt-1`,
      "production restart checkpoint recovery is unavailable",
      error,
    );
  }
  assertProductionAttemptSummarySafe(attemptSubmissionSummary);
  const attemptSubmissionSummaryHash = sha256Json(
    attemptSubmissionSummary,
  );
  const claimHash = sha256Json({
    schemaVersion: "production-job-claim-v1",
    jobId: input.scope.jobId,
    caseId: input.scope.caseId,
    runIds: input.scope.runIds,
    protocolSnapshot: input.protocolSnapshot,
    securityContextHash: input.securityContextHash,
    attemptSubmissionSummaryHash,
  });
  const result = await input.acquireClaim({
    claimHash,
    attemptSubmissionSummaryHash,
    attemptSubmissionSummary,
  });
  let postClaimAttemptSubmissionSummary:
    readonly ProductionAttemptSubmissionSummary[];
  try {
    postClaimAttemptSubmissionSummary =
      await readProductionAttemptSubmissionSummary(
        input.scope,
        input.checkpointStore,
      );
  } catch (error) {
    throw new UnresolvedAttemptShutdownError(
      `${input.scope.runIds[0] ?? "unknown-run"}-attempt-1`,
      "post-claim checkpoint recovery is unavailable",
      error,
    );
  }
  if (
    !isDeepStrictEqual(
      postClaimAttemptSubmissionSummary,
      attemptSubmissionSummary,
    )
  ) {
    throw new UnresolvedAttemptShutdownError(
      postClaimAttemptSubmissionSummary.find(
        (entry, index) =>
          !isDeepStrictEqual(
            entry,
            attemptSubmissionSummary[index],
          ),
      )?.attemptId ??
        `${input.scope.runIds[0] ?? "unknown-run"}-attempt-1`,
      "attempt submission state changed while the production claim was acquired",
    );
  }
  return Object.freeze({
    claimHash,
    attemptSubmissionSummary,
    result,
  });
}

export async function assertProductionVendorEgressSafe(input: {
  readonly jobId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly checkpointStore: AttemptCheckpointPort;
}): Promise<void> {
  let summary: readonly ProductionAttemptSubmissionSummary[];
  try {
    summary = await readProductionAttemptSubmissionSummary(
      {
        jobId: input.jobId,
        caseId: input.caseId,
        runIds: [input.runId],
      },
      input.checkpointStore,
    );
  } catch (error) {
    throw new UnresolvedAttemptShutdownError(
      input.attemptId,
      "vendor egress checkpoint recovery is unavailable",
      error,
    );
  }
  assertProductionAttemptSummarySafe(summary);
  if (
    !summary.some(
      (entry) =>
        entry.attemptId === input.attemptId &&
        entry.attemptSeq === input.attemptSeq,
    )
  ) {
    throw new UnresolvedAttemptShutdownError(
      input.attemptId,
      "vendor egress could not bind the current Attempt",
    );
  }
}

function snapshotProductSelections(
  adapters: readonly ProductAdapterPort[],
  environment: "test" | "production",
  dependencies: {
    readonly wpsAiPptBrowserDriver:
      | WpsAiPptBrowserDriverPort
      | undefined;
    readonly qwenBrowserDriver:
      | QwenBrowserDriverPort
      | undefined;
    readonly attemptCheckpointStore: AttemptCheckpointPort;
    readonly doubaoBrowserDriver:
      | DoubaoBrowserDriverPort
      | undefined;
  },
): readonly SelectedProductAdapter[] {
  return Object.freeze(
    adapters.map((adapter) => {
      const implementationPackage =
        Object.freeze<ProductAdapterImplementationPackage>({
          packageName: adapter.implementationPackage.packageName,
          contentHash: adapter.implementationPackage.contentHash,
          content: Uint8Array.from(
            adapter.implementationPackage.content,
          ),
        });
      const executionConfigurationPackage =
        Object.freeze<ProductAdapterImplementationPackage>({
          packageName:
            adapter.executionConfigurationPackage.packageName,
          contentHash:
            adapter.executionConfigurationPackage.contentHash,
          content: Uint8Array.from(
            adapter.executionConfigurationPackage.content,
          ),
        });
      const executionConfiguration =
        parseAdapterExecutionConfiguration(
          executionConfigurationPackage,
        );
      const canonicalProductPackage =
        resolveCanonicalProductPackage(
          executionConfiguration,
          environment,
        );
      if (
        !isDeepStrictEqual(
          adapter.productPackage,
          canonicalProductPackage,
        )
      ) {
        throw new Error(
          `Product Package descriptor does not match the harness canonical registry: ${executionConfiguration.adapterKind}:${executionConfiguration.scenario}`,
        );
      }
      const productPackage = Object.freeze({
        ...structuredClone(canonicalProductPackage),
        environmentOrigin:
          canonicalProductPackage.environmentOrigin,
        egressDestination: Object.freeze(
          structuredClone(
            canonicalProductPackage.egressDestination,
          ),
        ),
        ...(canonicalProductPackage.evaluationConfiguration ===
        undefined
          ? {}
          : {
              evaluationConfiguration: Object.freeze(
                structuredClone(
                  canonicalProductPackage.evaluationConfiguration,
                ),
              ),
            }),
      });
      const browserDriverEvidence =
        executionConfiguration.adapterKind === "wps-aippt-browser"
          ? registeredWpsAiPptBrowserDriverEvidence(
              dependencies.wpsAiPptBrowserDriver,
            )
          : executionConfiguration.adapterKind === "qwen-web"
            ? registeredQwenBrowserDriverEvidence(
                dependencies.qwenBrowserDriver,
              )
          : executionConfiguration.adapterKind === "doubao-web-ppt"
            ? registeredDoubaoBrowserDriverEvidence(
                dependencies.doubaoBrowserDriver,
              )
          : null;
      const selectedExecute =
        (environment === "test"
          ? resolveHarnessProductAdapterExecutorForTest
          : resolveHarnessProductAdapterExecutor)(
          implementationPackage,
          executionConfiguration,
          dependencies,
        );
      const executionEntrypointDigest = sha256Bytes(
        new TextEncoder().encode(selectedExecute.toString()),
      );
      return Object.freeze({
        execute: selectedExecute,
        executionConfiguration,
        executionEntrypointDigest,
        executionConfigurationPackage,
        implementationPackage,
        productPackage,
        browserDriverEvidence,
        runId: runIdForPackage(
          productPackage.packageId,
          productPackage.provenance,
        ),
      });
    }),
  );
}

function adapterImplementationEvidence(
  implementationPackage: ProductAdapterImplementationPackage,
  executionEntrypointDigest: `sha256:${string}`,
  executionConfigurationPackage: ProductAdapterImplementationPackage,
  executionConfiguration: ProductAdapterExecutionConfiguration,
  productPackageId: string,
  browserDriverEvidence: TrustedBrowserDriverEvidence | null = null,
): {
  readonly implementationDigest: `sha256:${string}`;
  readonly executionEntrypointDigest: `sha256:${string}`;
  readonly executionConfigurationDigest: `sha256:${string}`;
  readonly executionConfigurationPackageName: string;
  readonly executionConfigurationPackageByteSize: number;
  readonly executionConfiguration: ProductAdapterExecutionConfiguration;
  readonly implementationPackageName: string;
  readonly implementationPackageByteSize: number;
  readonly browserDriverEvidence: TrustedBrowserDriverEvidence | null;
} {
  const implementationDigest = sha256Bytes(
    implementationPackage.content,
  );
  const executionConfigurationDigest = sha256Bytes(
    executionConfigurationPackage.content,
  );
  const parsedExecutionConfiguration =
    parseAdapterExecutionConfiguration(
      executionConfigurationPackage,
    );
  if (
    implementationDigest !==
      implementationPackage.contentHash ||
    implementationPackage.packageName.trim().length === 0 ||
    executionConfigurationDigest !==
      executionConfigurationPackage.contentHash ||
    executionConfigurationPackage.packageName.trim().length === 0 ||
    !isDeepStrictEqual(
      parsedExecutionConfiguration,
      executionConfiguration,
    )
  ) {
    throw new Error(
      `Adapter implementation package is invalid: ${productPackageId}`,
    );
  }
  return {
    implementationDigest,
    executionEntrypointDigest,
    executionConfigurationDigest,
    executionConfigurationPackageName:
      executionConfigurationPackage.packageName,
    executionConfigurationPackageByteSize:
      executionConfigurationPackage.content.byteLength,
    executionConfiguration,
    implementationPackageName:
      implementationPackage.packageName,
    implementationPackageByteSize:
      implementationPackage.content.byteLength,
    browserDriverEvidence,
  };
}

function replayedBakeoffOutcome(
  context: BakeoffExecutionContext,
  command: StartBakeoffJobCommand,
  selections: readonly SelectedProductAdapter[],
  source: ComparisonReportSource,
  specCommitSha: string,
  rendererDestination: EgressDestinationMetadata,
  judgeDestination: EgressDestinationMetadata,
  securityContextHash: `sha256:${string}`,
): BakeoffJobOutcome | CaptureOnlyBakeoffJobOutcome {
  const expectedRunIds = selections.map(({ runId }) => runId);
  const selectedRunIds = source.job.selectedRunIds;
  if (
    source.job.caseId !== command.caseId ||
    selectedRunIds === null ||
    selectedRunIds.length !== expectedRunIds.length ||
    selectedRunIds.some((runId, index) => runId !== expectedRunIds[index])
  ) {
    throw new Error(
      `Bakeoff Job identity conflict: ${source.job.recordId}`,
    );
  }
  const expectedProtocol = bakeoffProtocolSnapshot(
    command.referencePackMode ?? "automatic",
    command.environment,
  );
  if (
    !isDeepStrictEqual(source.job.protocolSnapshot, expectedProtocol)
    || source.job.securityContextHash !== securityContextHash
  ) {
    throw new Error(
      `Bakeoff Job protocol mismatch: ${source.job.recordId}`,
    );
  }
  assertEnvironmentOriginAllowed(
    source.job.environmentOrigin,
    command.environment,
    `Bakeoff Job ${source.job.recordId}`,
  );
  if (
    source.job.status !== "active" &&
    source.job.status !== "completed" &&
    source.job.status !== "partial" &&
    source.job.status !== "failed"
  ) {
    throw new Error(
      `Bakeoff Job has invalid parent status: ${source.job.status}`,
    );
  }
  const captureOnly = command.executionMode === "capture_only";
  if (!captureOnly && source.primaryReport === null) {
    throw new Error(
      `Bakeoff Job replay is incomplete: ${source.job.recordId}`,
    );
  }

  const vendorRuns = new Map(
    source.vendorRuns.map((record) => [record.recordId, record]),
  );
  if (vendorRuns.size !== selections.length) {
    throw new Error(
      `Bakeoff Job identity conflict: ${source.job.recordId}`,
    );
  }
  const capturesByArtifactId = new Map(
    source.capturedArtifacts.map((record) => [record.artifactId, record]),
  );
  const scoresByScorecardId = new Map(
    source.artifactScores.map((record) => [
      record.scorecard.scorecardId,
      record,
    ]),
  );
  const captures = [];
  const scorecards = [];
  for (const selection of selections) {
    const run = vendorRuns.get(selection.runId);
    if (
      run === undefined ||
      run.product !== selection.productPackage.displayName ||
      run.productVendorId !== selection.productPackage.vendorId ||
      run.productPackageId !== selection.productPackage.packageId ||
      run.adapterVersion !== selection.productPackage.adapterVersion ||
      run.specificationReference?.specCommitSha !== specCommitSha ||
      run.specificationReference.versionReferences
        .productPackageContentHash !==
        sha256Bytes(canonicalJsonBytes(selection.productPackage)) ||
      run.specificationReference.versionReferences
        .adapterSpecificationHash !==
        sha256Bytes(
          canonicalJsonBytes({
            packageId: selection.productPackage.packageId,
            adapterVersion: selection.productPackage.adapterVersion,
            vendorId: selection.productPackage.vendorId,
            egressDestination:
              selection.productPackage.egressDestination,
            ...adapterImplementationEvidence(
              selection.implementationPackage,
              selection.executionEntrypointDigest,
              selection.executionConfigurationPackage,
              selection.executionConfiguration,
              selection.productPackage.packageId,
              selection.browserDriverEvidence,
            ),
          }),
        )
    ) {
      throw new Error(
        `Bakeoff Job identity conflict: ${source.job.recordId}`,
      );
    }
    const authorizations = run.egressAuthorizations ?? [];
    const destinationMatches = (
      purpose: ApprovedEgressAuthorization["request"]["processingPurpose"],
      destination: EgressDestinationMetadata,
      required: boolean,
    ) => {
      const matching = authorizations.find(
        ({ request }) => request.processingPurpose === purpose,
      );
      return (
        (!required && matching === undefined) ||
        (matching !== undefined &&
          matching.request.targetService === destination.targetService &&
          matching.request.targetAccount === destination.targetAccount &&
          matching.request.targetRegion === destination.targetRegion &&
          isDeepStrictEqual(
            matching.request.subprocessors,
            destination.subprocessors,
          ))
      );
    };
    if (
      !destinationMatches(
        "vendor_generation",
        selection.productPackage.egressDestination,
        true,
      ) ||
      (run.artifactId !== null &&
        !destinationMatches(
          "artifact_rendering",
          rendererDestination,
          true,
        )) ||
      (run.judgeEgressAttempt != null &&
        !destinationMatches("judge_evaluation", judgeDestination, true))
    ) {
      throw new Error(
        `Bakeoff Job security context mismatch: ${source.job.recordId}`,
      );
    }
    if (run.artifactId !== null) {
      const capture = capturesByArtifactId.get(run.artifactId);
      if (capture === undefined || capture.runId !== run.recordId) {
        throw new Error(
          `Bakeoff Job replay is incomplete: ${source.job.recordId}`,
        );
      }
      captures.push(capture);
    }
    if (run.scorecardId !== null) {
      const score = scoresByScorecardId.get(run.scorecardId);
      if (score === undefined || score.runId !== run.recordId) {
        throw new Error(
          `Bakeoff Job replay is incomplete: ${source.job.recordId}`,
        );
      }
      scorecards.push(score.scorecard);
    }
  }
  const primaryCapture = captures[0];
  const primaryScorecard =
    primaryCapture === undefined
      ? null
      : (scorecards.find(
          (scorecard) =>
            scorecard.runId === primaryCapture.runId &&
            scorecard.artifactId === primaryCapture.artifactId,
        ) ?? null);
  const outcomeBase = {
    job: {
      jobId: source.job.jobId,
      caseId: source.job.caseId,
      environment: command.environment,
      status: source.job.status,
      provenance: context.provenance,
      environmentOrigin: context.environmentOrigin,
    },
    artifact: primaryCapture?.artifact ?? null,
    renderManifest: primaryCapture?.renderManifest ?? null,
    artifacts: captures.map(({ artifact }) => artifact),
    renderManifests: captures.map(({ renderManifest }) => renderManifest),
  };
  if (captureOnly) {
    if (source.primaryReport !== null || scorecards.length > 0) {
      throw new Error(
        `Capture-only Bakeoff replay contains evaluation output: ${source.job.recordId}`,
      );
    }
    return {
      ...outcomeBase,
      scorecard: null,
      scorecards: [],
      report: null,
    };
  }
  return {
    ...outcomeBase,
    scorecard: primaryScorecard,
    scorecards,
    report: source.primaryReport!,
  };
}

const KNOWN_VENDOR_SLUGS = new Map<string, string>([
  ["MOCK-wps-package-v1", "wps"],
  ["MOCK-qwen-package-v1", "qwen"],
  ["MOCK-doubao-package-v1", "doubao"],
]);

type KnownVendorScenario =
  (typeof MOCK_SCENARIO.vendors)[keyof typeof MOCK_SCENARIO.vendors];

const KNOWN_VENDOR_SCENARIOS = new Map<string, KnownVendorScenario>(
  Object.entries(MOCK_SCENARIO.vendors),
);

function vendorSlug(packageId: string): string {
  const knownSlug = KNOWN_VENDOR_SLUGS.get(packageId);
  if (knownSlug !== undefined) return knownSlug;
  const readableSlug =
    packageId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "package";
  const hash = createHash("sha256")
    .update(packageId)
    .digest("hex")
    .slice(0, 32);
  return `${readableSlug}-${hash}`;
}

function runIdForPackage(
  packageId: string,
  provenance:
    | "MOCK"
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY",
): string {
  const scenario = KNOWN_VENDOR_SCENARIOS.get(packageId);
  if (provenance === "MOCK" && scenario !== undefined) {
    return scenario.runId;
  }
  const prefix =
    provenance === "LIVE_PRODUCTION"
      ? "live-production"
      : provenance === "PRODUCTION_REPLAY"
        ? "production-replay"
        : "MOCK";
  return `${prefix}-run-${vendorSlug(packageId)}-volcano-v1`;
}

function isRealProviderProductProvenance(
  provenance: ProductPackageSnapshot["provenance"],
): provenance is "LIVE_PRODUCTION" | "PRODUCTION_REPLAY" {
  return (
    provenance === "LIVE_PRODUCTION" ||
    provenance === "PRODUCTION_REPLAY"
  );
}

function isArtifact(
  execution: Artifact | ProductAttemptResult,
): execution is Artifact {
  return "content" in execution;
}

function normalizeExecution(
  execution: Artifact | ProductAttemptResult,
): ProductAttemptResult {
  if (!isArtifact(execution)) {
    return execution;
  }
  return {
    terminalReason: "success",
    blockReason: null,
    submissionEvidence: "submitted",
    elapsedMs: 1,
    artifactCandidates: [{ artifact: execution, policyCompliant: true }],
  };
}

function statusFromTerminalReason(reason: TerminalReason): RunStatus {
  if (reason === "success") return "completed";
  if (reason === "vendor_timeout") return "timed_out";
  if (
    reason === "payment" ||
    reason === "quota" ||
    reason === "authentication"
  ) {
    return "blocked";
  }
  if (reason === "human_wait") return "waiting_for_human";
  return "failed";
}

function fixedTimestampAfter(
  elapsedMs: number,
  fixedTime: string = MOCK_SCENARIO.fixedTime,
): string {
  return new Date(
    Date.parse(fixedTime) + elapsedMs,
  ).toISOString();
}

function sha256Json(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function attemptRecord(input: {
  readonly context: BakeoffExecutionContext;
  readonly productPackage: ProductPackageSnapshot;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly result: ProductAttemptResult;
  readonly measuredElapsedMs: number;
  readonly vendorReportedElapsedMs: number | null;
  readonly terminalReason: TerminalReason;
  readonly status: RunStatus;
  readonly retryOfAttemptId: string | null;
  readonly caseId: string;
}): RunRecord {
  return {
    recordId: input.attemptId,
    recordType: "evaluation_attempt",
    jobId: input.context.jobId,
    parentRecordId: input.runId,
    caseId: input.caseId,
    product: input.productPackage.displayName,
    productVendorId: input.productPackage.vendorId,
    productPackageId: input.productPackage.packageId,
    adapterVersion: input.productPackage.adapterVersion,
    status: input.status,
    attemptSeq: input.attemptSeq,
    elapsedMs: input.measuredElapsedMs,
    submissionEvidence: input.result.submissionEvidence,
    terminalReason:
      input.terminalReason === "human_wait" ? null : input.terminalReason,
    waitingReason:
      input.terminalReason === "human_wait" ? "human_intervention" : null,
    blockReason: input.result.blockReason,
    retryOfAttemptId: input.retryOfAttemptId,
    selectedRunIds: null,
    protocolSnapshot: null,
    deadlineAt: null,
    vendorGenerationMs: input.measuredElapsedMs,
    vendorReportedElapsedMs: input.vendorReportedElapsedMs,
    humanWaitMs: null,
    timingPausedAt:
      input.terminalReason === "human_wait"
        ? fixedTimestampAfter(
            input.measuredElapsedMs,
            input.context.fixedTime,
          )
        : null,
    observableEvents:
      input.result.observableEvents ??
      [
        {
          eventId: `${input.attemptId}-event-1`,
          jobId: input.context.jobId,
          caseId: input.caseId,
          runId: input.runId,
          attemptId: input.attemptId,
          attemptSeq: input.attemptSeq,
          eventType:
            input.terminalReason === "human_wait"
              ? "waiting_for_human"
              : `terminal:${input.terminalReason}`,
          sourceAt: fixedTimestampAfter(
            input.measuredElapsedMs,
            input.context.fixedTime,
          ),
          observedAt: fixedTimestampAfter(
            input.measuredElapsedMs,
            input.context.fixedTime,
          ),
          writerId: "mock-runner@1",
          evidenceRef: `mock://${vendorSlug(
            input.productPackage.packageId,
          )}/attempt-${input.attemptSeq}`,
        },
      ],
    manualActions: input.result.manualActions ?? [],
    ...(input.result.observedConfiguration === undefined
      ? {}
      : {
          productConfigurationEvidence:
            input.result.observedConfiguration,
        }),
    costEvidence: {
      classification: "unknown",
      amount: null,
      currency: null,
    },
    provenance: input.productPackage.provenance,
    environmentOrigin: input.productPackage.environmentOrigin,
    createdAt: input.context.fixedTime,
    lastSyncedAt: input.context.fixedTime,
    reportUrl: null,
    auxiliaryReportUrls: null,
    artifactId: null,
    renderManifestId: null,
    scorecardId: null,
  };
}

async function executeVendor(
  context: BakeoffExecutionContext,
  selection: SelectedProductAdapter,
  caseId: string,
  targetEnvironment: "test" | "production",
  executionMode: "evaluate" | "capture_only",
  attemptDeadline: AttemptDeadlinePort,
  jobDeadlineAtEpochMs: number,
  referencePack: ReferencePack | null,
  judge: OpenAiJudgePort | undefined,
  egressAuthorization: EgressAuthorizationPort | undefined,
  egressAudit: EgressAuthorizationAuditPort,
  artifactVault: ArtifactVault,
  clock: ClockPort,
  rendererDestination: EgressDestinationMetadata,
  safeRasterRenderer: SafeRasterRendererPort | undefined,
  judgeDestination: EgressDestinationMetadata,
  attemptCheckpointStore: AttemptCheckpointPort,
  onReferencePackUse: (evaluationAttemptId: string) => void,
  beforeVendorEgress?: (input: {
    readonly runId: string;
    readonly attemptId: string;
    readonly attemptSeq: number;
  }) => Promise<void>,
): Promise<CapturedVendorResult> {
  const {
    execute,
    productPackage,
    runId,
  } = selection;
  const scenario = KNOWN_VENDOR_SCENARIOS.get(productPackage.packageId);
  const attempts: RunRecord[] = [];
  let retryOfAttemptId: string | null = null;
  let attemptSeq = 1;
  let observedBudgetRemainingMs = VENDOR_GENERATION_TIMEOUT_MS;
  let result: ProductAttemptResult;
  let terminalReason: TerminalReason;
  let status: RunStatus;
  const egressAuthorizations: ApprovedEgressAuthorization[] = [];

  while (true) {
    const attemptId = `${runId}-attempt-${attemptSeq}`;
    let measuredElapsedMs = 0;
    let vendorReportedElapsedMs: number | null = null;
    const attemptTimeoutMs = Math.max(
      0,
      Math.min(observedBudgetRemainingMs, jobDeadlineAtEpochMs - Date.now()),
    );
    if (attemptTimeoutMs === 0) {
      result = {
        terminalReason: "vendor_timeout",
        blockReason: null,
        submissionEvidence: "unknown",
        elapsedMs: 0,
        artifactCandidates: [],
      };
    } else {
      await beforeVendorEgress?.({
        runId,
        attemptId,
        attemptSeq,
      });
      const vendorAuthorization =
        await requireEgressAuthorization(egressAuthorization, {
          requestId: `vendor-generation:${attemptId}`,
          jobId: context.jobId,
          runId,
          attemptId,
          dataClassification: context.evaluationCase.dataClassification,
          sourceOwner: context.evaluationCase.sourceOwner,
          processingPurpose: "vendor_generation",
          targetKind: "vendor",
          targetService:
            productPackage.egressDestination.targetService,
          targetAccount:
            productPackage.egressDestination.targetAccount,
          targetRegion:
            productPackage.egressDestination.targetRegion,
          subprocessors:
            productPackage.egressDestination.subprocessors,
          contentFields: [
            "evaluation_case",
            "run_identity",
            "attempt_policy",
          ],
          payloadHash: sha256Json({
            jobId: context.jobId,
            runId,
            attemptId,
            attemptSeq,
            timeoutMs: attemptTimeoutMs,
            evaluationCase: context.evaluationCase,
          }),
          requiredRedactions: [],
        }, clock);
      await egressAudit.append(vendorAuthorization);
      await egressAudit.assertRecorded(vendorAuthorization);
      assertApprovedEgressAuthorizationCurrent(
        vendorAuthorization,
        clock,
      );
      egressAuthorizations.push(vendorAuthorization);
      const startedAt = Date.now();
      try {
        const deadlineResult = await attemptDeadline.run(
          (signal) =>
            execute({
              jobId: context.jobId,
              runId,
              attemptId,
              attemptSeq,
              timeoutMs: attemptTimeoutMs,
              signal,
              evaluationCase: context.evaluationCase,
            }),
          attemptTimeoutMs,
        );
        observedBudgetRemainingMs = Math.max(
          0,
          observedBudgetRemainingMs - deadlineResult.elapsedMs,
        );
        measuredElapsedMs = deadlineResult.elapsedMs;
        if (
          deadlineResult.timedOut &&
          deadlineResult.shutdownCompleted !== true
        ) {
          throw new Error(
            "Attempt cannot finalize before adapter shutdown and durable reconciliation complete",
          );
        }
        if (deadlineResult.timedOut) {
          let durableCheckpoints: readonly ObservableAttemptEvent[];
          try {
            if (attemptCheckpointStore.readAttempt === undefined) {
              throw new Error(
                "durable checkpoint read is unavailable",
              );
            }
            durableCheckpoints =
              await attemptCheckpointStore.readAttempt(attemptId);
          } catch (error) {
            throw new UnresolvedAttemptShutdownError(
              attemptId,
              "durable checkpoint read is unavailable; reconciliation status is unknown",
              error,
            );
          }
          const submittedCheckpoint = durableCheckpoints.some(
            ({ submissionEvidenceAtCheckpoint }) =>
              submissionEvidenceAtCheckpoint === "submitted",
          );
          const durableResolvedReconciliation =
            durableCheckpoints.some(
              ({
                eventType,
                reconciliationObservedState,
                reconciliationTerminalReason,
              }) =>
                eventType === "task_reconciliation_result" &&
                ((reconciliationObservedState ===
                  "artifact_ready" &&
                  reconciliationTerminalReason ===
                    "download_failure") ||
                  (reconciliationObservedState === "failed" &&
                    reconciliationTerminalReason ===
                      "technical_failure")),
            );
          if (
            submittedCheckpoint &&
            !durableResolvedReconciliation
          ) {
            throw new UnresolvedAttemptShutdownError(attemptId);
          }
          const shutdownResult =
            deadlineResult.shutdownValue === undefined
              ? null
              : normalizeExecution(deadlineResult.shutdownValue);
          result = {
            terminalReason: "vendor_timeout",
            blockReason: null,
            submissionEvidence:
              shutdownResult?.submissionEvidence ?? "unknown",
            elapsedMs: deadlineResult.elapsedMs,
            artifactCandidates: [],
            ...(shutdownResult?.observableEvents === undefined
              ? {}
              : {
                  observableEvents:
                    shutdownResult.observableEvents,
                }),
            ...(shutdownResult?.manualActions === undefined
              ? {}
              : { manualActions: shutdownResult.manualActions }),
          };
        } else {
          result = normalizeExecution(deadlineResult.value);
        }
        if (!deadlineResult.timedOut) {
          vendorReportedElapsedMs = result.elapsedMs;
        }
      } catch (error) {
        if (
          error instanceof UnresolvedAttemptShutdownError ||
          (error instanceof Error &&
            /cannot finalize before adapter shutdown and durable reconciliation complete/i.test(
              error.message,
            ))
        ) {
          throw error;
        }
        measuredElapsedMs = Math.max(0, Date.now() - startedAt);
        observedBudgetRemainingMs = Math.max(
          0,
          observedBudgetRemainingMs - measuredElapsedMs,
        );
        result = {
          terminalReason: "technical_failure",
          blockReason: null,
          submissionEvidence: "unknown",
          elapsedMs: measuredElapsedMs,
          artifactCandidates: [],
        };
      }
    }
    terminalReason = result.terminalReason;
    status = statusFromTerminalReason(terminalReason);
    attempts.push(
      attemptRecord({
        context,
        productPackage,
        runId,
        attemptId,
        attemptSeq,
        result,
        measuredElapsedMs,
        vendorReportedElapsedMs,
        terminalReason,
        status,
        retryOfAttemptId,
        caseId,
      }),
    );
    const mayRetry =
      attemptSeq === 1 &&
      terminalReason === "technical_failure" &&
      result.submissionEvidence === "not_submitted" &&
      observedBudgetRemainingMs > 0 &&
      jobDeadlineAtEpochMs > Date.now();
    if (!mayRetry) break;
    retryOfAttemptId = attemptId;
    attemptSeq += 1;
  }

  if (status !== "completed") {
    return {
      productPackage,
      runId,
      status,
      terminalReason,
      blockReason: result.blockReason,
      artifact: null,
      renderManifest: null,
      scorecard: null,
      artifactPackageManifest: null,
      egressAuthorizations,
      attemptRecords: attempts,
    };
  }

  const selectedArtifact = result.artifactCandidates.find(
    ({ policyCompliant }) => policyCompliant,
  );
  if (selectedArtifact === undefined) {
    return {
      productPackage,
      runId,
      status: "failed",
      terminalReason: "technical_failure",
      blockReason: null,
      artifact: null,
      renderManifest: null,
      scorecard: null,
      artifactPackageManifest: null,
      egressAuthorizations,
      attemptRecords: attempts.map((attempt, index) =>
        index === attempts.length - 1
          ? {
              ...attempt,
              status: "failed",
              terminalReason: "technical_failure",
            }
          : attempt,
      ),
    };
  }
  const artifact = selectedArtifact.artifact;
  if (
    artifact.runId !== runId ||
    artifact.provenance !== productPackage.provenance
  ) {
    throw new Error(
      "Bakeoff Job requires Artifact lineage to match its Product Package",
    );
  }
  assertEnvironmentOriginAllowed(
    artifact.environmentOrigin,
    targetEnvironment,
    `Artifact ${artifact.artifactId}`,
  );
  const productionExecutionEvidence =
    selectedArtifact.productionExecutionEvidence;
  if (isRealProviderProductProvenance(productPackage.provenance)) {
    const latestEvent = result.observableEvents?.at(-1);
    if (
      productionExecutionEvidence === undefined ||
      productionExecutionEvidence.executionMode !==
        productPackage.provenance ||
      (productPackage.provenance === "LIVE_PRODUCTION"
        ? productionExecutionEvidence.captureSource !==
            "LIVE_BROWSER_AUTOMATION" ||
          productionExecutionEvidence.liveBridgeTranscriptHash ===
            undefined
        : productionExecutionEvidence.captureSource !==
          "REAL_PROVIDER_CAPTURE") ||
      !/^session_[a-z0-9_-]{16,128}$/.test(
        productionExecutionEvidence.driverSessionId,
      ) ||
      productionExecutionEvidence.vendorTaskId !==
        latestEvent?.vendorTaskId ||
      productionExecutionEvidence.taskStateVersion !==
        latestEvent?.taskStateVersion ||
      productionExecutionEvidence.driverVersion.trim().length === 0 ||
      productionExecutionEvidence.adapterVersion !==
        productPackage.adapterVersion ||
      productionExecutionEvidence.artifactContentHash !==
        artifact.contentHash ||
      productionExecutionEvidence.traceHash !==
        sha256Bytes(
          canonicalJsonBytes(result.observableEvents ?? []),
        )
    ) {
      throw new Error(
        "Production Artifact requires bound driver session, outcome, Artifact, and Trace evidence",
      );
    }
  }
  const rendererAuthorization = await requireEgressAuthorization(
    egressAuthorization,
    {
      requestId: `artifact-rendering:${artifact.artifactId}`,
      jobId: context.jobId,
      runId,
      attemptId: attempts.at(-1)?.recordId ?? null,
      dataClassification: context.evaluationCase.dataClassification,
      sourceOwner: context.evaluationCase.sourceOwner,
      processingPurpose: "artifact_rendering",
      targetKind: "renderer",
      targetService: rendererDestination.targetService,
      targetAccount: rendererDestination.targetAccount,
      targetRegion: rendererDestination.targetRegion,
      subprocessors: rendererDestination.subprocessors,
      contentFields: ["artifact_binary"],
      payloadHash: artifact.contentHash,
      requiredRedactions: [],
    },
    clock,
  );
  egressAuthorizations.push(rendererAuthorization);
  const rendererAuthorizationDecisionId =
    targetEnvironment === "production"
      ? rendererAuthorization.decisionId
      : "mock-renderer-authorized";
  if (
    isRealProviderProductProvenance(productPackage.provenance) &&
    selectedArtifact.renderManifest !== undefined
  ) {
    throw new Error(
      "Production Artifact cannot inject a pre-rendered manifest",
    );
  }
  if (
    isRealProviderProductProvenance(productPackage.provenance) &&
    selectedArtifact.safeRasterCandidate !== undefined
  ) {
    throw new Error(
      "Production browser driver cannot submit raster output before renderer authorization",
    );
  }
  let safeRasterCandidate = selectedArtifact.safeRasterCandidate;
  let safeRasterFailure: unknown;
  if (isRealProviderProductProvenance(productPackage.provenance)) {
    try {
      safeRasterCandidate = await safeRasterRenderer!.render({
        artifact,
        authorizationDecisionId:
          rendererAuthorizationDecisionId,
      });
    } catch (error) {
      safeRasterFailure = error;
      safeRasterCandidate = undefined;
    }
  }
  let renderManifest: RenderManifest;
  if (safeRasterFailure !== undefined) {
    renderManifest = createFailedSafeRasterManifest({
      artifact,
      renderer: safeRasterRenderer!.rendererId,
      rendererAuthorizationDecisionId:
        rendererAuthorizationDecisionId,
      failure: safeRasterFailure,
      renderManifestId: `${artifact.artifactId}-render`,
    });
  } else if (safeRasterCandidate !== undefined) {
    try {
      renderManifest = await createAuthorizedSafeRasterManifest({
        artifact,
        candidate: safeRasterCandidate,
        renderManifestId: `${artifact.artifactId}-render`,
        rendererAuthorizationDecisionId:
          rendererAuthorizationDecisionId,
      });
    } catch (error) {
      if (!isRealProviderProductProvenance(productPackage.provenance)) {
        throw error;
      }
      renderManifest = createFailedSafeRasterManifest({
        artifact,
        renderer: safeRasterRenderer!.rendererId,
        rendererAuthorizationDecisionId:
          rendererAuthorizationDecisionId,
        failure: error,
        renderManifestId: `${artifact.artifactId}-render`,
      });
    }
  } else {
    renderManifest =
      selectedArtifact.renderManifest ??
      renderStaticArtifact(
        artifact,
        scenario?.renderManifestId ??
          runId.replace(/^MOCK-run-/, "MOCK-render-"),
        rendererAuthorizationDecisionId,
      );
  }
  if (
    renderManifest.artifactId !== artifact.artifactId ||
    renderManifest.provenance !== artifact.provenance ||
    renderManifest.environmentOrigin !== artifact.environmentOrigin
  ) {
    throw new Error(
      "Bakeoff Job requires static render lineage to match its Artifact",
    );
  }
  let artifactPackageManifest: ArtifactPackageManifest;
  try {
    artifactPackageManifest = await artifactVault.capture({
      jobId: context.jobId,
      dataClassification: context.evaluationCase.dataClassification,
      sourceOwner: context.evaluationCase.sourceOwner,
      artifact,
      renderManifest,
      ...(productionExecutionEvidence === undefined
        ? {}
        : {
            productionExecutionEvidence: {
              ...productionExecutionEvidence,
              rasterManifestHash: renderManifest.contentHash,
            },
          }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (
        /immutable blob conflict:.*\/manifest/i.test(error.message) ||
        /payload inventory identity conflict:.*\/manifest/i.test(
          error.message,
        )
      )
    ) {
      throw new ArtifactPackageIdentityConflictError(
        artifact.artifactId,
        error,
      );
    }
    throw error;
  }
  egressAuthorizations.push(
    ...artifactPackageManifest.egressAuthorizations,
  );
  const scorecardId =
    scenario?.scorecardId ??
    runId.replace(/-run-/, "-scorecard-");
  if (executionMode === "capture_only") {
    return {
      productPackage,
      runId,
      status,
      terminalReason,
      blockReason: null,
      artifact,
      renderManifest,
      scorecard: null,
      judgeFailure: null,
      artifactPackageManifest,
      egressAuthorizations,
      attemptRecords: attempts.map((attempt, index) =>
        index === attempts.length - 1
          ? { ...attempt, artifactId: artifact.artifactId }
          : attempt,
      ),
    };
  }
  const visualScoringAllowed = renderManifest.renderOutcome === "faithful";
  const evaluationAttemptKind =
    judge === undefined || !visualScoringAllowed
      ? "local-gated-score-attempt"
      : "judge-attempt";
  const evaluationAttemptId = `${evaluationAttemptKind}:${context.jobId}:${runId}:${artifact.artifactId}`;
  let scorecard: ArtifactScorecard | null;
  let judgeFailure: JudgeFailureLineage | null = null;
  if (
    targetEnvironment === "production" &&
    !visualScoringAllowed
  ) {
    scorecard = null;
  } else if (judge === undefined || !visualScoringAllowed) {
    scorecard = scoreRenderedArtifact(artifact, renderManifest, {
      jobId: context.jobId,
      runId,
      referencePack,
      scorecardId,
      createdAt: context.fixedTime,
    });
  } else {
    try {
      egressAuthorizations.push(
        await requireEgressAuthorization(egressAuthorization, {
          requestId: `judge-evaluation:${evaluationAttemptId}`,
          jobId: context.jobId,
          runId,
          attemptId: evaluationAttemptId,
          dataClassification: context.evaluationCase.dataClassification,
          sourceOwner: context.evaluationCase.sourceOwner,
          processingPurpose: "judge_evaluation",
          targetKind: "judge",
          targetService: judgeDestination.targetService,
          targetAccount: judgeDestination.targetAccount,
          targetRegion: judgeDestination.targetRegion,
          subprocessors: judgeDestination.subprocessors,
          contentFields: [
            "evaluation_case",
            "reference_pack",
            "extracted_slide_text",
            "static_slide_images",
          ],
          payloadHash: sha256Json({
            evaluationCase: context.evaluationCase,
            artifactHash: artifact.contentHash,
            renderManifestHash: renderManifest.contentHash,
            referencePackHash: referencePack?.contentHash ?? null,
          }),
          requiredRedactions: [],
        }, clock),
      );
      scorecard = await judge.score({
        jobId: context.jobId,
        runId,
        scorecardId,
        evaluationAttemptId,
        evaluationCase: context.evaluationCase,
        artifact,
        renderManifest,
        referencePack,
      });
    } catch (error) {
      scorecard = null;
      judgeFailure = Object.freeze({
        failureClass: "judge_failure",
        submissionStatus:
          error instanceof OpenAiJudgeEvaluationError
            ? error.submissionStatus
            : "unknown",
        message:
          error instanceof Error ? error.message : "Unknown Judge failure",
        egressAttempt:
          error instanceof OpenAiJudgeEvaluationError
            ? error.egressAttempt
            : null,
      });
    }
  }
  if (
    scorecard !== null &&
    (scorecard.scorecardId !== scorecardId ||
      scorecard.jobId !== context.jobId ||
      scorecard.runId !== runId ||
      scorecard.artifactId !== artifact.artifactId ||
      scorecard.provenance !== artifact.provenance ||
      scorecard.environmentOrigin !== artifact.environmentOrigin ||
      scorecard.evaluationInputManifest.artifactHash !== artifact.contentHash ||
      scorecard.evaluationInputManifest.renderManifestHash !==
        renderManifest.contentHash ||
      scorecard.evaluationInputManifest.referencePackHash !==
        (referencePack?.contentHash ?? null) ||
      (judge !== undefined &&
        visualScoringAllowed &&
        (scorecard.judgeLineage === null ||
          !["openai", "codex_cli"].includes(
            scorecard.judgeLineage.provider,
          ))))
  ) {
    const lineageError = new Error(
      "Judge returned an inconsistent or non-OpenAI Scorecard lineage; only registered OpenAI or Codex CLI Judge lineage is accepted",
    );
    if (judge === undefined || !visualScoringAllowed) {
      throw lineageError;
    }
    scorecard = null;
    judgeFailure = Object.freeze({
      failureClass: "judge_failure",
      submissionStatus: "unknown",
      message: lineageError.message,
      egressAttempt: null,
    });
  }
  if (
    referencePack !== null &&
    scorecard !== null &&
    scorecard.evaluationInputManifest.referencePackHash ===
      referencePack.contentHash &&
    scorecard.dimensions.some(
      ({ dimension, assessmentStatus }) =>
        dimension === "factual_accuracy_and_content_quality" &&
        assessmentStatus === "ASSESSED",
    )
  ) {
    onReferencePackUse(evaluationAttemptId);
  }
  return {
    productPackage,
    runId,
    status,
    terminalReason,
    blockReason: null,
    artifact,
    renderManifest,
    scorecard,
    judgeFailure,
    artifactPackageManifest,
    egressAuthorizations,
    attemptRecords: attempts.map((attempt, index) =>
      index === attempts.length - 1
        ? { ...attempt, artifactId: artifact.artifactId }
        : attempt,
    ),
  };
}

function sharedRunFields(
  caseId: string,
  context: BakeoffExecutionContext,
) {
  return {
    jobId: context.jobId,
    caseId,
    provenance: context.provenance,
    environmentOrigin: context.environmentOrigin,
    createdAt: context.fixedTime,
    lastSyncedAt: context.fixedTime,
    reportUrl: null,
    auxiliaryReportUrls: null,
  };
}

export function createBakeoffHarness({
  feishu,
  productAdapter,
  productAdapters,
  attemptDeadline: configuredAttemptDeadline,
  referencePackStore: configuredReferencePackStore,
  referencePackGenerator: configuredReferencePackGenerator,
  judge,
  egressAuthorization: configuredEgressAuthorization,
  artifactVault: configuredArtifactVault,
  runSpecificationVault: configuredRunSpecificationVault,
  payloadInventory: configuredPayloadInventory,
  clock: configuredClock,
  rendererDestination: configuredRendererDestination,
  judgeDestination: configuredJudgeDestination,
  tombstones: configuredTombstones,
  egressAudit: configuredEgressAudit,
  wpsAiPptBrowserDriver,
  qwenBrowserDriver,
  attemptCheckpointStore: configuredAttemptCheckpointStore,
  browserProfileLock: configuredBrowserProfileLock,
  safeRasterRenderer,
  doubaoBrowserDriver,
}: BakeoffHarnessDependencies): BakeoffHarness {
  const attemptDeadline =
    configuredAttemptDeadline ?? WALL_CLOCK_ATTEMPT_DEADLINE;
  const referencePackStore =
    configuredReferencePackStore ?? defaultReferencePackStore(feishu);
  const referencePackGenerator =
    configuredReferencePackGenerator ?? DEFAULT_REFERENCE_PACK_GENERATOR;
  const egressAuthorization =
    configuredEgressAuthorization ?? DEFAULT_TEST_EGRESS_AUTHORIZATION;
  const tombstones =
    configuredTombstones ?? defaultTombstoneLedger(feishu);
  const egressAudit =
    configuredEgressAudit ?? defaultEgressAudit(feishu);
  const attemptCheckpointStore =
    configuredAttemptCheckpointStore ??
    defaultAttemptCheckpointStore(feishu);
  const browserProfileLock =
    configuredBrowserProfileLock ??
    new InProcessBrowserProfileLock(
      `in-process-wps-profile-lock:${dependencyIdentity(feishu)}`,
    );
  const payloadInventory =
    configuredPayloadInventory ??
    (configuredTombstones === undefined
      ? defaultPayloadInventory(feishu)
      : new InMemoryPayloadInventory(tombstones));
  const clock = configuredClock ?? SYSTEM_CLOCK;
  const rendererDestination =
    configuredRendererDestination ?? MOCK_RENDERER_DESTINATION;
  const judgeDestination =
    configuredJudgeDestination ?? MOCK_JUDGE_DESTINATION;
  const securityContextHash = sha256Json({
    schemaVersion: "bakeoff-security-context-v2",
    clockId: clock.clockId ?? "trusted-call-boundary-clock-v1",
    payloadInventoryId: payloadInventory.inventoryId,
    tombstoneLedgerId: tombstones.ledgerId,
    authorizationAuditId: egressAudit.auditId,
    rendererDestination,
    judgeDestination,
    projectionDestination: feishu.egressDestination,
  });
  const artifactVault =
    configuredArtifactVault ??
    (configuredEgressAuthorization === undefined
      ? defaultArtifactVault(feishu)
      : createArtifactVault({
          primary: new InMemoryImmutableBlobStore(
            `mock-primary-artifact-store:${dependencyIdentity(feishu)}`,
            tombstones,
          ),
          secondary: new InMemoryImmutableBlobStore(
            `mock-secondary-artifact-store:${dependencyIdentity(feishu)}`,
            tombstones,
          ),
          egressAuthorization,
          egressAudit,
          captureJournal:
            DEFAULT_ARTIFACT_CAPTURE_JOURNALS.get(feishu) ??
            (() => {
              const journal = new InMemoryArtifactCaptureJournal(
                `mock-artifact-capture-journal:${dependencyIdentity(feishu)}`,
              );
              DEFAULT_ARTIFACT_CAPTURE_JOURNALS.set(feishu, journal);
              return journal;
            })(),
          payloadInventory,
          clock,
        }));
  const runSpecificationVault =
    configuredRunSpecificationVault ??
    (configuredEgressAuthorization === undefined
      ? defaultRunSpecificationVault(feishu)
      : createRunSpecificationVault({
          store: new InMemoryImmutableBlobStore(
            `mock-recovery-store:${dependencyIdentity(feishu)}`,
            tombstones,
          ),
          egressAuthorization,
          egressAudit,
          payloadInventory,
          clock,
        }));
  const selectedProductAdapters = Object.freeze([
    ...(productAdapters ??
      (productAdapter === undefined ? [] : [productAdapter])),
  ]);
  if (selectedProductAdapters.length === 0) {
    throw new Error("A Bakeoff Job requires at least one Product Adapter");
  }
  const executor = {
    async startBakeoffJob(
      command: StartBakeoffJobCommand,
      selections: readonly SelectedProductAdapter[],
    ): Promise<BakeoffJobOutcome | CaptureOnlyBakeoffJobOutcome> {
      const context = executionContext(
        command.environment,
        clock.now(),
        command.executionMode ?? "evaluate",
      );
      if (command.caseId !== VOLCANO_CASE_ID) {
        throw new Error(`Unknown Evaluation Case: ${command.caseId}`);
      }
      if (command.environment !== feishu.targetEnvironment) {
        throw new Error(
          `${command.environment} command cannot use ${feishu.targetEnvironment} projection environment`,
        );
      }
      const packageIds = selections.map(
        ({ productPackage }) => productPackage.packageId,
      );
      if (new Set(packageIds).size !== packageIds.length) {
        throw new Error("Bakeoff Job contains duplicate Product Package IDs");
      }
      const selectedRunIds = selections.map(({ runId }) => runId);
      if (new Set(selectedRunIds).size !== selectedRunIds.length) {
        throw new Error("Bakeoff Job contains duplicate derived Run IDs");
      }
      for (const { productPackage } of selections) {
        assertEnvironmentOriginAllowed(
          productPackage.environmentOrigin,
          command.environment,
          `Product Package ${productPackage.packageId}`,
        );
      }
      assertEnvironmentOriginAllowed(
        context.evaluationCase.environmentOrigin,
        command.environment,
        `Evaluation Case ${context.evaluationCase.caseId}`,
      );
      const specCommitSha = BUILD_SPEC_COMMIT_SHA;
      if (
        command.environment === "production" &&
        configuredEgressAuthorization === undefined
      ) {
        throw new Error(
          "Production Bakeoff requires an explicit egress authorization port; calls blocked",
        );
      }
      if (
        command.environment === "production" &&
        (configuredRendererDestination === undefined ||
          configuredRendererDestination.targetService !==
            ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION.targetService ||
          configuredRendererDestination.targetAccount !==
            ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION.targetAccount ||
          configuredRendererDestination.targetRegion !==
            ISOLATED_OFFLINE_PNG_RENDERER_DESTINATION.targetRegion ||
          configuredRendererDestination.subprocessors.length !== 0)
      ) {
        throw new Error(
          "Production Bakeoff requires the isolated offline PNG renderer destination",
        );
      }
      let productionClaim: {
        readonly claimHash: `sha256:${string}`;
        readonly authorization: ApprovedEgressAuthorization;
        readonly attemptSubmissionSummary:
          readonly ProductionAttemptSubmissionSummary[];
      } | null = null;
      if (command.environment === "production") {
        if (command.executionMode !== "capture_only") {
          await preflightHarnessOwnedProductionJudge(judge!);
        }
        await preflightHarnessOwnedLarkBaseProjection(feishu, {
          requireReportDocument:
            command.executionMode !== "capture_only",
        });
      }

      const protocolSnapshot = bakeoffProtocolSnapshot(
        command.referencePackMode ?? "automatic",
        command.environment,
      );
      if ((await tombstones.findByJobId(context.jobId)) !== null) {
        throw new Error(
          `Bakeoff Job ${context.jobId} is tombstoned and cannot be replayed`,
        );
      }
      const existingSource = await feishu.findComparisonReportSource(
        context.jobId,
      );
      if (existingSource !== null) {
        return replayedBakeoffOutcome(
          context,
          command,
          selections,
          existingSource,
          specCommitSha,
          rendererDestination,
          judgeDestination,
          securityContextHash,
        );
      }
      if (command.environment === "production") {
        const boundClaim =
          await acquireProductionClaimBoundToAttemptState({
            scope: {
              jobId: context.jobId,
              caseId: context.evaluationCase.caseId,
              runIds: selectedRunIds,
            },
            protocolSnapshot,
            securityContextHash,
            checkpointStore: attemptCheckpointStore,
            async acquireClaim({ claimHash }) {
              const remoteState =
                await readHarnessOwnedLarkProductionJobState(feishu, {
                  jobId: context.jobId,
                  runIds: selectedRunIds,
                });
              if (remoteState.state !== "absent") {
                throw new Error(
                  `Production Bakeoff remote recovery required before provider execution: ${remoteState.state}`,
                );
              }
              const claimAuthorization =
                await requireEgressAuthorization(
                  egressAuthorization,
                  {
                    requestId:
                      `operational-ledger-production-claim:${context.jobId}:${claimHash}`,
                    jobId: context.jobId,
                    runId: null,
                    attemptId: null,
                    dataClassification:
                      context.evaluationCase.dataClassification,
                    sourceOwner:
                      context.evaluationCase.sourceOwner,
                    processingPurpose:
                      "operational_ledger_projection_storage",
                    targetKind: "storage",
                    targetService:
                      feishu.egressDestination.targetService,
                    targetAccount:
                      feishu.egressDestination.targetAccount,
                    targetRegion:
                      feishu.egressDestination.targetRegion,
                    subprocessors:
                      feishu.egressDestination.subprocessors,
                    contentFields: ["production_job_claim"],
                    payloadHash: claimHash,
                    requiredRedactions: [],
                  },
                  clock,
                );
              await egressAudit.append(claimAuthorization);
              const claimed =
                await claimHarnessOwnedLarkProductionJob(
                  feishu,
                  {
                    jobId: context.jobId,
                    runIds: selectedRunIds,
                    claimHash,
                    authorization: claimAuthorization,
                    clock,
                  },
                );
              if (claimed !== "claimed") {
                throw new Error(
                  "Production Bakeoff remote claim already exists; provider execution suppressed",
                );
              }
              return claimAuthorization;
            },
          });
        productionClaim = Object.freeze({
          claimHash: boundClaim.claimHash,
          authorization: boundClaim.result,
          attemptSubmissionSummary:
            boundClaim.attemptSubmissionSummary,
        });
      }

      const {
        runSpecificationReferences,
        referencePackSelection,
        stagedReferencePack,
      } = await (async () => {
        try {
          const runSpecificationReferences = new Map<
            string,
            RunSpecificationReference
          >(
            await Promise.all(
              selections.map(async ({
                implementationPackage,
                executionEntrypointDigest,
                executionConfigurationPackage,
                browserDriverEvidence,
                productPackage,
                runId,
              }) => {
                const reference =
                  await runSpecificationVault.capture({
                    jobId: context.jobId,
                    runId,
                    specCommitSha,
                    evaluationCase: context.evaluationCase,
                    productPackage,
                    protocolSnapshot,
                    adapterImplementationPackage:
                      implementationPackage,
                    adapterExecutionEntrypointDigest:
                      executionEntrypointDigest,
                    adapterExecutionConfigurationPackage:
                      executionConfigurationPackage,
                    browserDriverEvidence,
                  });
                return [runId, reference] as const;
              }),
            ),
          );
          const referencePackSelection =
            command.executionMode === "capture_only"
              ? { mode: "off" as const, pack: null }
              : resolveReferencePackForCase({
                  evaluationCase: context.evaluationCase,
                  ...(command.referencePackMode === undefined
                    ? {}
                    : { mode: command.referencePackMode }),
                  generator: referencePackGenerator,
                });
          const stagedReferencePack =
            referencePackSelection.pack === null
              ? null
              : referencePackStore.stage(
                  referencePackSelection.pack,
                  { jobId: context.jobId },
                );
          return {
            runSpecificationReferences,
            referencePackSelection,
            stagedReferencePack,
          };
        } catch (error) {
          if (
            productionClaim !== null &&
            attemptCheckpointStore.readAttempt !== undefined
          ) {
            const notSubmittedAttemptIds: string[] = [];
            let abortIsProvenSafe = true;
            for (const runId of selectedRunIds) {
              for (
                let attemptSeq = 1;
                attemptSeq <= MAX_PROVIDER_ATTEMPTS;
                attemptSeq += 1
              ) {
                const attemptId =
                  `${runId}-attempt-${attemptSeq}`;
                let checkpoints:
                  readonly ObservableAttemptEvent[];
                try {
                  checkpoints =
                    await attemptCheckpointStore.readAttempt(
                      attemptId,
                    );
                } catch {
                  abortIsProvenSafe = false;
                  break;
                }
                if (
                  checkpoints.length === 0 ||
                  attemptSubmissionState(checkpoints) !==
                    "not_submitted"
                ) {
                  abortIsProvenSafe = false;
                  break;
                }
                if (attemptSeq === 1) {
                  notSubmittedAttemptIds.push(attemptId);
                }
              }
              if (!abortIsProvenSafe) break;
            }
            if (
              abortIsProvenSafe &&
              notSubmittedAttemptIds.length ===
                selectedRunIds.length
            ) {
              try {
                await abortHarnessOwnedLarkProductionJobBeforeSubmission(
                  feishu,
                  {
                    jobId: context.jobId,
                    runIds: selectedRunIds,
                    claimHash: productionClaim.claimHash,
                    authorization:
                      productionClaim.authorization,
                    notSubmittedAttemptIds,
                    abortedAt: clock.now(),
                    clock,
                  },
                );
              } catch (abortError) {
                throw new AggregateError(
                  [error, abortError],
                  "Production Bakeoff failed before provider submission and could not persist its safe claim abort",
                );
              }
            }
          }
          throw error;
        }
      })();
      const jobDeadlineAtEpochMs = Date.now() + VENDOR_GENERATION_TIMEOUT_MS;
      const evaluationAttemptIdsThatUsedPack = new Set<string>();
      const settledResults = await Promise.allSettled(
        selections.map((selection) => {
          const operation = () =>
            executeVendor(
              context,
              selection,
              command.caseId,
              command.environment,
              command.executionMode ?? "evaluate",
              attemptDeadline,
              jobDeadlineAtEpochMs,
              referencePackSelection.pack,
              judge,
              egressAuthorization,
              egressAudit,
              artifactVault,
              clock,
              rendererDestination,
              safeRasterRenderer,
              judgeDestination,
              attemptCheckpointStore,
              (evaluationAttemptId) => {
                evaluationAttemptIdsThatUsedPack.add(evaluationAttemptId);
              },
              command.environment === "production"
                ? async ({ runId, attemptId, attemptSeq }) => {
                    await assertProductionVendorEgressSafe({
                      jobId: context.jobId,
                      caseId:
                        context.evaluationCase.caseId,
                      runId,
                      attemptId,
                      attemptSeq,
                      checkpointStore:
                        attemptCheckpointStore,
                    });
                  }
                : undefined,
            );
          const evidence = selection.browserDriverEvidence;
          return evidence === null
            ? operation()
            : browserProfileLock.runExclusive(
                `${evidence.browserProfileDigest}:${selection.productPackage.egressDestination.targetAccount}`,
                operation,
              );
        }),
      );
      const completedResults = settledResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (stagedReferencePack !== null) {
        if (evaluationAttemptIdsThatUsedPack.size === 0) {
          referencePackStore.deleteUnused(stagedReferencePack.stagingId);
        } else {
          referencePackStore.retainUsed(stagedReferencePack.stagingId, {
            jobId: context.jobId,
            scorecardIds: completedResults.flatMap(({ scorecard }) =>
              scorecard === null ? [] : [scorecard.scorecardId],
            ),
            evaluationAttemptIds: [...evaluationAttemptIdsThatUsedPack],
          });
        }
      }
      const rejectedResult = settledResults.find(
        (result) => result.status === "rejected",
      );
      if (rejectedResult?.status === "rejected") {
        if (
          rejectedResult.reason instanceof
            ArtifactPackageIdentityConflictError &&
          completedResults.some(
            ({ artifact }) =>
              artifact?.artifactId === rejectedResult.reason.artifactId,
          )
        ) {
          throw new Error("Bakeoff Job contains duplicate Artifact IDs");
        }
        throw rejectedResult.reason;
      }
      const results = completedResults;
      const artifactIds = results.flatMap(({ artifact }) =>
        artifact === null ? [] : [artifact.artifactId],
      );
      if (new Set(artifactIds).size !== artifactIds.length) {
        throw new Error("Bakeoff Job contains duplicate Artifact IDs");
      }
      const successful = results.filter(
        (
          result,
        ): result is CapturedVendorResult & {
          readonly artifact: Artifact;
          readonly renderManifest: RenderManifest;
          readonly scorecard: ArtifactScorecard;
        } =>
          result.status === "completed" &&
          result.artifact !== null &&
          result.renderManifest !== null &&
          result.scorecard !== null,
      );
      const captured = results.filter(
        (
          result,
        ): result is CapturedVendorResult & {
          readonly artifact: Artifact;
          readonly renderManifest: RenderManifest;
        } => result.artifact !== null && result.renderManifest !== null,
      );
      const completedForMode =
        command.executionMode === "capture_only"
          ? captured.length
          : successful.length;
      const jobStatus: BakeoffJobSummary["status"] = results.some(
        ({ status }) => status === "waiting_for_human",
      )
        ? "active"
        : completedForMode === results.length
          ? "completed"
          : completedForMode === 0
            ? "failed"
            : "partial";
      const writeProjection = async (
        projection: FeishuProjectionPort,
      ) => {
      await projection.upsertCase(context.evaluationCase);
      await projection.appendRunRecord({
        recordId: context.jobId,
        recordType: "bakeoff_job",
        parentRecordId: null,
        product: null,
        productVendorId: null,
        productPackageId: null,
        adapterVersion: null,
        status: jobStatus,
        attemptSeq: null,
        elapsedMs: null,
        submissionEvidence: null,
        terminalReason: null,
        waitingReason: null,
        blockReason: null,
        retryOfAttemptId: null,
        selectedRunIds: results.map(({ runId }) => runId),
        protocolSnapshot,
        deadlineAt: fixedTimestampAfter(
          VENDOR_GENERATION_TIMEOUT_MS,
          context.fixedTime,
        ),
        vendorGenerationMs: null,
        vendorReportedElapsedMs: null,
        humanWaitMs: null,
        timingPausedAt: null,
        observableEvents: null,
        manualActions: null,
        costEvidence: null,
        artifactId: null,
        renderManifestId: null,
        scorecardId: null,
        egressAuthorizations: [],
        securityContextHash,
        ...sharedRunFields(command.caseId, context),
      });
      for (const result of results) {
        await projection.appendRunRecord({
          recordId: result.runId,
          recordType: "vendor_run",
          parentRecordId: context.jobId,
          product: result.productPackage.displayName,
          productVendorId: result.productPackage.vendorId,
          productPackageId: result.productPackage.packageId,
          adapterVersion: result.productPackage.adapterVersion,
          status: result.status,
          attemptSeq: null,
          elapsedMs: null,
          submissionEvidence: null,
          terminalReason:
            result.terminalReason === "human_wait"
              ? null
              : result.terminalReason,
          waitingReason:
            result.terminalReason === "human_wait"
              ? "human_intervention"
              : null,
          blockReason: result.blockReason,
          retryOfAttemptId: null,
          selectedRunIds: null,
          protocolSnapshot: null,
          deadlineAt: null,
          vendorGenerationMs: null,
          vendorReportedElapsedMs: null,
          humanWaitMs: null,
          timingPausedAt: null,
          observableEvents: null,
          manualActions: null,
          costEvidence: null,
          artifactId: result.artifact?.artifactId ?? null,
          renderManifestId: result.renderManifest?.renderManifestId ?? null,
          scorecardId: result.scorecard?.scorecardId ?? null,
          judgeEgressAttempt:
            result.scorecard?.judgeLineage?.egressAttempt ??
            result.judgeFailure?.egressAttempt ??
            null,
          judgeFailure: result.judgeFailure ?? null,
          specificationReference:
            runSpecificationReferences.get(result.runId) ?? null,
          artifactPackageManifest: result.artifactPackageManifest,
          egressAuthorizations: result.egressAuthorizations,
          ...sharedRunFields(command.caseId, context),
        });
        for (const attempt of result.attemptRecords) {
          await projection.appendRunRecord(attempt);
        }
        if (result.artifact !== null && result.renderManifest !== null) {
          await projection.appendCapturedArtifact({
            recordId: `artifact-capture:${result.artifact.artifactId}`,
            caseId: command.caseId,
            jobId: context.jobId,
            runId: result.runId,
            artifactId: result.artifact.artifactId,
            provenance: context.provenance,
            environmentOrigin: context.environmentOrigin,
            artifact: result.artifact,
            renderManifest: result.renderManifest,
          });
        }
        if (
          result.artifact !== null &&
          result.renderManifest !== null &&
          result.scorecard !== null
        ) {
          await projection.appendArtifactScore({
            recordId: result.scorecard.scorecardId,
            caseId: command.caseId,
            jobId: context.jobId,
            runId: result.runId,
            artifactId: result.artifact.artifactId,
            provenance: context.provenance,
            environmentOrigin: context.environmentOrigin,
            artifact: result.artifact,
            renderManifest: result.renderManifest,
            scorecard: result.scorecard,
            comparisonCompatibilityFingerprint:
              expectedComparisonCompatibilityFingerprint(
                result.scorecard,
                protocolSnapshot,
                context.evaluationCase,
                result.renderManifest,
              ),
          });
        }
      }

      const comparisonSource =
        await projection.loadComparisonReportSource(context.jobId);
      const hasDefaultComparison =
        planCompatibleComparisonPairs({
          jobId: context.jobId,
          vendorRuns: comparisonSource.vendorRuns,
          artifactScores: comparisonSource.artifactScores,
        }).length > 0;
      let report;
      if (command.executionMode === "capture_only") {
        report = null;
      } else if (hasDefaultComparison) {
        report = (
          await createComparisonReportService({
            feishu: projection,
          }).createReport({
            jobId: context.jobId,
          })
        ).report;
      } else {
        report = await projection.createReport(
          createMockReportDraft(
            context.jobId,
            jobStatus,
            results.map((result) => ({
              product: result.productPackage.displayName,
              runId: result.runId,
              status: result.status,
              stateReason: result.terminalReason,
              artifact: result.artifact,
              renderManifest: result.renderManifest,
              scorecard: result.scorecard,
              judgeFailure: result.judgeFailure ?? null,
            })),
            {
              provenance: context.provenance,
              environmentOrigin: context.environmentOrigin,
              createdAt: context.fixedTime,
            },
          ),
        );
        await projection.linkReportToBakeoffJob(
          context.jobId,
          report.url,
        );
      }
      return report;
      };

      const stagedProjection = new InMemoryFeishuProjection({
        targetEnvironment: feishu.targetEnvironment,
        egressDestination: feishu.egressDestination,
      });
      const report = await writeProjection(stagedProjection);
      const projectionBatch = stagedProjection.snapshot();
      const projectionBatchHash = sha256Bytes(
        canonicalJsonBytes(projectionBatch),
      );
      const projectionAuthorization = await requireEgressAuthorization(
        egressAuthorization,
        {
          requestId: `operational-ledger-projection:${context.jobId}:${projectionBatchHash}`,
          jobId: context.jobId,
          runId: null,
          attemptId: null,
          dataClassification: context.evaluationCase.dataClassification,
          sourceOwner: context.evaluationCase.sourceOwner,
          processingPurpose: "operational_ledger_projection_storage",
          targetKind: "storage",
          targetService: feishu.egressDestination.targetService,
          targetAccount: feishu.egressDestination.targetAccount,
          targetRegion: feishu.egressDestination.targetRegion,
          subprocessors: feishu.egressDestination.subprocessors,
          contentFields: [
            "case_table",
            "run_record_table",
            "captured_artifact_table",
            "artifact_score_table",
            "adjudication_event_table",
            "review_event_table",
            "gap_card_workflow_event_table",
            "github_issue_delivery_reservation_table",
            "github_issue_link_event_table",
            "comparison_and_product_gap_card_table",
            "reports",
          ],
          payloadHash: projectionBatchHash,
          requiredRedactions: [],
        },
        clock,
      );
      await egressAudit.append(projectionAuthorization);
      await tombstones.runIfActive(context.jobId, () =>
        feishu.commitAuthorizedSnapshot(
          projectionBatch,
          projectionAuthorization,
        ),
      );
      let materializedReport: FeishuReport | null = null;
      if (command.executionMode !== "capture_only") {
        if (report === null) {
          throw new Error("Evaluation mode requires a staged report");
        }
        const readback = await feishu.loadComparisonReportSource(
          context.jobId,
        );
        materializedReport = readback.primaryReport;
        const committedReport = feishu
          .snapshot()
          .reports.find(
            ({ reportId }) => reportId === report.reportId,
          );
        if (
          materializedReport === null ||
          committedReport === undefined ||
          !isDeepStrictEqual(materializedReport, committedReport) ||
          readback.job.reportUrl !== materializedReport.url ||
          materializedReport.reportId !== report.reportId ||
          materializedReport.jobId !== report.jobId ||
          materializedReport.title !== report.title ||
          materializedReport.claimLevel !== report.claimLevel ||
          !isDeepStrictEqual(
            materializedReport.runIds,
            report.runIds,
          ) ||
          !isDeepStrictEqual(
            materializedReport.artifactIds,
            report.artifactIds,
          ) ||
          (command.environment === "production" &&
            !/^https:\/\/[^/\s]+\/.+/.test(materializedReport.url))
        ) {
          throw new Error(
            "Evaluation report post-commit readback is missing, non-HTTPS, or not bound to the staged report",
          );
        }
      }

      const outcomeBase = {
        job: {
          jobId: context.jobId,
          caseId: command.caseId,
          environment: command.environment,
          status: jobStatus,
          provenance: context.provenance,
          environmentOrigin: context.environmentOrigin,
        },
        artifact: captured[0]?.artifact ?? null,
        renderManifest: captured[0]?.renderManifest ?? null,
        scorecard: captured[0]?.scorecard ?? null,
        artifacts: captured.map(({ artifact }) => artifact),
        renderManifests: captured.map(({ renderManifest }) => renderManifest),
      };
      if (command.executionMode === "capture_only") {
        return {
          ...outcomeBase,
          scorecard: null,
          scorecards: [] as const,
          report: null,
        };
      }
      if (materializedReport === null) {
        throw new Error(
          "Evaluation mode requires a materialized report readback",
        );
      }
      return {
        ...outcomeBase,
        scorecards: successful.map(({ scorecard }) => scorecard),
        report: materializedReport,
      };
    },
  };
  const startBakeoffJob = (
    command: StartBakeoffJobCommand,
  ): Promise<BakeoffJobOutcome | CaptureOnlyBakeoffJobOutcome> => {
      const commandSnapshot = snapshotBakeoffCommand(command);
      if (commandSnapshot.environment !== feishu.targetEnvironment) {
        return Promise.reject(
          new Error(
            `${commandSnapshot.environment} command cannot use ${feishu.targetEnvironment} projection environment`,
          ),
        );
      }
      if (
        commandSnapshot.environment === "production" &&
        wpsAiPptBrowserDriver?.provenance === "TEST_FAKE" &&
        selectedProductAdapters.some(
          ({ executionConfigurationPackage }) =>
            parseAdapterExecutionConfiguration(
              executionConfigurationPackage,
            ).adapterKind === "wps-aippt-browser",
        )
      ) {
        return Promise.reject(
          new Error(
            "Production Bakeoff rejects caller-supplied WPS browser sessions",
          ),
        );
      }
      const selections = snapshotProductSelections(
        selectedProductAdapters,
        commandSnapshot.environment,
        {
          wpsAiPptBrowserDriver,
          qwenBrowserDriver,
          attemptCheckpointStore,
          doubaoBrowserDriver,
        },
      );
      if (commandSnapshot.environment === "production") {
        if (
          selections.some(({ executionConfiguration }) =>
            executionConfiguration.adapterKind.startsWith("mock-"),
          )
        ) {
          return Promise.reject(
            new Error(
              "Production environment origin rejects Mock adapter implementation lineage",
            ),
          );
        }
        const selectedRealProviderRuns = selections.filter(
          ({ executionConfiguration }) =>
            executionConfiguration.adapterKind === "wps-aippt-browser" ||
            executionConfiguration.adapterKind === "qwen-web" ||
            executionConfiguration.adapterKind === "doubao-web-ppt",
        );
        const isExplicitRealProviderReplay =
          selectedRealProviderRuns.length > 0 &&
          selectedRealProviderRuns.every(
            ({ browserDriverEvidence, productPackage }) =>
              productPackage.provenance ===
                "PRODUCTION_REPLAY" &&
              browserDriverEvidence?.provenance ===
                "PRODUCTION_REPLAY" &&
              browserDriverEvidence.captureSource ===
                "REAL_PROVIDER_CAPTURE",
          );
        if (
          wpsAiPptBrowserDriver !== undefined &&
          selections.some(
            ({ executionConfiguration }) =>
              executionConfiguration.adapterKind === "wps-aippt-browser",
          ) &&
          wpsAiPptBrowserDriver.provenance !== "PRODUCTION_REPLAY"
        ) {
          return Promise.reject(
            new Error(
              "Production Bakeoff rejects caller-supplied WPS browser sessions",
            ),
          );
        }
        if (
          doubaoBrowserDriver !== undefined &&
          selections.some(
            ({ executionConfiguration }) =>
              executionConfiguration.adapterKind === "doubao-web-ppt",
          ) &&
          doubaoBrowserDriver.provenance !== "PRODUCTION_REPLAY"
        ) {
          return Promise.reject(
            new Error(
              "Production Bakeoff rejects caller-supplied Doubao browser sessions",
            ),
          );
        }
        const selectedQwenRuns = selections.filter(
          ({ executionConfiguration }) =>
            executionConfiguration.adapterKind === "qwen-web",
        );
        const isExplicitQwenRealProviderReplay =
          qwenBrowserDriver?.runtimeProvenance ===
            "PRODUCTION_REPLAY" &&
          qwenBrowserDriver.captureSource ===
            "REAL_PROVIDER_CAPTURE" &&
          selectedQwenRuns.length > 0 &&
          selectedQwenRuns.every(
            ({ browserDriverEvidence, productPackage }) =>
              productPackage.provenance ===
                "PRODUCTION_REPLAY" &&
              browserDriverEvidence?.provenance ===
                "PRODUCTION_REPLAY" &&
              browserDriverEvidence.captureSource ===
                "REAL_PROVIDER_CAPTURE",
          );
        if (
          qwenBrowserDriver !== undefined &&
          !isExplicitQwenRealProviderReplay
        ) {
          return Promise.reject(
            new Error(
              "Production Bakeoff rejects caller-supplied Qwen browser sessions",
            ),
          );
        }
        if (
          selections.some(
            ({ productPackage }) =>
              productPackage.provenance === "PRODUCTION_REPLAY",
          ) &&
          !isExplicitRealProviderReplay
        ) {
          return Promise.reject(
            new Error(
              "Production replay requires explicit REAL_PROVIDER_CAPTURE lineage",
            ),
          );
        }
        assertProductionAdapterExecutionReadiness(selections);
        if (artifactVault.storageProfile?.durability !== "durable") {
          return Promise.reject(
            new Error(
              "Production Bakeoff requires an explicit durable ArtifactVault",
            ),
          );
        }
        if (
          runSpecificationVault.storageProfile?.durability !==
          "durable"
        ) {
          return Promise.reject(
            new Error(
              "Production Bakeoff requires an explicit durable RunSpecificationVault",
            ),
          );
        }
        if (attemptCheckpointStore.durability !== "durable") {
          return Promise.reject(
            new Error(
              "Production Bakeoff requires an explicit durable checkpoint store",
            ),
          );
        }
        if (browserProfileLock.isolation !== "cross_process") {
          return Promise.reject(
            new Error(
              "Production Bakeoff requires an explicit cross-process browser profile lock",
            ),
          );
        }
        if (safeRasterRenderer === undefined) {
          return Promise.reject(
            new Error(
              "Production Bakeoff requires an explicit authorized safe raster renderer",
            ),
          );
        }
        if (
          BUILD_IDENTITY_SOURCE !==
          "EMBEDDED_VERIFIED_BUILD_MANIFEST"
        ) {
          return Promise.reject(
            new Error(
              "Production Bakeoff requires an embedded verified build manifest",
            ),
          );
        }
        assertHarnessOwnedProductionCapabilities({
          artifactVault,
          runSpecificationVault,
          attemptCheckpointStore,
          browserProfileLock,
          safeRasterRenderer,
        });
        if (commandSnapshot.executionMode !== "capture_only") {
          assertHarnessOwnedProductionJudge(judge);
        }
        assertHarnessOwnedLarkBaseProjection(feishu);
        assertHarnessOwnedDurableEgressAuthorizationAudit(
          egressAudit,
        );
        if (
          artifactVault.storageProfile?.captureJournalDurability !==
          "durable"
        ) {
          return Promise.reject(
            new Error(
              "Production Bakeoff requires a durable Artifact capture journal",
            ),
          );
        }
        if (commandSnapshot.executionMode !== "capture_only") {
          assertHarnessOwnedDurableReferencePackStore(
            referencePackStore,
          );
        }
      }
      const context = executionContext(
        commandSnapshot.environment,
        clock.now(),
        commandSnapshot.executionMode ?? "evaluate",
      );
      const specCommitSha = BUILD_SPEC_COMMIT_SHA;
      const jobIdentity = bakeoffJobIdentity(
        commandSnapshot,
        selections,
        {
          attemptDeadline,
          referencePackStore,
          referencePackGenerator,
          judge,
          egressAuthorization,
          artifactVault,
          runSpecificationVault,
          payloadInventory,
          tombstones,
          clock,
          rendererDestination,
          judgeDestination,
          egressAudit,
          specCommitSha,
          wpsAiPptBrowserDriver,
          qwenBrowserDriver,
          attemptCheckpointStore,
          browserProfileLock,
          safeRasterRenderer,
          doubaoBrowserDriver,
        },
      );
      return coalesceBakeoffJob(
        feishu,
        context.jobId,
        jobIdentity,
        () => executor.startBakeoffJob(commandSnapshot, selections),
      );
    };
  return {
    startBakeoffJob:
      startBakeoffJob as BakeoffHarness["startBakeoffJob"],
  };
}
