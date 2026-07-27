import { createHash } from "node:crypto";

import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import sharp from "sharp";

import type {
  Artifact,
  ArtifactScorecard,
  DimensionScore,
  EvaluationCaseRecord,
  KnowledgeErrorDeduction,
  RasterizedImageLineage,
  RenderManifest,
  ScoreDimension,
  ScoreValue,
  StaticSlideRender,
} from "./domain.ts";
import type { ReferencePack } from "./reference-pack.ts";

export const OPENAI_JUDGE_MODEL = "gpt-5.6-sol" as const;
export const OPENAI_JUDGE_ADAPTER_VERSION =
  "openai-responses-judge@1" as const;
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

const JUDGE_PROMPT = `Evaluate one presentation Artifact from its static slide renders.
Return exactly the six declared 1–5 integer dimensions. Give page evidence and a concise rationale for every dimension.
Delivery Quality is handled by automatic gates and must not become a seventh score.
For factual correctness, use only facts in the supplied Reference Pack. Never deduct for an uncovered fact.
Every knowledge-error deduction must identify the exact Reference Pack factId and sourceIds that support the correction.
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
          value: { type: "integer", minimum: 1, maximum: 5 },
          evidencePages: {
            type: "array",
            minItems: 1,
            items: { type: "integer", minimum: 1 },
          },
          rationale: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: ["dimension", "value", "evidencePages", "rationale"],
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
        required: [
          "pageNumber",
          "claim",
          "correction",
          "factId",
          "sourceIds",
        ],
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
});

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const PROMPT_HASH = sha256(JUDGE_PROMPT);
const SCHEMA_HASH = sha256(JSON.stringify(JUDGE_SCHEMA));
const CONFIG_HASH = sha256(JSON.stringify(JUDGE_CONFIG));

export interface OpenAiJudgeCommand {
  readonly jobId: string;
  readonly runId: string;
  readonly scorecardId: string;
  readonly evaluationCase: EvaluationCaseRecord;
  readonly artifact: Artifact;
  readonly renderManifest: RenderManifest;
  readonly referencePack: ReferencePack | null;
}

export interface OpenAiJudgePort {
  score(command: OpenAiJudgeCommand): Promise<ArtifactScorecard>;
}

export interface OpenAiResponsesTransport {
  create(
    request: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown>;
}

export interface RasterizedJudgeImage {
  readonly mimeType: "image/png";
  readonly content: Uint8Array;
}

export interface StaticRenderRasterizerPort {
  readonly version: string;
  rasterize(slide: StaticSlideRender): Promise<RasterizedJudgeImage>;
}

export class SharpStaticRenderRasterizer
  implements StaticRenderRasterizerPort
{
  readonly version = "sharp-svg-to-png@1";

  async rasterize(slide: StaticSlideRender): Promise<RasterizedJudgeImage> {
    try {
      const content = await sharp(Buffer.from(slide.content))
        .png()
        .toBuffer();
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

  constructor(client: OpenAI = new OpenAI()) {
    this.#client = client;
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
  readonly transport?: OpenAiResponsesTransport;
  readonly rasterizer?: StaticRenderRasterizerPort;
  readonly now?: () => string;
}

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

function judgeInputHash(
  command: OpenAiJudgeCommand,
  rasterizerVersion: string,
  contextHash: `sha256:${string}`,
  rasterizedImageHashes: readonly RasterizedImageLineage[],
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
      rasterizedImageHashes,
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`OpenAI Judge invalid ${label}`);
  }
  return value as Record<string, unknown>;
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

function asPageNumbers(value: unknown, pageCount: number): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
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
      ["dimension", "value", "evidencePages", "rationale"],
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
    if (
      !Number.isInteger(record.value) ||
      (record.value as number) < 1 ||
      (record.value as number) > 5
    ) {
      throw new Error("OpenAI Judge invalid dimension value");
    }
    const rationale = asNonEmptyString(record.rationale, "rationale");
    if (rationale.length > 240) {
      throw new Error("OpenAI Judge invalid rationale");
    }
    return Object.freeze<DimensionScore>({
      dimension: dimension as ScoreDimension,
      value: record.value as ScoreValue,
      evidencePages: asPageNumbers(record.evidencePages, pageCount),
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
  return Object.freeze(
    value.map((entry) => {
      const record = asRecord(entry, "knowledge error");
      assertExactKeys(
        record,
        [
          "pageNumber",
          "claim",
          "correction",
          "factId",
          "sourceIds",
        ],
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
      return Object.freeze({
        pageNumber: pageNumber as number,
        claim: asBoundedNonEmptyString(
          record.claim,
          240,
          "knowledge claim",
        ),
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
  readonly #now: () => string;
  readonly #cache = new Map<string, Promise<ArtifactScorecard>>();

  constructor(options: OpenAiResponsesJudgeAdapterOptions) {
    this.#transport = options.transport ?? new OpenAiSdkResponsesTransport();
    this.#rasterizer =
      options.rasterizer ?? new SharpStaticRenderRasterizer();
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
    const pending = this.#scoreUncached(
      command,
      contextText,
      contextHash,
    );
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
        if (
          image.mimeType !== "image/png" ||
          !(image.content instanceof Uint8Array) ||
          image.content.byteLength === 0
        ) {
          throw new Error(
            `OpenAI Judge rasterizer returned an invalid PNG for page ${slide.pageNumber}`,
          );
        }
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
    const rasterizedImagesHash = sha256(
      JSON.stringify(rasterizedImageHashes),
    );
    const inputHash = judgeInputHash(
      command,
      this.#rasterizer.version,
      contextHash,
      rasterizedImageHashes,
    );
    const idempotencyKey =
      `judge_${inputHash.slice("sha256:".length)}` as const;
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
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "ppt_artifact_scorecard",
          strict: true,
          schema: JUDGE_SCHEMA,
        },
      },
    };
    const rawResponse = await this.#transport.create(request, idempotencyKey);
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
      createdAt: this.#now(),
    });
  }
}
