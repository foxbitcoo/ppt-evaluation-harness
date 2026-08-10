import { createHash } from "node:crypto";

import type { Sha256Hash } from "./module.ts";

export type MemoryExposureTreatment =
  | "NO_REQUESTER_PROFILE"
  | "REQUESTER_PROFILE_INJECTED";

export type EvaluationDataEnvironment =
  | "LIVE_PRODUCTION"
  | "PRODUCTION_REPLAY"
  | "MOCK";

export interface ApprovedQueryProfileCase {
  readonly caseId: string;
  readonly caseVersion: string;
  readonly query: string;
  readonly presentationAudience: {
    readonly description: string;
    readonly priorKnowledge: string;
    readonly readingMode: string;
  };
  readonly useContext: {
    readonly occasion: string;
    readonly objective: string;
    readonly expectedDurationMinutes: number;
    readonly targetPageCount: number;
  };
  readonly requesterProfile: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

export interface QueryProfileCaseVariant {
  readonly schemaVersion: "query-profile-case-variant-v1";
  readonly caseId: string;
  readonly caseVersion: string;
  readonly treatment: MemoryExposureTreatment;
  readonly query: string;
  readonly presentationAudience: ApprovedQueryProfileCase["presentationAudience"];
  readonly useContext: ApprovedQueryProfileCase["useContext"];
  readonly requesterProfileVisible: boolean;
  readonly commonInputHash: Sha256Hash;
  readonly vendorPrompt: {
    readonly templateVersion: "query-profile-ab-v1";
    readonly text: string;
    readonly contentHash: Sha256Hash;
  };
  readonly contentHash: Sha256Hash;
}

export interface ProductSurface {
  readonly surfaceId: string;
  readonly vendor: string;
  readonly surface: "WEB" | "DESKTOP";
  readonly entryLocator: string;
  readonly version: string;
}

export interface EvaluationRunPlan {
  readonly schemaVersion: "evaluation-run-plan-v1";
  readonly stableId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly batchSeq: number;
  readonly environment: EvaluationDataEnvironment;
  readonly status: "PREPARED";
  readonly caseId: string;
  readonly caseVersion: string;
  readonly treatment: MemoryExposureTreatment;
  readonly surfaceId: string;
  readonly vendor: string;
  readonly surface: "WEB" | "DESKTOP";
  readonly surfaceVersion: string;
  readonly entryLocator: string;
  readonly query: string;
  readonly vendorPrompt: QueryProfileCaseVariant["vendorPrompt"];
  readonly targetPageCount: number;
  readonly commonInputHash: Sha256Hash;
  readonly contentHash: Sha256Hash;
}

export interface BakeoffBatchManifest {
  readonly schemaVersion: "bakeoff-batch-manifest-v1";
  readonly stableId: string;
  readonly batchId: string;
  readonly batchSeq: number;
  readonly batchDate: string | null;
  readonly startedAt: string | null;
  readonly environment: EvaluationDataEnvironment;
  readonly status: "PREPARED";
  readonly judge: {
    readonly provider: string;
    readonly model: string;
  };
  readonly rubric: {
    readonly rubricId: string;
    readonly rubricVersion: string;
  };
  readonly runs: readonly EvaluationRunPlan[];
  readonly contentHash: Sha256Hash;
}

export interface CreateBakeoffBatchManifestInput {
  readonly batchId: string;
  readonly batchSeq: number;
  readonly environment: EvaluationDataEnvironment;
  readonly cases: readonly ApprovedQueryProfileCase[];
  readonly surfaces: readonly ProductSurface[];
  readonly judge: BakeoffBatchManifest["judge"];
  readonly rubric: BakeoffBatchManifest["rubric"];
}

export type FeishuRunRecord = Readonly<Record<string, string | number | undefined>>;

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) throw new Error(`${fieldName} 不能为空`);
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
    : JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function withoutSha256Prefix(hash: Sha256Hash): string {
  return hash.slice("sha256:".length);
}

