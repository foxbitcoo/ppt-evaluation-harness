import { createHash } from "node:crypto";

import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import sharp from "sharp";

import type {
  Artifact,
  ArtifactScorecard,
  DimensionAssessmentStatus,
  DimensionDeductionBasis,
  DimensionScore,
  EvaluationCaseRecord,
  JudgeEgressAuthorizationLineage,
  JudgeEgressAttemptAudit,
  JudgeEgressContentField,
  KnowledgeErrorDeduction,
  RasterizedImageLineage,
  RenderManifest,
  ScoreDimension,
  ScoreValue,
  StaticSlideRender,
} from "./domain.ts";
import type { ReferencePack } from "./reference-pack.ts";

export const OPENAI_JUDGE_MODEL = "gpt-5.6-sol" as const;
export const OPENAI_JUDGE_ADAPTER_VERSION = "openai-responses-judge@1" as const;
export const OPENAI_JUDGE_PROMPT_VERSION =
  "query-six-dimension-judge-prompt-v1" as const;

const SCORE_DIMENSIONS = [
  "requirement_understanding_and_content_coverage",
  "factual_accuracy_and_content_quality",
  "narrative_and_audience_fit",
  "visual_aesthetics_and_professional_finish",
  "layout_hierarchy_and_readability",
  "imagery_chart_and_information_expression",
] as const satisfies readonly ScoreDimension[];

const NON_FACTUAL_DEDUCTION_BASIS: Readonly<
  Partial<Record<ScoreDimension, DimensionDeductionBasis>>
> = Object.freeze({
  requirement_understanding_and_content_coverage:
    "visible_requirement_or_coverage_gap",
  narrative_and_audience_fit: "visible_narrative_or_audience_gap",
  visual_aesthetics_and_professional_finish: "visible_visual_finish_gap",
  layout_hierarchy_and_readability: "visible_layout_or_readability_gap",
  imagery_chart_and_information_expression:
    "visible_information_expression_gap",
});

const DEDUCTION_BASES = [
  "no_deduction",
  "visible_requirement_or_coverage_gap",
  "validated_reference_pack_errors",
  "not_assessable_no_reference_pack",
  "visible_narrative_or_audience_gap",
  "visible_visual_finish_gap",
  "visible_layout_or_readability_gap",
  "visible_information_expression_gap",
] as const satisfies readonly DimensionDeductionBasis[];

const JUDGE_PROMPT = `Evaluate one presentation Artifact from its static slide renders.
Return exactly the six declared dimensions. Use a 1–5 integer only for ASSESSED dimensions; use null only for NOT_ASSESSABLE. Give page evidence and a concise rationale for every dimension.
Delivery Quality is handled by automatic gates and must not become a seventh score.
For factual correctness, use only facts in the supplied Reference Pack. Never deduct for an uncovered fact.
Every knowledge-error deduction must identify the exact Reference Pack factId and sourceIds that support the correction.
The factual_accuracy_and_content_quality score starts at 5 and subtracts exactly one point per distinct validated knowledgeErrors entry, with a floor of 1. Apply no other deduction to that dimension; place non-factual quality observations in the other five dimensions.
Reference Pack facts may affect only factual_accuracy_and_content_quality. Every other dimension may deduct only through its declared visible-artifact deductionBasis. If no Reference Pack is supplied, factual_accuracy_and_content_quality must be NOT_ASSESSABLE with a null value and not_assessable_no_reference_pack.
Judge only the visible Artifact; do not infer vendor identity, hidden process, or internal pipeline causes.`;

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimensions: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          dimension: { type: "string", enum: SCORE_DIMENSIONS },
          assessmentStatus: {
            type: "string",
            enum: ["ASSESSED", "NOT_ASSESSABLE"],
          },
          value: {
            anyOf: [
              { type: "integer", minimum: 1, maximum: 5 },
              { type: "null" },
            ],
          },
          deductionBasis: {
            type: "string",
            enum: DEDUCTION_BASES,
          },
          evidencePages: {
            type: "array",
            items: { type: "integer", minimum: 1 },
          },
          rationale: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: [
          "dimension",
          "assessmentStatus",
          "value",
          "deductionBasis",
          "evidencePages",
          "rationale",
        ],
      },
    },
    knowledgeErrors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pageNumber: { type: "integer", minimum: 1 },
          claim: { type: "string", minLength: 1, maxLength: 240 },
          correction: { type: "string", minLength: 1, maxLength: 240 },
          factId: { type: "string", minLength: 1 },
          sourceIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["pageNumber", "claim", "correction", "factId", "sourceIds"],
      },
    },
  },
  required: ["dimensions", "knowledgeErrors"],
} as const;

