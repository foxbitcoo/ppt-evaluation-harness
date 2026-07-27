import { createHash } from "node:crypto";

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

export interface ProductPackageSnapshot {
  readonly packageId: string;
  readonly vendorId: "wps" | "qwen" | "doubao" | (string & {});
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly provenance: "MOCK" | "PRODUCTION";
  readonly environmentOrigin: EnvironmentOrigin;
  readonly egressDestination: EgressDestinationMetadata;
  readonly experienceConfiguration?: ProductExperienceConfiguration;
}

export interface ProductExperienceConfiguration {
  readonly productUrl: string;
  readonly accountScope: "current_authenticated_account";
  readonly accountIdentityObservation: "unknown";
  readonly commercialPlanObservation: "unknown";
  readonly packageSelection:
    "best_available_zero_incremental_cost";
  readonly incrementalCost: 0;
  readonly mode: "professional";
  readonly networking: "enabled";
  readonly pageCount: 16;
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
  readonly renderManifest?: RenderManifest;
  readonly safeRasterCandidate?: SafeRasterCandidate;
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

export interface ProductAttemptResult {
  readonly terminalReason: TerminalReason;
  readonly blockReason: BlockReason | null;
  readonly submissionEvidence: SubmissionEvidence;
  readonly elapsedMs: number;
  readonly artifactCandidates: readonly ArtifactCandidate[];
  readonly observableEvents?: readonly ObservableAttemptEvent[];
  readonly manualActions?: readonly string[];
}

export interface AttemptCheckpointPort {
  readonly checkpointStoreId: string;
  append(event: ObservableAttemptEvent): Promise<void>;
}

export class InMemoryAttemptCheckpointStore
  implements AttemptCheckpointPort
{
  readonly checkpointStoreId: string;
  readonly #events: ObservableAttemptEvent[] = [];

  constructor(
    checkpointStoreId = "in-memory-attempt-checkpoints",
  ) {
    this.checkpointStoreId = checkpointStoreId;
  }

  async append(event: ObservableAttemptEvent): Promise<void> {
    if (
      this.#events.some(({ eventId }) => eventId === event.eventId)
    ) {
      throw new Error(`Attempt checkpoint identity conflict: ${event.eventId}`);
    }
    this.#events.push(Object.freeze(structuredClone(event)));
  }

  snapshot(): readonly ObservableAttemptEvent[] {
    return Object.freeze(
      this.#events.map((event) => Object.freeze(structuredClone(event))),
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
