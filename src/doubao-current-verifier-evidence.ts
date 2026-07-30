import { parseStrictJson } from "./strict-json.ts";

type Sha256 = `sha256:${string}`;

export interface VerifiedBuildIdentity {
  readonly schemaVersion: "ppt-evaluation-build-identity-v1";
  readonly specCommitSha: string;
  readonly source: "EMBEDDED_VERIFIED_BUILD_MANIFEST";
  readonly sourceArchiveDigest: Sha256;
  readonly sourceArchiveEntryCount: number;
  readonly embeddedManifestHash: Sha256;
  readonly manifestHash: Sha256;
}

export interface DoubaoRecoveryCliResult {
  readonly registryId: string;
  readonly registryHash: Sha256;
  readonly rootReferences: {
    readonly artifactRecovery: string;
    readonly runSpecification: string;
    readonly checkpoint: string;
  };
  readonly jobId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly attemptId: string;
  readonly artifactId: string;
  readonly manifestHash: Sha256;
  readonly originalHash: Sha256;
  readonly renderManifestHash: Sha256;
  readonly derivativeCount: number;
  readonly recoveredDerivativeCount: number;
  readonly derivativeSetHash: Sha256;
  readonly runSpecificationHash: Sha256;
  readonly checkpointCount: number;
  readonly checkpointTraceHash: Sha256;
  readonly browserDriverId: string;
  readonly trustedRecoveryCheckpoint: {
    readonly checkpointId: string;
    readonly purpose: string;
    readonly schemaVersion: string;
  };
  readonly evaluatedRunIdentity: {
    readonly specCommitSha: string;
    readonly buildIdentitySource: string;
    readonly runnerCodeDigest: Sha256;
    readonly runSpecificationCanonicalHash: Sha256;
  };
  readonly verifierBuildIdentity: VerifiedBuildIdentity;
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
}

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
  readonly verifierBuildIdentity: VerifiedBuildIdentity;
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
  readonly recoveryCliEvidence: {
    readonly schemaVersion: "doubao-recovery-cli-evidence-v1";
    readonly rawResultReference: string;
    readonly rawResultHash: Sha256;
    readonly rawResultVerifierBuildIdentity: VerifiedBuildIdentity;
    readonly attestedResultSchemaVersion:
      "doubao-recovery-result-attestation-v1";
    readonly attestedResultHash: Sha256;
    readonly attestedResultVerifierBuildIdentity:
      VerifiedBuildIdentity;
  };
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

