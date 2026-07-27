import type { EvaluationCaseRecord } from "../domain.ts";
import {
  MOCK_TEST_ENVIRONMENT_ORIGIN,
  PRODUCTION_ENVIRONMENT_ORIGIN,
} from "../environment-origin.ts";

export const VOLCANO_CASE_ID = "volcano-query-v1";

export const VOLCANO_EVALUATION_CASE: EvaluationCaseRecord = Object.freeze({
  recordId: "MOCK-case-volcano-query-v1",
  provenance: "MOCK",
  environmentOrigin: MOCK_TEST_ENVIRONMENT_ORIGIN,
  dataClassification: "public_or_synthetic",
  sourceOwner: "ppt-evaluation-harness",
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

export const PRODUCTION_VOLCANO_EVALUATION_CASE: EvaluationCaseRecord =
  Object.freeze({
    ...VOLCANO_EVALUATION_CASE,
    recordId: "production-case-volcano-query-v1",
    provenance: "PRODUCTION",
    environmentOrigin: PRODUCTION_ENVIRONMENT_ORIGIN,
  });
