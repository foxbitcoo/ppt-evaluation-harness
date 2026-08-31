import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  Artifact,
  EvaluationCaseRecord,
  ObservableAttemptEvent,
  RenderFidelity,
  RenderManifest,
  RenderOutcome,
} from "./domain.ts";
import type {
  BlockReason,
  SubmissionEvidence,
  TerminalReason,
} from "./domain.ts";
import type { EnvironmentOrigin } from "./environment-origin.ts";
import type { EgressDestinationMetadata } from "./egress-authorization.ts";
import { durableTerminalNonSubmissionProof } from "./file-system-checkpoint-store.ts";

export interface ProductPackageSnapshot {
  readonly packageId: string;
  readonly vendorId: "wps" | "qwen" | "doubao" | (string & {});
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly provenance:
    | "MOCK"
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY";
  readonly environmentOrigin: EnvironmentOrigin;
  readonly egressDestination: EgressDestinationMetadata;
  readonly experienceConfiguration?: ProductExperienceConfiguration;
  readonly evaluationConfiguration?: ProductEvaluationConfigurationSnapshot;
}

export interface ProductEvaluationConfigurationSnapshot {
  readonly accountContext: "current_authenticated_account";
  readonly benchmarkProtocol: "best_available_zero_incremental_cost";
  readonly entryUrl: string;
  readonly modelSelection: "best_available_for_current_account";
  readonly networking: "enabled";
  readonly purchasePolicy: "no_incremental_charge";
  readonly requestedPageCount: 16;
}

export interface ProductExperienceConfiguration {
  readonly productUrl: string;
  readonly accountScope: "current_authenticated_account";
  readonly accountObservationPolicy:
    "observe_category_or_record_ui_unavailable";
  readonly commercialPlanObservationPolicy:
    "observe_plan_name_or_record_ui_unavailable";
  readonly packageSelection:
    "best_available_zero_incremental_cost";
  readonly incrementalCost: 0;
  readonly mode: "professional";
  readonly networking: "enabled";
  readonly pageCount: 16;
}

export type AccountCategoryObservation =
  | {
      readonly status: "observed";
      readonly category: "personal" | "enterprise" | "education";
      readonly evidenceId: `ev_${string}`;
    }
  | {
      readonly status: "ui_unavailable";
      readonly reason: string;
      readonly evidenceId: `ev_${string}`;
    };

export type CommercialPlanObservation =
  | {
      readonly status: "observed";
      readonly planName: string;
      readonly evidenceId: `ev_${string}`;
    }
  | {
      readonly status: "ui_unavailable";
      readonly reason: string;
      readonly evidenceId: `ev_${string}`;
    };

export interface ProductRunCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly evaluationCase: EvaluationCaseRecord;
}

export interface ArtifactCandidate {
  readonly artifact: Artifact;
  readonly policyCompliant: boolean;
  readonly renderManifest?: RenderManifest;
  readonly safeRasterCandidate?: SafeRasterCandidate;
  readonly productionExecutionEvidence?:
    ProductionDriverExecutionEvidence;
}

export interface ProductionDriverExecutionEvidence {
  readonly executionMode:
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY";
  readonly captureSource:
    | "LIVE_BROWSER_AUTOMATION"
    | "REAL_PROVIDER_CAPTURE";
  readonly driverSessionId: `session_${string}`;
  readonly vendorTaskId: `task_${string}`;
  readonly taskStateVersion: string;
  readonly driverVersion: string;
  readonly adapterVersion: string;
  readonly outcome: "captured";
  readonly artifactContentHash: `sha256:${string}`;
  readonly traceHash: `sha256:${string}`;
  readonly liveBridgeTranscriptHash?: `sha256:${string}`;
  readonly captureReceipt?: RealProviderCaptureReceiptEvidence;
}

export interface RealProviderCaptureReceiptEvidence {
  readonly captureId: string;
  readonly artifactContentHash: `sha256:${string}`;
  readonly traceDigest: `sha256:${string}`;
  readonly retainedPageDigest: `sha256:${string}`;
  readonly renderDigest: `sha256:${string}`;
}

export interface TrustedBrowserDriverEvidence {
  readonly driverId: string;
  readonly provenance:
    | "LIVE_PRODUCTION"
    | "PRODUCTION_REPLAY"
    | "TEST_FAKE";
  readonly captureSource:
    | "LIVE_BROWSER_AUTOMATION"
    | "REAL_PROVIDER_CAPTURE"
    | "TEST_FIXTURE";
  readonly driverVersion: string;
  readonly browserProfileDigest: `sha256:${string}`;
  readonly implementationDigest: `sha256:${string}`;
  readonly configurationDigest: `sha256:${string}`;
}

