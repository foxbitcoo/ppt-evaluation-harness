import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EVALUATION_FIELD_CATALOG,
  EVALUATION_COMPARISON_MAPPING_REGISTRY,
  MAX_QUERY_GENERATION_PAGE_COUNT,
  createEvaluationInput,
  createEvaluationResult,
  createQuestionBankCase,
  toFeishuEvaluationLabel,
  type CreateEvaluationResultInput,
} from "../evaluation/index.ts";

const hash = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as const;

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

function createVolcanoEvaluationInput() {
  const questionBankCase = createVolcanoQuestionBankCase();
  return createEvaluationInput({
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
      pages: [{
        pageNumber: 1,
        pageRole: "cover",
        imageHash: hash(new Uint8Array([1, 2, 3])),
        image: new Uint8Array([1, 2, 3]),
        extractedText: "火山为什么会喷发",
        extractedTextHash: hash("火山为什么会喷发"),
        elements: [
          {
            elementId: "slide-1-image-1",
            kind: "IMAGE",
            bounds: { x: 40, y: 80, width: 500, height: 260 },
            renderedCropHash: hash(new Uint8Array([4, 5, 6])),
            renderedCrop: new Uint8Array([4, 5, 6]),
            altText: "喷发中的火山",
          },
          {
            elementId: "slide-1-text-1",
            kind: "TEXT_BOX",
            bounds: { x: 40, y: 360, width: 500, height: 120 },
            text: "火山为什么会喷发",
            textHash: hash("火山为什么会喷发"),
            styleSnapshot: {
              fontFamilies: ["方正兰亭黑"],
              minimumFontSizePt: 28,
              maximumFontSizePt: 40,
              overflowDetected: false,
            },
          },
        ],
      }],
    },
    referencePack: { contentHash: null, facts: [] },
    evaluationProtocol: {
      rubricHash: `sha256:${"a".repeat(64)}`,
      aggregationSpecHash: `sha256:${"2".repeat(64)}`,
      batchProtocolHash: `sha256:${"3".repeat(64)}`,
      promptVersion: "tri-state-judge-v1",
      judge: { kind: "real", provider: "openai", model: "production-model" },
    },
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

test("QuestionBankCase hash is canonical across nested property insertion order", () => {
  const baseline = createVolcanoQuestionBankCase();
  const { caseHash: _caseHash, vendorPrompt: _vendorPrompt, schemaVersion: _schemaVersion, track: _track, ...input } = baseline;
  const reordered = createQuestionBankCase({
    ...input,
    requesterPersona: {
      domain: baseline.requesterPersona.domain,
      grade: baseline.requesterPersona.grade!,
      subject: baseline.requesterPersona.subject!,
      experienceLevel: baseline.requesterPersona.experienceLevel,
      roleDescription: baseline.requesterPersona.roleDescription,
      role: baseline.requesterPersona.role,
      personaId: baseline.requesterPersona.personaId,
    },
    vendorPromptTemplateVersion: baseline.vendorPrompt.templateVersion,
  });
  assert.equal(reordered.caseHash, baseline.caseHash);
});

test("QuestionBankCase public enums and Rubric identity fail closed at runtime", () => {
  const baseline = createVolcanoQuestionBankCase();
  const { caseHash: _caseHash, vendorPrompt: _vendorPrompt, schemaVersion: _schemaVersion, track: _track, ...input } = baseline;
  assert.throws(() => createQuestionBankCase({
    ...input,
    requesterPersona: { ...input.requesterPersona, role: "ALIEN" as never },
    vendorPromptTemplateVersion: baseline.vendorPrompt.templateVersion,
  }), /requesterPersona.role 枚举值无效/);
  assert.throws(() => createQuestionBankCase({
    ...input,
    reviewState: "PUBLISHED" as never,
    vendorPromptTemplateVersion: baseline.vendorPrompt.templateVersion,
  }), /reviewState 枚举值无效/);
  assert.throws(() => createQuestionBankCase({
    ...input,
    evaluatorContext: {
      ...input.evaluatorContext,
      rubricRef: { ...input.evaluatorContext.rubricRef, rubricHash: "not-a-hash" as never },
    },
    vendorPromptTemplateVersion: baseline.vendorPrompt.templateVersion,
  }), /rubricHash 必须是 sha256 哈希/);
});

test("EvaluationInput exposes deck, slide, image, and text-box targets and enforces the real-judge production boundary", () => {
  const evaluationInput = createVolcanoEvaluationInput();

  assert.equal(evaluationInput.schemaVersion, "evaluation-input-v1");
  assert.equal(evaluationInput.staticSurface.pages[0]?.elements[0]?.kind, "IMAGE");
  assert.equal(evaluationInput.staticSurface.pages[0]?.elements[1]?.kind, "TEXT_BOX");
  assert.deepEqual(EVALUATION_FIELD_CATALOG.targetScopes, [
    { value: "DECK", labelZh: "整份 PPT" },
    { value: "SLIDE", labelZh: "单页" },
    { value: "ELEMENT", labelZh: "页面元素" },
  ]);
  const pageBytes = evaluationInput.staticSurface.pages[0]!.image;
  pageBytes[0] = 9;
  pageBytes.subarray(1)[0] = 8;
  new Uint8Array(pageBytes.buffer)[2] = 7;
  assert.deepEqual([...evaluationInput.staticSurface.pages[0]!.image], [1, 2, 3]);
  assert.equal(hash(evaluationInput.staticSurface.pages[0]!.image), hash(new Uint8Array([1, 2, 3])));
  const imageElement = evaluationInput.staticSurface.pages[0]!.elements[0]!;
  assert.equal(imageElement.kind, "IMAGE");
  if (imageElement.kind === "IMAGE") imageElement.renderedCrop.fill(9);
  assert.deepEqual(
    [...(evaluationInput.staticSurface.pages[0]!.elements[0]! as { renderedCrop: Uint8Array }).renderedCrop],
    [4, 5, 6],
  );
  const {
    schemaVersion: _schemaVersion,
    evaluationInputHash: _evaluationInputHash,
    ...evaluationInputPayload
  } = evaluationInput;
  const changedAltText = createEvaluationInput({
    ...evaluationInputPayload,
    staticSurface: {
      ...evaluationInput.staticSurface,
      pages: evaluationInput.staticSurface.pages.map((page) => ({
        ...page,
        elements: page.elements.map((element) => element.kind === "IMAGE"
          ? { ...element, altText: "已改写的图片说明" }
          : element),
      })),
    },
  });
  assert.notEqual(changedAltText.evaluationInputHash, evaluationInput.evaluationInputHash);

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

  assert.throws(
    () => createEvaluationInput({
      ...evaluationInput,
      artifact: { ...evaluationInput.artifact, provenance: "MOCK" },
    }),
    /生产评测不能使用 Mock Artifact/,
  );

  assert.throws(
    () => createEvaluationInput({
      ...evaluationInput,
      staticSurface: {
        ...evaluationInput.staticSurface,
        pages: evaluationInput.staticSurface.pages.map((page) => ({
          ...page,
          imageHash: `sha256:${"0".repeat(64)}`,
        })),
      },
    }),
    /图片哈希不匹配/,
  );
});

test("EvaluationResult keeps target hierarchy separate from dimension aggregation and Evidence", () => {
  const evaluationInput = createVolcanoEvaluationInput();
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
    evaluationInput,
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
      mappingVersion: "query-atomic-dimensions-v1",
      mappingHash: EVALUATION_COMPARISON_MAPPING_REGISTRY["query-atomic-dimensions-v1"].mappingHash,
      axes: [
        {
          axisId: "audience_fit",
          sourceDimensionIds: ["audience_fit"],
          goodRate: 1,
          badRate: 0,
          uncertainRate: 0,
          denominator: 1,
          comparable: true,
        },
        {
          axisId: "layout_hierarchy",
          sourceDimensionIds: ["layout_hierarchy"],
          goodRate: 0,
          badRate: 0,
          uncertainRate: 1,
          denominator: 1,
          comparable: false,
        },
        {
          axisId: "image_quality_and_fit",
          sourceDimensionIds: ["image_quality_and_fit"],
          goodRate: 0,
          badRate: 1,
          uncertainRate: 0,
          denominator: 1,
          comparable: true,
        },
        {
          axisId: "text_readability",
          sourceDimensionIds: ["text_readability"],
          goodRate: 0,
          badRate: 0,
          uncertainRate: 1,
          denominator: 1,
          comparable: false,
        },
      ],
      rankStatus: "EXPLORATORY_ONLY",
    },
    lineage: {
      evaluationInputHash: evaluationInput.evaluationInputHash,
      referencePackHash: evaluationInput.referencePack.contentHash,
      caseHash: evaluationInput.questionBankCase.caseHash,
      artifactHash: evaluationInput.artifact.contentHash,
      renderManifestHash: evaluationInput.staticSurface.renderManifestHash,
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

  const invalidLabel = structuredClone(resultInput) as CreateEvaluationResultInput;
  (invalidLabel.tree.assessments[0]!.judgments[0] as { label: string }).label = "BROKEN";
  assert.throws(() => createEvaluationResult(invalidLabel), /label 枚举值无效/);

  const forgedVector: CreateEvaluationResultInput = {
    ...resultInput,
    comparisonVector: {
      ...resultInput.comparisonVector,
      axes: resultInput.comparisonVector.axes.map((axis) => ({
        ...axis,
        goodRate: 999,
      })),
    },
  };
  assert.throws(() => createEvaluationResult(forgedVector), /与原子判断聚合结果不一致/);

  const selectiveVector: CreateEvaluationResultInput = {
    ...resultInput,
    comparisonVector: {
      ...resultInput.comparisonVector,
      axes: resultInput.comparisonVector.axes.filter(({ axisId }) => axisId !== "audience_fit"),
    },
  };
  assert.throws(() => createEvaluationResult(selectiveVector), /比较轴集合与注册映射不一致/);

  const missingElementTarget: CreateEvaluationResultInput = {
    ...resultInput,
    tree: {
      ...resultInput.tree,
      targets: resultInput.tree.targets.filter(({ targetId }) => targetId !== "image-1"),
      assessments: resultInput.tree.assessments.filter(({ targetId }) => targetId !== "image-1"),
      evidence: resultInput.tree.evidence.filter(({ targetId }) => targetId !== "image-1"),
    },
  };
  assert.throws(() => createEvaluationResult(missingElementTarget), /完整覆盖 EvaluationInput 的所有页面元素/);

  const duplicateElementTarget: CreateEvaluationResultInput = {
    ...resultInput,
    tree: {
      ...resultInput.tree,
      targets: resultInput.tree.targets.map((target) => target.targetId === "text-1"
        ? { ...target, elementId: "slide-1-image-1", elementKind: "IMAGE" as const }
        : target),
    },
  };
  assert.throws(() => createEvaluationResult(duplicateElementTarget), /元素定位必须唯一且完整/);

  const deckEvidenceWithFakePage: CreateEvaluationResultInput = {
    ...resultInput,
    tree: {
      ...resultInput.tree,
      evidence: resultInput.tree.evidence.map((evidence) => evidence.evidenceId === "evidence-deck"
        ? { ...evidence, pageNumber: 999 }
        : evidence),
    },
  };
  assert.throws(() => createEvaluationResult(deckEvidenceWithFakePage), /Deck Evidence .*引用了不存在的页面/);

  const emptyResponseId: CreateEvaluationResultInput = {
    ...resultInput,
    lineage: {
      ...resultInput.lineage,
      judge: { ...resultInput.lineage.judge, responseIds: [""] },
    },
  };
  assert.throws(() => createEvaluationResult(emptyResponseId), /真实 Judge responseId/);

  const emptyEvaluation: CreateEvaluationResultInput = {
    ...resultInput,
    tree: { ...resultInput.tree, assessments: [], evidence: [] },
    comparisonVector: { ...resultInput.comparisonVector, axes: [] },
  };
  assert.throws(() => createEvaluationResult(emptyEvaluation), /至少需要一条 Assessment/);

  const brokenLineage: CreateEvaluationResultInput = {
    ...resultInput,
    lineage: {
      ...resultInput.lineage,
      rubricHash: `sha256:${"9".repeat(64)}`,
    },
  };
  assert.throws(() => createEvaluationResult(brokenLineage), /lineage 与已验证 EvaluationInput 不一致/);
});
