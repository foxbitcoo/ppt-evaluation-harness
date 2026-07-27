import { isDeepStrictEqual } from "node:util";

export type EgressProcessingPurpose =
  | "vendor_generation"
  | "judge_evaluation"
  | "artifact_rendering"
  | "artifact_storage"
  | "run_specification_storage"
  | "operational_ledger_recovery_export"
  | "operational_ledger_projection_storage";

export type EgressTargetKind =
  | "vendor"
  | "judge"
  | "renderer"
  | "storage";

export interface EgressDestinationMetadata {
  readonly targetService: string;
  readonly targetAccount: string;
  readonly targetRegion: string;
  readonly subprocessors: readonly string[];
}

export interface EgressAuthorizationRequest {
  readonly requestId: string;
  readonly jobId: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly dataClassification: "public_or_synthetic" | "restricted";
  readonly sourceOwner: string;
  readonly processingPurpose: EgressProcessingPurpose;
  readonly targetKind: EgressTargetKind;
  readonly targetService: string;
  readonly targetAccount: string;
  readonly targetRegion: string;
  readonly subprocessors: readonly string[];
  readonly contentFields: readonly string[];
  readonly payloadHash: `sha256:${string}`;
  readonly requiredRedactions: readonly string[];
  readonly requestedAt: string;
}

export type EgressAuthorizationRequestInput = Omit<
  EgressAuthorizationRequest,
  "requestedAt"
>;

export interface ClockPort {
  now(): string;
}

export const SYSTEM_CLOCK: ClockPort = Object.freeze({
  now: () => new Date().toISOString(),
});

export interface ApprovedEgressAuthorization {
  readonly status: "approved";
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly request: EgressAuthorizationRequest;
  readonly legalSecurityBasis: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface DeniedEgressAuthorization {
  readonly status: "denied";
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly request: EgressAuthorizationRequest;
  readonly reason: string;
  readonly decidedAt: string;
}

export type EgressAuthorizationDecision =
  | ApprovedEgressAuthorization
  | DeniedEgressAuthorization;

export interface EgressAuthorizationPort {
  authorize(
    request: EgressAuthorizationRequest,
  ): Promise<EgressAuthorizationDecision>;
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Egress authorization is missing ${label}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

export async function requireEgressAuthorization(
  port: EgressAuthorizationPort | undefined,
  input: EgressAuthorizationRequestInput,
  clock: ClockPort = SYSTEM_CLOCK,
): Promise<ApprovedEgressAuthorization> {
  const request: EgressAuthorizationRequest = deepFreeze({
    ...structuredClone(input),
    requestedAt: clock.now(),
  });
  const requestBaseline = structuredClone(request);
  nonEmpty(request.requestId, "requestId");
  nonEmpty(request.jobId, "jobId");
  nonEmpty(request.sourceOwner, "sourceOwner");
  nonEmpty(request.targetService, "targetService");
  nonEmpty(request.targetAccount, "targetAccount");
  nonEmpty(request.targetRegion, "targetRegion");
  if (!/^sha256:[a-f0-9]{64}$/.test(request.payloadHash)) {
    throw new Error(
      `${request.processingPurpose} egress authorization payload hash is invalid; call blocked`,
    );
  }
  if (
    request.contentFields.length === 0 ||
    request.contentFields.some((field) => field.trim().length === 0) ||
    request.subprocessors.some((name) => name.trim().length === 0)
  ) {
    throw new Error(
      `${request.processingPurpose} egress authorization request is incomplete; call blocked`,
    );
  }
  if (port === undefined) {
    throw new Error(
      `Egress authorization is missing for ${request.processingPurpose}; call blocked`,
    );
  }
  const decision = await port.authorize(Object.freeze(structuredClone(request)));
  if (
    decision.status !== "approved" ||
    !isDeepStrictEqual(decision.request, requestBaseline) ||
    !isDeepStrictEqual(request, requestBaseline)
  ) {
    throw new Error(
      `${request.processingPurpose} egress authorization denied or incompatible; call blocked`,
    );
  }
  nonEmpty(decision.decisionId, "decisionId");
  nonEmpty(decision.policyVersion, "policyVersion");
  nonEmpty(decision.legalSecurityBasis, "legalSecurityBasis");
  const requestedAt = Date.parse(request.requestedAt);
  const evaluatedAt = Date.parse(clock.now());
  const approvedAt = Date.parse(decision.approvedAt);
  const expiresAt = Date.parse(decision.expiresAt);
  if (
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    approvedAt > evaluatedAt ||
    expiresAt <= evaluatedAt ||
    decision.request.requiredRedactions.length > 0
  ) {
    throw new Error(
      `Egress authorization is missing, expired, or not yet valid for ${request.processingPurpose}; call blocked`,
    );
  }
  return Object.freeze({
    ...structuredClone(decision),
    request: Object.freeze(structuredClone(decision.request)),
  });
}