function buildIdentity(
  value: unknown,
  label: string,
): VerifiedBuildIdentity {
  const identity = exactObject(value, label, [
    "schemaVersion",
    "specCommitSha",
    "source",
    "sourceArchiveDigest",
    "sourceArchiveEntryCount",
    "embeddedManifestHash",
    "manifestHash",
  ]);
  return Object.freeze({
    schemaVersion: literalField(
      identity,
      "schemaVersion",
      "ppt-evaluation-build-identity-v1",
      label,
    ),
    specCommitSha: commitShaField(
      identity,
      "specCommitSha",
      label,
    ),
    source: literalField(
      identity,
      "source",
      "EMBEDDED_VERIFIED_BUILD_MANIFEST",
      label,
    ),
    sourceArchiveDigest: sha256Field(
      identity,
      "sourceArchiveDigest",
      label,
    ),
    sourceArchiveEntryCount: countField(
      identity,
      "sourceArchiveEntryCount",
      label,
    ),
    embeddedManifestHash: sha256Field(
      identity,
      "embeddedManifestHash",
      label,
    ),
    manifestHash: sha256Field(identity, "manifestHash", label),
  });
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
    "recoveryCliEvidence",
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
  const verifierBuildIdentity = buildIdentity(
    root.verifierBuildIdentity,
    `${rootLabel}.verifierBuildIdentity`,
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
  const recoveryCliEvidence = exactObject(
    root.recoveryCliEvidence,
    `${rootLabel}.recoveryCliEvidence`,
    [
      "schemaVersion",
      "rawResultReference",
      "rawResultHash",
      "rawResultVerifierBuildIdentity",
      "attestedResultSchemaVersion",
      "attestedResultHash",
      "attestedResultVerifierBuildIdentity",
    ],
  );
  const rawResultVerifierBuildIdentity = buildIdentity(
    recoveryCliEvidence.rawResultVerifierBuildIdentity,
    `${rootLabel}.recoveryCliEvidence.rawResultVerifierBuildIdentity`,
  );
  const attestedResultVerifierBuildIdentity = buildIdentity(
    recoveryCliEvidence.attestedResultVerifierBuildIdentity,
    `${rootLabel}.recoveryCliEvidence.attestedResultVerifierBuildIdentity`,
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
    verifierBuildIdentity,
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
    recoveryCliEvidence: Object.freeze({
      schemaVersion: literalField(
        recoveryCliEvidence,
        "schemaVersion",
        "doubao-recovery-cli-evidence-v1",
        `${rootLabel}.recoveryCliEvidence`,
      ),
      rawResultReference: stringField(
        recoveryCliEvidence,
        "rawResultReference",
        `${rootLabel}.recoveryCliEvidence`,
      ),
      rawResultHash: sha256Field(
        recoveryCliEvidence,
        "rawResultHash",
        `${rootLabel}.recoveryCliEvidence`,
      ),
      rawResultVerifierBuildIdentity,
      attestedResultSchemaVersion: literalField(
        recoveryCliEvidence,
        "attestedResultSchemaVersion",
        "doubao-recovery-result-attestation-v1",
        `${rootLabel}.recoveryCliEvidence`,
      ),
      attestedResultHash: sha256Field(
        recoveryCliEvidence,
        "attestedResultHash",
        `${rootLabel}.recoveryCliEvidence`,
      ),
      attestedResultVerifierBuildIdentity,
    }),
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
    recoveryCliEvidence: Object.freeze({
      schemaVersion: evidence.recoveryCliEvidence.schemaVersion,
      rawResultReference:
        evidence.recoveryCliEvidence.rawResultReference,
      rawResultHash: evidence.recoveryCliEvidence.rawResultHash,
      rawResultVerifierBuildIdentity: Object.freeze({
        ...evidence.recoveryCliEvidence
          .rawResultVerifierBuildIdentity,
      }),
      attestedResultSchemaVersion:
        evidence.recoveryCliEvidence.attestedResultSchemaVersion,
      attestedResultHash:
        evidence.recoveryCliEvidence.attestedResultHash,
      attestedResultVerifierBuildIdentity: Object.freeze({
        ...evidence.recoveryCliEvidence
          .attestedResultVerifierBuildIdentity,
      }),
    }),
  });
}

export function parseDoubaoRecoveryCliResult(
  source: string,
): DoubaoRecoveryCliResult {
  const rootLabel = "Doubao recovery CLI result";
  const root = exactObject(
    parseStrictJson(source, rootLabel),
    rootLabel,
    [
      "registryId",
      "registryHash",
      "rootReferences",
      "jobId",
      "runId",
      "caseId",
      "attemptId",
      "artifactId",
      "manifestHash",
      "originalHash",
      "renderManifestHash",
      "derivativeCount",
      "recoveredDerivativeCount",
      "derivativeSetHash",
      "runSpecificationHash",
      "checkpointCount",
      "checkpointTraceHash",
      "browserDriverId",
      "trustedRecoveryCheckpoint",
      "evaluatedRunIdentity",
      "verifierBuildIdentity",
      "rendererAuthorizationEvidence",
      "binaryValidation",
    ],
  );
  const rootReferences = exactObject(
    root.rootReferences,
    `${rootLabel}.rootReferences`,
    ["artifactRecovery", "runSpecification", "checkpoint"],
  );
  const trustedRecoveryCheckpoint = exactObject(
    root.trustedRecoveryCheckpoint,
    `${rootLabel}.trustedRecoveryCheckpoint`,
    ["checkpointId", "purpose", "schemaVersion"],
  );
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

  return Object.freeze({
    registryId: stringField(root, "registryId", rootLabel),
    registryHash: sha256Field(root, "registryHash", rootLabel),
    rootReferences: Object.freeze({
      artifactRecovery: stringField(
        rootReferences,
        "artifactRecovery",
        `${rootLabel}.rootReferences`,
      ),
      runSpecification: stringField(
        rootReferences,
        "runSpecification",
        `${rootLabel}.rootReferences`,
      ),
      checkpoint: stringField(
        rootReferences,
        "checkpoint",
        `${rootLabel}.rootReferences`,
      ),
    }),
    jobId: stringField(root, "jobId", rootLabel),
    runId: stringField(root, "runId", rootLabel),
    caseId: stringField(root, "caseId", rootLabel),
    attemptId: stringField(root, "attemptId", rootLabel),
    artifactId: stringField(root, "artifactId", rootLabel),
    manifestHash: sha256Field(root, "manifestHash", rootLabel),
    originalHash: sha256Field(root, "originalHash", rootLabel),
    renderManifestHash: sha256Field(
      root,
      "renderManifestHash",
      rootLabel,
    ),
    derivativeCount: countField(root, "derivativeCount", rootLabel),
    recoveredDerivativeCount: countField(
      root,
      "recoveredDerivativeCount",
      rootLabel,
    ),
    derivativeSetHash: sha256Field(
      root,
      "derivativeSetHash",
      rootLabel,
    ),
    runSpecificationHash: sha256Field(
      root,
      "runSpecificationHash",
      rootLabel,
    ),
    checkpointCount: countField(root, "checkpointCount", rootLabel),
    checkpointTraceHash: sha256Field(
      root,
      "checkpointTraceHash",
      rootLabel,
    ),
    browserDriverId: stringField(
      root,
      "browserDriverId",
      rootLabel,
    ),
    trustedRecoveryCheckpoint: Object.freeze({
      checkpointId: stringField(
        trustedRecoveryCheckpoint,
        "checkpointId",
        `${rootLabel}.trustedRecoveryCheckpoint`,
      ),
      purpose: stringField(
        trustedRecoveryCheckpoint,
        "purpose",
        `${rootLabel}.trustedRecoveryCheckpoint`,
      ),
      schemaVersion: stringField(
        trustedRecoveryCheckpoint,
        "schemaVersion",
        `${rootLabel}.trustedRecoveryCheckpoint`,
      ),
    }),
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
    verifierBuildIdentity: buildIdentity(
      root.verifierBuildIdentity,
      `${rootLabel}.verifierBuildIdentity`,
    ),
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
  });
}

