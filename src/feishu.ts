import { isDeepStrictEqual } from "node:util";

import type {
  ArtifactScorecard,
  ArtifactScoreTableRecord,
  CapturedArtifactTableRecord,
  ComparisonRecord,
  EvaluationCaseRecord,
  FeishuReport,
  FeishuReportDraft,
  ProductGapCardRecord,
  RunRecord,
} from "./domain.ts";
import {
  assertEnvironmentOriginAllowed,
  type EnvironmentOrigin,
} from "./environment-origin.ts";

function stableRunReplayPayload(record: RunRecord): unknown {
  const {
    reportUrl: _reportUrl,
    auxiliaryReportUrls: _auxiliaryReportUrls,
    ...stable
  } = record;
  return stable;
}

export interface EvaluationCaseTablePort {
  upsertCase(record: EvaluationCaseRecord): Promise<void>;
}

export interface RunRecordTablePort {
  appendRunRecord(record: RunRecord): Promise<void>;
  linkReportToBakeoffJob(
    jobId: string,
    reportUrl: string,
    role?: "primary" | "auxiliary",
  ): Promise<void>;
}

export interface ArtifactScoreTablePort {
  appendArtifactScore(record: ArtifactScoreTableRecord): Promise<void>;
}

export interface CapturedArtifactTablePort {
  appendCapturedArtifact(record: CapturedArtifactTableRecord): Promise<void>;
}

export interface ProductGapCardTablePort {
  appendProductGapCard(record: ProductGapCardRecord): Promise<void>;
}

export interface ComparisonTablePort {
  appendComparison(record: ComparisonRecord): Promise<void>;
}

export interface ReportDocumentPort {
  createReport(draft: FeishuReportDraft): Promise<FeishuReport>;
}

export interface ComparisonReportSource {
  readonly job: RunRecord;
  readonly vendorRuns: readonly RunRecord[];
  readonly capturedArtifacts: readonly CapturedArtifactTableRecord[];
  readonly artifactScores: readonly ArtifactScoreTableRecord[];
  readonly primaryReport: FeishuReport | null;
}

export interface ComparisonReportSourcePort {
  findComparisonReportSource(
    jobId: string,
  ): Promise<ComparisonReportSource | null>;
  loadComparisonReportSource(jobId: string): Promise<ComparisonReportSource>;
  artifactPageEvidenceUrl(artifactId: string, pageNumber: number): string;
}

export interface FeishuProjectionPort
  extends EvaluationCaseTablePort,
    RunRecordTablePort,
    CapturedArtifactTablePort,
    ArtifactScoreTablePort,
    ComparisonTablePort,
    ProductGapCardTablePort,
    ReportDocumentPort,
    ComparisonReportSourcePort {
  readonly targetEnvironment: "test" | "production";
}

export interface FeishuProjectionSnapshot {
  readonly caseTable: readonly EvaluationCaseRecord[];
  readonly runRecordTable: readonly RunRecord[];
  readonly capturedArtifactTable: readonly CapturedArtifactTableRecord[];
  readonly artifactScoreTable: readonly ArtifactScoreTableRecord[];
  readonly productGapCardTable: readonly (
    | ComparisonRecord
    | ProductGapCardRecord
  )[];
  readonly reports: readonly FeishuReport[];
}

export interface InMemoryFeishuProjectionOptions {
  readonly targetEnvironment?: "test" | "production";
}

export class InMemoryFeishuProjection implements FeishuProjectionPort {
  readonly #caseTable: EvaluationCaseRecord[] = [];
  readonly #runRecordTable: RunRecord[] = [];
  readonly #capturedArtifactTable: CapturedArtifactTableRecord[] = [];
  readonly #artifactScoreTable: ArtifactScoreTableRecord[] = [];
  readonly #productGapCardTable: (ComparisonRecord | ProductGapCardRecord)[] =
    [];
  readonly #reports: FeishuReport[] = [];
  readonly targetEnvironment: "test" | "production";

  constructor(options: InMemoryFeishuProjectionOptions = {}) {
    this.targetEnvironment = options.targetEnvironment ?? "test";
  }

