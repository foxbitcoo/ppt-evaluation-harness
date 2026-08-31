import assert from "node:assert/strict";
import test from "node:test";

import {
  PRESENTATION_REPORT_DIMENSIONS,
  PRESENTATION_REPORT_INDEX_VERSION,
  aggregatePresentationReport,
  type PresentationReportInput,
} from "../reporting/presentation-report-index.ts";

function validInput(): PresentationReportInput {
  return {
    reportIndexVersion: PRESENTATION_REPORT_INDEX_VERSION,
    rubricVersion: "query-ppt-rubric@1.1.0",
    artifactId: "artifact-a",
    dimensions: [
      {
        dimension: "content_accuracy_coverage",
        status: "SCORED",
        score: 22,
        evidenceIds: ["e-content"],
        rationale: "核心事实正确，遗漏一项次要边界。",
      },
      {
        dimension: "narrative_plain_language",
        status: "SCORED",
        score: 17,
        evidenceIds: ["e-narrative"],
        rationale: "故事线完整。",
      },
      {
        dimension: "visual_hierarchy_consistency",
        status: "SCORED",
        score: 8,
        evidenceIds: ["e-hierarchy"],
        rationale: "层级明确。",
      },
      {
        dimension: "visual_use",
        status: "SCORED",
        score: 7,
        evidenceIds: ["e-visual"],
        rationale: "图片承担解释任务。",
      },
      {
        dimension: "readability_static_finish",
        status: "SCORED",
        score: 12,
        evidenceIds: ["e-readability"],
        rationale: "静态完成度较好。",
      },
    ],
    presentationEffectiveness: {
      status: "SCORED",
      score: 8,
      evidenceIds: ["e-deck"],
      rationale: "可以支撑现场讲述。",
    },
    strongestPage: {
      pageNumber: 4,
      evidenceIds: ["e-page-4"],
      reason: "图文关系最清楚。",
    },
    weakestPage: {
      pageNumber: 7,
      evidenceIds: ["e-page-7"],
      reason: "正文偏小。",
    },
    findings: [
      {
        findingId: "finding-1",
        kind: "CONTENT_OMISSION",
        deductionOwner: "content_accuracy_coverage",
        evidenceIds: ["e-content"],
        pageNumbers: [5],
        description: "遗漏适用边界。",
      },
      {
        findingId: "finding-2",
        kind: "LAYOUT_READABILITY",
        deductionOwner: "readability_static_finish",
        evidenceIds: ["e-page-7"],
        pageNumbers: [7],
        description: "正文在投影距离下偏小。",
      },
    ],
    operationalCapabilities: [
      {
        capability: "editable_source",
        status: "UNVERIFIED",
        evidenceIds: [],
        note: "静态页面无法判断。",
      },
      {
        capability: "pptx_export",
        status: "VERIFIED",
        evidenceIds: ["e-export"],
        note: "原始 PPTX 已打开验证。",
      },
    ],
    scenarioRecommendations: ["视觉解释最好", "适合现场讲"],
  };
}

test("v0.2 aggregates exactly five integer static dimensions to an 80-point total", () => {
  assert.deepEqual(
    PRESENTATION_REPORT_DIMENSIONS.map(({ dimension, maxScore }) => ({
      dimension,
      maxScore,
    })),
    [
      { dimension: "content_accuracy_coverage", maxScore: 25 },
      { dimension: "narrative_plain_language", maxScore: 20 },
      { dimension: "visual_hierarchy_consistency", maxScore: 10 },
      { dimension: "visual_use", maxScore: 10 },
      { dimension: "readability_static_finish", maxScore: 15 },
    ],
  );

  const report = aggregatePresentationReport(validInput());

  assert.equal(report.calibrationStatus, "PROVISIONAL_SCORE_NOT_CALIBRATED");
  assert.equal(report.staticAssessmentStatus, "SCORED");
  assert.equal(report.staticTotal, 66);
  assert.equal(report.presentationEffectiveness.score, 8);
  assert.equal(report.presentationEffectivenessIncludedInStaticTotal, false);
  assert.deepEqual(report.contentErrors, []);
  assert.equal(report.contentOmissions.length, 1);
  assert.deepEqual(report.unverifiedCapabilities, ["editable_source"]);
});

test("an unknown static dimension keeps the report not assessable instead of inventing a total", () => {
  const input = validInput();
  const report = aggregatePresentationReport({
    ...input,
    dimensions: input.dimensions.map((assessment) =>
      assessment.dimension === "visual_use"
        ? {
            ...assessment,
            status: "UNKNOWN" as const,
            score: null,
            evidenceIds: [],
            rationale: "缺少原尺寸图片。",
          }
        : assessment,
    ),
  });

  assert.equal(report.staticAssessmentStatus, "NOT_ASSESSABLE");
  assert.equal(report.staticTotal, null);
});

test("fractional, out-of-range, duplicate, and evidence-free scored dimensions are rejected", () => {
  const base = validInput();

  for (const dimensions of [
    base.dimensions.map((item) =>
      item.dimension === "visual_use" ? { ...item, score: 7.5 } : item,
    ),
    base.dimensions.map((item) =>
      item.dimension === "visual_use" ? { ...item, score: 11 } : item,
    ),
    [...base.dimensions, base.dimensions[0]!],
    base.dimensions.map((item) =>
      item.dimension === "visual_use" ? { ...item, evidenceIds: [] } : item,
    ),
  ]) {
    assert.throws(() =>
      aggregatePresentationReport({ ...base, dimensions }),
    );
  }
});

test("each finding owns exactly one deduction dimension and duplicate finding ids are rejected", () => {
  const base = validInput();
  assert.throws(
    () =>
      aggregatePresentationReport({
        ...base,
        findings: [...base.findings, base.findings[0]!],
      }),
    /duplicate findingId/i,
  );
});

test("operational delivery evidence stays outside static scoring and verified claims require evidence", () => {
  const base = validInput();
  assert.throws(
    () =>
      aggregatePresentationReport({
        ...base,
        operationalCapabilities: [
          {
            capability: "speaker_mode",
            status: "VERIFIED",
            evidenceIds: [],
            note: "只有入口截图。",
          },
        ],
      }),
    /operational capability evidence/i,
  );
});