const JUDGE_CONFIG = Object.freeze({
  model: OPENAI_JUDGE_MODEL,
  reasoning: Object.freeze({ effort: "medium" as const }),
  max_output_tokens: 4_000,
  store: false as const,
  truncation: "disabled" as const,
  imageDetail: "high" as const,
  text: Object.freeze({
    verbosity: "low" as const,
    formatType: "json_schema" as const,
    formatName: "ppt_artifact_scorecard" as const,
    strict: true as const,
  }),
});

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const PROMPT_HASH = sha256(JUDGE_PROMPT);
const SCHEMA_HASH = sha256(JSON.stringify(JUDGE_SCHEMA));
const CONFIG_HASH = sha256(JSON.stringify(JUDGE_CONFIG));
const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface OpenAiJudgeCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly scorecardId: string;
  readonly evaluationAttemptId: string;
  readonly evaluationCase: EvaluationCaseRecord;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
  readonly referencePack: ReferencePack | null;
}

export interface OpenAiJudgePort {
  score(command: OpenAiJudgeCommand): Promise<ArtifactScorecard>;
}

export interface JudgeEgressAuthorizationRequest {
  readonly payloadHash: `sha256:${string}`;
  readonly dataClassification: "public_or_synthetic";
  readonly sourceOwner: string;
  readonly processingPurpose: "presentation_artifact_evaluation";
  readonly targetService: "openai";
  readonly targetAccount: string;
  readonly targetRegion: string;
  readonly contentFields: readonly JudgeEgressContentField[];
}

export interface JudgeEgressAuthorizationDecision {
  readonly decisionId: string;
  readonly decision: "approved" | "denied";
  readonly policyVersion: string;
  readonly dataClassification: "public_or_synthetic";
  readonly sourceOwner: string;
  readonly processingPurpose: "presentation_artifact_evaluation";
  readonly targetService: "openai";
  readonly targetAccount: string;
  readonly targetRegion: string;
  readonly subprocessors: readonly string[];
  readonly allowedContentFields: readonly JudgeEgressContentField[];
  readonly requiredRedactions: readonly string[];
  readonly legalSecurityBasis: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface JudgeEgressAuthorizationPort {
  authorize(
    request: JudgeEgressAuthorizationRequest,
  ): Promise<JudgeEgressAuthorizationDecision>;
}

export interface OpenAiResponsesTransport {
  readonly destination: OpenAiJudgeDestination;
  create(
    request: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown>;
}

export interface OpenAiJudgeDestination {
  readonly targetAccount: string;
  readonly targetRegion: string;
}

export interface RasterizedJudgeImage {
  readonly mimeType: "image/png";
  readonly content: Uint8Array;
}

export interface StaticRenderRasterizerPort {
  readonly version: string;
  rasterize(slide: StaticSlideRender): Promise<RasterizedJudgeImage>;
}

export class SharpStaticRenderRasterizer implements StaticRenderRasterizerPort {
  readonly version = "sharp-svg-to-png@1";

  async rasterize(slide: StaticSlideRender): Promise<RasterizedJudgeImage> {
    try {
      const content = await sharp(Buffer.from(slide.content)).png().toBuffer();
      if (content.byteLength === 0) {
        throw new Error("empty PNG");
      }
      return { mimeType: "image/png", content };
    } catch (error) {
      throw new Error(
        `OpenAI Judge could not rasterize static page ${slide.pageNumber}`,
        { cause: error },
      );
    }
  }
}

export class OpenAiSdkResponsesTransport implements OpenAiResponsesTransport {
  readonly #client: OpenAI;
  readonly destination: OpenAiJudgeDestination;