  #assertAllowed(origin: EnvironmentOrigin, entityName: string): void {
    assertEnvironmentOriginAllowed(origin, this.targetEnvironment, entityName);
  }

  async upsertCase(record: EvaluationCaseRecord): Promise<void> {
    this.#assertAllowed(record.environmentOrigin, "Evaluation Case");
    const existingIndex = this.#caseTable.findIndex(
      ({ recordId }) => recordId === record.recordId,
    );
    if (existingIndex === -1) {
      this.#caseTable.push(record);
      return;
    }
    this.#caseTable[existingIndex] = record;
  }

  async appendRunRecord(record: RunRecord): Promise<void> {
    this.#assertAllowed(record.environmentOrigin, "Run/Attempt");
    const existing = this.#runRecordTable.find(
      (candidate) => candidate.recordId === record.recordId,
    );
    if (existing !== undefined) {
      if (
        !isDeepStrictEqual(
          stableRunReplayPayload(existing),
          stableRunReplayPayload(record),
        )
      ) {
        throw new Error(`Run record identity conflict: ${record.recordId}`);
      }
      return;
    }
    this.#runRecordTable.push(record);
  }

  async linkReportToBakeoffJob(
    jobId: string,
    reportUrl: string,
    role: "primary" | "auxiliary" = "primary",
  ): Promise<void> {
    const parentIndex = this.#runRecordTable.findIndex(
      (record) => record.recordType === "bakeoff_job" && record.jobId === jobId,
    );
    const parentRecord = this.#runRecordTable[parentIndex];
    if (parentIndex === -1 || parentRecord === undefined) {
      throw new Error(`Bakeoff Job record not found: ${jobId}`);
    }
    this.#runRecordTable[parentIndex] = {
      ...parentRecord,
      ...(role === "primary"
        ? { reportUrl }
        : {
            auxiliaryReportUrls: [
              ...new Set([
                ...(parentRecord.auxiliaryReportUrls ?? []),
                reportUrl,
              ]),
            ],
          }),
    };
  }

  async appendArtifactScore(record: ArtifactScoreTableRecord): Promise<void> {
    this.#assertAllowed(record.environmentOrigin, "Artifact score projection");
    this.#assertAllowed(record.artifact.environmentOrigin, "Artifact");
    this.#assertAllowed(
      record.renderManifest.environmentOrigin,
      "Render manifest",
    );
    this.#assertAllowed(record.scorecard.environmentOrigin, "Evaluation");
    if (
      record.runId !== record.artifact.runId ||
      record.runId !== record.scorecard.runId ||
      record.artifactId !== record.artifact.artifactId ||
      record.artifactId !== record.scorecard.artifactId ||
      record.renderManifest.artifactId !== record.artifactId
    ) {
      throw new Error(
        "Artifact score projection contains inconsistent lineage",
      );
    }
    const existing = this.#artifactScoreTable.find(
      (candidate) => candidate.recordId === record.recordId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error(
          `Artifact Score identity conflict: ${record.recordId}`,
        );
      }
      return;
    }
    this.#artifactScoreTable.push(record);
  }

  async appendCapturedArtifact(
    record: CapturedArtifactTableRecord,
  ): Promise<void> {
    this.#assertAllowed(
      record.environmentOrigin,
      "Artifact capture projection",
    );
    this.#assertAllowed(record.artifact.environmentOrigin, "Artifact");
    this.#assertAllowed(
      record.renderManifest.environmentOrigin,
      "Render manifest",
    );
    if (
      record.runId !== record.artifact.runId ||
      record.artifactId !== record.artifact.artifactId ||
      record.renderManifest.artifactId !== record.artifactId
    ) {
      throw new Error(
        "Artifact capture projection contains inconsistent lineage",
      );
    }
    const existing = this.#capturedArtifactTable.find(
      (candidate) => candidate.recordId === record.recordId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error(
          `Captured Artifact identity conflict: ${record.recordId}`,
        );
      }
      return;
    }
    this.#capturedArtifactTable.push(record);
  }

  async appendComparison(record: ComparisonRecord): Promise<void> {
    this.#assertAllowed(record.environmentOrigin, "Comparison");
    const existing = this.#productGapCardTable.find(
      (candidate) =>
        candidate.recordType === "comparison" &&
        candidate.comparisonId === record.comparisonId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error(
          `Comparison identity conflict: ${record.comparisonId}`,
        );
      }
      return;
    }
    this.#productGapCardTable.push(record);
  }

  async appendProductGapCard(record: ProductGapCardRecord): Promise<void> {
    this.#assertAllowed(record.environmentOrigin, "Product gap comparison");
    const existing = this.#productGapCardTable.find(
      (candidate) =>
        candidate.recordType === "gap_card" &&
        candidate.gapCardId === record.gapCardId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error(`Gap Card identity conflict: ${record.gapCardId}`);
      }
      return;
    }
    this.#productGapCardTable.push(record);
  }

  async createReport(draft: FeishuReportDraft): Promise<FeishuReport> {
    this.#assertAllowed(draft.environmentOrigin, "Report");
    const report = {
      ...draft,
      url: `mock-feishu://documents/${draft.reportId}`,
    };
    const existing = this.#reports.find(
      (candidate) => candidate.reportId === report.reportId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, report)) {
        throw new Error(`Report identity conflict: ${report.reportId}`);
      }
      return structuredClone(existing);
    }
    this.#reports.push(report);
    return structuredClone(report);
  }

  async findComparisonReportSource(
    jobId: string,
  ): Promise<ComparisonReportSource | null> {
    const job = this.#runRecordTable.find(
      (record) =>
        record.recordType === "bakeoff_job" && record.jobId === jobId,
    );
    if (job === undefined) {
      return null;
    }
    const cloneRun = (record: RunRecord): RunRecord => ({
      ...structuredClone(record),
      environmentOrigin: record.environmentOrigin,
    });
    const primaryReport =
      job.reportUrl === null
        ? null
        : (this.#reports.find(({ url }) => url === job.reportUrl) ?? null);
    return {
      job: cloneRun(job),
      vendorRuns: this.#runRecordTable
        .filter(
          (record) =>
            record.recordType === "vendor_run" && record.jobId === jobId,
        )
        .map(cloneRun),
      capturedArtifacts: this.#capturedArtifactTable
        .filter((record) => record.jobId === jobId)
        .map((record) => ({
          ...structuredClone(record),
          environmentOrigin: record.environmentOrigin,
        })),
      artifactScores: this.#artifactScoreTable
        .filter((record) => record.jobId === jobId)
        .map((record) => ({
          ...structuredClone(record),
          environmentOrigin: record.environmentOrigin,
        })),
      primaryReport:
        primaryReport === null
          ? null
          : {
              ...structuredClone(primaryReport),
              environmentOrigin: primaryReport.environmentOrigin,
            },
    };
  }

  async loadComparisonReportSource(
    jobId: string,
  ): Promise<ComparisonReportSource> {
    const source = await this.findComparisonReportSource(jobId);
    if (source === null) {
      throw new Error(`Bakeoff Job record not found: ${jobId}`);
    }
    return source;
  }

  artifactPageEvidenceUrl(
    artifactId: string,
    pageNumber: number,
  ): string {
    const captured = this.#capturedArtifactTable.find(
      (record) => record.artifactId === artifactId,
    );
    if (
      captured === undefined ||
      pageNumber < 1 ||
      pageNumber > captured.artifact.pageCount
    ) {
      throw new Error(
        `Artifact page evidence not found: ${artifactId}#${pageNumber}`,
      );
    }
    return `mock-feishu://artifacts/${encodeURIComponent(
      artifactId,
    )}/pages/${pageNumber}`;
  }

  snapshot(): FeishuProjectionSnapshot {
    return {
      caseTable: structuredClone(this.#caseTable),
      runRecordTable: structuredClone(this.#runRecordTable),
      capturedArtifactTable: structuredClone(this.#capturedArtifactTable),
      artifactScoreTable: structuredClone(this.#artifactScoreTable),
      productGapCardTable: structuredClone(this.#productGapCardTable),
      reports: structuredClone(this.#reports),
    };
  }
}
