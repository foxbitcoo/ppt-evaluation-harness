import assert from "node:assert/strict";
import test from "node:test";

import {
  EVALUATION_FIELD_CATALOG,
  MAX_QUERY_GENERATION_PAGE_COUNT,
  createEvaluationInput,
  createEvaluationResult,
  createQuestionBankCase,
  toFeishuEvaluationLabel,
  type CreateEvaluationResultInput,
} from "../evaluation/index.ts";

function createVolcanoQuestionBankCase() {
  return createQuestionBankCase({
    caseId: "query-volcano-teacher-001",
    caseVersion: 2,
    requesterPersona: {
      personaId: "teacher-middle-school",
      role: "teacher",
      roleDescription: "初中地理老师",
      experienceLevel: "intermediate",
      domain: "education",
      subject: "地理",
      grade: "初一",
    },
    presentationAudience: {
      audienceId: "middle-school-grade-1",
      description: "初一学生",
      priorKnowledge: "low",
      readingMode: "self_reading",
    },
    useContext: {
      occasion: "classroom",
      objective: "让学生理解火山喷发的基本机制",
      targetPageCount: 16,
    },
    query: "制作一份《火山为什么会喷发》的科普 PPT。",
    intentConfirmation: {
      status: "confirmed",
      source: "vendor_confirmation",
      confirmedAt: "2026-08-03T09:30:00.000Z",
    },
    evaluatorContext: {
      explicitRequirements: ["适合初一学生"],
      requiredFacts: ["岩浆中的气体与压力变化"],
      expectedCoverage: ["火山结构", "喷发机制"],
      referencePackMode: "automatic",
      rubricRef: {
        rubricId: "query-ppt-rubric",
        rubricVersion: "1.1.0",
        rubricHash: `sha256:${"a".repeat(64)}`,
      },
    },
    vendorPromptTemplateVersion: "query-persona-audience-v1",
    author: "evaluation-team",
    reviewState: "reviewed",
  });
}