  constructor(options: {
    readonly destination: OpenAiJudgeDestination;
    readonly client?: OpenAI;
  }) {
    this.#client = options.client ?? new OpenAI();
    this.destination = Object.freeze({ ...options.destination });
  }

  async create(
    request: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.#client.responses.create(
      request as ResponseCreateParamsNonStreaming,
      { idempotencyKey },
    );
  }
}

export interface OpenAiResponsesJudgeAdapterOptions {
  readonly transport: OpenAiResponsesTransport;
  readonly rasterizer?: StaticRenderRasterizerPort;
  readonly egressAuthorization?: JudgeEgressAuthorizationPort;
  readonly egressAudit?: JudgeEgressAuditPort;
  readonly now?: () => string;
}

export interface JudgeEgressAuditPort {
  recordAuthorizedAttempt(audit: JudgeEgressAttemptAudit): Promise<void>;
}

export class OpenAiJudgeEvaluationError extends Error {
  readonly submissionStatus: "submitted" | "unknown";
  readonly egressAttempt: JudgeEgressAttemptAudit;

  constructor(
    message: string,
    input: {
      readonly submissionStatus: "submitted" | "unknown";
      readonly egressAttempt: JudgeEgressAttemptAudit;
      readonly cause: unknown;
    },
  ) {
    super(message, { cause: input.cause });
    this.name = "OpenAiJudgeEvaluationError";
    this.submissionStatus = input.submissionStatus;
    this.egressAttempt = input.egressAttempt;
  }
}

const JUDGE_EGRESS_CONTENT_FIELDS = Object.freeze([
  "evaluation_case",
  "reference_pack",
  "extracted_slide_text",
  "static_slide_images",
] as const satisfies readonly JudgeEgressContentField[]);

function judgeCacheKey(
  command: OpenAiJudgeCommand,
  rasterizerVersion: string,
  contextHash: `sha256:${string}`,
): `sha256:${string}` {
  return sha256(
    JSON.stringify({
      jobId: command.jobId,
      runId: command.runId,
      artifactId: command.artifact.artifactId,
      caseId: command.evaluationCase.caseId,
      caseVersion: command.evaluationCase.caseVersion,
      artifactHash: command.artifact.contentHash,
      renderManifestHash: command.renderManifest.contentHash,
      referencePackHash: command.referencePack?.contentHash ?? null,
      promptHash: PROMPT_HASH,
      schemaHash: SCHEMA_HASH,
      configHash: CONFIG_HASH,
      rasterizerVersion,
      contextHash,
    }),
  );
}

function judgeContextText(command: OpenAiJudgeCommand): string {
  return JSON.stringify({
    evaluationIdentity: {
      jobId: command.jobId,
      runId: command.runId,
      artifactId: command.artifact.artifactId,
    },
    evaluationCase: {
      caseId: command.evaluationCase.caseId,
      caseVersion: command.evaluationCase.caseVersion,
      title: command.evaluationCase.title,
      targetPageCount: command.evaluationCase.targetPageCount,
      audience: command.evaluationCase.audience,
      readingMode: command.evaluationCase.readingMode,
      vendorPrompt: command.evaluationCase.vendorPrompt,
    },
    referencePack: command.referencePack,
    slides: command.renderManifest.slides.map(
      ({ pageNumber, extractedText }) => ({
        pageNumber,
        extractedText,
      }),
    ),
  });
}

function nonEmptyDecisionString(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`OpenAI Judge egress authorization missing ${label}`);
  }
  return value;
}

