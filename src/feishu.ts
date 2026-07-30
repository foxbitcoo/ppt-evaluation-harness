import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  AdjudicationEventRecord,
  ArtifactScorecard,
  ArtifactScoreTableRecord,
  CapturedArtifactTableRecord,
  ComparisonRecord,
  EvaluationCaseRecord,
  FeishuReport,
  FeishuReportDraft,
  GitHubIssueDeliveryReservationRecord,
  GitHubIssueLinkEventRecord,
  ProductGapCardRecord,
  ProductGapCardWorkflowEventRecord,
  ReviewEventRecord,
  RunRecord,
} from "./domain.ts";
import {
  assertEnvironmentOriginAllowed,
  type EnvironmentOrigin,
} from "./environment-origin.ts";
import {
  assertApprovedEgressAuthorizationCurrent,
  SYSTEM_CLOCK,
  type ApprovedEgressAuthorization,
  type ClockPort,
  type EgressDestinationMetadata,
} from "./egress-authorization.ts";

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

function snapshotHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function cloneProjectionValue<T>(value: T): T {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneProjectionValue(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "environmentOrigin"
          ? entry
          : cloneProjectionValue(entry),
      ]),
    ) as T;
  }
  return value;
}

function stableRunReplayPayload(record: RunRecord): unknown {
  const {
    reportUrl: _reportUrl,
    auxiliaryReportUrls: _auxiliaryReportUrls,
    ...stable
  } = record;
  return stable;
}

function stableReportReplayPayload(report: FeishuReport): unknown {
  const { url: _url, ...stable } = report;
  return stable;
}

function cloneWithEnvironmentOrigin<
  T extends { readonly environmentOrigin: EnvironmentOrigin },