test("QuestionBankCase keeps requester and audience separate, injects both into the vendor prompt, and caps page count", () => {
  const evaluationCase = createVolcanoQuestionBankCase();

  assert.equal(evaluationCase.requesterPersona.roleDescription, "初中地理老师");
  assert.equal(evaluationCase.presentationAudience.description, "初一学生");
  assert.match(evaluationCase.vendorPrompt.text, /请求者人设：初中地理老师/);
  assert.match(evaluationCase.vendorPrompt.text, /PPT 受众：初一学生/);
  assert.match(evaluationCase.vendorPrompt.text, /页数要求：16 页以内/);
  assert.match(evaluationCase.vendorPrompt.text, /用户 Query：制作一份/);
  assert.match(evaluationCase.vendorPrompt.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(evaluationCase.caseHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(evaluationCase.intentConfirmation.source, "vendor_confirmation");
  assert.equal(MAX_QUERY_GENERATION_PAGE_COUNT, 20);
  assert.deepEqual(EVALUATION_FIELD_CATALOG.evaluationLabels, [
    { value: "GOOD", labelZh: "好" },
    { value: "BAD", labelZh: "不好" },
    { value: "UNCERTAIN", labelZh: "不确定" },
  ]);

  assert.throws(
    () =>
      createQuestionBankCase({
        ...evaluationCase,
        useContext: {
          ...evaluationCase.useContext,
          targetPageCount: 21,
        },
        vendorPromptTemplateVersion: "query-persona-audience-v1",
      }),
    /目标页数必须是 1到20 之间的整数/,
  );
});

test("EvaluationInput exposes deck, slide, image, and text-box targets and enforces the real-judge production boundary", () => {
  const questionBankCase = createVolcanoQuestionBankCase();
  const evaluationInput = createEvaluationInput({
    evaluationId: "evaluation-volcano-wps-001",
    mode: "production",
    questionBankCase,
    artifact: {
      artifactId: "artifact-wps-volcano-001",
      runId: "run-wps-volcano-001",
      jobId: "job-volcano-001",
      provenance: "LIVE_PRODUCTION",
      contentHash: `sha256:${"b".repeat(64)}`,
      pageCount: 1,
    },
    staticSurface: {
      surfaceClass: "canonical",
      renderManifestHash: `sha256:${"c".repeat(64)}`,
      fidelity: "verified",
      pages: [
        {
          pageNumber: 1,
          pageRole: "cover",
          imageHash: `sha256:${"d".repeat(64)}`,
          image: new Uint8Array([1, 2, 3]),
          extractedText: "火山为什么会喷发",
          extractedTextHash: `sha256:${"e".repeat(64)}`,
          elements: [
            {
              elementId: "slide-1-image-1",
              kind: "IMAGE",
              bounds: { x: 40, y: 80, width: 500, height: 260 },
              renderedCropHash: `sha256:${"f".repeat(64)}`,
              renderedCrop: new Uint8Array([4, 5, 6]),
              altText: "喷发中的火山",
            },
            {
              elementId: "slide-1-text-1",
              kind: "TEXT_BOX",
              bounds: { x: 40, y: 360, width: 500, height: 120 },
              text: "火山为什么会喷发",
              textHash: `sha256:${"1".repeat(64)}`,
              styleSnapshot: {
                fontFamilies: ["方正兰亭黑"],
                minimumFontSizePt: 28,
                maximumFontSizePt: 40,
                overflowDetected: false,
              },
            },
          ],
        },
      ],
    },
    referencePack: {
      contentHash: null,
      facts: [],
    },
    evaluationProtocol: {
      rubricHash: `sha256:${"a".repeat(64)}`,
      aggregationSpecHash: `sha256:${"2".repeat(64)}`,
      batchProtocolHash: `sha256:${"3".repeat(64)}`,
      promptVersion: "tri-state-judge-v1",
      judge: {
        kind: "real",
        provider: "openai",
        model: "production-model",
      },
    },
  });

  assert.equal(evaluationInput.schemaVersion, "evaluation-input-v1");
  assert.equal(evaluationInput.staticSurface.pages[0]?.elements[0]?.kind, "IMAGE");
  assert.equal(evaluationInput.staticSurface.pages[0]?.elements[1]?.kind, "TEXT_BOX");
  assert.deepEqual(EVALUATION_FIELD_CATALOG.targetScopes, [
    { value: "DECK", labelZh: "整份 PPT" },
    { value: "SLIDE", labelZh: "单页" },
    { value: "ELEMENT", labelZh: "页面元素" },
  ]);

  assert.throws(
    () =>
      createEvaluationInput({
        ...evaluationInput,
        mode: "production",
        evaluationProtocol: {
          ...evaluationInput.evaluationProtocol,
          judge: {
            kind: "mock",
            provider: "deterministic-test-double",
            model: "mock-v1",
          },
        },
      }),
    /生产评测必须使用真实 Judge/,
  );

  assert.throws(
    () =>
      createEvaluationInput({
        ...evaluationInput,
        artifact: { ...evaluationInput.artifact, pageCount: 2 },
      }),
    /产物页数与静态渲染页数不一致/,
  );
});

test("EvaluationResult keeps target hierarchy separate from dimension aggregation and Evidence", () => {
  const rubricHash = `sha256:${"a".repeat(64)}` as const;
  const annotator = { kind: "real", provider: "openai", model: "production-model" } as const;
  const judgment = (
    judgmentId: string,
    label: "GOOD" | "BAD" | "UNCERTAIN",
    evidenceId: string,
    rationale: string,
    confidence: "LOW" | "MEDIUM" | "HIGH",
    uncertainReason: "INSUFFICIENT_EVIDENCE" | null = null,
  ) => ({
    judgmentId,
    batchId: "batch-initial-1",
    batchKind: "initial" as const,
    annotator,
    assessmentStatus: label === "UNCERTAIN" ? "NOT_ASSESSABLE" as const : "ASSESSED" as const,
    label,
    uncertainReason,
    confidence,
    evidenceIds: [evidenceId],
    rationale,
    rubricHash,
    createdAt: "2026-08-03T10:00:00.000Z",
  });

  const resultInput: CreateEvaluationResultInput = {
    evaluationId: "evaluation-volcano-wps-001",
    caseId: "query-volcano-teacher-001",
    artifactId: "artifact-wps-volcano-001",
    mode: "production",
    deliveryStatus: "PASS",
    tree: {
      rootTargetId: "deck-1",
      targets: [
        { targetId: "deck-1", parentTargetId: null, scope: "DECK", pageNumber: null, elementId: null, elementKind: null },
        { targetId: "slide-1", parentTargetId: "deck-1", scope: "SLIDE", pageNumber: 1, elementId: null, elementKind: null },
        { targetId: "image-1", parentTargetId: "slide-1", scope: "ELEMENT", pageNumber: 1, elementId: "slide-1-image-1", elementKind: "IMAGE" },
        { targetId: "text-1", parentTargetId: "slide-1", scope: "ELEMENT", pageNumber: 1, elementId: "slide-1-text-1", elementKind: "TEXT_BOX" },
      ],
      assessments: [
        {
          assessmentId: "assessment-deck-audience",
          targetId: "deck-1",
          dimensionId: "audience_fit",
          judgments: [judgment("judgment-deck", "GOOD", "evidence-deck", "整体适合初一学生。", "HIGH")],
        },
        {
          assessmentId: "assessment-slide-layout",
          targetId: "slide-1",
          dimensionId: "layout_hierarchy",
          judgments: [
            judgment("judgment-slide", "BAD", "evidence-slide", "标题与正文层级距离太近。", "HIGH"),
            {
              ...judgment("judgment-slide-repeat", "GOOD", "evidence-slide", "重复 Batch 认为层级可接受。", "MEDIUM"),
              batchId: "batch-repeat-1",
              batchKind: "repeat",
            },
          ],
        },
        {
          assessmentId: "assessment-image-quality",
          targetId: "image-1",
          dimensionId: "image_quality_and_fit",
          judgments: [judgment("judgment-image", "BAD", "evidence-image", "火山顶部被裁切。", "MEDIUM")],
        },
        {
          assessmentId: "assessment-text-readability",
          targetId: "text-1",
          dimensionId: "text_readability",
          judgments: [judgment("judgment-text", "UNCERTAIN", "evidence-text", "裁剪分辨率不足。", "LOW", "INSUFFICIENT_EVIDENCE")],
        },
      ],
      evidence: [
        { evidenceId: "evidence-deck", targetId: "deck-1", pageNumber: 1, elementId: null, kind: "VISUAL_OBSERVATION", observation: "概念均附带初学者解释。" },
        { evidenceId: "evidence-slide", targetId: "slide-1", pageNumber: 1, elementId: null, kind: "VISUAL_OBSERVATION", observation: "标题与首行间距过小。" },
        { evidenceId: "evidence-image", targetId: "image-1", pageNumber: 1, elementId: "slide-1-image-1", kind: "ELEMENT_CROP", observation: "图片上沿裁掉火山口。" },
        { evidenceId: "evidence-text", targetId: "text-1", pageNumber: 1, elementId: "slide-1-text-1", kind: "GATE", observation: "元素裁剪仅 40px 高。" },
      ],
    },
    comparisonVector: {
      mappingVersion: "query-strategic-axes-v1",
      axes: [{
        axisId: "visual_system",
        sourceDimensionIds: ["layout_hierarchy", "image_quality_and_fit", "text_readability"],
        goodRate: 0,
        badRate: 2 / 3,
        uncertainRate: 1 / 3,
        denominator: 3,
        comparable: true,
      }],
      rankStatus: "EXPLORATORY_ONLY",
    },
    lineage: {
      caseHash: `sha256:${"4".repeat(64)}`,
      artifactHash: `sha256:${"b".repeat(64)}`,
      renderManifestHash: `sha256:${"c".repeat(64)}`,
      rubricHash,
      aggregationSpecHash: `sha256:${"2".repeat(64)}`,
      batchProtocolHash: `sha256:${"3".repeat(64)}`,
      promptVersion: "tri-state-judge-v1",
      judge: { kind: "real", provider: "openai", model: "production-model", responseIds: ["response-001"] },
    },
  };

  const result = createEvaluationResult(resultInput);

  assert.equal(result.schemaVersion, "evaluation-result-v1");
  assert.equal(result.deliveryStatus, "PASS");
  assert.equal(result.tree.assessments.find(({ assessmentId }) => assessmentId === "assessment-image-quality")?.consensus.resolvedLabel, "BAD");
  assert.equal(result.tree.assessments.find(({ assessmentId }) => assessmentId === "assessment-text-readability")?.consensus.resolvedLabel, "UNCERTAIN");
  assert.deepEqual(
    result.tree.assessments.find(({ assessmentId }) => assessmentId === "assessment-slide-layout")?.consensus,
    {
      goodCount: 1,
      badCount: 1,
      uncertainCount: 0,
      totalCount: 2,
      resolvedLabel: "UNCERTAIN",
      rule: "unresolved",
      agreementStatus: "mixed",
      uncertainReasons: ["ANNOTATOR_DISAGREEMENT"],
    },
  );
  assert.deepEqual(
    result.dimensionProfile.find(({ dimensionId }) => dimensionId === "image_quality_and_fit"),
    {
      dimensionId: "image_quality_and_fit",
      scope: "ELEMENT",
      goodCount: 0,
      badCount: 1,
      uncertainCount: 0,
      assessableCount: 1,
    },
  );
  assert.equal(result.tree.evidence[2]?.kind, "ELEMENT_CROP");
  assert.equal(toFeishuEvaluationLabel("BAD"), "不好");
  assert.equal("score" in result, false);

  const invalidUncertain: CreateEvaluationResultInput = {
    ...resultInput,
    tree: {
      ...resultInput.tree,
      assessments: resultInput.tree.assessments.map((assessment) =>
        assessment.assessmentId === "assessment-text-readability"
          ? { ...assessment, judgments: assessment.judgments.map((item) => ({ ...item, uncertainReason: null })) }
          : assessment,
      ),
    },
  };
  assert.throws(() => createEvaluationResult(invalidUncertain), /UNCERTAIN 判断必须记录 uncertainReason/);
});