function freezeApprovedEgressAuthorization(
  decision: JudgeEgressAuthorizationDecision,
  request: JudgeEgressAuthorizationRequest,
  evaluatedAt: string,
): JudgeEgressAuthorizationLineage {
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const approvedAtMs = Date.parse(decision.approvedAt);
  const expiresAtMs = Date.parse(decision.expiresAt);
  const allowed = new Set(decision.allowedContentFields);
  if (
    decision.decision !== "approved" ||
    decision.dataClassification !== request.dataClassification ||
    decision.sourceOwner !== request.sourceOwner ||
    decision.processingPurpose !== request.processingPurpose ||
    decision.targetService !== request.targetService ||
    decision.targetAccount !== request.targetAccount ||
    decision.targetRegion !== request.targetRegion ||
    !Number.isFinite(evaluatedAtMs) ||
    !Number.isFinite(approvedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    approvedAtMs > evaluatedAtMs ||
    expiresAtMs <= evaluatedAtMs ||
    JUDGE_EGRESS_CONTENT_FIELDS.some((field) => !allowed.has(field)) ||
    decision.requiredRedactions.length > 0 ||
    decision.subprocessors.some((name) => name.length === 0)
  ) {
    throw new Error(
      "OpenAI Judge egress authorization is missing, denied, expired, or incompatible",
    );
  }
  return Object.freeze({
    decisionId: nonEmptyDecisionString(decision.decisionId, "decisionId"),
    decision: "approved",
    policyVersion: nonEmptyDecisionString(
      decision.policyVersion,
      "policyVersion",
    ),
    dataClassification: decision.dataClassification,
    sourceOwner: decision.sourceOwner,
    processingPurpose: decision.processingPurpose,
    targetService: decision.targetService,
    targetAccount: nonEmptyDecisionString(
      decision.targetAccount,
      "targetAccount",
    ),
    targetRegion: nonEmptyDecisionString(decision.targetRegion, "targetRegion"),
    subprocessors: Object.freeze([...decision.subprocessors]),
    allowedContentFields: Object.freeze([...decision.allowedContentFields]),
    requiredRedactions: Object.freeze([...decision.requiredRedactions]),
    legalSecurityBasis: nonEmptyDecisionString(
      decision.legalSecurityBasis,
      "legalSecurityBasis",
    ),
    approvedAt: decision.approvedAt,
    expiresAt: decision.expiresAt,
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`OpenAI Judge invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

async function assertDecodablePng(
  image: RasterizedJudgeImage,
  pageNumber: number,
): Promise<void> {
  if (
    image.mimeType !== "image/png" ||
    !(image.content instanceof Uint8Array) ||
    image.content.byteLength < PNG_SIGNATURE.byteLength ||
    PNG_SIGNATURE.some((byte, index) => image.content[index] !== byte)
  ) {
    throw new Error(
      `OpenAI Judge rasterizer returned invalid PNG bytes for page ${pageNumber}`,
    );
  }
  try {
    const decoded = await sharp(image.content)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width < 1 ||
      decoded.info.height < 1 ||
      decoded.data.byteLength !==
        decoded.info.width * decoded.info.height * decoded.info.channels
    ) {
      throw new Error("invalid decoded PNG pixels");
    }
  } catch (error) {
    throw new Error(
      `OpenAI Judge rasterizer returned undecodable PNG bytes for page ${pageNumber}`,
      { cause: error },
    );
  }
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OpenAI Judge invalid ${label}`);
  }
  return value;
}

function asBoundedNonEmptyString(
  value: unknown,
  maxLength: number,
  label: string,
): string {
  const text = asNonEmptyString(value, label);
  if (text.length > maxLength) {
    throw new Error(`OpenAI Judge invalid ${label}`);
  }
  return text;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new Error(`OpenAI Judge ${label} violates the strict schema`);
  }
}

function asPageNumbers(
  value: unknown,
  pageCount: number,
  requireEvidence: boolean,
): readonly number[] {
  if (
    !Array.isArray(value) ||
    (requireEvidence && value.length === 0) ||
    value.some(
      (page) => !Number.isInteger(page) || page < 1 || page > pageCount,
    )
  ) {
    throw new Error("OpenAI Judge invalid evidencePages");
  }
  return Object.freeze([...value]) as readonly number[];
}

