import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  InMemoryFeishuProjection,
  MockWpsProductAdapter,
  VOLCANO_CASE_ID,
  createBakeoffHarness,
  type Artifact,
  type BakeoffJobOutcome,
  type ArtifactScorecard,
  type RenderManifest,
  type ProductAdapterPort,
  type ProductRunCommand,
} from "../src/index.ts";

type CapturedBakeoffOutcome = BakeoffJobOutcome & {
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
  readonly scorecard: ArtifactScorecard;
};

function requireCaptured(
  outcome: BakeoffJobOutcome,
): asserts outcome is CapturedBakeoffOutcome {
  assert.notEqual(outcome.artifact, null);
  assert.notEqual(outcome.renderManifest, null);
  assert.notEqual(outcome.scorecard, null);
}

function createFixedMockHarness(feishu: InMemoryFeishuProjection) {
  return createBakeoffHarness({
    feishu,
    productAdapter: new MockWpsProductAdapter(),
  });
}

test("a test Bakeoff Job freezes the 16-page volcano Case and creates MOCK parent, WPS Run, and Attempt records", async () => {
  const feishu = new InMemoryFeishuProjection();
  const harness = createFixedMockHarness(feishu);

  const outcome = await harness.startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const projection = feishu.snapshot();

  assert.equal(outcome.job.status, "completed");
  assert.equal(outcome.job.provenance, "MOCK");
  assert.equal(projection.caseTable.length, 1);
  assert.deepEqual(projection.caseTable[0], {
    recordId: "MOCK-case-volcano-query-v1",
    provenance: "MOCK",
    environmentOrigin: {
      originId: "test:mock-bakeoff-v1",
      environment: "test",
    },
    caseId: VOLCANO_CASE_ID,
    caseVersion: 1,
    track: "query_generation",
    title: "火山为什么会喷发",
    targetPageCount: 16,
    audience: "初中生",
    readingMode: "self_reading",
    vendorPrompt:
      "为初中生制作一份供自主阅读的 16 页《火山为什么会喷发》科普 PPT。共 16 页：第 1 页为封面，第 2 页为目录，第 3–15 页为正文，第 16 页为总结/知识回顾；不要单独的封底或致谢页。",
  });
  assert.deepEqual(
    projection.runRecordTable.map((record) => ({
      recordId: record.recordId,
      recordType: record.recordType,
      jobId: record.jobId,
      parentRecordId: record.parentRecordId,
      product: record.product,
      status: record.status,
      provenance: record.provenance,
    })),
    [
      {
        recordId: "MOCK-job-volcano-v1",
        recordType: "bakeoff_job",
        jobId: "MOCK-job-volcano-v1",
        parentRecordId: null,
        product: null,
        status: "completed",
        provenance: "MOCK",
      },
      {
        recordId: "MOCK-run-wps-volcano-v1",
        recordType: "vendor_run",
        jobId: "MOCK-job-volcano-v1",
        parentRecordId: "MOCK-job-volcano-v1",
        product: "Mock WPS AI PPT",
        status: "completed",
        provenance: "MOCK",
      },
      {
        recordId: "MOCK-run-wps-volcano-v1-attempt-1",
        recordType: "evaluation_attempt",
        jobId: "MOCK-job-volcano-v1",
        parentRecordId: "MOCK-run-wps-volcano-v1",
        product: "Mock WPS AI PPT",
        status: "completed",
        provenance: "MOCK",
      },
    ],
  );
});

