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
}

export interface ProductAdapterImplementationPackage {
  readonly packageName: string;
  readonly contentHash: `sha256:${string}`;
  readonly content: Uint8Array;
}

export type ProductAdapterExecutionConfiguration =
  | null
  | boolean
  | number
  | string
  | readonly ProductAdapterExecutionConfiguration[]
  | {
      readonly [key: string]: ProductAdapterExecutionConfiguration;
    };

function normalizeExecutionConfiguration(
  value: unknown,
): ProductAdapterExecutionConfiguration {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Adapter execution configuration requires finite numbers",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map(normalizeExecutionConfiguration),
    );
  }
  if (typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => {
            if (
              /(?:api.?key|credential|password|secret|token)/i.test(
                key,
              )
            ) {
              throw new Error(
                `Adapter execution configuration cannot persist secret-bearing field: ${key}`,
              );
            }
            return [
              key,
              normalizeExecutionConfiguration(entry),
            ];
          }),
      ),
    );
  }
  throw new Error(
    "Adapter execution configuration must be canonical JSON",
  );
}

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
  const normalized = normalizeExecutionConfiguration(parsed);
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
  execute(
    command: ProductRunCommand,
    executionConfiguration: ProductAdapterExecutionConfiguration,
  ): Promise<Artifact | ProductAttemptResult>;
}