function parseDimensions(
  value: unknown,
  pageCount: number,
): readonly DimensionScore[] {
  if (!Array.isArray(value) || value.length !== SCORE_DIMENSIONS.length) {
    throw new Error("OpenAI Judge invalid dimensions");
  }
  const seen = new Set<string>();
  const dimensions = value.map((entry) => {
    const record = asRecord(entry, "dimension");
    assertExactKeys(
      record,
      [
        "dimension",
        "assessmentStatus",
        "value",
        "deductionBasis",
        "evidencePages",
        "rationale",
      ],
      "dimension",
    );
    const dimension = asNonEmptyString(record.dimension, "dimension name");
    if (
      !SCORE_DIMENSIONS.includes(dimension as ScoreDimension) ||
      seen.has(dimension)
    ) {
      throw new Error("OpenAI Judge invalid or duplicate dimension");
    }
    seen.add(dimension);
    const assessmentStatus = record.assessmentStatus;
    if (
      assessmentStatus !== "ASSESSED" &&
      assessmentStatus !== "NOT_ASSESSABLE"
    ) {
      throw new Error("OpenAI Judge invalid assessment status");
    }
    if (assessmentStatus === "ASSESSED") {
      if (
        !Number.isInteger(record.value) ||
        (record.value as number) < 1 ||
        (record.value as number) > 5
      ) {
        throw new Error("OpenAI Judge invalid dimension value");
      }
    } else if (record.value !== null) {
      throw new Error("OpenAI Judge invalid dimension value");
    }
    const deductionBasis = record.deductionBasis;
    if (
      typeof deductionBasis !== "string" ||
      !(DEDUCTION_BASES as readonly string[]).includes(deductionBasis)
    ) {
      throw new Error("OpenAI Judge invalid deduction basis");
    }
    const typedDimension = dimension as ScoreDimension;
    if (typedDimension !== "factual_accuracy_and_content_quality") {
      const ownedBasis = NON_FACTUAL_DEDUCTION_BASIS[typedDimension];
      if (
        assessmentStatus !== "ASSESSED" ||
        record.value === null ||
        ownedBasis === undefined ||
        ((record.value as number) === 5 && deductionBasis !== "no_deduction") ||
        ((record.value as number) < 5 && deductionBasis !== ownedBasis)
      ) {
        throw new Error(
          "OpenAI Judge non-factual dimension used an unowned or hidden deduction basis",
        );
      }
    }
    const rationale = asNonEmptyString(record.rationale, "rationale");
    if (rationale.length > 240) {
      throw new Error("OpenAI Judge invalid rationale");
    }
    return Object.freeze<DimensionScore>({
      dimension: typedDimension,
      assessmentStatus: assessmentStatus as DimensionAssessmentStatus,
      value: record.value as ScoreValue | null,
      deductionBasis: deductionBasis as DimensionDeductionBasis,
      evidencePages: asPageNumbers(
        record.evidencePages,
        pageCount,
        assessmentStatus === "ASSESSED",
      ),
      rationale,
    });
  });
  if (SCORE_DIMENSIONS.some((dimension) => !seen.has(dimension))) {
    throw new Error("OpenAI Judge missing dimension");
  }
  return Object.freeze(dimensions);
}

function parseKnowledgeErrors(
  value: unknown,
  referencePack: ReferencePack | null,
  pageCount: number,
): readonly KnowledgeErrorDeduction[] {
  if (!Array.isArray(value)) {
    throw new Error("OpenAI Judge invalid knowledgeErrors");
  }
  if (value.length > 0 && referencePack === null) {
    throw new Error(
      "OpenAI Judge cannot deduct a knowledge error without a Reference Pack",
    );
  }
  const facts = new Map(
    referencePack?.facts.map((fact) => [fact.factId, fact]) ?? [],
  );
  const sourceIds = new Set(
    referencePack?.sources.map(({ sourceId }) => sourceId) ?? [],
  );
  const seenErrors = new Set<string>();
  return Object.freeze(
    value.map((entry) => {
      const record = asRecord(entry, "knowledge error");
      assertExactKeys(
        record,
        ["pageNumber", "claim", "correction", "factId", "sourceIds"],
        "knowledge error",
      );
      const pageNumber = record.pageNumber;
      if (
        !Number.isInteger(pageNumber) ||
        (pageNumber as number) < 1 ||
        (pageNumber as number) > pageCount
      ) {
        throw new Error("OpenAI Judge invalid knowledge error page");
      }
      const factId = asNonEmptyString(record.factId, "knowledge factId");
      const fact = facts.get(factId);
      if (
        fact === undefined ||
        !Array.isArray(record.sourceIds) ||
        record.sourceIds.length === 0 ||
        record.sourceIds.some(
          (sourceId) =>
            typeof sourceId !== "string" ||
            !sourceIds.has(sourceId) ||
            !fact.sourceIds.includes(sourceId),
        )
      ) {
        throw new Error(
          "OpenAI Judge knowledge error cites an uncovered fact or source",
        );
      }
      const claim = asBoundedNonEmptyString(
        record.claim,
        240,
        "knowledge claim",
      );
      const errorKey = `${pageNumber}:${factId}:${claim}`;
      if (seenErrors.has(errorKey)) {
        throw new Error("OpenAI Judge duplicate knowledge error");
      }
      seenErrors.add(errorKey);
      return Object.freeze({
        pageNumber: pageNumber as number,
        claim,
        correction: asBoundedNonEmptyString(
          record.correction,
          240,
          "knowledge correction",
        ),
        factId,
        sourceIds: Object.freeze([...record.sourceIds]) as readonly string[],
      });
    }),
  );
}