function buildCommonPrompt(input: ApprovedQueryProfileCase): string {
  return [
    `用户 Query：${input.query}`,
    `PPT 受众：${input.presentationAudience.description}`,
    `受众已有认知：${input.presentationAudience.priorKnowledge}`,
    `阅读/演示方式：${input.presentationAudience.readingMode}`,
    `使用场景：${input.useContext.occasion}`,
    `制作目标：${input.useContext.objective}`,
    `演示时长：${input.useContext.expectedDurationMinutes} 分钟`,
    `页数要求：${input.useContext.targetPageCount} 页`,
  ].join("\n");
}

export function createQueryProfileCaseVariants(
  input: ApprovedQueryProfileCase,
): readonly [QueryProfileCaseVariant, QueryProfileCaseVariant] {
  assertNonEmpty(input.caseId, "caseId");
  assertNonEmpty(input.caseVersion, "caseVersion");
  assertNonEmpty(input.query, "query");
  assertNonEmpty(input.presentationAudience.description, "presentationAudience.description");
  assertNonEmpty(input.useContext.objective, "useContext.objective");
  if (
    !Number.isInteger(input.useContext.targetPageCount) ||
    input.useContext.targetPageCount < 1 ||
    input.useContext.targetPageCount > 20
  ) {
    throw new Error("目标页数必须是 1到20 之间的整数");
  }
  if (input.requesterProfile.length === 0) {
    throw new Error("requesterProfile 至少需要一个字段");
  }
  input.requesterProfile.forEach(({ label, value }) => {
    assertNonEmpty(label, "requesterProfile.label");
    assertNonEmpty(value, "requesterProfile.value");
  });

  const commonPrompt = buildCommonPrompt(input);
  const commonInput = {
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    query: input.query,
    presentationAudience: input.presentationAudience,
    useContext: input.useContext,
  };
  const commonInputHash = sha256(commonInput);

  const createVariant = (
    treatment: MemoryExposureTreatment,
  ): QueryProfileCaseVariant => {
    const requesterProfileVisible = treatment === "REQUESTER_PROFILE_INJECTED";
    const profilePrompt = requesterProfileVisible
      ? [
          "请求者 Profile（用于个性化表达，不得据此虚构事实）：",
          ...input.requesterProfile.map(({ label, value }) => `- ${label}：${value}`),
        ].join("\n")
      : "";
    const promptText = requesterProfileVisible
      ? `${commonPrompt}\n${profilePrompt}`
      : commonPrompt;
    const withoutContentHash = {
      schemaVersion: "query-profile-case-variant-v1" as const,
      ...commonInput,
      treatment,
      requesterProfileVisible,
      commonInputHash,
      vendorPrompt: {
        templateVersion: "query-profile-ab-v1" as const,
        text: promptText,
        contentHash: sha256(promptText),
      },
    };
    return Object.freeze({
      ...withoutContentHash,
      contentHash: sha256(withoutContentHash),
    });
  };

  return Object.freeze([
    createVariant("NO_REQUESTER_PROFILE"),
    createVariant("REQUESTER_PROFILE_INJECTED"),
  ]) as readonly [QueryProfileCaseVariant, QueryProfileCaseVariant];
}

function createRunPlan(input: {
  readonly batchId: string;
  readonly batchSeq: number;
  readonly environment: EvaluationDataEnvironment;
  readonly variant: QueryProfileCaseVariant;
  readonly surface: ProductSurface;
}): EvaluationRunPlan {
  const runId = [
    input.batchId,
    input.variant.caseId,
    input.variant.treatment,
    input.surface.surfaceId,
  ].join(":");
  const withoutContentHash = {
    schemaVersion: "evaluation-run-plan-v1" as const,
    stableId: `run:${runId}`,
    runId,
    batchId: input.batchId,
    batchSeq: input.batchSeq,
    environment: input.environment,
    status: "PREPARED" as const,
    caseId: input.variant.caseId,
    caseVersion: input.variant.caseVersion,
    treatment: input.variant.treatment,
    surfaceId: input.surface.surfaceId,
    vendor: input.surface.vendor,
    surface: input.surface.surface,
    surfaceVersion: input.surface.version,
    entryLocator: input.surface.entryLocator,
    query: input.variant.query,
    vendorPrompt: input.variant.vendorPrompt,
    targetPageCount: input.variant.useContext.targetPageCount,
    commonInputHash: input.variant.commonInputHash,
  };
  return Object.freeze({
    ...withoutContentHash,
    contentHash: sha256(withoutContentHash),
  });
}