export function doubaoRecoveryResultAttestedView(
  result: DoubaoRecoveryCliResult,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "doubao-recovery-result-attestation-v1",
    recoveryResult: Object.freeze({
      registryId: result.registryId,
      registryHash: result.registryHash,
      rootReferences: Object.freeze({
        artifactRecovery: result.rootReferences.artifactRecovery,
        runSpecification: result.rootReferences.runSpecification,
        checkpoint: result.rootReferences.checkpoint,
      }),
      jobId: result.jobId,
      runId: result.runId,
      caseId: result.caseId,
      attemptId: result.attemptId,
      artifactId: result.artifactId,
      manifestHash: result.manifestHash,
      originalHash: result.originalHash,
      renderManifestHash: result.renderManifestHash,
      derivativeCount: result.derivativeCount,
      recoveredDerivativeCount: result.recoveredDerivativeCount,
      derivativeSetHash: result.derivativeSetHash,
      runSpecificationHash: result.runSpecificationHash,
      checkpointCount: result.checkpointCount,
      checkpointTraceHash: result.checkpointTraceHash,
      browserDriverId: result.browserDriverId,
      trustedRecoveryCheckpoint: Object.freeze({
        checkpointId:
          result.trustedRecoveryCheckpoint.checkpointId,
        purpose: result.trustedRecoveryCheckpoint.purpose,
        schemaVersion:
          result.trustedRecoveryCheckpoint.schemaVersion,
      }),
      evaluatedRunIdentity: Object.freeze({
        specCommitSha: result.evaluatedRunIdentity.specCommitSha,
        buildIdentitySource:
          result.evaluatedRunIdentity.buildIdentitySource,
        runnerCodeDigest:
          result.evaluatedRunIdentity.runnerCodeDigest,
        runSpecificationCanonicalHash:
          result.evaluatedRunIdentity
            .runSpecificationCanonicalHash,
      }),
      rendererAuthorizationEvidence: Object.freeze({
        decisionId:
          result.rendererAuthorizationEvidence.decisionId,
        authorizationAuditDigest:
          result.rendererAuthorizationEvidence
            .authorizationAuditDigest,
        requestId:
          result.rendererAuthorizationEvidence.requestId,
        targetService:
          result.rendererAuthorizationEvidence.targetService,
        targetAccount:
          result.rendererAuthorizationEvidence.targetAccount,
        targetRegion:
          result.rendererAuthorizationEvidence.targetRegion,
        payloadHash:
          result.rendererAuthorizationEvidence.payloadHash,
        policyVersion:
          result.rendererAuthorizationEvidence.policyVersion,
        approvedAt:
          result.rendererAuthorizationEvidence.approvedAt,
        expiresAt:
          result.rendererAuthorizationEvidence.expiresAt,
      }),
      binaryValidation: Object.freeze({
        pptxSlideCount: result.binaryValidation.pptxSlideCount,
        staticPngCount: result.binaryValidation.staticPngCount,
        contactSheetPngCount:
          result.binaryValidation.contactSheetPngCount,
      }),
    }),
  });
}
