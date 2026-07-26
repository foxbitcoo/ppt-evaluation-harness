import type {
  ArtifactScorecard,
  ArtifactScoreTableRecord,
  EvaluationCaseRecord,
  FeishuReport,
  FeishuReportDraft,
  ProductGapCardRecord,
  RunRecord,
} from "./domain.ts";

export interface EvaluationCaseTablePort {
  upsertCase(record: EvaluationCaseRecord): Promise<void>;
}

export interface RunRecordTablePort {
  appendRunRecord(record: RunRecord): Promise<void>;
  linkReportToBakeoffJob(jobId: string, reportUrl: string): Promise<void>;
}

export interface ArtifactScoreTablePort {
  appendArtifactScore(record: ArtifactScoreTableRecord): Promise<void>;
}

export interface ProductGapCardTablePort {
  appendProductGapCard(record: ProductGapCardRecord): Promise<void>;
}

export interface ReportDocumentPort {
  createReport(draft: FeishuReportDraft): Promise<FeishuReport>;
}

export interface FeishuProjectionPort
  extends EvaluationCaseTablePort,
    RunRecordTablePort,
    ArtifactScoreTablePort,
    ProductGapCardTablePort,
    ReportDocumentPort {}

export interface FeishuProjectionSnapshot {
  readonly caseTable: readonly EvaluationCaseRecord[];
  readonly runRecordTable: readonly RunRecord[];
  readonly artifactScoreTable: readonly ArtifactScoreTableRecord[];
  readonly productGapCardTable: readonly ProductGapCardRecord[];
  readonly reports: readonly FeishuReport[];
}

export class InMemoryFeishuProjection implements FeishuProjectionPort {
  readonly #caseTable: EvaluationCaseRecord[] = [];
  readonly #runRecordTable: RunRecord[] = [];
  readonly #artifactScoreTable: ArtifactScoreTableRecord[] = [];
  readonly #productGapCardTable: ProductGapCardRecord[] = [];
  readonly #reports: FeishuReport[] = [];

  async upsertCase(record: EvaluationCaseRecord): Promise<void> {
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
    this.#runRecordTable.push(record);
  }

  async linkReportToBakeoffJob(
    jobId: string,
    reportUrl: string,
  ): Promise<void> {
    const parentIndex = this.#runRecordTable.findIndex(
      (record) =>
        record.recordType === "bakeoff_job" && record.jobId === jobId,
    );
    const parentRecord = this.#runRecordTable[parentIndex];
    if (parentIndex === -1 || parentRecord === undefined) {
      throw new Error(`Bakeoff Job record not found: ${jobId}`);
    }
    this.#runRecordTable[parentIndex] = {
      ...parentRecord,
      reportUrl,
    };
  }

  async appendArtifactScore(record: ArtifactScoreTableRecord): Promise<void> {
    this.#artifactScoreTable.push(record);
  }

  async appendProductGapCard(record: ProductGapCardRecord): Promise<void> {
    this.#productGapCardTable.push(record);
  }

  async createReport(draft: FeishuReportDraft): Promise<FeishuReport> {
    const report = {
      ...draft,
      url: `mock-feishu://documents/${draft.reportId}`,
    };
    this.#reports.push(report);
    return structuredClone(report);
  }

  snapshot(): FeishuProjectionSnapshot {
    return {
      caseTable: structuredClone(this.#caseTable),
      runRecordTable: structuredClone(this.#runRecordTable),
      artifactScoreTable: structuredClone(this.#artifactScoreTable),
      productGapCardTable: structuredClone(this.#productGapCardTable),
      reports: structuredClone(this.#reports),
    };
  }
}
