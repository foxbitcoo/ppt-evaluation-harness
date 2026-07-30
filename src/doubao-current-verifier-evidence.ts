import { parseStrictJson } from "./strict-json.ts";

type Sha256 = `sha256:${string}`;

export interface DoubaoCurrentVerifierRecoveryEvidence {
  readonly schemaVersion:
    "doubao-current-verifier-trusted-recovery-evidence-v1";
  readonly status: "recovery_succeeded";
  readonly recordedOn: string;
  readonly timingBasis: "date_only_unobserved_exact_time";
  readonly registryId: string;
  readonly checkpointId: string;
  readonly artifactContentHash: Sha256;
  readonly artifactManifestHash: Sha256;
  readonly renderManifestHash: Sha256;
  readonly runSpecificationHash: Sha256;
  readonly checkpointTraceHash: Sha256;
  readonly evaluatedRunIdentity: {
    readonly specCommitSha: string;
    readonly buildIdentitySource:
      "EMBEDDED_VERIFIED_BUILD_MANIFEST";
    readonly runnerCodeDigest: Sha256;
    readonly runSpecificationCanonicalHash: Sha256;
  };
  readonly verifierBuildIdentity: {
    readonly schemaVersion: "ppt-evaluation-build-identity-v1";
    readonly specCommitSha: string;
    readonly source: "EMBEDDED_VERIFIED_BUILD_MANIFEST";
    readonly sourceArchiveDigest: Sha256;
    readonly sourceArchiveEntryCount: number;
    readonly embeddedManifestHash: Sha256;
    readonly manifestHash: Sha256;
  };
  readonly rendererAuthorizationEvidence: {
    readonly decisionId: string;
    readonly authorizationAuditDigest: Sha256;
    readonly requestId: string;
    readonly targetService: string;
    readonly targetAccount: string;
    readonly targetRegion: string;
    readonly payloadHash: Sha256;
    readonly policyVersion: string;
    readonly approvedAt: string;
    readonly expiresAt: string;
  };
  readonly binaryValidation: {
    readonly pptxSlideCount: number;
    readonly staticPngCount: number;
    readonly contactSheetPngCount: number;
  };
  readonly recoveryCliResultHash: Sha256;
  readonly resultHash: Sha256;
}

export type DoubaoCurrentVerifierRecoveryEvidenceAttestedView =
  Omit<DoubaoCurrentVerifierRecoveryEvidence, "resultHash">;

function exactObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new Error(
        `unexpected field ${JSON.stringify(key)} in ${label}`,
      );
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new Error(
        `missing required field ${JSON.stringify(key)} in ${label}`,
      );
    }
  }
  return record;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function literalField<const Value extends string>(
  record: Record<string, unknown>,
  key: string,
  expected: Value,
  label: string,
): Value {
  const value = stringField(record, key, label);
  if (value !== expected) {
    throw new Error(
      `${label}.${key} must equal ${JSON.stringify(expected)}`,
    );
  }
  return expected;
}

function sha256Field(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Sha256 {
  const value = stringField(record, key, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label}.${key} must be an exact SHA-256 digest`);
  }
  return value as Sha256;
}

function commitShaField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = stringField(record, key, label);
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${label}.${key} must be an exact commit SHA`);
  }
  return value;
}