export interface SafeRasterCandidate {
  readonly renderer: string;
  readonly fontPack: string;
  readonly resolution: string;
  readonly colorProfile: string;
  readonly renderOutcome: RenderOutcome;
  readonly fidelity: RenderFidelity;
  readonly slides: readonly {
    readonly pageNumber: number;
    readonly filename: string;
    readonly mimeType: "image/png";
    readonly content: Uint8Array;
    readonly extractedText: string;
  }[];
  readonly contactSheet: {
    readonly filename: string;
    readonly mimeType: "image/png";
    readonly content: Uint8Array;
  };
}

export interface SafeRasterRendererPort {
  readonly rendererId: string;
  render(input: {
    readonly artifact: Artifact;
    readonly authorizationDecisionId: string;
  }): Promise<SafeRasterCandidate>;
}

export interface ProductAdapterObservableEvent {
  readonly eventType:
    | "preflight_observed"
    | "query_not_submitted"
    | "query_submission_unknown"
    | "query_submitted"
    | "generation_ready"
    | "generation_failed"
    | "generation_timed_out"
    | "waiting_for_human"
    | "artifact_exported"
    | "export_failed"
    | "render_failed"
    | "static_render_completed";
  readonly observedAt: string;
  readonly evidenceRef: string;
}

export interface DoubaoObservedProductConfiguration {
  readonly sourceUrl: string;
  readonly accountEvidence: "current_account_signed_in";
  readonly planName: string;
  readonly modelName: string;
  readonly modeName: string;
  readonly networking: "enabled";
  readonly requestedPageCount: 16;
  readonly bestAvailableForCurrentAccount: true;
  readonly incrementalChargeRequired: false;
}

