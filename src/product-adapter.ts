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

export interface ProductAdapterPort {
  readonly productPackage: ProductPackageSnapshot;
  readonly implementationPackage: ProductAdapterImplementationPackage;
  execute(command: ProductRunCommand): Promise<Artifact | ProductAttemptResult>;
}
