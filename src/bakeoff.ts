import type {
  BakeoffJobOutcome,
  RunRecord,
  StartBakeoffJobCommand,
} from "./domain.ts";
import type { FeishuProjectionPort } from "./feishu.ts";
import {
  VOLCANO_CASE_ID,
  VOLCANO_EVALUATION_CASE,
} from "./fixtures/volcano-case.ts";
import {
  captureMockWpsArtifact,
  renderMockWpsArtifact,
} from "./mock-wps.ts";
import { createMockReportDraft } from "./mock-report.ts";
import { scoreMockWpsArtifact } from "./mock-score.ts";

const MOCK_JOB_ID = "MOCK-job-volcano-v1";
const MOCK_RUN_ID = "MOCK-run-wps-volcano-v1";
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

export interface BakeoffHarness {
  startBakeoffJob(command: StartBakeoffJobCommand): Promise<BakeoffJobOutcome>;
}

export interface BakeoffHarnessDependencies {
  readonly feishu: FeishuProjectionPort;
}

export function createBakeoffHarness({
  feishu,
}: BakeoffHarnessDependencies): BakeoffHarness {
  return {
    async startBakeoffJob(command) {
      if (command.caseId !== VOLCANO_CASE_ID) {
        throw new Error(`Unknown Evaluation Case: ${command.caseId}`);
      }

      const artifact = captureMockWpsArtifact();
      const renderManifest = renderMockWpsArtifact(artifact);
      const scorecard = scoreMockWpsArtifact(artifact, renderManifest);
      const parentRecord: RunRecord = {
        recordId: MOCK_JOB_ID,
        recordType: "bakeoff_job",
        jobId: MOCK_JOB_ID,
        parentRecordId: null,
        caseId: command.caseId,
        product: null,
        status: "completed",
        provenance: "MOCK",
        createdAt: FIXED_TIME,
        lastSyncedAt: FIXED_TIME,
        reportUrl: null,
        artifactId: null,
        renderManifestId: null,
        scorecardId: null,
      };
      const runRecord: RunRecord = {
        recordId: MOCK_RUN_ID,
        recordType: "vendor_run",
        jobId: MOCK_JOB_ID,
        parentRecordId: MOCK_JOB_ID,
        caseId: command.caseId,
        product: "Mock WPS AI PPT",
        status: "completed",
        provenance: "MOCK",
        createdAt: FIXED_TIME,
        lastSyncedAt: FIXED_TIME,
        reportUrl: null,
        artifactId: artifact.artifactId,
        renderManifestId: renderManifest.renderManifestId,
        scorecardId: scorecard.scorecardId,
      };

      await feishu.upsertCase(VOLCANO_EVALUATION_CASE);
      await feishu.appendRunRecord(parentRecord);
      await feishu.appendRunRecord(runRecord);
      await feishu.appendArtifactScore({
        recordId: scorecard.scorecardId,
        provenance: "MOCK",
        artifact,
        renderManifest,
        scorecard,
      });
      const report = await feishu.createReport(
        createMockReportDraft(artifact, scorecard),
      );
      await feishu.linkReportToBakeoffJob(MOCK_JOB_ID, report.url);

      return {
        job: {
          jobId: MOCK_JOB_ID,
          caseId: command.caseId,
          environment: command.environment,
          status: "completed",
          provenance: "MOCK",
        },
        artifact,
        renderManifest,
        scorecard,
        report,
      };
    },
  };
}
