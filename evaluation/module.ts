import { createHash } from "node:crypto";

export type Sha256Hash = `sha256:${string}`;

export const MAX_QUERY_GENERATION_PAGE_COUNT = 20 as const;

export const EVALUATION_FIELD_CATALOG = Object.freeze({
  evaluationLabels: Object.freeze([
    Object.freeze({ value: "GOOD", labelZh: "好" }),
    Object.freeze({ value: "BAD", labelZh: "不好" }),
    Object.freeze({ value: "UNCERTAIN", labelZh: "不确定" }),
  ]),
  confidenceLevels: Object.freeze([
    Object.freeze({ value: "LOW", labelZh: "低" }),
    Object.freeze({ value: "MEDIUM", labelZh: "中" }),
    Object.freeze({ value: "HIGH", labelZh: "高" }),
  ]),
  uncertainReasons: Object.freeze([
    Object.freeze({ value: "INSUFFICIENT_EVIDENCE", labelZh: "证据不足" }),
    Object.freeze({ value: "RUBRIC_UNDEFINED", labelZh: "评分标准未定义" }),
    Object.freeze({ value: "ANNOTATOR_DISAGREEMENT", labelZh: "标注结果分歧" }),
    Object.freeze({ value: "REFERENCE_MISSING", labelZh: "缺少事实参考材料" }),
  ]),
  targetScopes: Object.freeze([
    Object.freeze({ value: "DECK", labelZh: "整份 PPT" }),
    Object.freeze({ value: "SLIDE", labelZh: "单页" }),
    Object.freeze({ value: "ELEMENT", labelZh: "页面元素" }),
  ]),
  elementKinds: Object.freeze([
    Object.freeze({ value: "IMAGE", labelZh: "图片" }),
    Object.freeze({ value: "TEXT_BOX", labelZh: "文本框" }),
  ]),
  personaRoles: Object.freeze([
    Object.freeze({ value: "student", labelZh: "学生" }),
    Object.freeze({ value: "teacher", labelZh: "老师" }),
    Object.freeze({ value: "employee", labelZh: "打工人" }),
    Object.freeze({ value: "manager", labelZh: "管理者" }),
    Object.freeze({ value: "boss", labelZh: "老板" }),
    Object.freeze({ value: "other", labelZh: "其他" }),
  ]),
  experienceLevels: Object.freeze([
    Object.freeze({ value: "beginner", labelZh: "初级" }),
    Object.freeze({ value: "intermediate", labelZh: "中级" }),
    Object.freeze({ value: "expert", labelZh: "专家" }),
    Object.freeze({ value: "unknown", labelZh: "未知" }),
  ]),
  priorKnowledgeLevels: Object.freeze([
    Object.freeze({ value: "low", labelZh: "低" }),
    Object.freeze({ value: "medium", labelZh: "中" }),
    Object.freeze({ value: "high", labelZh: "高" }),
    Object.freeze({ value: "unknown", labelZh: "未知" }),
  ]),
  readingModes: Object.freeze([
    Object.freeze({ value: "self_reading", labelZh: "自主阅读" }),
    Object.freeze({ value: "presented_with_speaker", labelZh: "演讲者讲解" }),
  ]),
  occasions: Object.freeze([
    Object.freeze({ value: "classroom", labelZh: "课堂" }),
    Object.freeze({ value: "homework", labelZh: "作业" }),
    Object.freeze({ value: "meeting", labelZh: "会议" }),
    Object.freeze({ value: "sales", labelZh: "销售" }),
    Object.freeze({ value: "self_learning", labelZh: "自学" }),
    Object.freeze({ value: "other", labelZh: "其他" }),
  ]),
  intentConfirmationStatuses: Object.freeze([
    Object.freeze({ value: "not_requested", labelZh: "未请求确认" }),
    Object.freeze({ value: "pending", labelZh: "待确认" }),
    Object.freeze({ value: "confirmed", labelZh: "已确认" }),
  ]),
  intentConfirmationSources: Object.freeze([
    Object.freeze({ value: "case_author", labelZh: "题库作者" }),
    Object.freeze({ value: "vendor_confirmation", labelZh: "厂商意图确认" }),
  ]),
  evaluationModes: Object.freeze([
    Object.freeze({ value: "mock", labelZh: "测试" }),
    Object.freeze({ value: "production", labelZh: "正式评测" }),
  ]),
  deliveryStatuses: Object.freeze([
    Object.freeze({ value: "PASS", labelZh: "通过" }),
    Object.freeze({ value: "FAIL", labelZh: "失败" }),
    Object.freeze({ value: "UNKNOWN", labelZh: "未知" }),
  ]),
  batchKinds: Object.freeze([
    Object.freeze({ value: "initial", labelZh: "初始批次" }),
    Object.freeze({ value: "repeat", labelZh: "重复批次" }),
    Object.freeze({ value: "calibration", labelZh: "校准批次" }),
    Object.freeze({ value: "adjudication", labelZh: "裁决批次" }),
  ]),
  targetPageCount: Object.freeze({
    labelZh: "目标页数",
    minimum: 1,
    maximum: MAX_QUERY_GENERATION_PAGE_COUNT,
  }),
} as const);

export type EvaluationLabel =
  (typeof EVALUATION_FIELD_CATALOG.evaluationLabels)[number]["value"];
export type EvaluationTargetScope =
  (typeof EVALUATION_FIELD_CATALOG.targetScopes)[number]["value"];
export type EvaluationElementKind =
  (typeof EVALUATION_FIELD_CATALOG.elementKinds)[number]["value"];
export type PersonaRole =
  (typeof EVALUATION_FIELD_CATALOG.personaRoles)[number]["value"];
export type PersonaExperienceLevel =
  (typeof EVALUATION_FIELD_CATALOG.experienceLevels)[number]["value"];
export type AudiencePriorKnowledge =
  (typeof EVALUATION_FIELD_CATALOG.priorKnowledgeLevels)[number]["value"];
export type PresentationReadingMode =
  (typeof EVALUATION_FIELD_CATALOG.readingModes)[number]["value"];
export type QueryOccasion =
  (typeof EVALUATION_FIELD_CATALOG.occasions)[number]["value"];
export type IntentConfirmationStatus =
  (typeof EVALUATION_FIELD_CATALOG.intentConfirmationStatuses)[number]["value"];
export type IntentConfirmationSource =
  (typeof EVALUATION_FIELD_CATALOG.intentConfirmationSources)[number]["value"];
export type EvaluationMode =
  (typeof EVALUATION_FIELD_CATALOG.evaluationModes)[number]["value"];
export type EvaluationDeliveryStatus =
  (typeof EVALUATION_FIELD_CATALOG.deliveryStatuses)[number]["value"];
