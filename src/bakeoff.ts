import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  Artifact,
  ArtifactScorecard,
  BakeoffProtocolSnapshot,
  BakeoffJobOutcome,
  BlockReason,
  JudgeFailureLineage,
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
import { createComparisonReportService } from "./comparison-report.ts";
import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  assertEnvironmentOriginAllowed,
} from "./environment-origin.ts";
import {
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
  VOLCANO_CASE_ID,
  VOLCANO_EVALUATION_CASE,
} from "./fixtures/volcano-case.ts";
import {
  renderStaticArtifact,
  resolveHarnessProductAdapterExecutor,
  type HarnessProductAdapterRuntime,
} from "./mock-wps.ts";
import { createMockReportDraft } from "./mock-report.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";
import { scoreRenderedArtifact } from "./mock-score.ts";
import {
  OpenAiJudgeEvaluationError,
  type OpenAiJudgePort,
} from "./openai-judge.ts";
import {
  parseAdapterExecutionConfiguration,
  type ProductAdapterExecutionConfiguration,
  type ProductAdapterExecutor,
  type ProductAdapterImplementationPackage,
  type ProductAdapterPort,
  type ProductAttemptResult,
  type ProductPackageSnapshot,
} from "./product-adapter.ts";
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

export const VENDOR_GENERATION_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_SPEC_COMMIT_SHA = "9e68de5801bc14f00c187336000c83ce8cc37efa";
const MOCK_RENDERER_DESTINATION: EgressDestinationMetadata = Object.freeze({
  targetService: "mock-static-svg-renderer",
  targetAccount: "mock-renderer-sandbox",
  targetRegion: "test",
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

function bakeoffProtocolSnapshot(
  referencePackMode: NonNullable<
    StartBakeoffJobCommand["referencePackMode"]
  >,
): BakeoffProtocolSnapshot {
  if (referencePackMode === "automatic") {
    return MOCK_BAKEOFF_PROTOCOL_SNAPSHOT;
  }
  return Object.freeze({
    ...MOCK_BAKEOFF_PROTOCOL_SNAPSHOT,
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
    };

export interface AttemptDeadlinePort {
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<AttemptDeadlineResult<T>>;
}

const WALL_CLOCK_ATTEMPT_DEADLINE: AttemptDeadlinePort = {
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<AttemptDeadlineResult<T>> {
    const controller = new AbortController();
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        controller.abort();
        resolve({ timedOut: true, elapsedMs: timeoutMs });
      }, timeoutMs);
      void operation(controller.signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            timedOut: false,
            value,
            elapsedMs: Math.max(0, Date.now() - startedAt),
          });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  },
};

export interface BakeoffHarness {
  startBakeoffJob(command: StartBakeoffJobCommand): Promise<BakeoffJobOutcome>;
}

export interface BakeoffHarnessDependencies {
  readonly feishu: FeishuProjectionPort;
  readonly productAdapter?: ProductAdapterPort;
  readonly productAdapters?: readonly ProductAdapterPort[];
  readonly productAdapterRuntime?: HarnessProductAdapterRuntime;
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
  readonly specCommitSha?: string;
}

interface InFlightBakeoffJob {
  readonly jobIdentity: string;
  readonly outcome: Promise<BakeoffJobOutcome>;
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
  },
): string {
  return JSON.stringify({
    environment: command.environment,
    caseId: command.caseId,
    referencePackMode: command.referencePackMode ?? "automatic",
    protocol: bakeoffProtocolSnapshot(
      command.referencePackMode ?? "automatic",
    ),
    selections: selections.map(
      ({
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
    },
  });
}

function coalesceBakeoffJob(
  feishu: FeishuProjectionPort,
  jobId: string,
  jobIdentity: string,
  operation: () => Promise<BakeoffJobOutcome>,
): Promise<BakeoffJobOutcome> {
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

  let outcome!: Promise<BakeoffJobOutcome>;
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
  readonly runId: string;
}

class ArtifactPackageIdentityConflictError extends Error {
  readonly artifactId: string;

  constructor(artifactId: string, cause: unknown) {
    super(`Artifact package identity conflict: ${artifactId}`, { cause });
    this.name = "ArtifactPackageIdentityConflictError";
    this.artifactId = artifactId;
  }
}

function snapshotProductSelections(
  adapters: readonly ProductAdapterPort[],
  runtime: HarnessProductAdapterRuntime = {},
): readonly SelectedProductAdapter[] {
  return Object.freeze(
    adapters.map((adapter) => {
      const productPackage = Object.freeze({
        ...adapter.productPackage,
        egressDestination: Object.freeze(
          structuredClone(adapter.productPackage.egressDestination),
        ),
        ...(adapter.productPackage.declaredConfiguration === undefined
          ? {}
          : {
              declaredConfiguration: Object.freeze(
                structuredClone(
                  adapter.productPackage.declaredConfiguration,
                ),
              ),
            }),
      });
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
      const selectedExecute =
        resolveHarnessProductAdapterExecutor(
          implementationPackage,
          executionConfiguration,
          runtime,
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
        runId: runIdForPackage(productPackage.packageId),
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
): {
  readonly implementationDigest: `sha256:${string}`;
  readonly executionEntrypointDigest: `sha256:${string}`;
  readonly executionConfigurationDigest: `sha256:${string}`;
  readonly executionConfigurationPackageName: string;
  readonly executionConfigurationPackageByteSize: number;
  readonly executionConfiguration: ProductAdapterExecutionConfiguration;
  readonly implementationPackageName: string;
  readonly implementationPackageByteSize: number;
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
  };
}

function replayedBakeoffOutcome(
  command: StartBakeoffJobCommand,
  selections: readonly SelectedProductAdapter[],
  source: ComparisonReportSource,
  specCommitSha: string,
  rendererDestination: EgressDestinationMetadata,
  judgeDestination: EgressDestinationMetadata,
  securityContextHash: `sha256:${string}`,
): BakeoffJobOutcome {
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
  if (source.primaryReport === null) {
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
  return {
    job: {
      jobId: source.job.jobId,
      caseId: source.job.caseId,
      environment: command.environment,
      status: source.job.status,
      provenance: "MOCK",
      environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    },
    artifact: captures[0]?.artifact ?? null,
    renderManifest: captures[0]?.renderManifest ?? null,
    scorecard: scorecards[0] ?? null,
    artifacts: captures.map(({ artifact }) => artifact),
    renderManifests: captures.map(({ renderManifest }) => renderManifest),
    scorecards,
    report: source.primaryReport,
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

function runIdForPackage(packageId: string): string {
  const scenario = KNOWN_VENDOR_SCENARIOS.get(packageId);
  return scenario?.runId ?? `MOCK-run-${vendorSlug(packageId)}-volcano-v1`;
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

function fixedTimestampAfter(elapsedMs: number): string {
  return new Date(
    Date.parse(MOCK_SCENARIO.fixedTime) + elapsedMs,
  ).toISOString();
}

function sha256Json(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function comparisonCompatibilityFingerprint(
  scorecard: ArtifactScorecard,
  protocolSnapshot: BakeoffProtocolSnapshot,
) {
  const judge = scorecard.judgeLineage;
  return Object.freeze({
    caseManifestHash: sha256Json(VOLCANO_EVALUATION_CASE),
    caseInputHash: sha256Json({
      vendorPrompt: VOLCANO_EVALUATION_CASE.vendorPrompt,
    }),
    track: VOLCANO_EVALUATION_CASE.track,
    protocolHash: sha256Json(protocolSnapshot),
    rubricVersion: scorecard.rubricVersion,
    scenarioWeightProfile: null,
    judgeConfigurationHash:
      judge === null
        ? sha256Json({ scorer: "mock-score@1" })
        : sha256Json({
            provider: judge.provider,
            adapterVersion: judge.adapterVersion,
            requestedModel: judge.requestedModel,
            responseModel: judge.responseModel,
            promptVersion: judge.promptVersion,
            promptHash: judge.promptHash,
            configHash: judge.configHash,
            schemaHash: judge.schemaHash,
          }),
    renderPipelineHash: sha256Json({
      renderer: scorecard.evaluationInputManifest.renderer,
    }),
    designJudgmentSurfaceHash: sha256Json({
      surfaceClass: "canonical",
      renderer: scorecard.evaluationInputManifest.renderer,
      compatibilityStatus: "compatible",
    }),
    referencePackHash:
      scorecard.evaluationInputManifest.referencePackHash,
  });
}

function attemptRecord(input: {
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
  const adapterTrace = input.result.trace;
  return {
    recordId: input.attemptId,
    recordType: "evaluation_attempt",
    jobId: MOCK_SCENARIO.jobId,
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
        ? fixedTimestampAfter(input.measuredElapsedMs)
        : null,
    observableEvents:
      adapterTrace === undefined
        ? [
            {
              eventId: `${input.attemptId}-event-1`,
              jobId: MOCK_SCENARIO.jobId,
              caseId: input.caseId,
              runId: input.runId,
              attemptId: input.attemptId,
              attemptSeq: input.attemptSeq,
              eventType:
                input.terminalReason === "human_wait"
                  ? "waiting_for_human"
                  : `terminal:${input.terminalReason}`,
              sourceAt: fixedTimestampAfter(input.measuredElapsedMs),
              observedAt: fixedTimestampAfter(input.measuredElapsedMs),
              writerId: "mock-runner@1",
              evidenceRef: `mock://${vendorSlug(
                input.productPackage.packageId,
              )}/attempt-${input.attemptSeq}`,
            },
          ]
        : adapterTrace.map((event, index) => ({
            eventId: `${input.attemptId}-event-${index + 1}`,
            jobId: MOCK_SCENARIO.jobId,
            caseId: input.caseId,
            runId: input.runId,
            attemptId: input.attemptId,
            attemptSeq: input.attemptSeq,
            eventType: event.eventType,
            sourceAt: event.observedAt,
            observedAt: event.observedAt,
            writerId: input.productPackage.adapterVersion,
            evidenceRef: event.evidenceRef,
          })),
    manualActions:
      input.result.manualActions?.map(
        ({ action, observedAt }) => `${observedAt} ${action}`,
      ) ?? [],
    costEvidence: {
      classification: "unknown",
      amount: null,
      currency: null,
    },
    provenance: "MOCK",
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    createdAt: MOCK_SCENARIO.fixedTime,
    lastSyncedAt: MOCK_SCENARIO.fixedTime,
    reportUrl: null,
    auxiliaryReportUrls: null,
    artifactId: null,
    renderManifestId: null,
    scorecardId: null,
    ...(input.result.observedConfiguration === undefined
      ? {}
      : {
          observedProductConfiguration:
            input.result.observedConfiguration,
        }),
  };
}

async function executeVendor(
  selection: SelectedProductAdapter,
  caseId: string,
  targetEnvironment: "test" | "production",
  attemptDeadline: AttemptDeadlinePort,
  jobDeadlineAtEpochMs: number,
  referencePack: ReferencePack | null,
  judge: OpenAiJudgePort | undefined,
  egressAuthorization: EgressAuthorizationPort | undefined,
  artifactVault: ArtifactVault,
  clock: ClockPort,
  rendererDestination: EgressDestinationMetadata,
  judgeDestination: EgressDestinationMetadata,
  onReferencePackUse: (evaluationAttemptId: string) => void,
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
      egressAuthorizations.push(
        await requireEgressAuthorization(egressAuthorization, {
          requestId: `vendor-generation:${attemptId}`,
          jobId: MOCK_SCENARIO.jobId,
          runId,
          attemptId,
          dataClassification: VOLCANO_EVALUATION_CASE.dataClassification,
          sourceOwner: VOLCANO_EVALUATION_CASE.sourceOwner,
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
            jobId: MOCK_SCENARIO.jobId,
            runId,
            attemptId,
            attemptSeq,
            timeoutMs: attemptTimeoutMs,
            evaluationCase: VOLCANO_EVALUATION_CASE,
          }),
          requiredRedactions: [],
        }, clock),
      );
      const startedAt = Date.now();
      try {
        const deadlineResult = await attemptDeadline.run(
          (signal) =>
            execute({
              jobId: MOCK_SCENARIO.jobId,
              runId,
              attemptId,
              attemptSeq,
              timeoutMs: attemptTimeoutMs,
              signal,
              evaluationCase: VOLCANO_EVALUATION_CASE,
            }),
          attemptTimeoutMs,
        );
        observedBudgetRemainingMs = Math.max(
          0,
          observedBudgetRemainingMs - deadlineResult.elapsedMs,
        );
        measuredElapsedMs = deadlineResult.elapsedMs;
        result = deadlineResult.timedOut
          ? {
              terminalReason: "vendor_timeout",
              blockReason: null,
              submissionEvidence: "unknown",
              elapsedMs: deadlineResult.elapsedMs,
              artifactCandidates: [],
            }
          : normalizeExecution(deadlineResult.value);
        if (!deadlineResult.timedOut) {
          vendorReportedElapsedMs = result.elapsedMs;
        }
      } catch {
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

  const artifact = result.artifactCandidates.find(
    ({ policyCompliant }) => policyCompliant,
  )?.artifact;
  if (artifact === undefined) {
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
  if (artifact.runId !== runId || artifact.provenance !== "MOCK") {
    throw new Error("Test Bakeoff Job requires MOCK Artifact lineage");
  }
  assertEnvironmentOriginAllowed(
    artifact.environmentOrigin,
    targetEnvironment,
    `Artifact ${artifact.artifactId}`,
  );
  egressAuthorizations.push(
    await requireEgressAuthorization(egressAuthorization, {
      requestId: `artifact-rendering:${artifact.artifactId}`,
      jobId: MOCK_SCENARIO.jobId,
      runId,
      attemptId: attempts.at(-1)?.recordId ?? null,
      dataClassification: VOLCANO_EVALUATION_CASE.dataClassification,
      sourceOwner: VOLCANO_EVALUATION_CASE.sourceOwner,
      processingPurpose: "artifact_rendering",
      targetKind: "renderer",
      targetService: rendererDestination.targetService,
      targetAccount: rendererDestination.targetAccount,
      targetRegion: rendererDestination.targetRegion,
      subprocessors: rendererDestination.subprocessors,
      contentFields: ["artifact_binary"],
      payloadHash: artifact.contentHash,
      requiredRedactions: [],
    }, clock),
  );
  const renderManifest = renderStaticArtifact(
    artifact,
    scenario?.renderManifestId ?? runId.replace(/^MOCK-run-/, "MOCK-render-"),
  );
  let artifactPackageManifest: ArtifactPackageManifest;
  try {
    artifactPackageManifest = await artifactVault.capture({
      jobId: MOCK_SCENARIO.jobId,
      dataClassification: VOLCANO_EVALUATION_CASE.dataClassification,
      sourceOwner: VOLCANO_EVALUATION_CASE.sourceOwner,
      artifact,
      renderManifest,
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
    scenario?.scorecardId ?? runId.replace(/^MOCK-run-/, "MOCK-scorecard-");
  const evaluationAttemptKind =
    judge === undefined ? "mock-score-attempt" : "judge-attempt";
  const evaluationAttemptId = `${evaluationAttemptKind}:${MOCK_SCENARIO.jobId}:${runId}:${artifact.artifactId}`;
  if (referencePack !== null) {
    onReferencePackUse(evaluationAttemptId);
  }
  let scorecard: ArtifactScorecard | null;
  let judgeFailure: JudgeFailureLineage | null = null;
  if (judge === undefined) {
    scorecard = scoreRenderedArtifact(artifact, renderManifest, {
      jobId: MOCK_SCENARIO.jobId,
      runId,
      referencePack,
      scorecardId,
    });
  } else {
    try {
      egressAuthorizations.push(
        await requireEgressAuthorization(egressAuthorization, {
          requestId: `judge-evaluation:${evaluationAttemptId}`,
          jobId: MOCK_SCENARIO.jobId,
          runId,
          attemptId: evaluationAttemptId,
          dataClassification: VOLCANO_EVALUATION_CASE.dataClassification,
          sourceOwner: VOLCANO_EVALUATION_CASE.sourceOwner,
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
            evaluationCase: VOLCANO_EVALUATION_CASE,
            artifactHash: artifact.contentHash,
            renderManifestHash: renderManifest.contentHash,
            referencePackHash: referencePack?.contentHash ?? null,
          }),
          requiredRedactions: [],
        }, clock),
      );
      scorecard = await judge.score({
        jobId: MOCK_SCENARIO.jobId,
        runId,
        scorecardId,
        evaluationAttemptId,
        evaluationCase: VOLCANO_EVALUATION_CASE,
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
      scorecard.jobId !== MOCK_SCENARIO.jobId ||
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
        (scorecard.judgeLineage === null ||
          scorecard.judgeLineage.provider !== "openai")))
  ) {
    const lineageError = new Error(
      "Judge returned an inconsistent or non-OpenAI Scorecard lineage",
    );
    if (judge === undefined) {
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

function sharedRunFields(caseId: string) {
  return {
    jobId: MOCK_SCENARIO.jobId,
    caseId,
    provenance: "MOCK" as const,
    environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
    createdAt: MOCK_SCENARIO.fixedTime,
    lastSyncedAt: MOCK_SCENARIO.fixedTime,
    reportUrl: null,
    auxiliaryReportUrls: null,
  };
}

export function createBakeoffHarness({
  feishu,
  productAdapter,
  productAdapters,
  productAdapterRuntime,
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
  specCommitSha = DEFAULT_SPEC_COMMIT_SHA,
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
    ): Promise<BakeoffJobOutcome> {
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
        VOLCANO_EVALUATION_CASE.environmentOrigin,
        command.environment,
        `Evaluation Case ${VOLCANO_EVALUATION_CASE.caseId}`,
      );
      if (
        command.environment === "production" &&
        configuredEgressAuthorization === undefined
      ) {
        throw new Error(
          "Production Bakeoff requires an explicit egress authorization port; calls blocked",
        );
      }

      const protocolSnapshot = bakeoffProtocolSnapshot(
        command.referencePackMode ?? "automatic",
      );
      if ((await tombstones.findByJobId(MOCK_SCENARIO.jobId)) !== null) {
        throw new Error(
          `Bakeoff Job ${MOCK_SCENARIO.jobId} is tombstoned and cannot be replayed`,
        );
      }
      const existingSource = await feishu.findComparisonReportSource(
        MOCK_SCENARIO.jobId,
      );
      if (existingSource !== null) {
        return replayedBakeoffOutcome(
          command,
          selections,
          existingSource,
          specCommitSha,
          rendererDestination,
          judgeDestination,
          securityContextHash,
        );
      }

      const runSpecificationReferences = new Map<
        string,
        RunSpecificationReference
      >(
        await Promise.all(
          selections.map(async ({
            implementationPackage,
            executionEntrypointDigest,
            executionConfigurationPackage,
            productPackage,
            runId,
          }) => {
            const reference = await runSpecificationVault.capture({
              jobId: MOCK_SCENARIO.jobId,
              runId,
              specCommitSha,
              evaluationCase: VOLCANO_EVALUATION_CASE,
              productPackage,
              protocolSnapshot,
              adapterImplementationPackage:
                implementationPackage,
              adapterExecutionEntrypointDigest:
                executionEntrypointDigest,
              adapterExecutionConfigurationPackage:
                executionConfigurationPackage,
            });
            return [runId, reference] as const;
          }),
        ),
      );

      const referencePackSelection = resolveReferencePackForCase({
        evaluationCase: VOLCANO_EVALUATION_CASE,
        ...(command.referencePackMode === undefined
          ? {}
          : { mode: command.referencePackMode }),
        generator: referencePackGenerator,
      });
      const stagedReferencePack =
        referencePackSelection.pack === null
          ? null
          : referencePackStore.stage(referencePackSelection.pack, {
              jobId: MOCK_SCENARIO.jobId,
            });
      const jobDeadlineAtEpochMs = Date.now() + VENDOR_GENERATION_TIMEOUT_MS;
      const evaluationAttemptIdsThatUsedPack = new Set<string>();
      const settledResults = await Promise.allSettled(
        selections.map((selection) =>
          executeVendor(
            selection,
            command.caseId,
            command.environment,
            attemptDeadline,
            jobDeadlineAtEpochMs,
            referencePackSelection.pack,
            judge,
            egressAuthorization,
            artifactVault,
            clock,
            rendererDestination,
            judgeDestination,
            (evaluationAttemptId) => {
              evaluationAttemptIdsThatUsedPack.add(evaluationAttemptId);
            },
          ),
        ),
      );
      const completedResults = settledResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (stagedReferencePack !== null) {
        if (evaluationAttemptIdsThatUsedPack.size === 0) {
          referencePackStore.deleteUnused(stagedReferencePack.stagingId);
        } else {
          referencePackStore.retainUsed(stagedReferencePack.stagingId, {
            jobId: MOCK_SCENARIO.jobId,
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
      const jobStatus = results.some(
        ({ status }) => status === "waiting_for_human",
      )
        ? "active"
        : successful.length === results.length
          ? "completed"
          : successful.length === 0
            ? "failed"
            : "partial";
      const writeProjection = async (
        projection: FeishuProjectionPort,
      ) => {
      await projection.upsertCase(VOLCANO_EVALUATION_CASE);
      await projection.appendRunRecord({
        recordId: MOCK_SCENARIO.jobId,
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
        deadlineAt: fixedTimestampAfter(VENDOR_GENERATION_TIMEOUT_MS),
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
        ...sharedRunFields(command.caseId),
      });
      for (const result of results) {
        await projection.appendRunRecord({
          recordId: result.runId,
          recordType: "vendor_run",
          parentRecordId: MOCK_SCENARIO.jobId,
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
          ...sharedRunFields(command.caseId),
        });
        for (const attempt of result.attemptRecords) {
          await projection.appendRunRecord(attempt);
        }
        if (result.artifact !== null && result.renderManifest !== null) {
          await projection.appendCapturedArtifact({
            recordId: `artifact-capture:${result.artifact.artifactId}`,
            caseId: command.caseId,
            jobId: MOCK_SCENARIO.jobId,
            runId: result.runId,
            artifactId: result.artifact.artifactId,
            provenance: "MOCK",
            environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
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
            jobId: MOCK_SCENARIO.jobId,
            runId: result.runId,
            artifactId: result.artifact.artifactId,
            provenance: "MOCK",
            environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
            artifact: result.artifact,
            renderManifest: result.renderManifest,
            scorecard: result.scorecard,
            comparisonCompatibilityFingerprint:
              comparisonCompatibilityFingerprint(
                result.scorecard,
                protocolSnapshot,
              ),
          });
        }
      }

      const successfulVendorIds = new Set(
        successful.map(({ productPackage }) => productPackage.vendorId),
      );
      const hasDefaultComparison =
        successfulVendorIds.has("wps") &&
        (successfulVendorIds.has("qwen") ||
          successfulVendorIds.has("doubao"));
      let report;
      if (hasDefaultComparison) {
        report = (
          await createComparisonReportService({
            feishu: projection,
          }).createReport({
            jobId: MOCK_SCENARIO.jobId,
          })
        ).report;
      } else {
        report = await projection.createReport(
          createMockReportDraft(
            MOCK_SCENARIO.jobId,
            jobStatus,
            results.map((result) => ({
              product: result.productPackage.displayName,
              runId: result.runId,
              status: result.status,
              stateReason: result.terminalReason,
              artifact: result.artifact,
              scorecard: result.scorecard,
              judgeFailure: result.judgeFailure ?? null,
            })),
          ),
        );
        await projection.linkReportToBakeoffJob(
          MOCK_SCENARIO.jobId,
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
          requestId: `operational-ledger-projection:${MOCK_SCENARIO.jobId}:${projectionBatchHash}`,
          jobId: MOCK_SCENARIO.jobId,
          runId: null,
          attemptId: null,
          dataClassification: VOLCANO_EVALUATION_CASE.dataClassification,
          sourceOwner: VOLCANO_EVALUATION_CASE.sourceOwner,
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
      await tombstones.runIfActive(MOCK_SCENARIO.jobId, () =>
        feishu.commitAuthorizedSnapshot(
          projectionBatch,
          projectionAuthorization,
        ),
      );

      return {
        job: {
          jobId: MOCK_SCENARIO.jobId,
          caseId: command.caseId,
          environment: command.environment,
          status: jobStatus,
          provenance: "MOCK",
          environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
        },
        artifact: captured[0]?.artifact ?? null,
        renderManifest: captured[0]?.renderManifest ?? null,
        scorecard: captured[0]?.scorecard ?? null,
        artifacts: captured.map(({ artifact }) => artifact),
        renderManifests: captured.map(({ renderManifest }) => renderManifest),
        scorecards: successful.map(({ scorecard }) => scorecard),
        report,
      };
    },
  };
  return {
    startBakeoffJob(command) {
      const commandSnapshot = snapshotBakeoffCommand(command);
      const selections = snapshotProductSelections(
        selectedProductAdapters,
        productAdapterRuntime,
      );
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
        },
      );
      return coalesceBakeoffJob(
        feishu,
        MOCK_SCENARIO.jobId,
        jobIdentity,
        () => executor.startBakeoffJob(commandSnapshot, selections),
      );
    },
  };
}
