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
import type { EgressAuthorizationPort } from "./egress-authorization.ts";
import { requireEgressAuthorization } from "./egress-authorization.ts";
import type {
  RunSpecificationBundle,
  RunSpecificationVault,
} from "./run-specification.ts";
import {
  canonicalJsonBytes,
  sha256Bytes,
} from "./run-specification.ts";
import type { TombstoneLedgerPort } from "./retention.ts";

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
}

function uniqueStableIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Recovery export contains duplicate ${label} IDs`);
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
  const adjudicationEvents =
    command.snapshot.adjudicationEventTable.filter(
      ({ jobId, scorecardId, artifactId }) =>
        jobId === command.jobId &&
        scorecardIds.has(scorecardId) &&
        artifactIds.has(artifactId),
    );
  const reviewEvents = command.snapshot.reviewEventTable.filter(
    ({ jobId, scorecardId, artifactId }) =>
      jobId === command.jobId &&
      scorecardIds.has(scorecardId) &&
      artifactIds.has(artifactId),
  );
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

function exportTargetRegion(
  ledger: OperationalLedgerRecoveryExport,
): string {
  const job = ledger.runRecords.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  return job?.environmentOrigin.environment ?? "unknown";
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
      await requireEgressAuthorization(egressAuthorization, {
        requestId: `operational-ledger-export:${command.exportId}:${contentHash}`,
        jobId: command.jobId,
        runId: null,
        attemptId: null,
        dataClassification: "public_or_synthetic",
        sourceOwner: "ppt-evaluation-harness",
        processingPurpose: "operational_ledger_recovery_export",
        targetKind: "storage",
        targetService: recoveryStore.storeId,
        targetAccount: "controlled-recovery-store",
        targetRegion: exportTargetRegion(ledger),
        subprocessors: [],
        contentFields: [
          "stable_ids",
          "events",
          "manifests",
          "scorecards",
          "adjudication_history",
        ],
        requiredRedactions: [],
        requestedAt: command.createdAt,
      });
      await recoveryStore.putImmutable(key, content);
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
      };
    },

    async rehearse({ exportReference, rehearsedAt }) {
      const tombstone = await tombstones.findByJobId(
        exportReference.jobId,
      );
      if (tombstone !== null) {
        throw new Error(
          `Recovery blocked: Job ${exportReference.jobId} is tombstoned and cannot be resurrected`,
        );
      }
      if (exportReference.storeId !== recoveryStore.storeId) {
        throw new Error("Operational ledger recovery store mismatch");
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
        )
      ) {
        throw new Error(
          "Recovered Artifact, Scorecard, or adjudication lineage is inconsistent",
        );
      }

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
        rehearsedAt,
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