export type EvaluationBatchKind =
  (typeof EVALUATION_FIELD_CATALOG.batchKinds)[number]["value"];
export type EvaluationConfidence =
  (typeof EVALUATION_FIELD_CATALOG.confidenceLevels)[number]["value"];
export type UncertainReason =
  (typeof EVALUATION_FIELD_CATALOG.uncertainReasons)[number]["value"];

export interface PersonaProfile {
  readonly personaId: string;
  readonly role: PersonaRole;
  readonly roleDescription: string;
  readonly experienceLevel: PersonaExperienceLevel;
  readonly domain: string;
  readonly subject?: string;
  readonly grade?: string;
  readonly organizationContext?: string;
  readonly locale?: string;
}

export interface PresentationAudience {
  readonly audienceId: string;
  readonly description: string;
  readonly ageOrGrade?: string;
  readonly priorKnowledge: AudiencePriorKnowledge;
  readonly readingMode: PresentationReadingMode;
}

export interface QueryUseContext {
  readonly occasion: QueryOccasion;
  readonly objective: string;
  readonly expectedDurationMinutes?: number;
  readonly targetPageCount: number;
}

export interface IntentConfirmationSnapshot {
  readonly status: IntentConfirmationStatus;
  readonly source: IntentConfirmationSource;
  readonly confirmedAt: string | null;
}

export interface QuestionBankEvaluatorContext {
  readonly explicitRequirements: readonly string[];
  readonly requiredFacts: readonly string[];
  readonly expectedCoverage: readonly string[];
  readonly referencePackMode: "automatic" | "force" | "off";
  readonly rubricRef: {
    readonly rubricId: string;
    readonly rubricVersion: string;
    readonly rubricHash: Sha256Hash;
  };
}

export interface QuestionBankCase {
  readonly schemaVersion: "question-bank-case-v1";
  readonly caseId: string;
  readonly caseVersion: number;
  readonly track: "query_generation";
  readonly requesterPersona: PersonaProfile;
  readonly presentationAudience: PresentationAudience;
  readonly useContext: QueryUseContext;
  readonly query: string;
  readonly intentConfirmation: IntentConfirmationSnapshot;
  readonly vendorPrompt: {
    readonly templateVersion: string;
    readonly text: string;
    readonly contentHash: Sha256Hash;
  };
  readonly evaluatorContext: QuestionBankEvaluatorContext;
  readonly caseHash: Sha256Hash;
  readonly author: string;
  readonly reviewState: "draft" | "reviewed" | "retired";
}

export interface CreateQuestionBankCaseInput {
  readonly caseId: string;
  readonly caseVersion: number;
  readonly requesterPersona: PersonaProfile;
  readonly presentationAudience: PresentationAudience;
  readonly useContext: QueryUseContext;
  readonly query: string;
  readonly intentConfirmation: IntentConfirmationSnapshot;
  readonly evaluatorContext: QuestionBankEvaluatorContext;
  readonly vendorPromptTemplateVersion: string;
  readonly author: string;
  readonly reviewState: "draft" | "reviewed" | "retired";
}

export interface ElementBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface EvaluationElementBase {
  readonly elementId: string;
  readonly bounds: ElementBounds;
}

export interface ImageEvaluationElement extends EvaluationElementBase {
  readonly kind: "IMAGE";
  readonly renderedCropHash: Sha256Hash;
  readonly renderedCrop: Uint8Array;
  readonly altText?: string;
  readonly sourceAssetHash?: Sha256Hash;
}

export interface TextBoxEvaluationElement extends EvaluationElementBase {
  readonly kind: "TEXT_BOX";
  readonly text: string;
  readonly textHash: Sha256Hash;
  readonly styleSnapshot: {
    readonly fontFamilies: readonly string[];
    readonly minimumFontSizePt: number | null;
    readonly maximumFontSizePt: number | null;
    readonly overflowDetected: boolean | null;
  };
}

export type EvaluationElement =
  | ImageEvaluationElement
  | TextBoxEvaluationElement;

export interface EvaluationStaticPage {
  readonly pageNumber: number;
  readonly pageRole?: string;
  readonly imageHash: Sha256Hash;
  readonly image: Uint8Array;
  readonly extractedText: string;
  readonly extractedTextHash: Sha256Hash;
  readonly elements: readonly EvaluationElement[];
}

export interface EvaluationJudgeConfiguration {
  readonly kind: "mock" | "real";
  readonly provider: string;
  readonly model: string;
}

export interface EvaluationInput {
  readonly schemaVersion: "evaluation-input-v1";
  readonly evaluationInputHash: Sha256Hash;
  readonly evaluationId: string;
  readonly mode: EvaluationMode;
  readonly questionBankCase: QuestionBankCase;
  readonly artifact: {
    readonly artifactId: string;
    readonly runId: string;
    readonly jobId: string;
    readonly provenance:
      | "MOCK"
      | "PRODUCTION"
      | "LIVE_PRODUCTION"
      | "PRODUCTION_REPLAY";
    readonly contentHash: Sha256Hash;
    readonly pageCount: number;
  };
  readonly staticSurface: {
    readonly surfaceClass: "canonical" | "native_frozen";
    readonly renderManifestHash: Sha256Hash;
    readonly fidelity: "verified" | "degraded" | "unknown";
    readonly pages: readonly EvaluationStaticPage[];
  };
  readonly referencePack: {
    readonly contentHash: Sha256Hash | null;
    readonly facts: readonly {
      readonly factId: string;
      readonly statement: string;
      readonly sourceIds: readonly string[];
    }[];
  };
  readonly evaluationProtocol: {
    readonly rubricHash: Sha256Hash;
    readonly aggregationSpecHash: Sha256Hash;
    readonly batchProtocolHash: Sha256Hash;
    readonly promptVersion: string;
    readonly judge: EvaluationJudgeConfiguration;
  };
}

export type CreateEvaluationInputInput = Omit<
  EvaluationInput,
  "schemaVersion" | "evaluationInputHash"
>;

export interface EvaluationTargetNode {
  readonly targetId: string;
  readonly parentTargetId: string | null;
  readonly scope: EvaluationTargetScope;
  readonly pageNumber: number | null;
  readonly elementId: string | null;
  readonly elementKind: EvaluationElementKind | null;
}

export interface EvaluationJudgment {
  readonly judgmentId: string;
  readonly batchId: string;
  readonly batchKind: EvaluationBatchKind;
  readonly annotator: {
    readonly kind: "mock" | "real";
    readonly provider: string;
    readonly model: string;
  };
  readonly assessmentStatus: "ASSESSED" | "NOT_ASSESSABLE";
  readonly label: EvaluationLabel;
  readonly uncertainReason: UncertainReason | null;
  readonly confidence: EvaluationConfidence;
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
  readonly rubricHash: Sha256Hash;
  readonly createdAt: string;
}