export interface QwenObservedProductConfiguration {
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

export type ObservedProductConfiguration =
  | DoubaoObservedProductConfiguration
  | QwenObservedProductConfiguration;

export interface StaticRenderEvidence {
  readonly pageNumber: number;
  readonly filename: string;
  readonly mimeType: "image/png";
  readonly byteSize: number;
  readonly contentHash: `sha256:${string}`;
}

export interface ProductArtifactCaptureEvidence {
  readonly renderer: string;
  readonly artifactContentHash: `sha256:${string}`;
  readonly artifactPageCount: number;
  readonly staticRenders: readonly StaticRenderEvidence[];
}

export interface ProductAttemptResult {
  readonly terminalReason: TerminalReason;
  readonly blockReason: BlockReason | null;
  readonly submissionEvidence: SubmissionEvidence;
  readonly elapsedMs: number;
  readonly artifactCandidates: readonly ArtifactCandidate[];
  readonly observableEvents?: readonly ObservableAttemptEvent[];
  readonly manualActions?: readonly string[];
  readonly observedConfiguration?: ObservedProductConfiguration | null;
  readonly captureEvidence?: ProductArtifactCaptureEvidence;
}

export interface AttemptCheckpointReadPort {
  readonly checkpointStoreId: string;
  readonly durability?: "ephemeral" | "durable";
  readonly checkpointIntegrity?:
    | "authenticated_hash_chain"
    | "legacy_unverified_read_only";
  readonly recoveryReferencePrefix?: string;
  readAttempt(
    attemptId: string,
  ): Promise<readonly ObservableAttemptEvent[]>;
}

export interface AttemptCheckpointPort {
  readonly checkpointStoreId: string;
  readonly durability?: "ephemeral" | "durable";
  readonly checkpointIntegrity?:
    | "authenticated_hash_chain"
    | "legacy_unverified_read_only";
  readonly recoveryReferencePrefix?: string;
  append(event: ObservableAttemptEvent): Promise<void>;
  readAttempt?(
    attemptId: string,
  ): Promise<readonly ObservableAttemptEvent[]>;
  registerAdapterClaim?(
    claim: AttemptCheckpointAdapterClaim,
  ): Promise<void>;
}

export interface AttemptCheckpointAdapterClaim {
  readonly jobId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly adapterVersion: string;
  readonly claimEpoch: number;
}

export const PROVIDER_SUBMISSION_INTENT_EVENT_TYPE =
  "submission_intent" as const;
export const HARNESS_PROVIDER_EXECUTION_NOT_STARTED_EVENT_TYPE =
  "provider_execution_not_started" as const;
const HARNESS_PROVIDER_EXECUTION_NOT_STARTED_TIMESTAMP =
  "1970-01-01T00:00:00.000Z";

export function createProviderSubmissionIntentCheckpoint(
  command: ProductRunCommand,
  adapterVersion: string,
  observedAt = new Date().toISOString(),
  submissionEpoch = 1,
): ObservableAttemptEvent {
  if (!Number.isSafeInteger(submissionEpoch) || submissionEpoch < 1) {
    throw new Error("Provider submission intent epoch is invalid");
  }
  const epochSuffix = submissionEpoch === 1 ? "" : `-${submissionEpoch}`;
  return Object.freeze({
    eventId: `${command.attemptId}-submission-intent${epochSuffix}`,
    jobId: command.jobId,
    caseId: command.evaluationCase.caseId,
    runId: command.runId,
    attemptId: command.attemptId,
    attemptSeq: command.attemptSeq,
    eventType: PROVIDER_SUBMISSION_INTENT_EVENT_TYPE,
    sourceAt: observedAt,
    observedAt,
    writerId: adapterVersion,
    evidenceRef:
      `harness://${command.jobId}/${command.attemptId}/submission-intent${epochSuffix}`,
    sourceUrl: null,
    submissionEvidenceAtCheckpoint: "unknown",
    vendorTaskId: null,
    taskStateVersion: null,
    adapterVersion,
    artifactId: null,
  });
}

function providerSubmissionIntentEpoch(
  event: ObservableAttemptEvent,
  attemptId: string,
): number {
  const match = new RegExp(
    `^${attemptId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-submission-intent(?:-([1-9]\\d*))?$`,
  ).exec(event.eventId);
  if (match === null) {
    throw new Error(
      `Provider submission intent identity is invalid: ${event.eventId}`,
    );
  }
  return match[1] === undefined ? 1 : Number(match[1]);
}

export async function appendProviderSubmissionIntentCheckpoint(
  checkpointStore: AttemptCheckpointPort,
  command: ProductRunCommand,
  adapterVersion: string,
  observedAt = new Date().toISOString(),
): Promise<ObservableAttemptEvent> {
  if (checkpointStore.readAttempt === undefined) {
    throw new Error(
      "Provider submission intent requires durable checkpoint readback",
    );
  }
  const recovered = await checkpointStore.readAttempt(command.attemptId);
  const intents = recovered.filter(
    ({ eventType }) => eventType === PROVIDER_SUBMISSION_INTENT_EVENT_TYPE,
  );
  for (const event of intents) {
    if (
      event.jobId !== command.jobId ||
      event.caseId !== command.evaluationCase.caseId ||
      event.runId !== command.runId ||
      event.attemptId !== command.attemptId ||
      event.attemptSeq !== command.attemptSeq ||
      event.writerId !== adapterVersion ||
      event.adapterVersion !== adapterVersion ||
      !isUnresolvedProviderSubmissionIntent(event)
    ) {
      throw new Error(
        "Recovered provider submission intent lineage does not match the Attempt",
      );
    }
  }
  const epochs = intents.map((event) =>
    providerSubmissionIntentEpoch(event, command.attemptId),
  );
  if (
    epochs.some((epoch, index) => epoch !== index + 1) ||
    new Set(epochs).size !== epochs.length
  ) {
    throw new Error(
      "Provider submission intent epochs must be contiguous and ordered",
    );
  }
  const submissionState = attemptSubmissionState(recovered);
  if (submissionState === "submitted") {
    throw new Error(
      "Provider submission intent cannot follow submitted Attempt state",
    );
  }
  if (submissionState === "unknown" && intents.length > 0) {
    return Object.freeze(
      structuredClone(intents[intents.length - 1]!),
    );
  }
  if (submissionState !== "not_submitted") {
    throw new Error(
      "Provider submission intent requires proven non-submission",
    );
  }
  const nextEpoch =
    (epochs.at(-1) ?? 0) + 1;
  const intent = createProviderSubmissionIntentCheckpoint(
    command,
    adapterVersion,
    observedAt,
    nextEpoch,
  );
  await checkpointStore.append(intent);
  return intent;
}

export function isUnresolvedProviderSubmissionIntent(
  event: ObservableAttemptEvent,
): boolean {
  return (
    event.eventType === PROVIDER_SUBMISSION_INTENT_EVENT_TYPE &&
    event.submissionEvidenceAtCheckpoint === "unknown" &&
    (event.vendorTaskId === null ||
      event.vendorTaskId === undefined) &&
    (event.taskStateVersion === null ||
      event.taskStateVersion === undefined)
  );
}

export function createHarnessProviderExecutionNotStartedCheckpoint(
  input: {
    readonly jobId: string;
    readonly caseId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly attemptSeq: number;
  },
): ObservableAttemptEvent {
  return Object.freeze({
    eventId: `${input.attemptId}-provider-not-started`,
    jobId: input.jobId,
    caseId: input.caseId,
    runId: input.runId,
    attemptId: input.attemptId,
    attemptSeq: input.attemptSeq,
    eventType: HARNESS_PROVIDER_EXECUTION_NOT_STARTED_EVENT_TYPE,
    sourceAt: HARNESS_PROVIDER_EXECUTION_NOT_STARTED_TIMESTAMP,
    observedAt: HARNESS_PROVIDER_EXECUTION_NOT_STARTED_TIMESTAMP,
    writerId: "bakeoff-harness@1",
    evidenceRef:
      `harness://${input.jobId}/${input.attemptId}/provider-not-started`,
    submissionEvidenceAtCheckpoint: "not_submitted",
    vendorTaskId: null,
    taskStateVersion: "pre_provider@1",
    artifactId: null,
  });
}

export function isHarnessProviderExecutionNotStartedCheckpoint(
  event: ObservableAttemptEvent,
  command: ProductRunCommand,
): boolean {
  return isDeepStrictEqual(
    event,
    createHarnessProviderExecutionNotStartedCheckpoint({
      jobId: command.jobId,
      caseId: command.evaluationCase.caseId,
      runId: command.runId,
      attemptId: command.attemptId,
      attemptSeq: command.attemptSeq,
    }),
  );
}

export function attemptSubmissionState(
  events: readonly ObservableAttemptEvent[],
): SubmissionEvidence {
  let state: SubmissionEvidence = "not_submitted";
  for (const event of events) {
    const observed = event.submissionEvidenceAtCheckpoint;
    if (observed === "submitted") {
      state = "submitted";
      continue;
    }
    if (state === "submitted" || observed === undefined) {
      continue;
    }
    if (observed === "unknown") {
      state = "unknown";
      continue;
    }
    if (observed === "not_submitted") {
      if (
        event.eventType === "query_not_submitted" &&
        event.adapterVersion !== undefined &&
        event.writerId === event.adapterVersion &&
        (event.vendorTaskId === null ||
          event.vendorTaskId === undefined) &&
        /^not_submitted@[1-9]\d*$/.test(
          event.taskStateVersion ?? "",
        ) &&
        isHarnessVerifiedTerminalNonSubmission(event)
      ) {
        state = "not_submitted";
      }
    }
  }
  return state;
}

const IN_MEMORY_VERIFIED_TERMINAL_NON_SUBMISSIONS =
  new WeakSet<ObservableAttemptEvent>();

function isHarnessVerifiedTerminalNonSubmission(
  event: ObservableAttemptEvent,
): boolean {
  return (
    durableTerminalNonSubmissionProof(event) !== null ||
    IN_MEMORY_VERIFIED_TERMINAL_NON_SUBMISSIONS.has(event)
  );
}

export function submissionEvidenceBoundToCheckpoints(
  reported: SubmissionEvidence,
  events: readonly ObservableAttemptEvent[],
): SubmissionEvidence {
  const durable = attemptSubmissionState(events);
  if (reported === "submitted") {
    if (durable !== "submitted") {
      throw new Error(
        "Submitted Attempt result is not backed by durable checkpoints",
      );
    }
    return "submitted";
  }
  if (reported === "unknown") {
    return durable === "submitted" ? "submitted" : "unknown";
  }
  return durable;
}

export class InMemoryAttemptCheckpointStore
  implements AttemptCheckpointPort
{
  readonly checkpointStoreId: string;
  readonly durability = "ephemeral" as const;
  readonly recoveryReferencePrefix = "unavailable";
  readonly #events: ObservableAttemptEvent[] = [];
  readonly #adapterClaims = new Map<
    string,
    AttemptCheckpointAdapterClaim
  >();

  constructor(
    checkpointStoreId = "in-memory-attempt-checkpoints",
  ) {
    this.checkpointStoreId = checkpointStoreId;
  }

  async append(event: ObservableAttemptEvent): Promise<void> {
    const existing = this.#events.find(
      ({ eventId }) => eventId === event.eventId,
    );
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(event)
    ) {
      throw new Error(`Attempt checkpoint identity conflict: ${event.eventId}`);
    }
    if (existing !== undefined) return;
    const stored = Object.freeze(structuredClone(event));
    if (
      stored.eventType === "query_not_submitted" &&
      [...this.#events].reverse().some(
        (prior) =>
          prior.attemptId === stored.attemptId &&
          prior.eventType === PROVIDER_SUBMISSION_INTENT_EVENT_TYPE &&
          prior.adapterVersion === stored.adapterVersion,
      )
    ) {
      IN_MEMORY_VERIFIED_TERMINAL_NON_SUBMISSIONS.add(stored);
    }
    this.#events.push(stored);
  }

  async registerAdapterClaim(
    claim: AttemptCheckpointAdapterClaim,
  ): Promise<void> {
    const key = `${claim.attemptId}:${claim.claimEpoch}`;
    const existing = this.#adapterClaims.get(key);
    if (
      existing !== undefined &&
      !isDeepStrictEqual(existing, claim)
    ) {
      throw new Error("Attempt adapter claim epoch conflicts");
    }
    this.#adapterClaims.set(key, Object.freeze(structuredClone(claim)));
  }

  async readAttempt(
    attemptId: string,
  ): Promise<readonly ObservableAttemptEvent[]> {
    return Object.freeze(
      this.#events
        .filter((event) => event.attemptId === attemptId)
        .map((event) => {
          const clone = Object.freeze(structuredClone(event));
          if (
            IN_MEMORY_VERIFIED_TERMINAL_NON_SUBMISSIONS.has(event)
          ) {
            IN_MEMORY_VERIFIED_TERMINAL_NON_SUBMISSIONS.add(clone);
          }
          return clone;
        }),
    );
  }

  snapshot(): readonly ObservableAttemptEvent[] {
    return Object.freeze(
      this.#events.map((event) => {
        const clone = Object.freeze(structuredClone(event));
        if (IN_MEMORY_VERIFIED_TERMINAL_NON_SUBMISSIONS.has(event)) {
          IN_MEMORY_VERIFIED_TERMINAL_NON_SUBMISSIONS.add(clone);
        }
        return clone;
      }),
    );
  }
}