export function createBakeoffBatchManifest(
  input: CreateBakeoffBatchManifestInput,
): BakeoffBatchManifest {
  assertNonEmpty(input.batchId, "batchId");
  assertNonEmpty(input.judge.provider, "judge.provider");
  assertNonEmpty(input.judge.model, "judge.model");
  assertNonEmpty(input.rubric.rubricId, "rubric.rubricId");
  assertNonEmpty(input.rubric.rubricVersion, "rubric.rubricVersion");
  if (!Number.isInteger(input.batchSeq) || input.batchSeq < 1) {
    throw new Error("batchSeq 必须是正整数");
  }
  if (input.cases.length === 0) throw new Error("批次至少需要一个 Case");
  if (input.surfaces.length === 0) throw new Error("批次至少需要一个运行面");

  const surfaceIds = new Set<string>();
  input.surfaces.forEach((surface) => {
    assertNonEmpty(surface.surfaceId, "surfaceId");
    assertNonEmpty(surface.vendor, "surface.vendor");
    assertNonEmpty(surface.entryLocator, "surface.entryLocator");
    assertNonEmpty(surface.version, "surface.version");
    if (surfaceIds.has(surface.surfaceId)) {
      throw new Error(`运行面 ID 重复：${surface.surfaceId}`);
    }
    surfaceIds.add(surface.surfaceId);
  });

  const caseIds = new Set<string>();
  const runs: EvaluationRunPlan[] = [];
  input.cases.forEach((approvedCase) => {
    if (caseIds.has(approvedCase.caseId)) {
      throw new Error(
        `同一批次不能包含同一 Case 的多个版本：${approvedCase.caseId}`,
      );
    }
    caseIds.add(approvedCase.caseId);
    const variants = createQueryProfileCaseVariants(approvedCase);
    variants.forEach((variant) => {
      input.surfaces.forEach((surface) => {
        runs.push(createRunPlan({
          batchId: input.batchId,
          batchSeq: input.batchSeq,
          environment: input.environment,
          variant,
          surface,
        }));
      });
    });
  });

  const withoutContentHash = {
    schemaVersion: "bakeoff-batch-manifest-v1" as const,
    stableId: `batch:${input.batchId}`,
    batchId: input.batchId,
    batchSeq: input.batchSeq,
    batchDate: null,
    startedAt: null,
    environment: input.environment,
    status: "PREPARED" as const,
    judge: input.judge,
    rubric: input.rubric,
    runs: Object.freeze(runs),
  };
  return Object.freeze({
    ...withoutContentHash,
    contentHash: sha256(withoutContentHash),
  });
}

export function toFeishuRunRecord(run: EvaluationRunPlan): FeishuRunRecord {
  const record: Record<string, string | number | undefined> = {
    "稳定ID": run.stableId,
    "运行ID": run.runId,
    "批次ID": run.batchId,
    "批次序号": run.batchSeq,
    "题目ID": run.caseId,
    "Case版本": run.caseVersion,
    "实验分组": run.treatment,
    "厂商": run.vendor,
    "运行面": run.surface,
    "运行面版本": run.surfaceVersion,
    "入口定位": run.entryLocator,
    "数据环境": run.environment,
    "提示词": run.vendorPrompt.text,
    "目标页数": run.targetPageCount,
    "网页入口": run.surface === "WEB" ? run.entryLocator : undefined,
    "载荷": JSON.stringify(run),
    "载荷哈希": withoutSha256Prefix(run.contentHash),
  };
  return Object.freeze(record);
}