export interface ConsensusSummary {
  readonly goodCount: number;
  readonly badCount: number;
  readonly uncertainCount: number;
  readonly totalCount: number;
  readonly resolvedLabel: EvaluationLabel;
  readonly rule: "unanimous" | "unresolved";
  readonly agreementStatus: "consistent" | "mixed";
  readonly uncertainReasons: readonly UncertainReason[];
}

export interface EvaluationAssessmentInput {
  readonly assessmentId: string;
  readonly targetId: string;
  readonly dimensionId: string;
  readonly judgments: readonly EvaluationJudgment[];
}

export interface EvaluationAssessment extends EvaluationAssessmentInput {
  readonly consensus: ConsensusSummary;
}

export interface EvaluationEvidence {
  readonly evidenceId: string;
  readonly targetId: string;
  readonly pageNumber: number | null;
  readonly elementId: string | null;
  readonly kind:
    | "VISUAL_OBSERVATION"
    | "EXTRACTED_TEXT"
    | "REFERENCE_FACT"
    | "ELEMENT_CROP"
    | "GATE";
  readonly observation: string;
  readonly sourceFactId?: string;
  readonly sourceIds?: readonly string[];
}

export interface EvaluationDimensionProfile {
  readonly dimensionId: string;
  readonly scope: EvaluationTargetScope;
  readonly goodCount: number;
  readonly badCount: number;
  readonly uncertainCount: number;
  readonly assessableCount: number;
}

export interface EvaluationComparisonVector {
  readonly mappingVersion: string;
  readonly mappingHash: Sha256Hash;
  readonly axes: readonly {
    readonly axisId: string;
    readonly sourceDimensionIds: readonly string[];
    readonly goodRate: number | null;
    readonly badRate: number | null;
    readonly uncertainRate: number | null;
    readonly denominator: number;
    readonly comparable: boolean;
  }[];
  readonly rankStatus:
    | "NOT_CALIBRATED"
    | "NOT_COMPARABLE"
    | "EXPLORATORY_ONLY"
    | "ELIGIBLE";
}

export interface EvaluationResultLineage {
  readonly evaluationInputHash: Sha256Hash;
  readonly referencePackHash: Sha256Hash | null;
  readonly caseHash: Sha256Hash;
  readonly artifactHash: Sha256Hash;
  readonly renderManifestHash: Sha256Hash;
  readonly rubricHash: Sha256Hash;
  readonly aggregationSpecHash: Sha256Hash;
  readonly batchProtocolHash: Sha256Hash;
  readonly promptVersion: string;
  readonly judge: {
    readonly kind: "mock" | "real";
    readonly provider: string;
    readonly model: string;
    readonly responseIds: readonly string[];
  };
}

export interface CreateEvaluationResultInput {
  readonly evaluationInput: EvaluationInput;
  readonly evaluationId: string;
  readonly caseId: string;
  readonly artifactId: string;
  readonly mode: EvaluationMode;
  readonly deliveryStatus: EvaluationDeliveryStatus;
  readonly tree: {
    readonly rootTargetId: string;
    readonly targets: readonly EvaluationTargetNode[];
    readonly assessments: readonly EvaluationAssessmentInput[];
    readonly evidence: readonly EvaluationEvidence[];
  };
  readonly comparisonVector: EvaluationComparisonVector;
  readonly lineage: EvaluationResultLineage;
}

export interface EvaluationResult {
  readonly schemaVersion: "evaluation-result-v1";
  readonly evaluationId: string;
  readonly caseId: string;
  readonly artifactId: string;
  readonly mode: EvaluationMode;
  readonly deliveryStatus: EvaluationDeliveryStatus;
  readonly tree: {
    readonly rootTargetId: string;
    readonly targets: readonly EvaluationTargetNode[];
    readonly assessments: readonly EvaluationAssessment[];
    readonly evidence: readonly EvaluationEvidence[];
  };
  readonly dimensionProfile: readonly EvaluationDimensionProfile[];
  readonly comparisonVector: EvaluationComparisonVector;
  readonly lineage: EvaluationResultLineage;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sha256(value: unknown): Sha256Hash {
  const content = typeof value === "string"
    ? value
    : value instanceof Uint8Array
      ? value.slice()
      : JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const QUERY_ATOMIC_DIMENSIONS_V1 = Object.freeze({
  mappingVersion: "query-atomic-dimensions-v1",
  strategy: "IDENTITY_ALL_DIMENSIONS",
});

export const EVALUATION_COMPARISON_MAPPING_REGISTRY = Object.freeze({
  "query-atomic-dimensions-v1": Object.freeze({
    ...QUERY_ATOMIC_DIMENSIONS_V1,
    mappingHash: sha256(QUERY_ATOMIC_DIMENSIONS_V1),
  }),
});

function immutableSnapshot<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    value.forEach((item, index) => {
      if (item instanceof Uint8Array) {
        const bytes = new Uint8Array(item);
        Object.defineProperty(snapshot, index, {
          enumerable: true,
          configurable: false,
          get: () => bytes.slice(),
        });
      } else {
        snapshot[index] = immutableSnapshot(item);
      }
    });
    return Object.freeze(snapshot) as T;
  }
  if (value !== null && typeof value === "object") {
    const snapshot: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      if (child instanceof Uint8Array) {
        const bytes = new Uint8Array(child);
        Object.defineProperty(snapshot, key, {
          enumerable: true,
          configurable: false,
          get: () => bytes.slice(),
        });
      } else {
        snapshot[key] = immutableSnapshot(child);
      }
    });
    return Object.freeze(snapshot) as T;
  }
  return value;
}

