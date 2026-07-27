import { createHash, randomUUID } from "node:crypto";
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
  readonly clockId?: string;
  now(): string;
}

export const SYSTEM_CLOCK: ClockPort = Object.freeze({
  clockId: "system-clock",
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

export interface EgressAuthorizationAuditPort {
  readonly auditId: string;
  append(decision: ApprovedEgressAuthorization): Promise<void>;
  assertRecorded(decision: ApprovedEgressAuthorization): Promise<void>;
}

export class InMemoryEgressAuthorizationAudit
  implements EgressAuthorizationAuditPort
{
  readonly auditId: string;
  readonly #decisions: ApprovedEgressAuthorization[] = [];

  constructor(
    auditId = `in-memory-egress-authorization-audit:${randomUUID()}`,
  ) {
    this.auditId = auditId;
  }

  async append(decision: ApprovedEgressAuthorization): Promise<void> {
    const existing = this.#decisions.find(
      ({ decisionId }) => decisionId === decision.decisionId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, decision)) {
        throw new Error(
          `Egress authorization audit conflict: ${decision.decisionId}`,
        );
      }
      return;
    }
    this.#decisions.push(structuredClone(decision));
  }

  async assertRecorded(
    decision: ApprovedEgressAuthorization,
  ): Promise<void> {
    const recorded = this.#decisions.find(
      ({ decisionId }) => decisionId === decision.decisionId,
    );
    if (
      recorded === undefined ||
      !isDeepStrictEqual(recorded, decision)
    ) {
      throw new Error(
        `Egress authorization audit evidence is invalid: ${decision.decisionId}`,
      );
    }
  }

  list(): readonly ApprovedEgressAuthorization[] {
    return structuredClone(this.#decisions);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function approvedEgressAuthorizationHash(
  decision: ApprovedEgressAuthorization,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(decision)))
    .digest("hex")}`;
}

export function assertPersistedApprovedEgressAuthorization(
  decision: ApprovedEgressAuthorization,
  expectedRequest: EgressAuthorizationRequest,
  expectedIntegrityHash: `sha256:${string}`,
): void {
  const runtimeDecision = decision as EgressAuthorizationDecision;
  if (
    runtimeDecision.status !== "approved" ||
    !isDeepStrictEqual(runtimeDecision.request, expectedRequest) ||
    approvedEgressAuthorizationHash(decision) !== expectedIntegrityHash ||
    decision.decisionId.trim().length === 0 ||
    decision.policyVersion.trim().length === 0 ||
    decision.legalSecurityBasis.trim().length === 0
  ) {
    throw new Error("Persisted egress authorization decision is invalid");
  }
  const requestedAt = Date.parse(decision.request.requestedAt);
  const approvedAt = Date.parse(decision.approvedAt);
  const expiresAt = Date.parse(decision.expiresAt);
  if (
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    approvedAt < requestedAt ||
    approvedAt >= expiresAt ||
    requestedAt >= expiresAt ||
    decision.request.requiredRedactions.length > 0
  ) {
    throw new Error("Persisted egress authorization decision is invalid");
  }
}

export function assertApprovedEgressAuthorizationCurrent(
  decision: ApprovedEgressAuthorization,
  clock: ClockPort = SYSTEM_CLOCK,
): void {
  const runtimeDecision = decision as EgressAuthorizationDecision;
  if (
    runtimeDecision.status !== "approved" ||
    decision.decisionId.trim().length === 0 ||
    decision.policyVersion.trim().length === 0 ||
    decision.legalSecurityBasis.trim().length === 0
  ) {
    throw new Error(
      `${decision.request.processingPurpose} egress authorization denied or incompatible; call blocked`,
    );
  }
  const requestedAt = Date.parse(decision.request.requestedAt);
  const evaluatedAt = Date.parse(clock.now());
  const approvedAt = Date.parse(decision.approvedAt);
  const expiresAt = Date.parse(decision.expiresAt);
  if (
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    approvedAt < requestedAt ||
    approvedAt > evaluatedAt ||
    approvedAt >= expiresAt ||
    expiresAt <= evaluatedAt ||
    decision.request.requiredRedactions.length > 0
  ) {
    throw new Error(
      `Egress authorization is missing, expired, or not yet valid for ${decision.request.processingPurpose}; call blocked`,
    );
  }
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
    approvedAt < requestedAt ||
    approvedAt > evaluatedAt ||
    approvedAt >= expiresAt ||
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
