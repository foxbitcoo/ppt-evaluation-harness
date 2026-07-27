import { isDeepStrictEqual } from "node:util";

import type {
  AdjudicationEventRecord,
  ArtifactScorecard,
  ComparisonRecord,
  ComparisonCompatibilityFingerprint,
  EvaluationCaseRecord,
  FeishuReport,
  GitHubIssueDeliveryReservationRecord,
  GitHubIssueLinkEventRecord,
  ObservableAttemptEvent,
  ProductGapCardRecord,
  ProductGapCardWorkflowEventRecord,
  ReviewEventRecord,
  RunRecord,
} from "./domain.ts";
import type {
  ArtifactMetadata,
  ArtifactPackageManifest,
  ArtifactVault,
  ImmutableBlobStorePort,
  RecoveredArtifactPackage,
  RetentionPayloadLocation,
} from "./artifact-vault.ts";
import type { FeishuProjectionSnapshot } from "./feishu.ts";
import type {
  ApprovedEgressAuthorization,
  ClockPort,
  EgressAuthorizationPort,
} from "./egress-authorization.ts";
import {
  requireEgressAuthorization,
  SYSTEM_CLOCK,
} from "./egress-authorization.ts";
import type {
  RunSpecificationBundle,
  RunSpecificationVault,
} from "./run-specification.ts";
import {
  canonicalJsonBytes,
  sha256Bytes,
} from "./run-specification.ts";
import type {
  PayloadInventoryPort,
  TombstoneLedgerPort,
} from "./retention.ts";

export interface CapturedArtifactRecoveryManifest {
  readonly recordId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly artifact: ArtifactMetadata;
  readonly renderManifest: {
    readonly renderManifestId: string;
    readonly artifactId: string;
    readonly renderer: string;
    readonly pageCount: number;
    readonly contentHash: `sha256:${string}`;
  };
  readonly artifactPackageManifest: ArtifactPackageManifest;
}

export interface RecoveryScorecardRecord {
  readonly recordId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly scorecard: ArtifactScorecard;
  readonly comparisonCompatibilityFingerprint: ComparisonCompatibilityFingerprint;
}

export interface OperationalLedgerRecoveryExport {
  readonly schemaVersion: "operational-ledger-recovery-v1";
  readonly exportId: string;
  readonly jobId: string;
  readonly checkpoint: string;
  readonly createdAt: string;
  readonly encryption: string;
  readonly retentionExpiresAt: string;
  readonly cases: readonly EvaluationCaseRecord[];
  readonly runRecords: readonly RunRecord[];
  readonly events: readonly ObservableAttemptEvent[];
  readonly artifactManifests: readonly CapturedArtifactRecoveryManifest[];
  readonly scorecards: readonly RecoveryScorecardRecord[];
  readonly adjudicationEvents: readonly AdjudicationEventRecord[];
  readonly reviewEvents: readonly ReviewEventRecord[];
  readonly gapCardWorkflowEvents: readonly ProductGapCardWorkflowEventRecord[];
  readonly githubIssueDeliveryReservations: readonly GitHubIssueDeliveryReservationRecord[];
  readonly githubIssueLinkEvents: readonly GitHubIssueLinkEventRecord[];
  readonly comparisons: readonly ComparisonRecord[];
  readonly productGapCards: readonly ProductGapCardRecord[];
  readonly reports: readonly FeishuReport[];
  readonly recordCount: number;
}

export interface OperationalLedgerExportReference {
  readonly schemaVersion: "operational-ledger-export-reference-v1";
  readonly exportSchemaVersion: "operational-ledger-recovery-v1";
  readonly exportId: string;
  readonly jobId: string;
  readonly checkpoint: string;
  readonly recordCount: number;
  readonly contentHash: `sha256:${string}`;
  readonly storeId: string;
  readonly key: string;
  readonly createdAt: string;
  readonly encryption: string;
  readonly retentionExpiresAt: string;
  readonly egressAuthorization: ApprovedEgressAuthorization;
}

export interface ExportOperationalLedgerCommand {
  readonly exportId: string;
  readonly jobId: string;
  readonly checkpoint: string;
  readonly snapshot: FeishuProjectionSnapshot;
  readonly createdAt: string;
  readonly encryption: string;
  readonly retentionExpiresAt: string;
}