function assertSha256Hash(value: string, fieldName: string): asserts value is Sha256Hash {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${fieldName} 必须是 sha256 哈希`);
  }
}

function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  fieldName: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${fieldName} 枚举值无效：${value}`);
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} 不能为空`);
  }
}

function assertTargetPageCount(targetPageCount: number): void {
  if (
    !Number.isInteger(targetPageCount) ||
    targetPageCount < 1 ||
    targetPageCount > MAX_QUERY_GENERATION_PAGE_COUNT
  ) {
    throw new Error("目标页数必须是 1到20 之间的整数");
  }
}

export function buildQueryGenerationVendorPrompt(input: {
  readonly requesterPersona: PersonaProfile;
  readonly presentationAudience: PresentationAudience;
  readonly useContext: QueryUseContext;
  readonly query: string;
}): string {
  return [
    `请求者人设：${input.requesterPersona.roleDescription}`,
    `PPT 受众：${input.presentationAudience.description}`,
    `使用场景：${input.useContext.occasion}`,
    `制作目标：${input.useContext.objective}`,
    `页数要求：${input.useContext.targetPageCount} 页以内`,
    `用户 Query：${input.query}`,
  ].join("\n");
}

export function createQuestionBankCase(
  input: CreateQuestionBankCaseInput,
): QuestionBankCase {
  assertNonEmpty(input.caseId, "caseId");
  assertNonEmpty(input.requesterPersona.roleDescription, "requesterPersona.roleDescription");
  assertNonEmpty(input.presentationAudience.description, "presentationAudience.description");
  assertNonEmpty(input.query, "query");
  assertTargetPageCount(input.useContext.targetPageCount);
  assertOneOf(input.requesterPersona.role, ["student", "teacher", "employee", "manager", "boss", "other"], "requesterPersona.role");
  assertOneOf(input.requesterPersona.experienceLevel, ["beginner", "intermediate", "expert", "unknown"], "requesterPersona.experienceLevel");
  assertOneOf(input.presentationAudience.priorKnowledge, ["low", "medium", "high", "unknown"], "presentationAudience.priorKnowledge");
  assertOneOf(input.presentationAudience.readingMode, ["self_reading", "presented_with_speaker"], "presentationAudience.readingMode");
  assertOneOf(input.useContext.occasion, ["classroom", "homework", "meeting", "sales", "self_learning", "other"], "useContext.occasion");
  assertOneOf(input.intentConfirmation.status, ["not_requested", "pending", "confirmed"], "intentConfirmation.status");
  assertOneOf(input.intentConfirmation.source, ["case_author", "vendor_confirmation"], "intentConfirmation.source");
  assertOneOf(input.evaluatorContext.referencePackMode, ["automatic", "force", "off"], "evaluatorContext.referencePackMode");
  assertOneOf(input.reviewState, ["draft", "reviewed", "retired"], "reviewState");
  assertSha256Hash(input.evaluatorContext.rubricRef.rubricHash, "evaluatorContext.rubricRef.rubricHash");
  assertNonEmpty(input.evaluatorContext.rubricRef.rubricId, "evaluatorContext.rubricRef.rubricId");
  assertNonEmpty(input.evaluatorContext.rubricRef.rubricVersion, "evaluatorContext.rubricRef.rubricVersion");

  if (!Number.isInteger(input.caseVersion) || input.caseVersion < 1) {
    throw new Error("caseVersion 必须是正整数");
  }
  if (
    input.intentConfirmation.status === "confirmed" &&
    input.intentConfirmation.confirmedAt === null
  ) {
    throw new Error("已确认的意图必须记录 confirmedAt");
  }

  const promptText = buildQueryGenerationVendorPrompt(input);
  const withoutCaseHash = immutableSnapshot({
    schemaVersion: "question-bank-case-v1" as const,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    track: "query_generation" as const,
    requesterPersona: input.requesterPersona,
    presentationAudience: input.presentationAudience,
    useContext: input.useContext,
    query: input.query,
    intentConfirmation: input.intentConfirmation,
    vendorPrompt: {
      templateVersion: input.vendorPromptTemplateVersion,
      text: promptText,
      contentHash: sha256(promptText),
    },
    evaluatorContext: input.evaluatorContext,
    author: input.author,
    reviewState: input.reviewState,
  });

  return immutableSnapshot({
    ...withoutCaseHash,
    caseHash: sha256(withoutCaseHash),
  });
}

function buildEvaluationInputHash(input: CreateEvaluationInputInput): Sha256Hash {
  return sha256({
    evaluationId: input.evaluationId,
    mode: input.mode,
    questionBankCaseHash: input.questionBankCase.caseHash,
    artifact: input.artifact,
    staticSurface: {
      surfaceClass: input.staticSurface.surfaceClass,
      renderManifestHash: input.staticSurface.renderManifestHash,
      fidelity: input.staticSurface.fidelity,
      pages: input.staticSurface.pages.map((page) => ({
        pageNumber: page.pageNumber,
        pageRole: page.pageRole,
        imageHash: page.imageHash,
        extractedTextHash: page.extractedTextHash,
        elements: page.elements.map((element) => element.kind === "IMAGE"
          ? {
              elementId: element.elementId,
              kind: element.kind,
              bounds: element.bounds,
              renderedCropHash: element.renderedCropHash,
              sourceAssetHash: element.sourceAssetHash,
              altText: element.altText,
            }
          : {
              elementId: element.elementId,
              kind: element.kind,
              bounds: element.bounds,
              textHash: element.textHash,
              styleSnapshot: element.styleSnapshot,
            }),
      })),
    },
    referencePack: input.referencePack,
    evaluationProtocol: input.evaluationProtocol,
  });
}

function assertElementBounds(bounds: ElementBounds, elementId: string): void {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error(`元素 ${elementId} 的 bounds 无效`);
  }
}

export function createEvaluationInput(
  input: CreateEvaluationInputInput,
): EvaluationInput {
  assertNonEmpty(input.evaluationId, "evaluationId");
  assertOneOf(input.mode, ["mock", "production"], "mode");
  assertOneOf(input.evaluationProtocol.judge.kind, ["mock", "real"], "judge.kind");
  if (input.mode === "production" && input.evaluationProtocol.judge.kind !== "real") {
    throw new Error("生产评测必须使用真实 Judge");
  }
  if (input.mode === "production" && input.artifact.provenance === "MOCK") {
    throw new Error("生产评测不能使用 Mock Artifact");
  }
  if (input.mode === "mock" && input.evaluationProtocol.judge.kind !== "mock") {
    throw new Error("Mock 评测必须使用 Mock Judge");
  }
  if (input.mode === "mock" && input.artifact.provenance !== "MOCK") {
    throw new Error("Mock 评测只能使用 Mock Artifact");
  }
  assertNonEmpty(input.evaluationProtocol.promptVersion, "promptVersion");
  assertNonEmpty(input.evaluationProtocol.judge.provider, "judge.provider");
  assertNonEmpty(input.evaluationProtocol.judge.model, "judge.model");
  assertNonEmpty(input.artifact.artifactId, "artifactId");
  assertNonEmpty(input.artifact.runId, "runId");
  assertNonEmpty(input.artifact.jobId, "jobId");
  assertOneOf(
    input.artifact.provenance,
    ["MOCK", "PRODUCTION", "LIVE_PRODUCTION", "PRODUCTION_REPLAY"],
    "artifact.provenance",
  );
  assertOneOf(input.staticSurface.surfaceClass, ["canonical", "native_frozen"], "surfaceClass");
  assertOneOf(input.staticSurface.fidelity, ["verified", "degraded", "unknown"], "fidelity");

  assertSha256Hash(input.artifact.contentHash, "artifact.contentHash");
  assertSha256Hash(input.staticSurface.renderManifestHash, "renderManifestHash");
  assertSha256Hash(input.evaluationProtocol.rubricHash, "rubricHash");
  assertSha256Hash(input.evaluationProtocol.aggregationSpecHash, "aggregationSpecHash");
  assertSha256Hash(input.evaluationProtocol.batchProtocolHash, "batchProtocolHash");
  if (input.referencePack.contentHash !== null) {
    assertSha256Hash(input.referencePack.contentHash, "referencePack.contentHash");
  }
  if (input.referencePack.facts.length > 0 && input.referencePack.contentHash === null) {
    throw new Error("Reference Pack 含事实时必须记录 contentHash");
  }
  const factIds = new Set<string>();
  input.referencePack.facts.forEach((fact) => {
    assertNonEmpty(fact.factId, "referencePack.factId");
    assertNonEmpty(fact.statement, `Reference Fact ${fact.factId}.statement`);
    if (factIds.has(fact.factId)) throw new Error(`Reference Fact ID 重复：${fact.factId}`);
    if (fact.sourceIds.length === 0 || fact.sourceIds.some((sourceId) => sourceId.trim().length === 0)) {
      throw new Error(`Reference Fact ${fact.factId} 必须记录非空 sourceIds`);
    }
    factIds.add(fact.factId);
  });

  assertSha256Hash(input.questionBankCase.caseHash, "questionBankCase.caseHash");
  assertSha256Hash(
    input.questionBankCase.vendorPrompt.contentHash,
    "questionBankCase.vendorPrompt.contentHash",
  );
  if (sha256(input.questionBankCase.vendorPrompt.text) !== input.questionBankCase.vendorPrompt.contentHash) {
    throw new Error("QuestionBankCase vendorPrompt 哈希不匹配");
  }
  const { caseHash, ...questionBankCaseWithoutHash } = input.questionBankCase;
  if (sha256(questionBankCaseWithoutHash) !== caseHash) {
    throw new Error("QuestionBankCase caseHash 不匹配");
  }

  const pages = input.staticSurface.pages;
  if (input.artifact.pageCount !== pages.length) {
    throw new Error("产物页数与静态渲染页数不一致");
  }
  if (!Number.isInteger(input.artifact.pageCount) || input.artifact.pageCount < 1) {
    throw new Error("产物页数必须是正整数");
  }

  const elementIds = new Set<string>();
  pages.forEach((page, pageIndex) => {
    const expectedPageNumber = pageIndex + 1;
    if (page.pageNumber !== expectedPageNumber) {
      throw new Error(`静态渲染页码必须连续，期望 ${expectedPageNumber}`);
    }
    assertSha256Hash(page.imageHash, `page ${page.pageNumber}.imageHash`);
    assertSha256Hash(page.extractedTextHash, `page ${page.pageNumber}.extractedTextHash`);
    if (sha256(page.image) !== page.imageHash) {
      throw new Error(`第 ${page.pageNumber} 页图片哈希不匹配`);
    }
    if (sha256(page.extractedText) !== page.extractedTextHash) {
      throw new Error(`第 ${page.pageNumber} 页文本哈希不匹配`);
    }
    page.elements.forEach((element) => {
      assertNonEmpty(element.elementId, "elementId");
      if (elementIds.has(element.elementId)) {
        throw new Error(`元素 ID 重复：${element.elementId}`);
      }
      elementIds.add(element.elementId);
      assertElementBounds(element.bounds, element.elementId);
      assertOneOf(element.kind, ["IMAGE", "TEXT_BOX"], `元素 ${element.elementId}.kind`);
      if (element.kind === "IMAGE") {
        assertSha256Hash(element.renderedCropHash, `图片 ${element.elementId}.renderedCropHash`);
        if (sha256(element.renderedCrop) !== element.renderedCropHash) {
          throw new Error(`图片 ${element.elementId} 裁剪哈希不匹配`);
        }
        if (element.sourceAssetHash !== undefined) {
          assertSha256Hash(element.sourceAssetHash, `图片 ${element.elementId}.sourceAssetHash`);
        }
      }
      if (element.kind === "TEXT_BOX") {
        assertNonEmpty(element.text, `文本框 ${element.elementId}.text`);
        assertSha256Hash(element.textHash, `文本框 ${element.elementId}.textHash`);
        if (sha256(element.text) !== element.textHash) {
          throw new Error(`文本框 ${element.elementId} 文本哈希不匹配`);
        }
      }
    });
  });

  return immutableSnapshot({
    ...input,
    schemaVersion: "evaluation-input-v1",
    evaluationInputHash: buildEvaluationInputHash(input),
  });
}

export function toFeishuEvaluationLabel(
  label: EvaluationLabel,
): "好" | "不好" | "不确定" {
  const option = EVALUATION_FIELD_CATALOG.evaluationLabels.find(
    (candidate) => candidate.value === label,
  );
  if (option === undefined) {
    throw new Error(`未知评测标签：${String(label)}`);
  }
  return option.labelZh;
}

function buildConsensus(
  judgments: readonly EvaluationJudgment[],
): ConsensusSummary {
  const goodCount = judgments.filter(({ label }) => label === "GOOD").length;
  const badCount = judgments.filter(({ label }) => label === "BAD").length;
  const uncertainCount = judgments.filter(({ label }) => label === "UNCERTAIN").length;
  const labels = [goodCount > 0, badCount > 0, uncertainCount > 0].filter(Boolean).length;
  const consistent = labels === 1;
  const resolvedLabel: EvaluationLabel = consistent
    ? judgments[0]!.label
    : "UNCERTAIN";
  const uncertainReasons = new Set<UncertainReason>();
  judgments.forEach(({ uncertainReason }) => {
    if (uncertainReason !== null) uncertainReasons.add(uncertainReason);
  });
  if (!consistent) uncertainReasons.add("ANNOTATOR_DISAGREEMENT");

  return Object.freeze({
    goodCount,
    badCount,
    uncertainCount,
    totalCount: judgments.length,
    resolvedLabel,
    rule: consistent ? "unanimous" : "unresolved",
    agreementStatus: consistent ? "consistent" : "mixed",
    uncertainReasons: Object.freeze([...uncertainReasons]),
  });
}

function validateTargetTree(
  rootTargetId: string,
  targets: readonly EvaluationTargetNode[],
): Map<string, EvaluationTargetNode> {
  const byId = new Map<string, EvaluationTargetNode>();
  targets.forEach((target) => {
    assertNonEmpty(target.targetId, "targetId");
    assertOneOf(target.scope, ["DECK", "SLIDE", "ELEMENT"], `Target ${target.targetId}.scope`);
    if (byId.has(target.targetId)) throw new Error(`评测对象 ID 重复：${target.targetId}`);
    byId.set(target.targetId, target);
  });
  const root = byId.get(rootTargetId);
  if (root === undefined || root.scope !== "DECK" || root.parentTargetId !== null) {
    throw new Error("评测树必须有且只有一个 Deck 根对象");
  }

  targets.forEach((target) => {
    if (target.scope === "DECK") {
      if (target.targetId !== rootTargetId || target.pageNumber !== null || target.elementId !== null) {
        throw new Error("Deck 对象只能作为根节点");
      }
      return;
    }
    const parent = target.parentTargetId === null
      ? undefined
      : byId.get(target.parentTargetId);
    if (target.scope === "SLIDE") {
      if (
        parent?.scope !== "DECK" ||
        !Number.isInteger(target.pageNumber) ||
        target.pageNumber === null ||
        target.pageNumber < 1 ||
        target.elementId !== null ||
        target.elementKind !== null
      ) {
        throw new Error(`Slide 对象 ${target.targetId} 必须挂在 Deck 下并带有有效页码`);
      }
      return;
    }
    if (
      parent?.scope !== "SLIDE" ||
      target.pageNumber !== parent.pageNumber ||
      target.elementId === null ||
      target.elementKind === null
    ) {
      throw new Error(`Element 对象 ${target.targetId} 必须挂在同页 Slide 下`);
    }
  });
  return byId;
}

function validateComparisonVector(
  vector: EvaluationComparisonVector,
  assessments: readonly EvaluationAssessment[],
): EvaluationComparisonVector {
  assertNonEmpty(vector.mappingVersion, "comparisonVector.mappingVersion");
  const mapping = EVALUATION_COMPARISON_MAPPING_REGISTRY[
    vector.mappingVersion as keyof typeof EVALUATION_COMPARISON_MAPPING_REGISTRY
  ];
  if (mapping === undefined) {
    throw new Error(`比较映射版本未注册：${vector.mappingVersion}`);
  }
  assertSha256Hash(vector.mappingHash, "comparisonVector.mappingHash");
  if (vector.mappingHash !== mapping.mappingHash) {
    throw new Error("比较映射哈希与注册表不一致");
  }
  assertOneOf(
    vector.rankStatus,
    ["NOT_CALIBRATED", "NOT_COMPARABLE", "EXPLORATORY_ONLY", "ELIGIBLE"],
    "comparisonVector.rankStatus",
  );
  if (vector.rankStatus === "ELIGIBLE") {
    throw new Error("evaluation-result-v1 尚未冻结可排名校准，不能使用 ELIGIBLE");
  }
  const axisIds = new Set<string>();
  const dimensionIds = new Set(assessments.map(({ dimensionId }) => dimensionId));
  if (vector.axes.length !== dimensionIds.size) {
    throw new Error("比较轴集合与注册映射不一致");
  }
  vector.axes.forEach((axis) => {
    assertNonEmpty(axis.axisId, "comparisonVector.axisId");
    if (axisIds.has(axis.axisId)) throw new Error(`比较轴 ID 重复：${axis.axisId}`);
    axisIds.add(axis.axisId);
    if (
      axis.sourceDimensionIds.length !== 1 ||
      axis.sourceDimensionIds[0] !== axis.axisId ||
      !dimensionIds.has(axis.axisId)
    ) {
      throw new Error(`比较轴 ${axis.axisId} 的维度映射与注册表不一致`);
    }
    const matching = assessments.filter(({ dimensionId }) =>
      axis.sourceDimensionIds.includes(dimensionId)
    );
    const counts = {
      GOOD: matching.filter(({ consensus }) => consensus.resolvedLabel === "GOOD").length,
      BAD: matching.filter(({ consensus }) => consensus.resolvedLabel === "BAD").length,
      UNCERTAIN: matching.filter(({ consensus }) => consensus.resolvedLabel === "UNCERTAIN").length,
    };
    const expectedDenominator = matching.length;
    const expectedComparable = expectedDenominator > 0 && counts.UNCERTAIN < expectedDenominator;
    const expectedRate = (count: number): number | null =>
      expectedDenominator === 0 ? null : count / expectedDenominator;
    const closeEnough = (actual: number | null, expected: number | null): boolean =>
      actual === expected || (
        actual !== null && expected !== null &&
        Number.isFinite(actual) && Math.abs(actual - expected) < 1e-12
      );
    if (
      axis.denominator !== expectedDenominator ||
      axis.comparable !== expectedComparable ||
      !closeEnough(axis.goodRate, expectedRate(counts.GOOD)) ||
      !closeEnough(axis.badRate, expectedRate(counts.BAD)) ||
      !closeEnough(axis.uncertainRate, expectedRate(counts.UNCERTAIN))
    ) {
      throw new Error(`比较轴 ${axis.axisId} 与原子判断聚合结果不一致`);
    }
  });
  const mappedDimensionIds = new Set(vector.axes.flatMap(({ sourceDimensionIds }) => sourceDimensionIds));
  dimensionIds.forEach((dimensionId) => {
    if (!mappedDimensionIds.has(dimensionId)) {
      throw new Error(`评测维度未进入冻结比较映射：${dimensionId}`);
    }
  });
  if (
    vector.rankStatus === "NOT_COMPARABLE" &&
    vector.axes.some(({ comparable }) => comparable)
  ) {
    throw new Error("存在可比较轴时不能标记为 NOT_COMPARABLE");
  }
  return immutableSnapshot(vector);
}

function buildDimensionProfiles(
  assessments: readonly EvaluationAssessment[],
  targets: ReadonlyMap<string, EvaluationTargetNode>,
): readonly EvaluationDimensionProfile[] {
  const groups = new Map<string, {
    dimensionId: string;
    scope: EvaluationTargetScope;
    labels: EvaluationLabel[];
  }>();
  assessments.forEach((assessment) => {
    const scope = targets.get(assessment.targetId)!.scope;
    const key = `${scope}:${assessment.dimensionId}`;
    const group = groups.get(key) ?? {
      dimensionId: assessment.dimensionId,
      scope,
      labels: [],
    };
    group.labels.push(assessment.consensus.resolvedLabel);
    groups.set(key, group);
  });

  return Object.freeze([...groups.values()].map((group) => {
    const goodCount = group.labels.filter((label) => label === "GOOD").length;
    const badCount = group.labels.filter((label) => label === "BAD").length;
    const uncertainCount = group.labels.filter((label) => label === "UNCERTAIN").length;
    return Object.freeze({
      dimensionId: group.dimensionId,
      scope: group.scope,
      goodCount,
      badCount,
      uncertainCount,
      assessableCount: goodCount + badCount,
    });
  }));
}

function validateTargetsAgainstEvaluationInput(
  targets: ReadonlyMap<string, EvaluationTargetNode>,
  evaluationInput: EvaluationInput,
): void {
  const slideTargets = [...targets.values()].filter(({ scope }) => scope === "SLIDE");
  const elementTargets = [...targets.values()].filter(({ scope }) => scope === "ELEMENT");
  const expectedPages = new Set(evaluationInput.staticSurface.pages.map(({ pageNumber }) => pageNumber));
  const actualPages = new Set(slideTargets.map(({ pageNumber }) => pageNumber!));
  if (
    slideTargets.length !== expectedPages.size ||
    [...expectedPages].some((pageNumber) => !actualPages.has(pageNumber))
  ) {
    throw new Error("评测 Target 树必须完整覆盖 EvaluationInput 的所有页面");
  }
  const expectedElements = new Map<string, { pageNumber: number; kind: EvaluationElementKind }>();
  evaluationInput.staticSurface.pages.forEach((page) => {
    page.elements.forEach((element) => {
      expectedElements.set(element.elementId, { pageNumber: page.pageNumber, kind: element.kind });
    });
  });
  if (elementTargets.length !== expectedElements.size) {
    throw new Error("评测 Target 树必须完整覆盖 EvaluationInput 的所有页面元素");
  }
  const actualElementIds = new Set(elementTargets.map(({ elementId }) => elementId));
  if (
    actualElementIds.size !== elementTargets.length ||
    [...expectedElements.keys()].some((elementId) => !actualElementIds.has(elementId))
  ) {
    throw new Error("评测 Target 树的元素定位必须唯一且完整");
  }
  elementTargets.forEach((target) => {
    const expected = target.elementId === null ? undefined : expectedElements.get(target.elementId);
    if (
      expected === undefined ||
      expected.pageNumber !== target.pageNumber ||
      expected.kind !== target.elementKind
    ) {
      throw new Error(`Element Target 未绑定 EvaluationInput：${target.targetId}`);
    }
  });
}

export function createEvaluationResult(
  input: CreateEvaluationResultInput,
): EvaluationResult {
  const {
    schemaVersion: _inputSchemaVersion,
    evaluationInputHash: suppliedEvaluationInputHash,
    ...evaluationInputPayload
  } = input.evaluationInput;
  const evaluationInput = createEvaluationInput(evaluationInputPayload);
  if (evaluationInput.evaluationInputHash !== suppliedEvaluationInputHash) {
    throw new Error("EvaluationInput 哈希校验失败");
  }
  if (
    input.evaluationId !== evaluationInput.evaluationId ||
    input.caseId !== evaluationInput.questionBankCase.caseId ||
    input.artifactId !== evaluationInput.artifact.artifactId ||
    input.mode !== evaluationInput.mode
  ) {
    throw new Error("EvaluationResult 身份与 EvaluationInput 不一致");
  }
  assertOneOf(input.mode, ["mock", "production"], "mode");
  assertOneOf(input.deliveryStatus, ["PASS", "FAIL", "UNKNOWN"], "deliveryStatus");
  assertOneOf(input.lineage.judge.kind, ["mock", "real"], "lineage.judge.kind");
  if (input.mode === "production" && input.lineage.judge.kind !== "real") {
    throw new Error("生产评测结果必须记录真实 Judge");
  }
  if (input.mode === "mock" && input.lineage.judge.kind !== "mock") {
    throw new Error("Mock 评测结果必须记录 Mock Judge");
  }
  assertNonEmpty(input.lineage.promptVersion, "lineage.promptVersion");
  assertNonEmpty(input.lineage.judge.provider, "lineage.judge.provider");
  assertNonEmpty(input.lineage.judge.model, "lineage.judge.model");
  if (
    input.mode === "production" &&
    (input.lineage.judge.responseIds.length === 0 ||
      input.lineage.judge.responseIds.some((responseId) => responseId.trim().length === 0))
  ) {
    throw new Error("生产评测结果必须记录真实 Judge responseId");
  }
  if (new Set(input.lineage.judge.responseIds).size !== input.lineage.judge.responseIds.length) {
    throw new Error("Judge responseId 不能重复");
  }
  [
    [input.lineage.caseHash, "lineage.caseHash"],
    [input.lineage.artifactHash, "lineage.artifactHash"],
    [input.lineage.renderManifestHash, "lineage.renderManifestHash"],
    [input.lineage.rubricHash, "lineage.rubricHash"],
    [input.lineage.aggregationSpecHash, "lineage.aggregationSpecHash"],
    [input.lineage.batchProtocolHash, "lineage.batchProtocolHash"],
    [input.lineage.evaluationInputHash, "lineage.evaluationInputHash"],
  ].forEach(([hash, fieldName]) => assertSha256Hash(hash!, fieldName!));
  if (input.lineage.referencePackHash !== null) {
    assertSha256Hash(input.lineage.referencePackHash, "lineage.referencePackHash");
  }
  if (
    input.lineage.evaluationInputHash !== evaluationInput.evaluationInputHash ||
    input.lineage.referencePackHash !== evaluationInput.referencePack.contentHash ||
    input.lineage.caseHash !== evaluationInput.questionBankCase.caseHash ||
    input.lineage.artifactHash !== evaluationInput.artifact.contentHash ||
    input.lineage.renderManifestHash !== evaluationInput.staticSurface.renderManifestHash ||
    input.lineage.rubricHash !== evaluationInput.evaluationProtocol.rubricHash ||
    input.lineage.aggregationSpecHash !== evaluationInput.evaluationProtocol.aggregationSpecHash ||
    input.lineage.batchProtocolHash !== evaluationInput.evaluationProtocol.batchProtocolHash ||
    input.lineage.promptVersion !== evaluationInput.evaluationProtocol.promptVersion ||
    input.lineage.judge.kind !== evaluationInput.evaluationProtocol.judge.kind ||
    input.lineage.judge.provider !== evaluationInput.evaluationProtocol.judge.provider ||
    input.lineage.judge.model !== evaluationInput.evaluationProtocol.judge.model
  ) {
    throw new Error("EvaluationResult lineage 与已验证 EvaluationInput 不一致");
  }
  const targets = validateTargetTree(input.tree.rootTargetId, input.tree.targets);
  validateTargetsAgainstEvaluationInput(targets, evaluationInput);
  if (input.tree.assessments.length === 0) {
    throw new Error("EvaluationResult 至少需要一条 Assessment");
  }

  const evidenceById = new Map<string, EvaluationEvidence>();
  input.tree.evidence.forEach((evidence) => {
    assertNonEmpty(evidence.evidenceId, "evidenceId");
    if (evidenceById.has(evidence.evidenceId)) throw new Error(`Evidence ID 重复：${evidence.evidenceId}`);
    if (!targets.has(evidence.targetId)) throw new Error(`Evidence 指向未知评测对象：${evidence.targetId}`);
    assertNonEmpty(evidence.observation, `Evidence ${evidence.evidenceId}.observation`);
    assertOneOf(
      evidence.kind,
      ["VISUAL_OBSERVATION", "EXTRACTED_TEXT", "REFERENCE_FACT", "ELEMENT_CROP", "GATE"],
      `Evidence ${evidence.evidenceId}.kind`,
    );
    if (evidence.kind === "REFERENCE_FACT") {
      if (evidence.sourceFactId === undefined || evidence.sourceIds === undefined || evidence.sourceIds.length === 0) {
        throw new Error(`Reference Evidence ${evidence.evidenceId} 必须记录 sourceFactId/sourceIds`);
      }
      const fact = evaluationInput.referencePack.facts.find(({ factId }) => factId === evidence.sourceFactId);
      if (
        fact === undefined ||
        fact.sourceIds.length !== evidence.sourceIds.length ||
        fact.sourceIds.some((sourceId, index) => sourceId !== evidence.sourceIds![index])
      ) {
        throw new Error(`Reference Evidence ${evidence.evidenceId} 未绑定已验证 Reference Pack`);
      }
    }
    const target = targets.get(evidence.targetId)!;
    if (target.scope === "DECK" && (evidence.pageNumber !== null || evidence.elementId !== null)) {
      throw new Error(`Deck Evidence ${evidence.evidenceId} 不能定位页面或元素`);
    }
    if (
      target.scope === "SLIDE" &&
      (evidence.pageNumber !== target.pageNumber || evidence.elementId !== null)
    ) {
      throw new Error(`Slide Evidence ${evidence.evidenceId} 定位与 Target 不一致`);
    }
    if (
      target.scope === "ELEMENT" &&
      (evidence.pageNumber !== target.pageNumber || evidence.elementId !== target.elementId)
    ) {
      throw new Error(`Element Evidence ${evidence.evidenceId} 定位与 Target 不一致`);
    }
    evidenceById.set(evidence.evidenceId, evidence);
  });

  const assessmentIds = new Set<string>();
  const judgmentIds = new Set<string>();
  const assessments = input.tree.assessments.map((assessment): EvaluationAssessment => {
    if (assessmentIds.has(assessment.assessmentId)) throw new Error(`Assessment ID 重复：${assessment.assessmentId}`);
    assessmentIds.add(assessment.assessmentId);
    if (!targets.has(assessment.targetId)) throw new Error(`Assessment 指向未知评测对象：${assessment.targetId}`);
    assertNonEmpty(assessment.dimensionId, "dimensionId");
    if (assessment.judgments.length === 0) throw new Error(`Assessment ${assessment.assessmentId} 至少需要一条判断`);

    assessment.judgments.forEach((judgment) => {
      if (judgmentIds.has(judgment.judgmentId)) throw new Error(`Judgment ID 重复：${judgment.judgmentId}`);
      judgmentIds.add(judgment.judgmentId);
      assertOneOf(judgment.batchKind, ["initial", "repeat", "calibration", "adjudication"], "batchKind");
      assertOneOf(judgment.annotator.kind, ["mock", "real"], "annotator.kind");
      assertOneOf(judgment.assessmentStatus, ["ASSESSED", "NOT_ASSESSABLE"], "assessmentStatus");
      assertOneOf(judgment.label, ["GOOD", "BAD", "UNCERTAIN"], "label");
      assertOneOf(judgment.confidence, ["LOW", "MEDIUM", "HIGH"], "confidence");
      if (judgment.uncertainReason !== null) {
        assertOneOf(
          judgment.uncertainReason,
          ["INSUFFICIENT_EVIDENCE", "RUBRIC_UNDEFINED", "ANNOTATOR_DISAGREEMENT", "REFERENCE_MISSING"],
          "uncertainReason",
        );
      }
      assertNonEmpty(judgment.batchId, "judgment.batchId");
      assertNonEmpty(judgment.rationale, "judgment.rationale");
      assertNonEmpty(judgment.createdAt, "judgment.createdAt");
      assertSha256Hash(judgment.rubricHash, "judgment.rubricHash");
      if (judgment.rubricHash !== input.lineage.rubricHash) {
        throw new Error(`Judgment ${judgment.judgmentId} 的 Rubric lineage 不一致`);
      }
      if (
        judgment.annotator.kind !== input.lineage.judge.kind ||
        judgment.annotator.provider !== input.lineage.judge.provider ||
        judgment.annotator.model !== input.lineage.judge.model
      ) {
        throw new Error(`Judgment ${judgment.judgmentId} 的 Judge lineage 不一致`);
      }
      if (input.mode === "production" && judgment.annotator.kind !== "real") {
        throw new Error("生产评测判断不能由 Mock Judge 生成");
      }
      if (judgment.label === "UNCERTAIN" && judgment.uncertainReason === null) {
        throw new Error("UNCERTAIN 判断必须记录 uncertainReason");
      }
      if (judgment.label !== "UNCERTAIN" && judgment.uncertainReason !== null) {
        throw new Error("只有 UNCERTAIN 判断可以记录 uncertainReason");
      }
      if (judgment.assessmentStatus === "NOT_ASSESSABLE" && judgment.label !== "UNCERTAIN") {
        throw new Error("NOT_ASSESSABLE 只能输出 UNCERTAIN");
      }
      if (judgment.evidenceIds.length === 0) throw new Error(`Judgment ${judgment.judgmentId} 必须引用 Evidence`);
      judgment.evidenceIds.forEach((evidenceId) => {
        const evidence = evidenceById.get(evidenceId);
        if (evidence === undefined) throw new Error(`Judgment 引用未知 Evidence：${evidenceId}`);
        if (evidence.targetId !== assessment.targetId) {
          throw new Error(`Evidence ${evidenceId} 与 Assessment 评测对象不一致`);
        }
      });
    });

    return immutableSnapshot({
      ...assessment,
      consensus: buildConsensus(assessment.judgments),
    });
  });

  const comparisonVector = validateComparisonVector(input.comparisonVector, assessments);

  return immutableSnapshot({
    schemaVersion: "evaluation-result-v1",
    evaluationId: input.evaluationId,
    caseId: input.caseId,
    artifactId: input.artifactId,
    mode: input.mode,
    deliveryStatus: input.deliveryStatus,
    tree: Object.freeze({
      rootTargetId: input.tree.rootTargetId,
      targets: immutableSnapshot(input.tree.targets),
      assessments: immutableSnapshot(assessments),
      evidence: immutableSnapshot(input.tree.evidence),
    }),
    dimensionProfile: buildDimensionProfiles(assessments, targets),
    comparisonVector,
    lineage: immutableSnapshot(input.lineage),
  });
}
