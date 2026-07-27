import { createHash } from "node:crypto";

import type { Artifact, EvaluationCaseRecord } from "./domain.ts";
import type {
  BlockReason,
  SubmissionEvidence,
  TerminalReason,
} from "./domain.ts";
import type { EnvironmentOrigin } from "./environment-origin.ts";
import type { EgressDestinationMetadata } from "./egress-authorization.ts";

export interface ProductPackageSnapshot {
  readonly packageId: string;
  readonly vendorId: "wps" | "qwen" | "doubao" | (string & {});
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly provenance: "MOCK" | "PRODUCTION";
  readonly environmentOrigin: EnvironmentOrigin;
  readonly egressDestination: EgressDestinationMetadata;
  readonly declaredConfiguration?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

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
}

export interface ProductAttemptResult {
  readonly terminalReason: TerminalReason;
  readonly blockReason: BlockReason | null;
  readonly submissionEvidence: SubmissionEvidence;
  readonly elapsedMs: number;
  readonly artifactCandidates: readonly ArtifactCandidate[];
  readonly trace?: readonly {
    readonly eventType: string;
    readonly observedAt: string;
    readonly evidenceRef: string;
  }[];
  readonly manualActions?: readonly {
    readonly action: string;
    readonly observedAt: string;
  }[];
  readonly observedConfiguration?: Readonly<object> | null;
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