export interface ProductAdapterImplementationPackage {
  readonly packageName: string;
  readonly contentHash: `sha256:${string}`;
  readonly content: Uint8Array;
}

export interface ProductAdapterExecutionConfiguration {
  readonly adapterKind: string;
  readonly scenario: string;
  readonly schemaVersion:
    "product-adapter-execution-configuration-v1";
}

export type ProductAdapterExecutor = (
  this: void,
  command: ProductRunCommand,
) => Promise<Artifact | ProductAttemptResult>;

export function parseAdapterExecutionConfiguration(
  executionConfigurationPackage: ProductAdapterImplementationPackage,
): ProductAdapterExecutionConfiguration {
  if (
    executionConfigurationPackage.content.byteLength === 0 ||
    executionConfigurationPackage.content.byteLength > 65_536
  ) {
    throw new Error(
      "Adapter execution configuration package has an invalid size",
    );
  }
  const actualContentHash =
    `sha256:${createHash("sha256")
      .update(executionConfigurationPackage.content)
      .digest("hex")}` as const;
  if (
    actualContentHash !==
    executionConfigurationPackage.contentHash
  ) {
    throw new Error(
      "Adapter execution configuration package hash mismatch",
    );
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      executionConfigurationPackage.content,
    );
  } catch {
    throw new Error(
      "Adapter execution configuration must be UTF-8 JSON",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error(
      "Adapter execution configuration must be canonical JSON",
    );
  }
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object"
  ) {
    throw new Error(
      "Adapter execution configuration must match the recoverable allowlist schema",
    );
  }
  const configuration = parsed as Record<string, unknown>;
  if (
    !(
      Object.keys(configuration).sort().join(",") ===
        "adapterKind,scenario,schemaVersion" &&
      configuration.schemaVersion ===
        "product-adapter-execution-configuration-v1" &&
      typeof configuration.adapterKind === "string" &&
      /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(
        configuration.adapterKind,
      ) &&
      typeof configuration.scenario === "string" &&
      /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(
        configuration.scenario,
      )
    )
  ) {
    throw new Error(
      "Adapter execution configuration must match the recoverable allowlist schema",
    );
  }
  const normalized = Object.freeze({
    adapterKind: configuration.adapterKind,
    scenario: configuration.scenario,
    schemaVersion:
      "product-adapter-execution-configuration-v1" as const,
  });
  if (JSON.stringify(normalized) !== decoded) {
    throw new Error(
      "Adapter execution configuration must use canonical JSON encoding",
    );
  }
  return normalized;
}

export interface ProductAdapterPort {
  readonly productPackage: ProductPackageSnapshot;
  readonly implementationPackage: ProductAdapterImplementationPackage;
  readonly executionConfigurationPackage: ProductAdapterImplementationPackage;
}