function assertNoHiddenFactualDeductions(
  dimensions: readonly DimensionScore[],
  knowledgeErrors: readonly KnowledgeErrorDeduction[],
  referencePack: ReferencePack | null,
): void {
  const factualScore = dimensions.find(
    ({ dimension }) => dimension === "factual_accuracy_and_content_quality",
  );
  if (referencePack === null) {
    if (
      factualScore?.assessmentStatus !== "NOT_ASSESSABLE" ||
      factualScore.value !== null ||
      factualScore.deductionBasis !== "not_assessable_no_reference_pack" ||
      factualScore.evidencePages.length !== 0
    ) {
      throw new Error(
        "OpenAI Judge factual criterion must be NOT_ASSESSABLE without a Reference Pack",
      );
    }
    return;
  }
  const expectedValue = Math.max(1, 5 - knowledgeErrors.length);
  const expectedBasis =
    knowledgeErrors.length === 0
      ? "no_deduction"
      : "validated_reference_pack_errors";
  if (
    factualScore?.assessmentStatus !== "ASSESSED" ||
    factualScore.value !== expectedValue ||
    factualScore.deductionBasis !== expectedBasis
  ) {
    throw new Error(
      "OpenAI Judge factual score contains a hidden deduction not backed by a validated knowledge error",
    );
  }
}

function responseOutputText(response: Record<string, unknown>): string {
  if (!Array.isArray(response.output)) {
    throw new Error("OpenAI Judge response has no output");
  }
  let outputText: string | null = null;
  for (const item of response.output) {
    const message = asRecord(item, "output item");
    if (message.type !== "message" || !Array.isArray(message.content)) {
      continue;
    }
    if (message.status !== "completed") {
      throw new Error("OpenAI Judge message was incomplete");
    }
    for (const content of message.content) {
      const part = asRecord(content, "message content");
      if (part.type === "refusal") {
        throw new Error("OpenAI Judge refused the evaluation");
      }
      if (part.type === "output_text") {
        if (outputText !== null) {
          throw new Error("OpenAI Judge response has multiple output texts");
        }
        outputText = asNonEmptyString(part.text, "output text");
      }
    }
  }
  if (outputText === null) {
    throw new Error("OpenAI Judge response has no output text");
  }
  return outputText;
}

export class OpenAiResponsesJudgeAdapter implements OpenAiJudgePort {
  readonly #transport: OpenAiResponsesTransport;
  readonly #rasterizer: StaticRenderRasterizerPort;
  readonly #egressAuthorization: JudgeEgressAuthorizationPort | undefined;
  readonly #egressAudit: JudgeEgressAuditPort | undefined;
  readonly #now: () => string;
  readonly #cache = new Map<string, Promise<ArtifactScorecard>>();

