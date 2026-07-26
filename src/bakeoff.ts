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
import { renderStaticArtifact } from "./mock-wps.ts";
import { createMockReportDraft } from "./mock-report.ts";
import { MOCK_SCENARIO } from "./mock-scenario.ts";
import { scoreRenderedArtifact } from "./mock-score.ts";
import type { ProductAdapterPort } from "./product-adapter.ts";

export interface BakeoffHarness {
  startBakeoffJob(command: StartBakeoffJobCommand): Promise<BakeoffJobOutcome>;
}

export interface BakeoffHarnessDependencies {
  readonly feishu: FeishuProjectionPort;
  readonly productAdapter: ProductAdapterPort;
}

export function createBakeoffHarness({
  feishu,
  productAdapter,
}: BakeoffHarnessDependencies): BakeoffHarness {
  return {
    async startBakeoffJob(command) {
      if (command.caseId !== VOLCANO_CASE_ID) {
        throw new Error(`Unknown Evaluation Case: ${command.caseId}`);
      }

      const artifact = await productAdapter.execute({
        jobId: MOCK_SCENARIO.jobId,
        runId: MOCK_SCENARIO.runId,
        evaluationCase: VOLCANO_EVALUATION_CASE,
      });
      if (
        artifact.runId !== MOCK_SCENARIO.runId ||
        artifact.provenance !== "MOCK"
      ) {
        throw new Error("Test Bakeoff Job requires MOCK Artifact lineage");
      }
      const renderManifest = renderStaticArtifact(artifact);
      const scorecard = scoreRenderedArtifact(artifact, renderManifest, {
        jobId: MOCK_SCENARIO.jobId,
        runId: MOCK_SCENARIO.runId,
      });
      const parentRecord: RunRecord = {
        recordId: MOCK_SCENARIO.jobId,
        recordType: "bakeoff_job",
        jobId: MOCK_SCENARIO.jobId,
        parentRecordId: null,
        caseId: command.caseId,
        product: null,
        productPackageId: null,
        adapterVersion: null,
        status: "completed",
        provenance: "MOCK",
        createdAt: MOCK_SCENARIO.fixedTime,
        lastSyncedAt: MOCK_SCENARIO.fixedTime,
        reportUrl: null,
        artifactId: null,
        renderManifestId: null,
        scorecardId: null,
      };
      const runRecord: RunRecord = {
        recordId: MOCK_SCENARIO.runId,
        recordType: "vendor_run",
        jobId: MOCK_SCENARIO.jobId,
        parentRecordId: MOCK_SCENARIO.jobId,
        caseId: command.caseId,
        product: productAdapter.productPackage.displayName,
        productPackageId: productAdapter.productPackage.packageId,
        adapterVersion: productAdapter.productPackage.adapterVersion,
        status: "completed",
        provenance: "MOCK",
        createdAt: MOCK_SCENARIO.fixedTime,
        lastSyncedAt: MOCK_SCENARIO.fixedTime,
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
      await feishu.linkReportToBakeoffJob(MOCK_SCENARIO.jobId, report.url);

      return {
        job: {
          jobId: MOCK_SCENARIO.jobId,
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