>(record: T): T {
  return {
    ...structuredClone(record),
    environmentOrigin: record.environmentOrigin,
  };
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

export interface AdjudicationEventTablePort {
  appendAdjudicationEvent(record: AdjudicationEventRecord): Promise<void>;
  listAdjudicationEvents(
    scorecardId: string,
  ): Promise<readonly AdjudicationEventRecord[]>;
  loadArtifactScoreByScorecardId(
    scorecardId: string,
  ): Promise<ArtifactScoreTableRecord>;
}

export interface ReviewEventTablePort {
  appendReviewEvent(record: ReviewEventRecord): Promise<void>;
  listReviewEvents(
    scorecardId: string,
  ): Promise<readonly ReviewEventRecord[]>;
}

export interface CapturedArtifactTablePort {
  appendCapturedArtifact(record: CapturedArtifactTableRecord): Promise<void>;
}

export interface ProductGapCardTablePort {
  appendProductGapCard(record: ProductGapCardRecord): Promise<void>;
}

export interface ProductGapCardWorkflowTablePort {
  loadProductGapCard(gapCardId: string): Promise<ProductGapCardRecord>;
  appendProductGapCardWorkflowEvent(
    record: ProductGapCardWorkflowEventRecord,
  ): Promise<void>;
  listProductGapCardWorkflowEvents(
    gapCardId: string,
  ): Promise<readonly ProductGapCardWorkflowEventRecord[]>;
  /**
   * Atomically creates or returns the unique reservation for a Gap Card.
   */
  reserveGitHubIssueDelivery(
    record: GitHubIssueDeliveryReservationRecord,
  ): Promise<GitHubIssueDeliveryReservationRecord>;
  loadGitHubIssueDeliveryReservation(
    gapCardId: string,
  ): Promise<GitHubIssueDeliveryReservationRecord | null>;
  appendGitHubIssueLinkEvent(
    record: GitHubIssueLinkEventRecord,
  ): Promise<void>;
  listGitHubIssueLinkEvents(
    gapCardId: string,
  ): Promise<readonly GitHubIssueLinkEventRecord[]>;
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
    AdjudicationEventTablePort,
    ReviewEventTablePort,
    ComparisonTablePort,
    ProductGapCardTablePort,
    ProductGapCardWorkflowTablePort,
    ReportDocumentPort,
    ComparisonReportSourcePort {
  readonly targetEnvironment: "test" | "production";
  readonly egressDestination: EgressDestinationMetadata;
  commitAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
    authorization: ApprovedEgressAuthorization,
  ): Promise<void>;
  forkForStaging(): FeishuProjectionPort;
  snapshot(): FeishuProjectionSnapshot;
  scrubPayloadsForJob(jobId: string): Promise<void>;
  hasPayloadsForJob(jobId: string): Promise<boolean>;
}

export interface FeishuProjectionSnapshot {
  readonly caseTable: readonly EvaluationCaseRecord[];
  readonly runRecordTable: readonly RunRecord[];
  readonly capturedArtifactTable: readonly CapturedArtifactTableRecord[];
  readonly artifactScoreTable: readonly ArtifactScoreTableRecord[];
  readonly adjudicationEventTable: readonly AdjudicationEventRecord[];
  readonly reviewEventTable: readonly ReviewEventRecord[];
  readonly gapCardWorkflowEventTable: readonly ProductGapCardWorkflowEventRecord[];
  readonly githubIssueDeliveryReservationTable: readonly GitHubIssueDeliveryReservationRecord[];
  readonly githubIssueLinkEventTable: readonly GitHubIssueLinkEventRecord[];
  readonly productGapCardTable: readonly (
    | ComparisonRecord
    | ProductGapCardRecord
  )[];
  readonly reports: readonly FeishuReport[];
}

export interface InMemoryFeishuProjectionOptions {
  readonly targetEnvironment?: "test" | "production";
  readonly egressDestination?: EgressDestinationMetadata;
  readonly clock?: ClockPort;
}

export class InMemoryFeishuProjection implements FeishuProjectionPort {
  readonly #caseTable: EvaluationCaseRecord[] = [];
  readonly #runRecordTable: RunRecord[] = [];
  readonly #capturedArtifactTable: CapturedArtifactTableRecord[] = [];
  readonly #artifactScoreTable: ArtifactScoreTableRecord[] = [];
  readonly #adjudicationEventTable: AdjudicationEventRecord[] = [];
  readonly #reviewEventTable: ReviewEventRecord[] = [];
  readonly #gapCardWorkflowEventTable: ProductGapCardWorkflowEventRecord[] =
    [];
  readonly #githubIssueDeliveryReservationTable: GitHubIssueDeliveryReservationRecord[] =
    [];
  readonly #githubIssueLinkEventTable: GitHubIssueLinkEventRecord[] = [];
  readonly #productGapCardTable: (ComparisonRecord | ProductGapCardRecord)[] =
    [];
  readonly #reports: FeishuReport[] = [];
  readonly #expiredJobIds = new Set<string>();
  readonly #expiredCaseIds = new Set<string>();
  readonly #expiredJobCaseIds = new Map<string, Set<string>>();
  #projectionTail: Promise<void> = Promise.resolve();
  #mutationVersion = 0;
  readonly #clock: ClockPort;
  readonly targetEnvironment: "test" | "production";
  readonly egressDestination: EgressDestinationMetadata;

  constructor(options: InMemoryFeishuProjectionOptions = {}) {
    this.targetEnvironment = options.targetEnvironment ?? "test";
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.egressDestination = Object.freeze(
      structuredClone(
        options.egressDestination ?? {
          targetService: "in-memory-feishu-operational-ledger",
          targetAccount: "in-memory-feishu-test-project",
          targetRegion: this.targetEnvironment,
          subprocessors: [],
        },
      ),
    );
  }

  protected async materializeAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
    _authorization: ApprovedEgressAuthorization,
  ): Promise<FeishuProjectionSnapshot> {
    return snapshot;
  }

  forkForStaging(): FeishuProjectionPort {
    const staging = new InMemoryFeishuProjection({
      targetEnvironment: this.targetEnvironment,
      egressDestination: this.egressDestination,
      clock: this.#clock,
    });
    staging.#replaceSnapshot(this.snapshot());
    return staging;
  }

  #assertAllowed(origin: EnvironmentOrigin, entityName: string): void {
    assertEnvironmentOriginAllowed(origin, this.targetEnvironment, entityName);
  }

  #assertJobActive(jobId: string): void {
    if (this.#expiredJobIds.has(jobId)) {
      throw new Error(
        `Tombstoned Job ${jobId} blocked Feishu projection write`,
      );
    }
  }

  async #runProjectionExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#projectionTail;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#projectionTail = tail;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async upsertCase(record: EvaluationCaseRecord): Promise<void> {
    if (
      this.#expiredCaseIds.has(record.caseId) &&
      !this.#runRecordTable.some(
        ({ caseId }) => caseId === record.caseId,
      )
    ) {
      throw new Error(
        `Tombstoned Case ${record.caseId} blocked Feishu projection write`,
      );
    }
    this.#assertAllowed(record.environmentOrigin, "Evaluation Case");
    const existingIndex = this.#caseTable.findIndex(
      ({ recordId }) => recordId === record.recordId,
    );
    if (existingIndex === -1) {
      this.#caseTable.push(record);
      this.#mutationVersion += 1;
      return;
    }
    this.#caseTable[existingIndex] = record;
    this.#mutationVersion += 1;
  }

  async appendRunRecord(record: RunRecord): Promise<void> {
    this.#assertJobActive(record.jobId);
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
    this.#mutationVersion += 1;
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
    this.#mutationVersion += 1;
  }

  async appendArtifactScore(record: ArtifactScoreTableRecord): Promise<void> {
    this.#assertJobActive(record.jobId);
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
    this.#mutationVersion += 1;
  }

  async appendAdjudicationEvent(
    record: AdjudicationEventRecord,
  ): Promise<void> {
    this.#assertJobActive(record.jobId);
    this.#assertAllowed(record.environmentOrigin, "Adjudication Event");
    const existing = this.#adjudicationEventTable.find(
      ({ adjudicationEventId }) =>
        adjudicationEventId === record.adjudicationEventId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error(
          `Adjudication Event identity conflict: ${record.adjudicationEventId}`,
        );
      }
      return;
    }
    const score = this.#artifactScoreTable.find(
      ({ scorecard }) => scorecard.scorecardId === record.scorecardId,
    );
    const dimension = score?.scorecard.dimensions.find(
      (candidate) => candidate.dimension === record.dimension,
    );
    if (
      score === undefined ||
      dimension === undefined ||
      score.artifactId !== record.artifactId ||
      score.runId !== record.runId ||
      score.jobId !== record.jobId ||
      score.provenance !== record.provenance ||
      score.environmentOrigin !== record.environmentOrigin ||
      dimension.assessmentStatus !==
        record.modelOriginalAssessmentStatus ||
      dimension.value !== record.modelOriginalScore ||
      dimension.assessmentStatus !== "ASSESSED" ||
      dimension.value === null ||
      record.evidencePages.length === 0 ||
      new Set(record.evidencePages).size !==
        record.evidencePages.length ||
      record.evidencePages.some(
        (pageNumber) =>
          !Number.isInteger(pageNumber) ||
          pageNumber < 1 ||
          pageNumber > score.artifact.pageCount,
      )
    ) {
      throw new Error(
        "Adjudication Event contains inconsistent model-score lineage",
      );
    }
    const priorEvents = this.#adjudicationEventTable.filter(
      (event) =>
        event.scorecardId === record.scorecardId &&
        event.dimension === record.dimension,
    );
    const expectedPrior =
      priorEvents[priorEvents.length - 1]?.adjudicationEventId ?? null;
    if (record.priorAdjudicationEventId !== expectedPrior) {
      throw new Error(
        `Adjudication Event prior reference conflict: expected ${
          expectedPrior ?? "null"
        }`,
      );
    }
    this.#adjudicationEventTable.push(
      cloneWithEnvironmentOrigin(record),
    );
    this.#mutationVersion += 1;
  }

  async listAdjudicationEvents(
    scorecardId: string,
  ): Promise<readonly AdjudicationEventRecord[]> {
    return structuredClone(
      this.#adjudicationEventTable.filter(
        (event) => event.scorecardId === scorecardId,
      ),
    );
  }

  async appendReviewEvent(record: ReviewEventRecord): Promise<void> {
    this.#assertJobActive(record.jobId);
    this.#assertAllowed(record.environmentOrigin, "Review Event");
    const existing = this.#reviewEventTable.find(
      ({ reviewEventId }) => reviewEventId === record.reviewEventId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error(
          `Review Event identity conflict: ${record.reviewEventId}`,
        );
      }
      return;
    }
    const score = this.#artifactScoreTable.find(
      ({ scorecard }) => scorecard.scorecardId === record.scorecardId,
    );
    const scoreDimensions = new Set(
      score?.scorecard.dimensions.map(({ dimension }) => dimension) ?? [],
    );
    if (
      score === undefined ||
      score.artifactId !== record.artifactId ||
      score.runId !== record.runId ||
      score.jobId !== record.jobId ||
      score.provenance !== record.provenance ||
      score.environmentOrigin !== record.environmentOrigin ||
      record.reviewedDimensions.length === 0 ||
      new Set(record.reviewedDimensions).size !==
        record.reviewedDimensions.length ||
      record.reviewedDimensions.some(
        (dimension) => !scoreDimensions.has(dimension),
      )
    ) {
      throw new Error("Review Event contains inconsistent score lineage");
    }
    const expectedPrior =
      this.#reviewEventTable.filter(
        (event) => event.scorecardId === record.scorecardId,
      ).at(-1)?.reviewEventId ?? null;
    if (record.priorReviewEventId !== expectedPrior) {
      throw new Error(
        `Review Event prior reference conflict: expected ${
          expectedPrior ?? "null"
        }`,
      );
    }
    this.#reviewEventTable.push(cloneWithEnvironmentOrigin(record));
    this.#mutationVersion += 1;
  }

  async listReviewEvents(
    scorecardId: string,
  ): Promise<readonly ReviewEventRecord[]> {
    return structuredClone(
      this.#reviewEventTable.filter(
        (event) => event.scorecardId === scorecardId,
      ),
    );
  }

  async loadArtifactScoreByScorecardId(
    scorecardId: string,
  ): Promise<ArtifactScoreTableRecord> {
    const score = this.#artifactScoreTable.find(
      ({ scorecard }) => scorecard.scorecardId === scorecardId,
    );
    if (score === undefined) {
      throw new Error(`Artifact Scorecard not found: ${scorecardId}`);
    }
    return {
      ...structuredClone(score),
      environmentOrigin: score.environmentOrigin,
    };
  }

  async appendCapturedArtifact(
    record: CapturedArtifactTableRecord,
  ): Promise<void> {
    this.#assertJobActive(record.jobId);
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
    this.#mutationVersion += 1;
  }

  async appendComparison(record: ComparisonRecord): Promise<void> {
    this.#assertJobActive(record.jobId);
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
    this.#mutationVersion += 1;
  }

  async appendProductGapCard(record: ProductGapCardRecord): Promise<void> {
    this.#assertJobActive(record.jobId);
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
    this.#mutationVersion += 1;
  }

  async loadProductGapCard(
    gapCardId: string,
  ): Promise<ProductGapCardRecord> {
    const card = this.#productGapCardTable.find(
      (record): record is ProductGapCardRecord =>
        record.recordType === "gap_card" &&
        record.gapCardId === gapCardId,
    );
    if (card === undefined) {
      throw new Error(`Product Gap Card not found: ${gapCardId}`);
    }
    return {
      ...structuredClone(card),
      environmentOrigin: card.environmentOrigin,
    };
  }

  async appendProductGapCardWorkflowEvent(
    record: ProductGapCardWorkflowEventRecord,
  ): Promise<void> {
    this.#assertAllowed(
      record.environmentOrigin,
      "Product Gap Card workflow event",
    );
    const existing = this.#gapCardWorkflowEventTable.find(
      ({ workflowEventId }) =>
        workflowEventId === record.workflowEventId,
    );
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error(
          `Product Gap Card workflow event identity conflict: ${record.workflowEventId}`,
        );
      }
      return;
    }
    const card = await this.loadProductGapCard(record.gapCardId);
    this.#assertJobActive(card.jobId);
    if (
      card.provenance !== record.provenance ||
      card.environmentOrigin !== record.environmentOrigin
    ) {
      throw new Error(
        "Product Gap Card workflow event contains inconsistent lineage",
      );
    }
    if (
      this.#githubIssueLinkEventTable.some(
        (event) => event.gapCardId === record.gapCardId,
      )
    ) {
      throw new Error(
        "Product Gap Card workflow is immutable after GitHub Issue delivery",
      );
    }
    const priorEvents = this.#gapCardWorkflowEventTable.filter(
      (event) => event.gapCardId === record.gapCardId,
    );
    const expectedPrior =
      priorEvents.at(-1)?.workflowEventId ?? null;
    if (record.priorWorkflowEventId !== expectedPrior) {
      throw new Error(
        `Product Gap Card workflow prior reference conflict: expected ${
          expectedPrior ?? "null"
        }`,
      );
    }
    if (priorEvents.length > 0) {
      throw new Error(
        "Product Gap Card already has a terminal workflow decision",
      );
    }
    this.#gapCardWorkflowEventTable.push(
      cloneWithEnvironmentOrigin(record),
    );
    this.#mutationVersion += 1;
  }

  async listProductGapCardWorkflowEvents(
    gapCardId: string,
  ): Promise<readonly ProductGapCardWorkflowEventRecord[]> {
    return structuredClone(
      this.#gapCardWorkflowEventTable.filter(
        (event) => event.gapCardId === gapCardId,
      ),
    );
  }

  async reserveGitHubIssueDelivery(
    record: GitHubIssueDeliveryReservationRecord,
  ): Promise<GitHubIssueDeliveryReservationRecord> {
    this.#assertAllowed(
      record.environmentOrigin,
      "GitHub Issue delivery reservation",
    );
    const card = await this.loadProductGapCard(record.gapCardId);
    this.#assertJobActive(card.jobId);
    const existing =
      this.#githubIssueDeliveryReservationTable.find(
        (reservation) =>
          reservation.gapCardId === record.gapCardId ||
          reservation.reservationId === record.reservationId,
      );
    if (existing !== undefined) {
      if (
        existing.gapCardId !== record.gapCardId ||
        existing.reservationId !== record.reservationId ||
        existing.idempotencyKey !== record.idempotencyKey ||
        existing.confirmedByWorkflowEventId !==
          record.confirmedByWorkflowEventId
      ) {
        throw new Error(
          `GitHub Issue delivery reservation conflict: ${record.gapCardId}`,
        );
      }
      return {
        ...structuredClone(existing),
        environmentOrigin: existing.environmentOrigin,
      };
    }
    const confirmation = this.#gapCardWorkflowEventTable.find(
      (event) =>
        event.workflowEventId ===
          record.confirmedByWorkflowEventId &&
        event.gapCardId === record.gapCardId &&
        event.decision === "confirmed_for_delivery",
    );
    if (
      confirmation === undefined ||
      card.provenance !== record.provenance ||
      card.environmentOrigin !== record.environmentOrigin
    ) {
      throw new Error(
        "GitHub Issue delivery reservation requires a matching confirmed Product Gap Card",
      );
    }
    const stored = cloneWithEnvironmentOrigin(record);
    this.#githubIssueDeliveryReservationTable.push(stored);
    this.#mutationVersion += 1;
    return {
      ...structuredClone(stored),
      environmentOrigin: stored.environmentOrigin,
    };
  }

  async loadGitHubIssueDeliveryReservation(
    gapCardId: string,
  ): Promise<GitHubIssueDeliveryReservationRecord | null> {
    const reservation =
      this.#githubIssueDeliveryReservationTable.find(
        (candidate) => candidate.gapCardId === gapCardId,
      );
    return reservation === undefined
      ? null
      : {
          ...structuredClone(reservation),
          environmentOrigin: reservation.environmentOrigin,
        };
  }

  async appendGitHubIssueLinkEvent(
    record: GitHubIssueLinkEventRecord,
  ): Promise<void> {
    this.#assertAllowed(
      record.environmentOrigin,
      "GitHub Issue link event",
    );
    const existingById = this.#githubIssueLinkEventTable.find(
      ({ linkEventId }) => linkEventId === record.linkEventId,
    );
    if (existingById !== undefined) {
      if (!isDeepStrictEqual(existingById, record)) {
        throw new Error(
          `GitHub Issue link event identity conflict: ${record.linkEventId}`,
        );
      }
      return;
    }
    const existingForCard = this.#githubIssueLinkEventTable.find(
      (event) => event.gapCardId === record.gapCardId,
    );
    if (existingForCard !== undefined) {
      if (!isDeepStrictEqual(existingForCard, record)) {
        throw new Error(
          `Product Gap Card GitHub linkage conflict: ${record.gapCardId}`,
        );
      }
      return;
    }
    const card = await this.loadProductGapCard(record.gapCardId);
    this.#assertJobActive(card.jobId);
    const concurrentExisting = this.#githubIssueLinkEventTable.find(
      (event) =>
        event.linkEventId === record.linkEventId ||
        event.gapCardId === record.gapCardId,
    );
    if (concurrentExisting !== undefined) {
      if (!isDeepStrictEqual(concurrentExisting, record)) {
        throw new Error(
          `Product Gap Card GitHub linkage conflict: ${record.gapCardId}`,
        );
      }
      return;
    }
    const confirmation = this.#gapCardWorkflowEventTable.find(
      (event) =>
        event.workflowEventId ===
          record.confirmedByWorkflowEventId &&
        event.gapCardId === record.gapCardId &&
        event.decision === "confirmed_for_delivery",
    );
    const reservation =
      this.#githubIssueDeliveryReservationTable.find(
        (candidate) =>
          candidate.gapCardId === record.gapCardId &&
          candidate.idempotencyKey === record.idempotencyKey &&
          candidate.confirmedByWorkflowEventId ===
            record.confirmedByWorkflowEventId,
      );
    if (
      confirmation === undefined ||
      reservation === undefined ||
      card.provenance !== record.provenance ||
      card.environmentOrigin !== record.environmentOrigin
    ) {
      throw new Error(
        "GitHub Issue link requires a matching confirmed Product Gap Card",
      );
    }
    this.#githubIssueLinkEventTable.push(
      cloneWithEnvironmentOrigin(record),
    );
    this.#mutationVersion += 1;
  }

  async listGitHubIssueLinkEvents(
    gapCardId: string,
  ): Promise<readonly GitHubIssueLinkEventRecord[]> {
    return structuredClone(
      this.#githubIssueLinkEventTable.filter(
        (event) => event.gapCardId === gapCardId,
      ),
    );
  }

  async createReport(draft: FeishuReportDraft): Promise<FeishuReport> {
    this.#assertJobActive(draft.jobId);
    this.#assertAllowed(draft.environmentOrigin, "Report");
    const suppliedUrl = (draft as FeishuReport).url;
    const report = {
      ...draft,
      url:
        typeof suppliedUrl === "string" &&
        /^https:\/\/[^/\s]+\/.+/.test(suppliedUrl)
          ? suppliedUrl
          : `mock-feishu://documents/${draft.reportId}`,
    };
    const existing = this.#reports.find(
      (candidate) => candidate.reportId === report.reportId,
    );
    if (existing !== undefined) {
      if (
        !isDeepStrictEqual(
          stableReportReplayPayload(existing),
          stableReportReplayPayload(report),
        )
      ) {
        throw new Error(`Report identity conflict: ${report.reportId}`);
      }
      return structuredClone(existing);
    }
    this.#reports.push(report);
    this.#mutationVersion += 1;
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
      caseTable: cloneProjectionValue(this.#caseTable),
      runRecordTable: cloneProjectionValue(this.#runRecordTable),
      capturedArtifactTable: cloneProjectionValue(this.#capturedArtifactTable),
      artifactScoreTable: cloneProjectionValue(this.#artifactScoreTable),
      adjudicationEventTable: cloneProjectionValue(
        this.#adjudicationEventTable,
      ),
      reviewEventTable: cloneProjectionValue(this.#reviewEventTable),
      gapCardWorkflowEventTable: cloneProjectionValue(
        this.#gapCardWorkflowEventTable,
      ),
      githubIssueDeliveryReservationTable: cloneProjectionValue(
        this.#githubIssueDeliveryReservationTable,
      ),
      githubIssueLinkEventTable: cloneProjectionValue(
        this.#githubIssueLinkEventTable,
      ),
      productGapCardTable: cloneProjectionValue(this.#productGapCardTable),
      reports: cloneProjectionValue(this.#reports),
    };
  }

  async commitAuthorizedSnapshot(
    snapshot: FeishuProjectionSnapshot,
    authorization: ApprovedEgressAuthorization,
  ): Promise<void> {
    const batchJobIds = new Set([
      ...snapshot.runRecordTable.map(({ jobId }) => jobId),
      ...snapshot.capturedArtifactTable.map(({ jobId }) => jobId),
      ...snapshot.artifactScoreTable.map(({ jobId }) => jobId),
      ...snapshot.adjudicationEventTable.map(({ jobId }) => jobId),
      ...snapshot.reviewEventTable.map(({ jobId }) => jobId),
      ...snapshot.productGapCardTable.map(({ jobId }) => jobId),
      ...snapshot.reports.map(({ jobId }) => jobId),
    ]);
    if (batchJobIds.size !== 1) {
      throw new Error(
        "Operational ledger projection batch must contain exactly one Job",
      );
    }
    const jobId = [...batchJobIds][0];
    if (jobId === undefined) {
      throw new Error("Operational ledger projection batch is empty");
    }
    return this.#runProjectionExclusive(async () => {
      this.#assertJobActive(jobId);
      const job = snapshot.runRecordTable.find(
        (record) =>
          record.recordType === "bakeoff_job" &&
          record.jobId === jobId,
      );
      const evaluationCase = snapshot.caseTable.find(
        ({ caseId }) => caseId === job?.caseId,
      );
      const batchGapCards = new Map(
        snapshot.productGapCardTable.flatMap((record) =>
          record.recordType === "gap_card"
            ? [[record.gapCardId, record] as const]
            : [],
        ),
      );
      const joblessGapCardRows = [
        ...snapshot.gapCardWorkflowEventTable,
        ...snapshot.githubIssueDeliveryReservationTable,
        ...snapshot.githubIssueLinkEventTable,
      ];
      const payloadHash = snapshotHash(snapshot);
      const expectedContentFields = [
        "case_table",
        "run_record_table",
        "captured_artifact_table",
        "artifact_score_table",
        "adjudication_event_table",
        "review_event_table",
        "gap_card_workflow_event_table",
        "github_issue_delivery_reservation_table",
        "github_issue_link_event_table",
        "comparison_and_product_gap_card_table",
        "reports",
      ];
      if (
        job === undefined ||
        evaluationCase === undefined ||
        snapshot.caseTable.length !== 1 ||
        snapshot.caseTable.some(
          ({ caseId }) => caseId !== job.caseId,
        ) ||
        snapshot.runRecordTable.some(
          ({ caseId }) => caseId !== job.caseId,
        ) ||
        joblessGapCardRows.some(
          ({ gapCardId }) =>
            batchGapCards.get(gapCardId)?.jobId !== jobId,
        ) ||
        !isDeepStrictEqual(authorization.request, {
          requestId: `operational-ledger-projection:${jobId}:${payloadHash}`,
          jobId,
          runId: null,
          attemptId: null,
          dataClassification: evaluationCase.dataClassification,
          sourceOwner: evaluationCase.sourceOwner,
          processingPurpose: "operational_ledger_projection_storage",
          targetKind: "storage",
          targetService: this.egressDestination.targetService,
          targetAccount: this.egressDestination.targetAccount,
          targetRegion: this.egressDestination.targetRegion,
          subprocessors: this.egressDestination.subprocessors,
          contentFields: expectedContentFields,
          payloadHash,
          requiredRedactions: [],
          requestedAt: authorization.request.requestedAt,
        })
      ) {
        throw new Error(
          "Operational ledger projection authorization mismatch",
        );
      }
      assertApprovedEgressAuthorizationCurrent(
        authorization,
        this.#clock,
      );
      const materializedSnapshot =
        await this.materializeAuthorizedSnapshot(
          snapshot,
          authorization,
        );
      const stableMaterializationView = (
        candidate: FeishuProjectionSnapshot,
      ) => {
        const normalizePageEvidenceInMarkdown = (markdown: string) =>
          markdown.replace(
            /(\]\()([^) \n]+)(\))/g,
            "$1<page-evidence-url>$3",
          );
        return {
          ...candidate,
          runRecordTable: candidate.runRecordTable.map((record) => ({
            ...record,
            reportUrl:
              record.reportUrl === null ? null : "<report-url>",
            auxiliaryReportUrls:
              record.auxiliaryReportUrls === null
                ? null
                : record.auxiliaryReportUrls.map(() => "<report-url>"),
          })),
          productGapCardTable: candidate.productGapCardTable.map(
            (record) =>
              record.recordType === "comparison"
                ? record
                : {
                    ...record,
                    leftEvidence: {
                      ...record.leftEvidence,
                      links: record.leftEvidence.links.map((link) => ({
                        ...link,
                        url: "<page-evidence-url>",
                      })),
                    },
                    rightEvidence: {
                      ...record.rightEvidence,
                      links: record.rightEvidence.links.map((link) => ({
                        ...link,
                        url: "<page-evidence-url>",
                      })),
                    },
                  },
          ),
          reports: candidate.reports.map((report) => ({
            ...report,
            url: "<report-url>",
            markdown: normalizePageEvidenceInMarkdown(report.markdown),
          })),
        };
      };
      const materializedPageEvidenceUrls =
        materializedSnapshot.productGapCardTable.flatMap((record) =>
          record.recordType === "gap_card"
            ? [
                ...record.leftEvidence.links.map(({ url }) => url),
                ...record.rightEvidence.links.map(({ url }) => url),
              ]
            : [],
        );
      const originalPageEvidenceUrls =
        snapshot.productGapCardTable.flatMap((record) =>
          record.recordType === "gap_card"
            ? [
                ...record.leftEvidence.links.map(({ url }) => url),
                ...record.rightEvidence.links.map(({ url }) => url),
              ]
            : [],
        );
      const markdownLinks = (candidate: FeishuProjectionSnapshot) =>
        candidate.reports.flatMap(({ markdown }) =>
          [...markdown.matchAll(/\]\(([^) \n]+)\)/g)].map(
            (match) => match[1]!,
          ),
        );
      const originalMarkdownLinks = markdownLinks(snapshot);
      const materializedMarkdownLinks =
        markdownLinks(materializedSnapshot);
      if (
        !isDeepStrictEqual(
          stableMaterializationView(snapshot),
          stableMaterializationView(materializedSnapshot),
        ) ||
        materializedSnapshot.reports.some(
          ({ reportId, url }) =>
            snapshot.reports.find(
              (candidate) => candidate.reportId === reportId,
            )?.url !== url &&
            !/^https:\/\/[^/\s]+\/.+/.test(url),
        ) ||
        materializedPageEvidenceUrls.some(
          (url, index) =>
            url !== originalPageEvidenceUrls[index] &&
            !/^https:\/\/[^/\s]+\/.+/.test(url),
        ) ||
        materializedMarkdownLinks.some(
          (url, index) =>
            url !== originalMarkdownLinks[index] &&
            !/^https:\/\/[^/\s]+\/.+/.test(url),
        )
      ) {
        throw new Error(
          "Operational ledger materialization may change only report and page-evidence URLs to HTTPS evidence",
        );
      }
      while (true) {
        const observedMutationVersion = this.#mutationVersion;
        const working = new InMemoryFeishuProjection({
          targetEnvironment: this.targetEnvironment,
          egressDestination: this.egressDestination,
        });
        working.#replaceSnapshot(this.snapshot());
        const productGapIdentity = (
          record: FeishuProjectionSnapshot["productGapCardTable"][number],
        ) =>
          record.recordType === "comparison"
            ? record.comparisonId
            : record.gapCardId;
        const materializedProductGapIds = new Set(
          materializedSnapshot.productGapCardTable.map(
            productGapIdentity,
          ),
        );
        const materializedReportIds = new Set(
          materializedSnapshot.reports.map(({ reportId }) => reportId),
        );
        const materializedRunRecordIds = new Set(
          materializedSnapshot.runRecordTable.map(
            ({ recordId }) => recordId,
          ),
        );
        const currentBeforeMaterialization = working.snapshot();
        for (const current of currentBeforeMaterialization.runRecordTable) {
          if (!materializedRunRecordIds.has(current.recordId)) continue;
          const staged = snapshot.runRecordTable.find(
            ({ recordId }) => recordId === current.recordId,
          );
          if (
            staged === undefined ||
            !isDeepStrictEqual(
              stableRunReplayPayload(current),
              stableRunReplayPayload(staged),
            )
          ) {
            throw new Error(
              "Operational ledger materialization detected a concurrent Run mutation",
            );
          }
        }
        for (const current of currentBeforeMaterialization.productGapCardTable) {
          if (!materializedProductGapIds.has(productGapIdentity(current))) {
            continue;
          }
          const staged = snapshot.productGapCardTable.find(
            (candidate) =>
              productGapIdentity(candidate) ===
              productGapIdentity(current),
          );
          const rematerialized =
            materializedSnapshot.productGapCardTable.find(
              (candidate) =>
                productGapIdentity(candidate) ===
                productGapIdentity(current),
            );
          if (
            staged === undefined ||
            (!isDeepStrictEqual(current, staged) &&
              !isDeepStrictEqual(current, rematerialized))
          ) {
            throw new Error(
              "Operational ledger materialization detected a concurrent Product Gap mutation",
            );
          }
        }
        for (const current of currentBeforeMaterialization.reports) {
          if (!materializedReportIds.has(current.reportId)) continue;
          const staged = snapshot.reports.find(
            ({ reportId }) => reportId === current.reportId,
          );
          const rematerialized = materializedSnapshot.reports.find(
            ({ reportId }) => reportId === current.reportId,
          );
          if (
            staged === undefined ||
            (!isDeepStrictEqual(current, staged) &&
              !isDeepStrictEqual(current, rematerialized))
          ) {
            throw new Error(
              "Operational ledger materialization detected a concurrent report mutation",
            );
          }
        }
        working.#replaceSnapshot({
          ...currentBeforeMaterialization,
          runRecordTable:
            currentBeforeMaterialization.runRecordTable.filter(
              ({ recordId }) =>
                !materializedRunRecordIds.has(recordId),
            ),
          productGapCardTable:
            currentBeforeMaterialization.productGapCardTable.filter(
              (record) =>
                !materializedProductGapIds.has(
                  productGapIdentity(record),
                ),
            ),
          reports: currentBeforeMaterialization.reports.filter(
            ({ reportId }) => !materializedReportIds.has(reportId),
          ),
        });
        for (const record of materializedSnapshot.caseTable) {
          await working.upsertCase(record);
        }
        for (const record of materializedSnapshot.runRecordTable) {
          await working.appendRunRecord(record);
        }
        for (const record of materializedSnapshot.capturedArtifactTable) {
          await working.appendCapturedArtifact(record);
        }
        for (const record of materializedSnapshot.artifactScoreTable) {
          await working.appendArtifactScore(record);
        }
        for (const record of materializedSnapshot.adjudicationEventTable) {
          await working.appendAdjudicationEvent(record);
        }
        for (const record of materializedSnapshot.reviewEventTable) {
          await working.appendReviewEvent(record);
        }
        for (const record of materializedSnapshot.productGapCardTable) {
          if (record.recordType === "comparison") {
            await working.appendComparison(record);
          } else {
            await working.appendProductGapCard(record);
          }
        }
        for (const record of materializedSnapshot.gapCardWorkflowEventTable) {
          await working.appendProductGapCardWorkflowEvent(record);
        }
        for (const record of materializedSnapshot.githubIssueDeliveryReservationTable) {
          await working.reserveGitHubIssueDelivery(record);
        }
        for (const record of materializedSnapshot.githubIssueLinkEventTable) {
          await working.appendGitHubIssueLinkEvent(record);
        }
        for (const report of materializedSnapshot.reports) {
          const created = await working.createReport(report);
          if (!isDeepStrictEqual(created, report)) {
            throw new Error(
              `Operational ledger projection report mismatch: ${report.reportId}`,
            );
          }
        }
        if (this.#mutationVersion !== observedMutationVersion) {
          continue;
        }
        assertApprovedEgressAuthorizationCurrent(
          authorization,
          this.#clock,
        );
        this.#replaceSnapshot(working.snapshot());
        return;
      }
    });
  }

  #replaceSnapshot(snapshot: FeishuProjectionSnapshot): void {
    const replace = <T>(target: T[], source: readonly T[]) => {
      target.splice(0, target.length, ...cloneProjectionValue(source));
    };
    replace(this.#caseTable, snapshot.caseTable);
    replace(this.#runRecordTable, snapshot.runRecordTable);
    replace(this.#capturedArtifactTable, snapshot.capturedArtifactTable);
    replace(this.#artifactScoreTable, snapshot.artifactScoreTable);
    replace(this.#adjudicationEventTable, snapshot.adjudicationEventTable);
    replace(this.#reviewEventTable, snapshot.reviewEventTable);
    replace(
      this.#gapCardWorkflowEventTable,
      snapshot.gapCardWorkflowEventTable,
    );
    replace(
      this.#githubIssueDeliveryReservationTable,
      snapshot.githubIssueDeliveryReservationTable,
    );
    replace(
      this.#githubIssueLinkEventTable,
      snapshot.githubIssueLinkEventTable,
    );
    replace(this.#productGapCardTable, snapshot.productGapCardTable);
    replace(this.#reports, snapshot.reports);
    this.#mutationVersion += 1;
  }

  async scrubPayloadsForJob(jobId: string): Promise<void> {
    return this.#runProjectionExclusive(async () => {
      this.#expiredJobIds.add(jobId);
      const jobRuns = this.#runRecordTable.filter(
        (record) => record.jobId === jobId,
      );
      const caseIds =
        this.#expiredJobCaseIds.get(jobId) ?? new Set<string>();
      for (const { caseId } of jobRuns) caseIds.add(caseId);
      this.#expiredJobCaseIds.set(jobId, caseIds);
      for (const caseId of caseIds) this.#expiredCaseIds.add(caseId);
      const gapCardIds = new Set(
        this.#productGapCardTable
          .filter(
            (record): record is ProductGapCardRecord =>
              record.recordType === "gap_card" && record.jobId === jobId,
          )
          .map(({ gapCardId }) => gapCardId),
      );
      const remove = <T>(values: T[], matches: (value: T) => boolean) => {
        for (let index = values.length - 1; index >= 0; index -= 1) {
          const value = values[index];
          if (value !== undefined && matches(value)) values.splice(index, 1);
        }
      };
      remove(this.#capturedArtifactTable, (record) => record.jobId === jobId);
      remove(this.#artifactScoreTable, (record) => record.jobId === jobId);
      remove(this.#adjudicationEventTable, (record) => record.jobId === jobId);
      remove(this.#reviewEventTable, (record) => record.jobId === jobId);
      remove(this.#gapCardWorkflowEventTable, (record) =>
        gapCardIds.has(record.gapCardId),
      );
      remove(this.#githubIssueDeliveryReservationTable, (record) =>
        gapCardIds.has(record.gapCardId),
      );
      remove(this.#githubIssueLinkEventTable, (record) =>
        gapCardIds.has(record.gapCardId),
      );
      remove(this.#productGapCardTable, (record) => record.jobId === jobId);
      remove(this.#reports, (record) => record.jobId === jobId);
      remove(this.#runRecordTable, (record) => record.jobId === jobId);
      remove(
        this.#caseTable,
        (record) =>
          caseIds.has(record.caseId) &&
          !this.#runRecordTable.some(
            (run) => run.caseId === record.caseId,
          ),
      );
      this.#mutationVersion += 1;
    });
  }

  async hasPayloadsForJob(jobId: string): Promise<boolean> {
    const gapCardIds = new Set(
      this.#productGapCardTable
        .filter(
          (record): record is ProductGapCardRecord =>
            record.recordType === "gap_card" && record.jobId === jobId,
        )
        .map(({ gapCardId }) => gapCardId),
    );
    const caseIds = this.#expiredJobCaseIds.get(jobId) ?? new Set<string>();
    return (
      this.#runRecordTable.some((record) => record.jobId === jobId) ||
      this.#capturedArtifactTable.some((record) => record.jobId === jobId) ||
      this.#artifactScoreTable.some((record) => record.jobId === jobId) ||
      this.#adjudicationEventTable.some((record) => record.jobId === jobId) ||
      this.#reviewEventTable.some((record) => record.jobId === jobId) ||
      this.#productGapCardTable.some((record) => record.jobId === jobId) ||
      this.#reports.some((record) => record.jobId === jobId) ||
      this.#caseTable.some(
        (record) =>
          caseIds.has(record.caseId) &&
          !this.#runRecordTable.some(
            ({ caseId }) => caseId === record.caseId,
          ),
      ) ||
      this.#gapCardWorkflowEventTable.some((record) =>
        gapCardIds.has(record.gapCardId),
      ) ||
      this.#githubIssueDeliveryReservationTable.some((record) =>
        gapCardIds.has(record.gapCardId),
      ) ||
      this.#githubIssueLinkEventTable.some((record) =>
        gapCardIds.has(record.gapCardId),
      )
    );
  }
}