  constructor(options: OpenAiResponsesJudgeAdapterOptions) {
    this.#transport = options.transport;
    this.#rasterizer = options.rasterizer ?? new SharpStaticRenderRasterizer();
    this.#egressAuthorization = options.egressAuthorization;
    this.#egressAudit = options.egressAudit;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  score(command: OpenAiJudgeCommand): Promise<ArtifactScorecard> {
    if (
      command.artifact.artifactId !== command.renderManifest.artifactId ||
      command.artifact.runId !== command.runId
    ) {
      return Promise.reject(
        new Error("OpenAI Judge received inconsistent Artifact lineage"),
      );
    }
    const contextText = judgeContextText(command);
    const contextHash = sha256(contextText);
    const cacheKey = judgeCacheKey(
      command,
      this.#rasterizer.version,
      contextHash,
    );
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const pending = this.#scoreUncached(command, contextText, contextHash);
    this.#cache.set(cacheKey, pending);
    return pending;
  }

  async #scoreUncached(
    command: OpenAiJudgeCommand,
    contextText: string,
    contextHash: `sha256:${string}`,
  ): Promise<ArtifactScorecard> {
    const rasterizedSlides = await Promise.all(
      command.renderManifest.slides.map(async (slide) => {
        const image = await this.#rasterizer.rasterize(slide);
        await assertDecodablePng(image, slide.pageNumber);
        return {
          pageNumber: slide.pageNumber,
          image,
        };
      }),
    );
    const rasterizedImageHashes = Object.freeze(
      rasterizedSlides.map(({ pageNumber, image }) =>
        Object.freeze<RasterizedImageLineage>({
          pageNumber,
          mimeType: "image/png",
          contentHash: sha256(image.content),
        }),
      ),
    );
    const rasterizedImagesHash = sha256(JSON.stringify(rasterizedImageHashes));
    const request = {
      model: JUDGE_CONFIG.model,
      reasoning: JUDGE_CONFIG.reasoning,
      max_output_tokens: JUDGE_CONFIG.max_output_tokens,
      store: JUDGE_CONFIG.store,
      truncation: JUDGE_CONFIG.truncation,
      instructions: JUDGE_PROMPT,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: contextText,
            },
            ...rasterizedSlides.map(({ image }) => ({
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${Buffer.from(
                image.content,
              ).toString("base64")}`,
              detail: JUDGE_CONFIG.imageDetail,
            })),
          ],
        },
      ],
      text: {
        verbosity: JUDGE_CONFIG.text.verbosity,
        format: {
          type: JUDGE_CONFIG.text.formatType,
          name: JUDGE_CONFIG.text.formatName,
          strict: JUDGE_CONFIG.text.strict,
          schema: JUDGE_SCHEMA,
        },
      },
    };
    const payloadHash = sha256(JSON.stringify(request));
    if (this.#egressAuthorization === undefined) {
      throw new Error(
        "OpenAI Judge egress authorization is missing; submission blocked",
      );
    }
    const evaluatedAt = this.#now();
    const egressRequest = Object.freeze<JudgeEgressAuthorizationRequest>({
      payloadHash,
      dataClassification: "public_or_synthetic",
      sourceOwner: [
        command.evaluationCase.recordId,
        ...(command.referencePack?.sources.map(({ publisher }) => publisher) ??
          []),
      ].join(" | "),
      processingPurpose: "presentation_artifact_evaluation",
      targetService: "openai",
      targetAccount: this.#transport.destination.targetAccount,
      targetRegion: this.#transport.destination.targetRegion,
      contentFields: JUDGE_EGRESS_CONTENT_FIELDS,
    });
    const egressAuthorization = freezeApprovedEgressAuthorization(
      await this.#egressAuthorization.authorize(egressRequest),
      egressRequest,
      evaluatedAt,
    );
    const egressAuthorizationHash = sha256(JSON.stringify(egressAuthorization));
    const inputHash = sha256(
      JSON.stringify({ payloadHash, egressAuthorizationHash }),
    );
    const idempotencyKey =
      `judge_${payloadHash.slice("sha256:".length)}` as const;
    if (this.#egressAudit === undefined) {
      throw new Error(
        "OpenAI Judge egress audit persistence is missing; submission blocked",
      );
    }
    const egressAttempt = Object.freeze<JudgeEgressAttemptAudit>({
      attemptId: command.evaluationAttemptId,
      jobId: command.jobId,
      runId: command.runId,
      artifactId: command.artifact.artifactId,
      scorecardId: command.scorecardId,
      payloadHash,
      idempotencyKey,
      egressAuthorizationHash,
      egressAuthorization,
      recordedAt: evaluatedAt,
    });
    await this.#egressAudit.recordAuthorizedAttempt(egressAttempt);
    let rawResponse: unknown;
    try {
      rawResponse = await this.#transport.create(request, idempotencyKey);
    } catch (error) {
      throw new OpenAiJudgeEvaluationError(
        "OpenAI Judge transport failed after authorized attempt was persisted",
        {
          submissionStatus: "unknown",
          egressAttempt,
          cause: error,
        },
      );
    }
    try {
      const response = asRecord(rawResponse, "response");
      if (response.status !== "completed") {
        throw new Error("OpenAI Judge response was incomplete");
      }
      const outputText = responseOutputText(response);
      let payload: unknown;
      try {
        payload = JSON.parse(outputText);
      } catch {
        throw new Error("OpenAI Judge returned invalid JSON");
      }
      const parsed = asRecord(payload, "structured output");
      assertExactKeys(
        parsed,
        ["dimensions", "knowledgeErrors"],
        "structured output",
      );
      const dimensions = parseDimensions(
        parsed.dimensions,
        command.artifact.pageCount,
      );
      const knowledgeErrors = parseKnowledgeErrors(
        parsed.knowledgeErrors,
        command.referencePack,
        command.artifact.pageCount,
      );
      assertNoHiddenFactualDeductions(
        dimensions,
        knowledgeErrors,
        command.referencePack,
      );
      return Object.freeze<ArtifactScorecard>({
        scorecardId: command.scorecardId,
        artifactId: command.artifact.artifactId,
        runId: command.runId,
        jobId: command.jobId,
        provenance: command.artifact.provenance,
        environmentOrigin: command.artifact.environmentOrigin,
        rubricVersion: "query-six-dimension-v1",
        evaluationInputManifest: {
          artifactHash: command.artifact.contentHash,
          renderManifestHash: command.renderManifest.contentHash,
          renderer: command.renderManifest.renderer,
          referencePackHash: command.referencePack?.contentHash ?? null,
        },
        dimensions,
        knowledgeErrors,
        judgeLineage: {
          provider: "openai",
          adapterVersion: OPENAI_JUDGE_ADAPTER_VERSION,
          requestedModel: OPENAI_JUDGE_MODEL,
          responseModel: asNonEmptyString(response.model, "response model"),
          responseId: asNonEmptyString(response.id, "response id"),
          promptVersion: OPENAI_JUDGE_PROMPT_VERSION,
          promptHash: PROMPT_HASH,
          configHash: CONFIG_HASH,
          schemaHash: SCHEMA_HASH,
          contextHash,
          payloadHash,
          egressAuthorizationHash,
          egressAuthorization,
          egressAttemptId: egressAttempt.attemptId,
          egressAttempt,
          inputHash,
          idempotencyKey,
          rasterizerVersion: this.#rasterizer.version,
          rasterizedImagesHash,
          rasterizedImageHashes,
          imageDetail: JUDGE_CONFIG.imageDetail,
          store: false,
        },
        deliveryQualityGates: [
          {
            gate: "artifact_captured_and_openable",
            status: "PASS",
            effect: "exclude_from_quality",
          },
          {
            gate: "sufficient_faithful_visual_input",
            status: "PASS",
            effect: "exclude_from_quality",
          },
          {
            gate: "required_delivery_export_format",
            status: "PASS",
            effect: "score_normally_with_flag",
          },
        ],
        createdAt: evaluatedAt,
      });
    } catch (error) {
      if (error instanceof OpenAiJudgeEvaluationError) throw error;
      throw new OpenAiJudgeEvaluationError(
        error instanceof Error
          ? error.message
          : "OpenAI Judge response failed closed after authorized submission",
        {
          submissionStatus: "submitted",
          egressAttempt,
          cause: error,
        },
      );
    }
  }
}
