import type { Artifact, EvaluationCaseRecord } from "./domain.ts";

export interface ProductPackageSnapshot {
  readonly packageId: string;
  readonly displayName: string;
  readonly adapterVersion: string;
}

export interface ProductRunCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly evaluationCase: EvaluationCaseRecord;
}

export interface ProductAdapterPort {
  readonly productPackage: ProductPackageSnapshot;
  execute(command: ProductRunCommand): Promise<Artifact>;
}