function countField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label}.${key} must be a non-negative integer`);
  }
  return value;
}

export function parseDoubaoCurrentVerifierRecoveryEvidence(
  source: string,
): DoubaoCurrentVerifierRecoveryEvidence {
  const rootLabel = "Doubao current-verifier recovery evidence";
  const parsed = parseStrictJson(source, rootLabel);
  const root = exactObject(parsed, rootLabel, [
    "schemaVersion",
    "status",
    "recordedOn",
    "timingBasis",
    "registryId",
    "checkpointId",
    "artifactContentHash",
    "artifactManifestHash",
    "renderManifestHash",
    "runSpecificationHash",
    "checkpointTraceHash",
    "evaluatedRunIdentity",
    "verifierBuildIdentity",
    "rendererAuthorizationEvidence",
    "binaryValidation",
    "recoveryCliResultHash",
    "resultHash",
  ]);
  const evaluatedRunIdentity = exactObject(
    root.evaluatedRunIdentity,
    `${rootLabel}.evaluatedRunIdentity`,
    [
      "specCommitSha",
      "buildIdentitySource",
      "runnerCodeDigest",
      "runSpecificationCanonicalHash",
    ],
  );
  const verifierBuildIdentity = exactObject(
    root.verifierBuildIdentity,
    `${rootLabel}.verifierBuildIdentity`,
    [
      "schemaVersion",
      "specCommitSha",
      "source",
      "sourceArchiveDigest",
      "sourceArchiveEntryCount",
      "embeddedManifestHash",
      "manifestHash",
    ],
  );
  const rendererAuthorizationEvidence = exactObject(
    root.rendererAuthorizationEvidence,
    `${rootLabel}.rendererAuthorizationEvidence`,
    [
      "decisionId",
      "authorizationAuditDigest",
      "requestId",
      "targetService",
      "targetAccount",
      "targetRegion",
      "payloadHash",
      "policyVersion",
      "approvedAt",
      "expiresAt",
    ],
  );
  const binaryValidation = exactObject(
    root.binaryValidation,
    `${rootLabel}.binaryValidation`,
    [
      "pptxSlideCount",
      "staticPngCount",
      "contactSheetPngCount",
    ],
  );
  const recordedOn = stringField(root, "recordedOn", rootLabel);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordedOn)) {
    throw new Error(
      `${rootLabel}.recordedOn must be a date-only YYYY-MM-DD value`,
    );
  }

  return Object.freeze({
    schemaVersion: literalField(
      root,
      "schemaVersion",
      "doubao-current-verifier-trusted-recovery-evidence-v1",
      rootLabel,
    ),
    status: literalField(
      root,
      "status",
      "recovery_succeeded",
      rootLabel,
    ),
    recordedOn,
    timingBasis: literalField(
      root,
      "timingBasis",
      "date_only_unobserved_exact_time",
      rootLabel,
    ),
    registryId: stringField(root, "registryId", rootLabel),
    checkpointId: stringField(root, "checkpointId", rootLabel),
    artifactContentHash: sha256Field(
      root,
      "artifactContentHash",
      rootLabel,
    ),
    artifactManifestHash: sha256Field(
      root,
      "artifactManifestHash",
      rootLabel,
    ),
    renderManifestHash: sha256Field(
      root,
      "renderManifestHash",
      rootLabel,
    ),
    runSpecificationHash: sha256Field(
      root,
      "runSpecificationHash",
      rootLabel,
    ),
    checkpointTraceHash: sha256Field(
      root,
      "checkpointTraceHash",
      rootLabel,
    ),
    evaluatedRunIdentity: Object.freeze({
      specCommitSha: commitShaField(
        evaluatedRunIdentity,
        "specCommitSha",
        `${rootLabel}.evaluatedRunIdentity`,
      ),
      buildIdentitySource: literalField(
        evaluatedRunIdentity,
        "buildIdentitySource",
        "EMBEDDED_VERIFIED_BUILD_MANIFEST",
        `${rootLabel}.evaluatedRunIdentity`,
      ),
      runnerCodeDigest: sha256Field(
        evaluatedRunIdentity,
        "runnerCodeDigest",
        `${rootLabel}.evaluatedRunIdentity`,
      ),
      runSpecificationCanonicalHash: sha256Field(
        evaluatedRunIdentity,
        "runSpecificationCanonicalHash",
        `${rootLabel}.evaluatedRunIdentity`,
      ),
    }),
    verifierBuildIdentity: Object.freeze({
      schemaVersion: literalField(
        verifierBuildIdentity,
        "schemaVersion",
        "ppt-evaluation-build-identity-v1",
        `${rootLabel}.verifierBuildIdentity`,
      ),
      specCommitSha: commitShaField(
        verifierBuildIdentity,
        "specCommitSha",
        `${rootLabel}.verifierBuildIdentity`,
      ),
      source: literalField(
        verifierBuildIdentity,
        "source",
        "EMBEDDED_VERIFIED_BUILD_MANIFEST",
        `${rootLabel}.verifierBuildIdentity`,
      ),
      sourceArchiveDigest: sha256Field(
        verifierBuildIdentity,
        "sourceArchiveDigest",
        `${rootLabel}.verifierBuildIdentity`,
      ),
      sourceArchiveEntryCount: countField(
        verifierBuildIdentity,
        "sourceArchiveEntryCount",
        `${rootLabel}.verifierBuildIdentity`,
      ),
      embeddedManifestHash: sha256Field(
        verifierBuildIdentity,
        "embeddedManifestHash",
        `${rootLabel}.verifierBuildIdentity`,
      ),
      manifestHash: sha256Field(
        verifierBuildIdentity,
        "manifestHash",
        `${rootLabel}.verifierBuildIdentity`,
      ),
    }),
    rendererAuthorizationEvidence: Object.freeze({
      decisionId: stringField(
        rendererAuthorizationEvidence,
        "decisionId",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      authorizationAuditDigest: sha256Field(
        rendererAuthorizationEvidence,
        "authorizationAuditDigest",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      requestId: stringField(
        rendererAuthorizationEvidence,
        "requestId",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      targetService: stringField(
        rendererAuthorizationEvidence,
        "targetService",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      targetAccount: stringField(
        rendererAuthorizationEvidence,
        "targetAccount",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      targetRegion: stringField(
        rendererAuthorizationEvidence,
        "targetRegion",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      payloadHash: sha256Field(
        rendererAuthorizationEvidence,
        "payloadHash",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      policyVersion: stringField(
        rendererAuthorizationEvidence,
        "policyVersion",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      approvedAt: stringField(
        rendererAuthorizationEvidence,
        "approvedAt",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
      expiresAt: stringField(
        rendererAuthorizationEvidence,
        "expiresAt",
        `${rootLabel}.rendererAuthorizationEvidence`,
      ),
    }),
    binaryValidation: Object.freeze({
      pptxSlideCount: countField(
        binaryValidation,
        "pptxSlideCount",
        `${rootLabel}.binaryValidation`,
      ),
      staticPngCount: countField(
        binaryValidation,
        "staticPngCount",
        `${rootLabel}.binaryValidation`,
      ),
      contactSheetPngCount: countField(
        binaryValidation,
        "contactSheetPngCount",
        `${rootLabel}.binaryValidation`,
      ),
    }),
    recoveryCliResultHash: sha256Field(
      root,
      "recoveryCliResultHash",
      rootLabel,
    ),
    resultHash: sha256Field(root, "resultHash", rootLabel),
  });
}

export function currentVerifierRecoveryEvidenceAttestedView(
  evidence: DoubaoCurrentVerifierRecoveryEvidence,
): DoubaoCurrentVerifierRecoveryEvidenceAttestedView {
  return Object.freeze({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    recordedOn: evidence.recordedOn,
    timingBasis: evidence.timingBasis,
    registryId: evidence.registryId,
    checkpointId: evidence.checkpointId,
    artifactContentHash: evidence.artifactContentHash,
    artifactManifestHash: evidence.artifactManifestHash,
    renderManifestHash: evidence.renderManifestHash,
    runSpecificationHash: evidence.runSpecificationHash,
    checkpointTraceHash: evidence.checkpointTraceHash,
    evaluatedRunIdentity: Object.freeze({
      specCommitSha: evidence.evaluatedRunIdentity.specCommitSha,
      buildIdentitySource:
        evidence.evaluatedRunIdentity.buildIdentitySource,
      runnerCodeDigest:
        evidence.evaluatedRunIdentity.runnerCodeDigest,
      runSpecificationCanonicalHash:
        evidence.evaluatedRunIdentity
          .runSpecificationCanonicalHash,
    }),
    verifierBuildIdentity: Object.freeze({
      schemaVersion: evidence.verifierBuildIdentity.schemaVersion,
      specCommitSha: evidence.verifierBuildIdentity.specCommitSha,
      source: evidence.verifierBuildIdentity.source,
      sourceArchiveDigest:
        evidence.verifierBuildIdentity.sourceArchiveDigest,
      sourceArchiveEntryCount:
        evidence.verifierBuildIdentity.sourceArchiveEntryCount,
      embeddedManifestHash:
        evidence.verifierBuildIdentity.embeddedManifestHash,
      manifestHash: evidence.verifierBuildIdentity.manifestHash,
    }),
    rendererAuthorizationEvidence: Object.freeze({
      decisionId:
        evidence.rendererAuthorizationEvidence.decisionId,
      authorizationAuditDigest:
        evidence.rendererAuthorizationEvidence
          .authorizationAuditDigest,
      requestId: evidence.rendererAuthorizationEvidence.requestId,
      targetService:
        evidence.rendererAuthorizationEvidence.targetService,
      targetAccount:
        evidence.rendererAuthorizationEvidence.targetAccount,
      targetRegion:
        evidence.rendererAuthorizationEvidence.targetRegion,
      payloadHash:
        evidence.rendererAuthorizationEvidence.payloadHash,
      policyVersion:
        evidence.rendererAuthorizationEvidence.policyVersion,
      approvedAt:
        evidence.rendererAuthorizationEvidence.approvedAt,
      expiresAt:
        evidence.rendererAuthorizationEvidence.expiresAt,
    }),
    binaryValidation: Object.freeze({
      pptxSlideCount: evidence.binaryValidation.pptxSlideCount,
      staticPngCount: evidence.binaryValidation.staticPngCount,
      contactSheetPngCount:
        evidence.binaryValidation.contactSheetPngCount,
    }),
    recoveryCliResultHash: evidence.recoveryCliResultHash,
  });
}