export interface RecoveredOperationalJob {
  readonly job: RunRecord;
  readonly vendorRuns: readonly RunRecord[];
  readonly attempts: readonly RunRecord[];
  readonly events: readonly ObservableAttemptEvent[];
  readonly artifactManifests: readonly CapturedArtifactRecoveryManifest[];
  readonly scorecards: readonly RecoveryScorecardRecord[];
  readonly adjudicationEvents: readonly AdjudicationEventRecord[];
  readonly reviewEvents: readonly ReviewEventRecord[];
  readonly gapCardWorkflowEvents: readonly ProductGapCardWorkflowEventRecord[];
  readonly githubIssueDeliveryReservations: readonly GitHubIssueDeliveryReservationRecord[];
  readonly githubIssueLinkEvents: readonly GitHubIssueLinkEventRecord[];
  readonly comparisons: readonly ComparisonRecord[];
  readonly productGapCards: readonly ProductGapCardRecord[];
  readonly reports: readonly FeishuReport[];
}

export interface RecoveryRehearsalResult {
  readonly rehearsalId: string;
  readonly complete: true;
  readonly jobId: string;
  readonly rehearsedAt: string;
  readonly recordCount: number;
  readonly recoveredJob: RecoveredOperationalJob;
  readonly runSpecifications: readonly RunSpecificationBundle[];
  readonly artifacts: readonly RecoveredArtifactPackage[];
  readonly verifiedHashes: readonly `sha256:${string}`[];
  readonly usedSources: readonly [
    "versioned_recovery_export",
    "run_specification_recovery_store",
    "secondary_artifact_copy",
  ];
}

export interface OperationalLedgerRecoveryService {
  exportLedger(
    command: ExportOperationalLedgerCommand,
  ): Promise<OperationalLedgerExportReference>;
  rehearse(command: {
    readonly exportReference: OperationalLedgerExportReference;
    readonly rehearsedAt: string;
  }): Promise<RecoveryRehearsalResult>;
  retentionLocation(
    reference: OperationalLedgerExportReference,
  ): RetentionPayloadLocation;
}

export interface OperationalLedgerRecoveryServiceDependencies {
  readonly recoveryStore: ImmutableBlobStorePort;
  readonly artifactVault: ArtifactVault;
  readonly runSpecificationVault: RunSpecificationVault;
  readonly tombstones: TombstoneLedgerPort;
  readonly egressAuthorization?: EgressAuthorizationPort;
  readonly payloadInventory: PayloadInventoryPort;
  readonly clock?: ClockPort;
}

function uniqueStableIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Recovery export contains duplicate ${label} IDs`);
  }
}

function assertSingleCausalChain<T>(input: {
  readonly events: readonly T[];
  readonly id: (event: T) => string;
  readonly priorId: (event: T) => string | null;
  readonly occurredAt: (event: T) => string;
  readonly label: string;
}): void {
  if (input.events.length === 0) return;
  const byId = new Map(input.events.map((event) => [input.id(event), event]));
  if (byId.size !== input.events.length) {
    throw new Error(`${input.label} history contains duplicate IDs`);
  }
  const childrenByParent = new Map<string, number>();
  const roots: T[] = [];
  for (const event of input.events) {
    const eventTime = Date.parse(input.occurredAt(event));
    if (!Number.isFinite(eventTime)) {
      throw new Error(`${input.label} history time is invalid`);
    }
    const priorId = input.priorId(event);
    if (priorId === null) {
      roots.push(event);
      continue;
    }
    const prior = byId.get(priorId);
    if (prior === undefined) {
      throw new Error(`${input.label} history has a missing prior event`);
    }
    childrenByParent.set(
      priorId,
      (childrenByParent.get(priorId) ?? 0) + 1,
    );
    if ((childrenByParent.get(priorId) ?? 0) > 1) {
      throw new Error(`${input.label} history contains a causal fork`);
    }
    if (
      eventTime < Date.parse(input.occurredAt(prior))
    ) {
      throw new Error(`${input.label} history time order is invalid`);
    }
  }
  if (roots.length !== 1) {
    throw new Error(`${input.label} history must have one causal root`);
  }
  const visited = new Set<string>();
  let current: T | undefined = input.events.find(
    (event) => !childrenByParent.has(input.id(event)),
  );
  while (current !== undefined) {
    const currentId = input.id(current);
    if (visited.has(currentId)) {
      throw new Error(`${input.label} history contains a cycle`);
    }
    visited.add(currentId);
    const priorId = input.priorId(current);
    current = priorId === null ? undefined : byId.get(priorId);
  }
  if (visited.size !== input.events.length) {
    throw new Error(`${input.label} history is disconnected`);
  }
}

function validateHumanHistory(input: {
  readonly jobId: string;
  readonly scorecards: readonly RecoveryScorecardRecord[];
  readonly adjudications: readonly AdjudicationEventRecord[];
  readonly reviews: readonly ReviewEventRecord[];
}): void {
  const scoresById = new Map(
    input.scorecards.map((record) => [record.scorecard.scorecardId, record]),
  );
  for (const event of input.adjudications) {
    const score = scoresById.get(event.scorecardId);
    const modelDimension = score?.scorecard.dimensions.find(
      ({ dimension }) => dimension === event.dimension,
    );
    if (
      score === undefined ||
      modelDimension === undefined ||
      event.jobId !== input.jobId ||
      event.runId !== score.runId ||
      event.artifactId !== score.artifactId ||
      event.modelOriginalAssessmentStatus !==
        modelDimension.assessmentStatus ||
      event.modelOriginalScore !== modelDimension.value ||
      event.provenance !== score.scorecard.provenance ||
      !isDeepStrictEqual(
        event.environmentOrigin,
        score.scorecard.environmentOrigin,
      )
    ) {
      throw new Error(
        `Adjudication history ownership or model lineage mismatch: ${event.adjudicationEventId}`,
      );
    }
  }
  for (const event of input.reviews) {
    const score = scoresById.get(event.scorecardId);
    const dimensions = new Set(
      score?.scorecard.dimensions.map(({ dimension }) => dimension) ?? [],
    );
    if (
      score === undefined ||
      event.jobId !== input.jobId ||
      event.runId !== score.runId ||
      event.artifactId !== score.artifactId ||
      event.reviewedDimensions.length === 0 ||
      event.reviewedDimensions.some((dimension) => !dimensions.has(dimension)) ||
      event.provenance !== score.scorecard.provenance ||
      !isDeepStrictEqual(
        event.environmentOrigin,
        score.scorecard.environmentOrigin,
      )
    ) {
      throw new Error(
        `Review history ownership or model lineage mismatch: ${event.reviewEventId}`,
      );
    }
  }
  const adjudicationGroups = new Map<string, AdjudicationEventRecord[]>();
  for (const event of input.adjudications) {
    const key = `${event.scorecardId}\u0000${event.dimension}`;
    const group = adjudicationGroups.get(key) ?? [];
    group.push(event);
    adjudicationGroups.set(key, group);
  }
  for (const events of adjudicationGroups.values()) {
    assertSingleCausalChain({
      events,
      id: (event) => event.adjudicationEventId,
      priorId: (event) => event.priorAdjudicationEventId,
      occurredAt: (event) => event.occurredAt,
      label: "Adjudication",
    });
  }
  const reviewGroups = new Map<string, ReviewEventRecord[]>();
  for (const event of input.reviews) {
    const group = reviewGroups.get(event.scorecardId) ?? [];
    group.push(event);
    reviewGroups.set(event.scorecardId, group);
  }
  for (const events of reviewGroups.values()) {
    assertSingleCausalChain({
      events,
      id: (event) => event.reviewEventId,
      priorId: (event) => event.priorReviewEventId,
      occurredAt: (event) => event.occurredAt,
      label: "Review",
    });
  }
}

function createExport(
  command: ExportOperationalLedgerCommand,
): OperationalLedgerRecoveryExport {
  const runRecords = command.snapshot.runRecordTable.filter(
    ({ jobId }) => jobId === command.jobId,
  );
  const vendorRuns = runRecords.filter(
    ({ recordType }) => recordType === "vendor_run",
  );
  const manifestsByArtifactId = new Map(
    vendorRuns.flatMap(({ artifactPackageManifest }) =>
      artifactPackageManifest === undefined ||
      artifactPackageManifest === null
        ? []
        : [
            [
              artifactPackageManifest.artifact.artifactId,
              artifactPackageManifest,
            ] as const,
          ],
    ),
  );
  const artifactManifests = command.snapshot.capturedArtifactTable
    .filter(({ jobId }) => jobId === command.jobId)
    .map((record): CapturedArtifactRecoveryManifest => {
      const packageManifest = manifestsByArtifactId.get(record.artifactId);
      if (packageManifest === undefined) {
        throw new Error(
          `Artifact recovery manifest is missing: ${record.artifactId}`,
        );
      }
      if (
        record.renderManifest.renderManifestId !==
          packageManifest.renderManifestId ||
        record.renderManifest.contentHash !==
          packageManifest.renderManifestHash ||
        record.renderManifest.artifactId !==
          packageManifest.artifact.artifactId ||
        record.renderManifest.pageCount !==
          packageManifest.artifact.pageCount
      ) {
        throw new Error(
          `Artifact recovery render manifest lineage is inconsistent: ${record.artifactId}`,
        );
      }
      return {
        recordId: record.recordId,
        caseId: record.caseId,
        jobId: record.jobId,
        runId: record.runId,
        artifact: packageManifest.artifact,
        renderManifest: {
          renderManifestId: record.renderManifest.renderManifestId,
          artifactId: record.renderManifest.artifactId,
          renderer: record.renderManifest.renderer,
          pageCount: record.renderManifest.pageCount,
          contentHash: record.renderManifest.contentHash,
        },
        artifactPackageManifest: packageManifest,
      };
    });
  const scorecards = command.snapshot.artifactScoreTable
    .filter(({ jobId }) => jobId === command.jobId)
    .map(
      (record): RecoveryScorecardRecord => ({
        recordId: record.recordId,
        caseId: record.caseId,
        jobId: record.jobId,
        runId: record.runId,
        artifactId: record.artifactId,
        scorecard: record.scorecard,
        comparisonCompatibilityFingerprint:
          record.comparisonCompatibilityFingerprint,
      }),
    );
  const artifactIds = new Set(
    artifactManifests.map(({ artifact }) => artifact.artifactId),
  );
  const scorecardIds = new Set(
    scorecards.map(({ scorecard }) => scorecard.scorecardId),
  );
  const adjudicationEvents = command.snapshot.adjudicationEventTable.filter(
    ({ jobId }) => jobId === command.jobId,
  );
  if (
    adjudicationEvents.some(
      ({ scorecardId, artifactId }) =>
        !scorecardIds.has(scorecardId) || !artifactIds.has(artifactId),
    )
  ) {
    throw new Error(
      `Operational ledger contains dangling adjudication history for Job: ${command.jobId}`,
    );
  }
  const reviewEvents = command.snapshot.reviewEventTable.filter(
    ({ jobId }) => jobId === command.jobId,
  );
  if (
    reviewEvents.some(
      ({ scorecardId, artifactId }) =>
        !scorecardIds.has(scorecardId) || !artifactIds.has(artifactId),
    )
  ) {
    throw new Error(
      `Operational ledger contains dangling review history for Job: ${command.jobId}`,
    );
  }
  validateHumanHistory({
    jobId: command.jobId,
    scorecards,
    adjudications: adjudicationEvents,
    reviews: reviewEvents,
  });
  const gapCardWorkflowEvents =
    command.snapshot.gapCardWorkflowEventTable.filter((event) =>
      command.snapshot.productGapCardTable.some(
        (record) =>
          record.recordType === "gap_card" &&
          record.jobId === command.jobId &&
          record.gapCardId === event.gapCardId,
      ),
    );
  const gapCardIds = new Set(
    command.snapshot.productGapCardTable.flatMap((record) =>
      record.recordType === "gap_card" &&
      record.jobId === command.jobId
        ? [record.gapCardId]
        : [],
    ),
  );
  const githubIssueDeliveryReservations =
    command.snapshot.githubIssueDeliveryReservationTable.filter(
      ({ gapCardId }) => gapCardIds.has(gapCardId),
    );
  const githubIssueLinkEvents =
    command.snapshot.githubIssueLinkEventTable.filter(({ gapCardId }) =>
      gapCardIds.has(gapCardId),
    );
  const comparisons = command.snapshot.productGapCardTable.filter(
    (record): record is ComparisonRecord =>
      record.recordType === "comparison" &&
      record.jobId === command.jobId,
  );
  const productGapCards = command.snapshot.productGapCardTable.filter(
    (record): record is ProductGapCardRecord =>
      record.recordType === "gap_card" && record.jobId === command.jobId,
  );
  const cases = command.snapshot.caseTable.filter(({ caseId }) =>
    runRecords.some((record) => record.caseId === caseId),
  );
  const events = runRecords.flatMap(
    ({ observableEvents }) => observableEvents ?? [],
  );
  const reports = command.snapshot.reports.filter(
    ({ jobId }) => jobId === command.jobId,
  );
  const recordCount =
    cases.length +
    runRecords.length +
    events.length +
    artifactManifests.length +
    scorecards.length +
    adjudicationEvents.length +
    reviewEvents.length +
    gapCardWorkflowEvents.length +
    githubIssueDeliveryReservations.length +
    githubIssueLinkEvents.length +
    comparisons.length +
    productGapCards.length +
    reports.length;
  return {
    schemaVersion: "operational-ledger-recovery-v1",
    exportId: command.exportId,
    jobId: command.jobId,
    checkpoint: command.checkpoint,
    createdAt: command.createdAt,
    encryption: command.encryption,
    retentionExpiresAt: command.retentionExpiresAt,
    cases,
    runRecords,
    events,
    artifactManifests,
    scorecards,
    adjudicationEvents,
    reviewEvents,
    gapCardWorkflowEvents,
    githubIssueDeliveryReservations,
    githubIssueLinkEvents,
    comparisons,
    productGapCards,
    reports,
    recordCount,
  };
}

function parseExport(content: Uint8Array): OperationalLedgerRecoveryExport {
  const parsed = JSON.parse(new TextDecoder().decode(content)) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== "operational-ledger-recovery-v1"
  ) {
    throw new Error("Operational ledger recovery export is invalid");
  }
  return parsed as OperationalLedgerRecoveryExport;
}

export function createOperationalLedgerRecoveryService({
  recoveryStore,
  artifactVault,
  runSpecificationVault,
  tombstones,
  egressAuthorization,
  payloadInventory,
  clock = SYSTEM_CLOCK,
}: OperationalLedgerRecoveryServiceDependencies): OperationalLedgerRecoveryService {
  return {
    async exportLedger(command) {
      if (
        !Number.isFinite(Date.parse(command.createdAt)) ||
        Date.parse(command.retentionExpiresAt) <= Date.parse(command.createdAt)
      ) {
        throw new Error("Operational ledger export retention is invalid");
      }
      const ledger = createExport(command);
      const job = ledger.runRecords.find(
        ({ recordType }) => recordType === "bakeoff_job",
      );
      if (job === undefined) {
        throw new Error(`Bakeoff Job not found for export: ${command.jobId}`);
      }
      uniqueStableIds(
        ledger.runRecords.map(({ recordId }) => recordId),
        "Run",
      );
      uniqueStableIds(
        ledger.events.map(({ eventId }) => eventId),
        "event",
      );
      uniqueStableIds(
        ledger.artifactManifests.map(
          ({ artifact }) => artifact.artifactId,
        ),
        "Artifact",
      );
      uniqueStableIds(
        ledger.adjudicationEvents.map(
          ({ adjudicationEventId }) => adjudicationEventId,
        ),
        "adjudication",
      );
      uniqueStableIds(
        ledger.scorecards.map(({ recordId }) => recordId),
        "Scorecard",
      );
      uniqueStableIds(
        ledger.reviewEvents.map(({ reviewEventId }) => reviewEventId),
        "review",
      );
      uniqueStableIds(
        ledger.gapCardWorkflowEvents.map(
          ({ workflowEventId }) => workflowEventId,
        ),
        "Gap Card workflow event",
      );
      uniqueStableIds(
        ledger.githubIssueDeliveryReservations.map(
          ({ reservationId }) => reservationId,
        ),
        "GitHub Issue delivery reservation",
      );
      uniqueStableIds(
        ledger.githubIssueLinkEvents.map(({ linkEventId }) => linkEventId),
        "GitHub Issue link event",
      );
      uniqueStableIds(
        ledger.comparisons.map(({ comparisonId }) => comparisonId),
        "Comparison",
      );
      uniqueStableIds(
        ledger.productGapCards.map(({ gapCardId }) => gapCardId),
        "Product Gap Card",
      );
      const content = canonicalJsonBytes(ledger);
      const contentHash = sha256Bytes(content);
      const key = `ledger-exports/${command.jobId}/${command.exportId}`;
      const evaluationCase = ledger.cases.find(
        ({ caseId }) => caseId === job.caseId,
      );
      if (evaluationCase === undefined) {
        throw new Error(
          `Operational ledger export is missing Job Case: ${job.caseId}`,
        );
      }
      const authorization = await requireEgressAuthorization(egressAuthorization, {
        requestId: `operational-ledger-export:${command.exportId}:${contentHash}`,
        jobId: command.jobId,
        runId: null,
        attemptId: null,
        dataClassification: evaluationCase.dataClassification,
        sourceOwner: evaluationCase.sourceOwner,
        processingPurpose: "operational_ledger_recovery_export",
        targetKind: "storage",
        targetService: recoveryStore.egressDestination.targetService,
        targetAccount: recoveryStore.egressDestination.targetAccount,
        targetRegion: recoveryStore.egressDestination.targetRegion,
        subprocessors: recoveryStore.egressDestination.subprocessors,
        contentFields: [
          "cases",
          "run_records",
          "attempt_events",
          "artifact_manifests",
          "scorecards",
          "adjudication_history",
          "review_history",
          "gap_card_workflow_history",
          "github_issue_delivery_reservations",
          "github_issue_link_history",
          "comparisons",
          "product_gap_cards",
          "reports",
        ],
        payloadHash: contentHash,
        requiredRedactions: [],
      });
      await payloadInventory.register(command.jobId, [
        {
          storeId: recoveryStore.storeId,
          key,
          contentHash,
          copyRole: "recovery_export",
        },
      ]);
      await recoveryStore.putImmutable(key, content, {
        jobId: command.jobId,
        contentHash,
      });
      const readback = await recoveryStore.read(key);
      if (readback === null || sha256Bytes(readback) !== contentHash) {
        throw new Error(
          "Operational ledger recovery export readback hash mismatch",
        );
      }
      return {
        schemaVersion: "operational-ledger-export-reference-v1",
        exportSchemaVersion: ledger.schemaVersion,
        exportId: command.exportId,
        jobId: command.jobId,
        checkpoint: command.checkpoint,
        recordCount: ledger.recordCount,
        contentHash,
        storeId: recoveryStore.storeId,
        key,
        createdAt: command.createdAt,
        encryption: command.encryption,
        retentionExpiresAt: command.retentionExpiresAt,
        egressAuthorization: authorization,
      };
    },

    async rehearse({ exportReference, rehearsedAt }) {
      if (
        (await tombstones.findByJobId(exportReference.jobId)) !== null
      ) {
        throw new Error(
          `Recovery blocked: Job ${exportReference.jobId} is tombstoned and cannot be resurrected`,
        );
      }
      return tombstones.runIfActive(exportReference.jobId, async () => {
      const trustedRehearsedAt = clock.now();
      if (rehearsedAt !== trustedRehearsedAt) {
        throw new Error(
          "Recovery rehearsal timestamp does not match the trusted clock",
        );
      }
      if (exportReference.storeId !== recoveryStore.storeId) {
        throw new Error("Operational ledger recovery store mismatch");
      }
      if (
        exportReference.egressAuthorization.request.payloadHash !==
          exportReference.contentHash ||
        exportReference.egressAuthorization.request.processingPurpose !==
          "operational_ledger_recovery_export" ||
        exportReference.egressAuthorization.request.targetService !==
          recoveryStore.egressDestination.targetService ||
        exportReference.egressAuthorization.request.targetAccount !==
          recoveryStore.egressDestination.targetAccount ||
        exportReference.egressAuthorization.request.targetRegion !==
          recoveryStore.egressDestination.targetRegion ||
        !isDeepStrictEqual(
          exportReference.egressAuthorization.request.subprocessors,
          recoveryStore.egressDestination.subprocessors,
        )
      ) {
        throw new Error(
          "Operational ledger recovery export authorization mismatch",
        );
      }
      const content = await recoveryStore.read(exportReference.key);
      if (
        content === null ||
        sha256Bytes(content) !== exportReference.contentHash
      ) {
        throw new Error(
          "Operational ledger recovery export hash mismatch",
        );
      }
      const ledger = parseExport(content);
      if (
        ledger.exportId !== exportReference.exportId ||
        ledger.jobId !== exportReference.jobId ||
        ledger.checkpoint !== exportReference.checkpoint ||
        ledger.createdAt !== exportReference.createdAt ||
        ledger.encryption !== exportReference.encryption ||
        ledger.retentionExpiresAt !==
          exportReference.retentionExpiresAt ||
        ledger.recordCount !== exportReference.recordCount ||
        ledger.recordCount !==
          ledger.cases.length +
            ledger.runRecords.length +
            ledger.events.length +
            ledger.artifactManifests.length +
            ledger.scorecards.length +
            ledger.adjudicationEvents.length +
            ledger.reviewEvents.length +
            ledger.gapCardWorkflowEvents.length +
            ledger.githubIssueDeliveryReservations.length +
            ledger.githubIssueLinkEvents.length +
            ledger.comparisons.length +
            ledger.productGapCards.length +
            ledger.reports.length
      ) {
        throw new Error(
          "Operational ledger recovery export lineage mismatch",
        );
      }
      const rehearsalTime = Date.parse(trustedRehearsedAt);
      const retentionExpiry = Date.parse(ledger.retentionExpiresAt);
      if (
        !Number.isFinite(rehearsalTime) ||
        !Number.isFinite(retentionExpiry) ||
        rehearsalTime >= retentionExpiry
      ) {
        throw new Error(
          `Recovery blocked: export ${exportReference.exportId} is expired`,
        );
      }
      const job = ledger.runRecords.find(
        ({ recordType }) => recordType === "bakeoff_job",
      );
      if (
        job === undefined ||
        job.selectedRunIds === null ||
        job.selectedRunIds.length === 0
      ) {
        throw new Error("Recovered Bakeoff Job is incomplete");
      }
      const evaluationCase = ledger.cases.find(
        ({ caseId }) => caseId === job.caseId,
      );
      const authorizationRequest =
        exportReference.egressAuthorization.request;
      if (
        evaluationCase === undefined ||
        authorizationRequest.requestId !==
          `operational-ledger-export:${exportReference.exportId}:${exportReference.contentHash}` ||
        authorizationRequest.jobId !== exportReference.jobId ||
        authorizationRequest.runId !== null ||
        authorizationRequest.attemptId !== null ||
        authorizationRequest.dataClassification !==
          evaluationCase.dataClassification ||
        authorizationRequest.sourceOwner !== evaluationCase.sourceOwner ||
        authorizationRequest.targetKind !== "storage" ||
        !isDeepStrictEqual(authorizationRequest.contentFields, [
          "cases",
          "run_records",
          "attempt_events",
          "artifact_manifests",
          "scorecards",
          "adjudication_history",
          "review_history",
          "gap_card_workflow_history",
          "github_issue_delivery_reservations",
          "github_issue_link_history",
          "comparisons",
          "product_gap_cards",
          "reports",
        ]) ||
        authorizationRequest.requiredRedactions.length !== 0
      ) {
        throw new Error(
          "Operational ledger recovery export authorization mismatch",
        );
      }
      const vendorRuns = ledger.runRecords.filter(
        ({ recordType }) => recordType === "vendor_run",
      );
      const attempts = ledger.runRecords.filter(
        ({ recordType }) => recordType === "evaluation_attempt",
      );
      if (
        vendorRuns.length !== job.selectedRunIds.length ||
        job.selectedRunIds.some(
          (runId, index) => vendorRuns[index]?.recordId !== runId,
        )
      ) {
        throw new Error("Recovered Bakeoff Job selected Run set is incomplete");
      }
      const vendorRunsById = new Map(
        vendorRuns.map((run) => [run.recordId, run]),
      );
      const attemptsById = new Map(
        attempts.map((attempt) => [attempt.recordId, attempt]),
      );
      if (
        attempts.some(
          (attempt) =>
            attempt.parentRecordId === null ||
            !vendorRunsById.has(attempt.parentRecordId),
        ) ||
        ledger.events.some((event) => {
          const attempt = attemptsById.get(event.attemptId);
          return (
            attempt === undefined ||
            event.jobId !== ledger.jobId ||
            event.runId !== attempt.parentRecordId ||
            event.caseId !== attempt.caseId ||
            event.attemptSeq !== attempt.attemptSeq
          );
        })
      ) {
        throw new Error(
          "Recovered Attempt or observable-event lineage is inconsistent",
        );
      }
      const artifactIds = new Set(
        ledger.artifactManifests.map(
          ({ artifact }) => artifact.artifactId,
        ),
      );
      const scorecardIds = new Set(
        ledger.scorecards.map(({ scorecard }) => scorecard.scorecardId),
      );
      if (
        ledger.artifactManifests.some(
          (manifest) =>
            !vendorRunsById.has(manifest.runId) ||
            manifest.artifact.runId !== manifest.runId ||
            manifest.artifactPackageManifest.artifact.artifactId !==
              manifest.artifact.artifactId,
        ) ||
        ledger.scorecards.some(
          ({ runId, artifactId, scorecard }) =>
            !vendorRunsById.has(runId) ||
            !artifactIds.has(artifactId) ||
            scorecard.runId !== runId ||
            scorecard.artifactId !== artifactId,
        ) ||
        ledger.adjudicationEvents.some(
          ({ scorecardId, artifactId }) =>
            !scorecardIds.has(scorecardId) ||
            !artifactIds.has(artifactId),
        ) ||
        ledger.reviewEvents.some(
          ({ scorecardId, artifactId }) =>
            !scorecardIds.has(scorecardId) ||
            !artifactIds.has(artifactId),
        )
      ) {
        throw new Error(
          "Recovered Artifact, Scorecard, or adjudication lineage is inconsistent",
        );
      }
      validateHumanHistory({
        jobId: ledger.jobId,
        scorecards: ledger.scorecards,
        adjudications: ledger.adjudicationEvents,
        reviews: ledger.reviewEvents,
      });

      const runSpecifications: RunSpecificationBundle[] = [];
      const artifacts: RecoveredArtifactPackage[] = [];
      const verifiedHashes: `sha256:${string}`[] = [
        exportReference.contentHash,
      ];
      for (const run of vendorRuns) {
        if (
          run.specificationReference === undefined ||
          run.specificationReference === null
        ) {
          throw new Error(
            `Recovered Run specification reference is missing: ${run.recordId}`,
          );
        }
        const specification = await runSpecificationVault.read(
          run.specificationReference,
        );
        const specificationCase = ledger.cases.find(
          ({ caseId }) => caseId === run.caseId,
        );
        if (
          specification.jobId !== ledger.jobId ||
          specification.runId !== run.recordId ||
          specificationCase === undefined ||
          !isDeepStrictEqual(
            specification.evaluationCase,
            specificationCase,
          ) ||
          specification.productPackage.packageId !==
            run.productPackageId ||
          specification.productPackage.vendorId !== run.productVendorId ||
          specification.productPackage.adapterVersion !==
            run.adapterVersion ||
          job.protocolSnapshot === null ||
          !isDeepStrictEqual(
            specification.protocolSnapshot,
            job.protocolSnapshot,
          )
        ) {
          throw new Error(
            `Run specification lineage does not match recovered Job, Run, Case, or Product Package: ${run.recordId}`,
          );
        }
        runSpecifications.push(specification);
        verifiedHashes.push(run.specificationReference.contentHash);
        if (run.artifactId !== null) {
          if (
            run.artifactPackageManifest === undefined ||
            run.artifactPackageManifest === null ||
            run.artifactPackageManifest.artifact.artifactId !==
              run.artifactId
          ) {
            throw new Error(
              `Recovered Artifact manifest is missing: ${run.recordId}`,
            );
          }
          const recovered = await artifactVault.readFromSecondary(
            run.artifactPackageManifest,
          );
          artifacts.push(recovered);
          verifiedHashes.push(
            recovered.manifest.manifestHash,
            recovered.manifest.renderManifestHash,
            recovered.manifest.artifact.contentHash,
            ...recovered.manifest.derivatives.map(
              ({ contentHash }) => contentHash,
            ),
          );
        }
      }
      if (
        ledger.artifactManifests.length !== artifacts.length ||
        ledger.artifactManifests.some(
          ({ artifact }, index) =>
            artifacts[index]?.manifest.artifact.artifactId !==
            artifact.artifactId,
        )
      ) {
        throw new Error(
          "Recovered Artifact package set is incomplete",
        );
      }

      return {
        rehearsalId: `recovery-rehearsal:${exportReference.exportId}`,
        complete: true,
        jobId: ledger.jobId,
        rehearsedAt: trustedRehearsedAt,
        recordCount: ledger.recordCount,
        recoveredJob: {
          job,
          vendorRuns,
          attempts,
          events: ledger.events,
          artifactManifests: ledger.artifactManifests,
          scorecards: ledger.scorecards,
          adjudicationEvents: ledger.adjudicationEvents,
          reviewEvents: ledger.reviewEvents,
          gapCardWorkflowEvents: ledger.gapCardWorkflowEvents,
          githubIssueDeliveryReservations:
            ledger.githubIssueDeliveryReservations,
          githubIssueLinkEvents: ledger.githubIssueLinkEvents,
          comparisons: ledger.comparisons,
          productGapCards: ledger.productGapCards,
          reports: ledger.reports,
        },
        runSpecifications,
        artifacts,
        verifiedHashes,
        usedSources: [
          "versioned_recovery_export",
          "run_specification_recovery_store",
          "secondary_artifact_copy",
        ],
      };
      });
    },

    retentionLocation(reference) {
      return {
        storeId: reference.storeId,
        key: reference.key,
        contentHash: reference.contentHash,
        copyRole: "recovery_export",
      };
    },
  };
}