test("the completed Mock WPS Run captures one content-addressed PPT Artifact and 16 static renders", async () => {
  const firstFeishu = new InMemoryFeishuProjection();
  const firstOutcome = await createFixedMockHarness(
    firstFeishu,
  ).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const secondOutcome = await createFixedMockHarness(
    new InMemoryFeishuProjection(),
  ).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  requireCaptured(firstOutcome);
  requireCaptured(secondOutcome);

  assert.equal(firstOutcome.artifact.provenance, "MOCK");
  assert.equal(firstOutcome.artifact.filename, "MOCK-wps-volcano-16.pptx");
  assert.equal(
    firstOutcome.artifact.mimeType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  assert.equal(firstOutcome.artifact.pageCount, 16);
  assert.equal(firstOutcome.artifact.byteSize, 27_655);
  assert.equal(
    firstOutcome.artifact.contentHash,
    "sha256:fadcc2150e1d5262efa0ba3364c0665b59efd1fd0b536fa65fdc19b7b4613942",
  );
  assert.deepEqual(
    Array.from(firstOutcome.artifact.content.subarray(0, 2)),
    [0x50, 0x4b],
  );
  assert.equal(
    firstOutcome.artifact.contentHash,
    secondOutcome.artifact.contentHash,
  );

  assert.equal(firstOutcome.renderManifest.provenance, "MOCK");
  assert.equal(
    firstOutcome.renderManifest.artifactId,
    firstOutcome.artifact.artifactId,
  );
  assert.equal(firstOutcome.renderManifest.renderer, "mock-static-svg@1");
  assert.equal(firstOutcome.renderManifest.pageCount, 16);
  assert.equal(
    firstOutcome.renderManifest.contentHash,
    "sha256:d5905033ed901384ae1605cf439686e63c60afb440498a459bfc8b5929835dee",
  );
  assert.deepEqual(
    firstOutcome.renderManifest.slides.map((slide) => slide.pageNumber),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.ok(
    firstOutcome.renderManifest.slides.every(
      (slide) =>
        slide.mimeType === "image/svg+xml" &&
        slide.content.includes("<svg") &&
        slide.content.includes("MOCK") &&
        /^sha256:[a-f0-9]{64}$/.test(slide.contentHash),
    ),
  );
  assert.deepEqual(
    firstOutcome.renderManifest.slides.map(({ contentHash }) => contentHash),
    secondOutcome.renderManifest.slides.map(({ contentHash }) => contentHash),
  );

  const wpsRun = firstFeishu
    .snapshot()
    .runRecordTable.find(({ recordType }) => recordType === "vendor_run");
  assert.equal(wpsRun?.artifactId, firstOutcome.artifact.artifactId);
  assert.equal(
    wpsRun?.renderManifestId,
    firstOutcome.renderManifest.renderManifestId,
  );
});

test("the captured Artifact receives one deterministic six-dimension 1–5 scorecard with page evidence", async () => {
  const firstFeishu = new InMemoryFeishuProjection();
  const firstOutcome = await createFixedMockHarness(
    firstFeishu,
  ).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const secondOutcome = await createFixedMockHarness(
    new InMemoryFeishuProjection(),
  ).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  requireCaptured(firstOutcome);
  requireCaptured(secondOutcome);

  assert.equal(firstOutcome.scorecard.provenance, "MOCK");
  assert.equal(
    firstOutcome.scorecard.artifactId,
    firstOutcome.artifact.artifactId,
  );
  assert.deepEqual(
    firstOutcome.scorecard.dimensions.map(({ dimension, value }) => ({
      dimension,
      value,
    })),
    [
      {
        dimension: "requirement_understanding_and_content_coverage",
        value: 5,
      },
      { dimension: "factual_accuracy_and_content_quality", value: 5 },
      { dimension: "narrative_and_audience_fit", value: 4 },
      {
        dimension: "visual_aesthetics_and_professional_finish",
        value: 4,
      },
      { dimension: "layout_hierarchy_and_readability", value: 4 },
      {
        dimension: "imagery_chart_and_information_expression",
        value: 3,
      },
    ],
  );
  assert.ok(
    firstOutcome.scorecard.dimensions.every(
      ({ value, evidencePages, rationale }) =>
        value !== null &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 5 &&
        evidencePages.length > 0 &&
        evidencePages.every((page) => page >= 1 && page <= 16) &&
        rationale.length > 0 &&
        rationale.length <= 120,
    ),
  );
  assert.deepEqual(firstOutcome.scorecard, secondOutcome.scorecard);
  assert.equal(
    Object.prototype.hasOwnProperty.call(firstOutcome.scorecard, "total"),
    false,
  );

  const artifactScoreRecord = firstFeishu.snapshot().artifactScoreTable[0];
  assert.equal(artifactScoreRecord?.provenance, "MOCK");
  assert.deepEqual(artifactScoreRecord?.artifact, firstOutcome.artifact);
  assert.deepEqual(
    artifactScoreRecord?.renderManifest,
    firstOutcome.renderManifest,
  );
  assert.deepEqual(artifactScoreRecord?.scorecard, firstOutcome.scorecard);
});

test("the Feishu domain tables keep Artifact capture independent from scoring and link a minimal report", async () => {
  const feishu = new InMemoryFeishuProjection();
  const outcome = await createFixedMockHarness(feishu).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  requireCaptured(outcome);
  const projection = feishu.snapshot();

  assert.deepEqual(
    Object.keys(projection)
      .filter((key) => key.endsWith("Table"))
      .sort(),
    [
      "adjudicationEventTable",
      "artifactScoreTable",
      "capturedArtifactTable",
      "caseTable",
      "gapCardWorkflowEventTable",
      "githubIssueLinkEventTable",
      "productGapCardTable",
      "reviewEventTable",
      "runRecordTable",
    ],
  );
  assert.equal(projection.caseTable.length, 1);
  assert.equal(projection.runRecordTable.length, 3);
  assert.equal(projection.capturedArtifactTable.length, 1);
  assert.equal(projection.artifactScoreTable.length, 1);
  assert.deepEqual(projection.productGapCardTable, []);

  assert.equal(outcome.report.provenance, "MOCK");
  assert.match(outcome.report.title, /^MOCK/);
  assert.equal(outcome.report.jobId, outcome.job.jobId);
  assert.deepEqual(outcome.report.runIds, ["MOCK-run-wps-volcano-v1"]);
  assert.deepEqual(outcome.report.artifactIds, [outcome.artifact.artifactId]);
  assert.equal(outcome.report.claimLevel, "case_sample");
  assert.match(outcome.report.markdown, /^# MOCK/m);
  assert.match(outcome.report.markdown, /Case Sample/);
  assert.match(outcome.report.markdown, /MOCK-job-volcano-v1/);
  assert.match(outcome.report.markdown, /MOCK-artifact-wps-volcano-v1/);
  assert.match(outcome.report.markdown, /不生成总分或总冠军/);
  assert.equal(projection.reports.length, 1);
  assert.deepEqual(projection.reports[0], outcome.report);

  const parentRecord = projection.runRecordTable.find(
    ({ recordType }) => recordType === "bakeoff_job",
  );
  assert.equal(parentRecord?.reportUrl, outcome.report.url);
  assert.match(parentRecord?.reportUrl ?? "", /^mock-feishu:\/\//);
});

test("the public product adapter port can be replaced without changing the Bakeoff Job seam", async () => {
  const fixedMockAdapter = new MockWpsProductAdapter();
  const replacementAdapter: ProductAdapterPort = {
    productPackage: {
      ...fixedMockAdapter.productPackage,
      packageId: "MOCK-replacement-package-v1",
      displayName: "Replacement Playwright-ready WPS Adapter",
      adapterVersion: "replacement-test@1",
    },
    async execute(command: ProductRunCommand): Promise<Artifact> {
      const artifact = await fixedMockAdapter.execute(command);
      return {
        ...artifact,
        filename: "MOCK-replacement-wps-volcano-16.pptx",
      };
    },
  };
  const feishu = new InMemoryFeishuProjection();

  const outcome = await createBakeoffHarness({
    feishu,
    productAdapter: replacementAdapter,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  requireCaptured(outcome);

  assert.equal(
    feishu.snapshot().runRecordTable[1]?.product,
    "Replacement Playwright-ready WPS Adapter",
  );
  assert.equal(
    feishu.snapshot().runRecordTable[1]?.productPackageId,
    "MOCK-replacement-package-v1",
  );
  assert.equal(
    outcome.artifact.filename,
    "MOCK-replacement-wps-volcano-16.pptx",
  );
});

test("the Bakeoff Job rejects an adapter Artifact whose bytes no longer match its content hash", async () => {
  const fixedMockAdapter = new MockWpsProductAdapter();
  const tamperingAdapter: ProductAdapterPort = {
    productPackage: fixedMockAdapter.productPackage,
    async execute(command: ProductRunCommand): Promise<Artifact> {
      const artifact = await fixedMockAdapter.execute(command);
      const content = artifact.content.slice();
      content[100] = (content[100] ?? 0) ^ 0xff;
      return { ...artifact, content };
    },
  };
  const feishu = new InMemoryFeishuProjection();

  await assert.rejects(
    createBakeoffHarness({
      feishu,
      productAdapter: tamperingAdapter,
    }).startBakeoffJob({
      environment: "test",
      caseId: VOLCANO_CASE_ID,
    }),
    /Artifact content hash mismatch/,
  );
  assert.deepEqual(feishu.snapshot().runRecordTable, []);
  assert.deepEqual(feishu.snapshot().artifactScoreTable, []);
  assert.deepEqual(feishu.snapshot().reports, []);
});

test("Artifact byte changes with a valid new hash drive new static renders and evidence-based scores", async () => {
  const fixedMockAdapter = new MockWpsProductAdapter();
  const variantAdapter: ProductAdapterPort = {
    productPackage: {
      ...fixedMockAdapter.productPackage,
      packageId: "MOCK-content-variant-package-v1",
    },
    async execute(command: ProductRunCommand): Promise<Artifact> {
      const artifact = await fixedMockAdapter.execute(command);
      const original = Buffer.from("火山为什么会喷发");
      const replacement = Buffer.from("岩浆为什么会上升");
      assert.equal(original.byteLength, replacement.byteLength);
      const content = artifact.content.slice();
      const firstMatch = Buffer.from(content).indexOf(original);
      assert.notEqual(firstMatch, -1);
      content.set(replacement, firstMatch);
      return {
        ...artifact,
        content,
        contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      };
    },
  };
  const fixedOutcome = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapter: fixedMockAdapter,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  const variantOutcome = await createBakeoffHarness({
    feishu: new InMemoryFeishuProjection(),
    productAdapter: variantAdapter,
  }).startBakeoffJob({
    environment: "test",
    caseId: VOLCANO_CASE_ID,
  });
  requireCaptured(fixedOutcome);
  requireCaptured(variantOutcome);

  assert.notEqual(
    variantOutcome.artifact.contentHash,
    fixedOutcome.artifact.contentHash,
  );
  assert.notEqual(
    variantOutcome.renderManifest.contentHash,
    fixedOutcome.renderManifest.contentHash,
  );
  assert.match(
    variantOutcome.renderManifest.slides[0]?.extractedText ?? "",
    /岩浆为什么会上升/,
  );
  assert.notDeepEqual(
    variantOutcome.scorecard.dimensions,
    fixedOutcome.scorecard.dimensions,
  );
});
