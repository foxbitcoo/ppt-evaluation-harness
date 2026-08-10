import assert from "node:assert/strict";
import test from "node:test";

import {
  createBakeoffBatchManifest,
  createQueryProfileCaseVariants,
  toFeishuRunRecord,
  type ApprovedQueryProfileCase,
  type ProductSurface,
} from "../evaluation/index.ts";

const approvedCase: ApprovedQueryProfileCase = {
  caseId: "qprofile-v1-office-01-project-status-decision",
  caseVersion: "1.0.0",
  query: "制作一份8页中文高层项目状态PPT。",
  presentationAudience: {
    description: "CEO、研发负责人、销售负责人、财务负责人",
    priorKnowledge: "了解产品，但不了解日常实现细节",
    readingMode: "10分钟会议投影",
  },
  useContext: {
    occasion: "经营层项目例会",
    objective: "获得资源或范围取舍决策",
    expectedDurationMinutes: 10,
    targetPageCount: 8,
  },
  requesterProfile: [
    { label: "角色", value: "B2B SaaS产品经理" },
    { label: "经验", value: "5年产品经验，第一年定期向经营层汇报" },
    { label: "工作方式", value: "重细节，习惯先讲过程再讲结论" },
  ],
};

const surfaces: readonly ProductSurface[] = [
  {
    surfaceId: "wps-aippt-web",
    vendor: "WPS AI PPT",
    surface: "WEB",
    entryLocator: "https://aippt.wps.cn/aippt/",
    version: "web@batch-time",
  },
  {
    surfaceId: "qianwen-desktop",
    vendor: "千问",
    surface: "DESKTOP",
    entryLocator: "com.alibaba.tongyi",
    version: "4.0.0.158",
  },
];

test("Profile A/B variants keep Query, audience, use context, and page count identical", () => {
  const variants = createQueryProfileCaseVariants(approvedCase);
  const [control, treatment] = variants;

  assert.equal(control.treatment, "NO_REQUESTER_PROFILE");
  assert.equal(treatment.treatment, "REQUESTER_PROFILE_INJECTED");
  assert.equal(control.commonInputHash, treatment.commonInputHash);
  assert.equal(control.query, treatment.query);
  assert.deepEqual(control.presentationAudience, treatment.presentationAudience);
  assert.deepEqual(control.useContext, treatment.useContext);
  assert.doesNotMatch(control.vendorPrompt.text, /B2B SaaS产品经理/);
  assert.match(treatment.vendorPrompt.text, /请求者 Profile/);
  assert.match(treatment.vendorPrompt.text, /B2B SaaS产品经理/);
  assert.notEqual(control.vendorPrompt.contentHash, treatment.vendorPrompt.contentHash);
});

test("Batch manifest expands one approved case into deterministic per-surface A/B run plans", () => {
  const manifest = createBakeoffBatchManifest({
    batchId: "BATCH-0001",
    batchSeq: 1,
    environment: "LIVE_PRODUCTION",
    cases: [approvedCase],
    surfaces,
    judge: {
      provider: "volcengine-ark",
      model: "doubao-seed-2-0-pro-260215",
    },
    rubric: {
      rubricId: "query-ppt-rubric",
      rubricVersion: "1.1.0",
    },
  });

  assert.equal(manifest.status, "PREPARED");
  assert.equal(manifest.batchDate, null);
  assert.equal(manifest.startedAt, null);
  assert.equal(manifest.runs.length, 4);
  assert.equal(new Set(manifest.runs.map(({ runId }) => runId)).size, 4);
  assert.match(manifest.contentHash, /^sha256:[a-f0-9]{64}$/);

  const webControl = manifest.runs.find(
    ({ surfaceId, treatment }) =>
      surfaceId === "wps-aippt-web" && treatment === "NO_REQUESTER_PROFILE",
  );
  assert.ok(webControl);
  const feishu = toFeishuRunRecord(webControl);
  assert.equal(feishu["批次ID"], "BATCH-0001");
  assert.equal(feishu["实验分组"], "NO_REQUESTER_PROFILE");
  assert.equal(feishu["运行面"], "WEB");
  assert.equal(feishu["网页入口"], "https://aippt.wps.cn/aippt/");
  assert.equal(feishu["运行状态"], undefined);
  assert.match(String(feishu["载荷哈希"]), /^[a-f0-9]{64}$/);
});

test("Batch manifest rejects ambiguous or duplicate product surfaces", () => {
  assert.throws(
    () =>
      createBakeoffBatchManifest({
        batchId: "BATCH-0001",
        batchSeq: 1,
        environment: "LIVE_PRODUCTION",
        cases: [approvedCase],
        surfaces: [surfaces[0]!, surfaces[0]!],
        judge: {
          provider: "volcengine-ark",
          model: "doubao-seed-2-0-pro-260215",
        },
        rubric: {
          rubricId: "query-ppt-rubric",
          rubricVersion: "1.1.0",
        },
      }),
    /运行面 ID 重复/,
  );
});

test("Batch manifest rejects multiple versions of one Case because Run IDs must stay unambiguous", () => {
  assert.throws(
    () =>
      createBakeoffBatchManifest({
        batchId: "BATCH-0001",
        batchSeq: 1,
        environment: "LIVE_PRODUCTION",
        cases: [
          approvedCase,
          { ...approvedCase, caseVersion: "1.0.1" },
        ],
        surfaces,
        judge: {
          provider: "volcengine-ark",
          model: "doubao-seed-2-0-pro-260215",
        },
        rubric: {
          rubricId: "query-ppt-rubric",
          rubricVersion: "1.1.0",
        },
      }),
    /同一批次不能包含同一 Case 的多个版本/,
  );
});
