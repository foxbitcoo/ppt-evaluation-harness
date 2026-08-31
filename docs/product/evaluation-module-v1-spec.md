# PPT Evaluation Module v1：现状审计与规格草案

状态：Draft，供主任务和产品经理评审
审计基线：`codex/bridge-v2-integration` / `c141b45`；预期交付分支：`codex/ppt-evaluation-v1-spec`
日期：2026-08-03

修订说明：用户讨论后，当前方向已转入 [v1.1 三态标注、分层评测与 Query 题库](evaluation-module-v1.1-tristate-hierarchy.md)。本文件仅保留原始六维/九维审计作为历史背景；权威公共契约使用三态、`Deck → Slide → Element` 对象层级和独立 Evidence。

本文件只覆盖静态 PPT 的 Evaluation Module：美学质量、内容/结构质量、底线问题、事实准确性、评分证据、Rubric 版本化、Mock/真实 Judge 边界和评测测试。厂商网页采集、PPT 生成、Trace/耗时、飞书发布、产品差距卡和最终报告编排仍由主任务负责。

## 1. 结论摘要

当前仓库已经具备可复用的评测基础设施，但还没有一个对主流程隐藏复杂性的深 Evaluation Module。当前能力分散在 `bakeoff.ts`、`mock-score.ts`、`openai-judge.ts`、`reference-pack.ts` 和 `domain.ts` 中；`bakeoff.ts` 直接选择 Mock scorer 或 OpenAI Judge，测试也有直接导入 `scoreRenderedArtifact` 和 `OpenAiResponsesJudgeAdapter` 的情况。

v1 建议新增一个外部 seam：

```text
EvaluationInput  ──>  EvaluationModule.evaluate()  ──>  EvaluationResult
                         │
                         ├─ gate evaluator
                         ├─ track rubric registry
                         ├─ reference-pack validator
                         ├─ Mock Judge adapter / Real Judge adapter
                         └─ evidence + lineage validator
```

主流程只负责把已捕获 Artifact 和已完成的静态渲染组装成 `EvaluationInput`，再消费 `EvaluationResult`。现有 `ArtifactScorecard`、Feishu 投影和动态比较先通过兼容转换保留，避免本阶段改动厂商 Runner 或发布流程。

v1 不计算未经校准的总分、冠军或固定 WPS baseline。单个维度仍使用整数 1–5；缺少可靠输入或参考材料时使用 `NOT_ASSESSABLE`。底线状态单独返回 `PASS | FAIL | UNKNOWN`，不把底线失败伪装成美学零分。

## 2. 现状审计

### 2.1 已存在且应复用的能力

| 能力 | 当前证据 | v1 处理 |
|---|---|---|
| Case 与轨道 | `src/domain.ts:96-110`、`src/fixtures/volcano-case.ts:7-24` 已有版本、Query track、受众、页数、自读模式；当前类型只允许 `query_generation` | 保留 Case 语义；输入接口扩展为 Query/Document 联合类型，Rubric 按 track 选择 |
| Artifact 血缘 | `src/domain.ts:159-171` 有 Artifact ID、Run ID、哈希、页数、MIME、捕获时间；`artifact-vault.ts` 负责不可变存储和派生物 | 作为输入元数据来源；不把 URL 当 Artifact |
| 静态渲染 | `src/domain.ts:173-218` 有 slide render、提取文本、contact sheet、渲染策略、保真状态；`safe-raster.ts` 已有离线渲染授权 | 渲染仍在模块外；模块只接受冻结的静态评测面，并检查页号/哈希/保真度 |
| 按需知识包 | `src/reference-pack.ts:6-35,165-295` 已有 `automatic/force/off`、权威来源过滤、内容哈希和使用留档 | 复用为 Reference Pack adapter；不把知识包传给厂商生成器 |
| 真实 Judge | `src/openai-judge.ts:164-176,764-1030` 已有多模态、严格 JSON schema、一次调用、模型/提示词/配置/输入/图像哈希和 egress lineage | 适配到内部 Judge seam；OpenAI 命令对象不外泄给主流程 |
| Mock scorer | `src/mock-score.ts:19-185,187-237` 有固定六维、静态文本/图形启发式和 `NOT_ASSESSABLE` 事实维度 | 保留为测试 adapter；不得被生产模式选中，也不得作为真实报告评分 |
| 动态 A/B | `src/comparison-report.ts` 和 `ComparisonCompatibilityFingerprint` 已防止固定 WPS baseline，并按 rubric、render、Judge、Reference Pack 等兼容性选择 | 模块只输出可比较的 scorecard/result；A/B 仍归主任务的 Comparison View |
| 人工修正 | `src/score-adjudication.ts` 已采用 append-only Review/Adjudication Event，且不允许把旧 `NOT_ASSESSABLE` 直接改成可评分 | v1 结果保留原始模型结果；人工修正仍在模块外 |

### 2.2 当前缺口与风险

| 缺口 | 具体表现 | 影响 |
|---|---|---|
| 没有小而稳定的评测接口 | 主流程在 `src/bakeoff.ts:1775-1885` 直接分支 Mock/真实 Judge、构造 Judge command、校验 scorecard lineage | Runner 知道评测实现细节，未来换 Judge 或加入 Document track 会扩大耦合 |
| Rubric 没有注册表 | `rubricVersion` 多处硬编码为 `query-six-dimension-v1`；真实 Judge prompt 没有完整的 1/3/5 anchor registry | “版本号已存在”不等于 Rubric 内容可复现；改 prompt 可能未形成完整 Rubric 版本 |
| 六维与框架 v0.8 不一致 | Issue #1/T03 与代码按六维；`docs/product/evaluation-framework.md` v0.8 的 Query Task Success 展开为 5 维，另有 3 个 Design 维度 | 直接改动会影响报告列、比较 fingerprint、Feishu schema 和验收；需要 PM 决策 |
| 底线没有独立的三态结果 | `DeliveryQualityGate` 目前是 `PASS/CONDITIONAL/FAIL/NOT_ASSESSABLE`，只有 3 个 gate，缺少 severity/evidence/ownership；没有一个规范化 `PASS/FAIL/UNKNOWN` bottom line | 不同模块可能把渲染失败、不可打开、Judge 失败解释成不同的“质量低分” |
| 评分证据粒度不足 | `DimensionScore` 只有页码和 rationale；事实错误有 fact/source ID，但没有统一的文本摘录、视觉观察、证据类型和证据哈希 | 评审者知道“第几页”，但未必能复核具体判断；页码无法覆盖同页多处证据 |
| 没有置信度字段 | 当前 Judge schema 和 `DimensionScore` 不返回 confidence；框架只在方法层提醒模型 confidence 不是可靠性指标 | 用户要求的置信度无法传递；需要明确其为解释性元数据而非概率 |
| 输入 manifest 不完整 | `EvaluationInputManifest` 只有 artifact/render/renderer/referencePack 四类字段 | 缺少 viewport、resolution、font pack、color profile、动画/外部资源策略、surface class、extractor 等比较必要信息 |
| Judge/Mock 边界依赖调用位置 | `scoreRenderedArtifact` 和 `OpenAiJudgePort` 都可由测试/主流程直接调用；生产拒绝 Mock 主要散落在 Bakeoff/环境校验 | 测试容易绕过生产边界，新增调用者容易复制一套选择逻辑 |
| 静态限定没有形成评测输入不变量 | 当前 render policy 有 `first_frame`，但模块接口没有明确“只评静态完成面，不评动画、演讲、讲者补充” | 后续输入若混入视频/动画语义，评分含义会漂移 |
| 文档布局不完整 | `AGENTS.md` 要求相关 ADR；当前基线不存在 `docs/adr/` 目录 | 本规格不能声称已完成 ADR 对照；需要主任务决定是否补 ADR 索引或将本规格提升为 ADR |
| 基线验证未完成 | 工作树无 `node_modules`、`tsc`、`tsx`；`npm test` 和 `npm run typecheck` 均因依赖缺失退出 | 当前只能报告代码审计结果，不能声称基线测试通过 |

### 2.3 已验证的基线命令证据

- 当前 HEAD：`c141b45`，从 `codex/bridge-v2-integration` 分出独立分支。
- `git status --short --branch` 在审计开始时工作树干净；本阶段只新增本规格文件。
- `npm test`：未执行成功，原因是 `Cannot find package 'tsx'`。
- `npm run typecheck`：未执行成功，原因是 `tsc: command not found`。
- 本阶段没有安装依赖，避免在未确认的情况下生成大批 `node_modules` 写入。

## 3. 模块边界

### 3.1 模块拥有的责任

1. 校验静态评测输入的完整性、血缘和环境来源。
2. 选择与冻结对应 `track` 和 `rubricRef` 的 Rubric 定义。
3. 计算/请求 Task Success 与 Presentation Design 维度判断。
4. 按需加载、校验和引用场景 Reference Pack；事实不足时返回 `NOT_ASSESSABLE`。
5. 计算独立的底线 `PASS | FAIL | UNKNOWN`。
6. 统一输出页码、证据、理由、解释性置信度和完整 lineage。
7. 验证 Judge 返回是否符合 Rubric、事实来源和证据规则。
8. 保证 Mock 与真实 Judge 的模式隔离。

### 3.2 模块不拥有的责任

- 厂商浏览器 Runner、登录、提交、生成、下载、重试、Trace、耗时和 Product Package。
- PPTX 捕获、沙箱渲染、字体安装、网络关闭和 Artifact storage；这些是上游产物/渲染前置条件。
- 飞书 Base 写入、报告 Markdown 编排、产品差距卡生成与交付、GitHub Issue 创建。
- Pairwise Judgment、用户偏好研究、总分权重校准、Selection Utility 和厂商排名。
- 动画、转场、Presenter delivery、实时讲解和隐藏模型推理。

### 3.3 与主任务的最小契约

主任务只需要完成以下转换：

```text
captured Artifact + canonical static render + Evaluation Case + frozen Reference Pack
                                      │
                                      ▼
                              EvaluationInput
                                      │
                                      ▼
                            EvaluationModule.evaluate
                                      │
                                      ▼
                              EvaluationResult
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
          ArtifactScorecard adapter                 Comparison View / Report
```

如果需要变更输入字段，先增加可选字段并保持 `schemaVersion` 兼容；不得让主任务直接依赖 `OpenAiJudgeCommand`、OpenAI response schema 或 Mock scorer 的启发式字段。

## 4. EvaluationInput v1 草案

以下是接口草案，不是本阶段要直接合入的 TypeScript 实现。字段的语义属于接口；校验顺序、错误分类、Judge payload 和存储细节留在实现内部。

```ts
type EvaluationInput = {
  schemaVersion: "evaluation-input-v1";
  evaluationId: string;
  mode: "mock" | "production";

  case: {
    caseId: string;
    caseVersion: number;
    track: "query_generation" | "document_generation";
    vendorInputHash: `sha256:${string}`;
    audience: string;
    objective: string;
    readingMode: "self_reading";
    targetPageCount: number | null;
    explicitRequirements: readonly string[];
    sourceDocumentHash?: `sha256:${string}`;
  };

  artifact: {
    artifactId: string;
    runId: string;
    jobId: string;
    provenance: "MOCK" | "PRODUCTION";
    environmentOrigin: string;
    contentHash: `sha256:${string}`;
    mimeType: string;
    pageCount: number;
  };

  staticSurface: {
    surfaceClass: "canonical" | "native_frozen";
    renderManifestHash: `sha256:${string}`;
    renderer: string;
    extractor: string;
    fontPack: string;
    resolution: string;
    colorProfile: string;
    animationPolicy: "static_only";
    externalAssetPolicy: "network_disabled";
    fidelity: "verified" | "degraded" | "unknown";
    pages: readonly {
      pageNumber: number;
      imageHash: `sha256:${string}`;
      image: Uint8Array;
      extractedText: string;
      extractedTextHash: `sha256:${string}`;
    }[];
  };

  referencePack: {
    mode: "automatic" | "force" | "off";
    packId: string | null;
    packVersion: number | null;
    contentHash: `sha256:${string}` | null;
    facts: readonly {
      factId: string;
      statement: string;
      sourceIds: readonly string[];
    }[];
  };

  rubricRef: {
    rubricId: string;
    rubricVersion: string;
    rubricHash: `sha256:${string}`;
  };
};

interface EvaluationModule {
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}
```

实现通过构造函数注入内部 `JudgeAdapter`、`ReferencePackResolver`、`RubricRegistry` 和 Clock；这些不是主任务需要学习的接口。`mode`、Artifact provenance 和 Judge adapter 的组合必须由模块 fail closed 校验：生产输入不能由 Mock Judge 评分，Mock 输入不能产生生产 lineage。

## 5. EvaluationResult v1 草案

```ts
type EvaluationResult = {
  schemaVersion: "evaluation-result-v1";
  evaluationId: string;
  status: "SCORED" | "NOT_ASSESSABLE" | "FAILED";

  bottomLine: {
    status: "PASS" | "FAIL" | "UNKNOWN";
    checks: readonly {
      check:
        | "artifact_captured_and_openable"
        | "static_visual_input"
        | "required_delivery_format"
        | "evidence_sufficient_for_judgment";
      status: "PASS" | "FAIL" | "UNKNOWN";
      severity: "blocking" | "major" | "warning";
      effect: "exclude_quality" | "flag_only" | "route_to_dimension";
      evidence: readonly EvidenceRef[];
      reason: string;
    }[];
    reason: string;
  };

  rubric: {
    rubricId: string;
    rubricVersion: string;
    rubricHash: `sha256:${string}`;
    track: "query_generation" | "document_generation";
  };

  dimensions: readonly {
    family: "task_success" | "presentation_design";
    dimension: string;
    assessmentStatus: "ASSESSED" | "NOT_ASSESSABLE";
    value: 1 | 2 | 3 | 4 | 5 | null;
    confidence: "low" | "medium" | "high";
    evidence: readonly EvidenceRef[];
    rationale: string;
  }[];

  lineage: {
    artifactHash: `sha256:${string}`;
    renderManifestHash: `sha256:${string}`;
    referencePackHash: `sha256:${string}` | null;
    judge: {
      kind: "mock" | "real";
      provider: string;
      model: string;
      adapterVersion: string;
      promptVersion: string;
      promptHash: `sha256:${string}`;
      configHash: `sha256:${string}`;
      responseId: string | null;
    };
    inputHash: `sha256:${string}`;
    createdAt: string;
  };

  errors: readonly {
    code: string;
    message: string;
    retryable: boolean;
  }[];
};

type EvidenceRef = {
  pageNumber: number;
  kind: "visual_observation" | "extracted_text" | "reference_fact" | "gate";
  quoteOrObservation: string;
  sourceFactId?: string;
  sourceIds?: readonly string[];
};
```

### 5.1 三态底线规则

- `FAIL`：捕获/打开、静态评测面或明确的必需交付条件有阻断性失败；不得生成可误读为质量结论的 1–5 设计分。
- `UNKNOWN`：输入存在但关键可验证证据缺失、渲染保真未知、Judge 失败或必要的 Reference Pack 无法确认；可以保留已独立可评估的维度，但报告必须显示未知原因。
- `PASS`：所有 blocking checks 通过，且证据足以支持当前 Rubric 的判断。

`NOT_ASSESSABLE` 是维度状态，不等价于底线 `UNKNOWN`，也不等价于 0 分。例如火山 PPT 没有可辩护 Reference Pack 时，事实维度为 `NOT_ASSESSABLE`；如果静态渲染仍忠实、可读，底线可以仍为 `PASS`，但结果不能宣称“没有事实错误”。

### 5.2 证据和置信度规则

- 每个 `ASSESSED` 维度至少有一个 page evidence；`NOT_ASSESSABLE` 必须说明缺失条件。
- 事实错误必须同时引用 `factId` 和 `sourceIds`；知识包未覆盖的内容不得作为隐藏扣分。
- `confidence` 只表示当前判断对输入证据的解释性把握，不是经过校准的概率，也不替代 Judge repeatability/human-baseline 校准。
- 视觉证据描述“看到了什么”，不得写成未经验证的内部 pipeline root cause；原因只能由主任务生成带 `HYPOTHESIS` 标签的产品差距卡。

## 6. Rubric 分层和版本化

### 6.1 共同结构

Rubric 由 `rubricId + rubricVersion + rubricHash` 唯一标识，内容至少冻结：轨道、维度 ID/label、1/3/5 anchor、可评估条件、证据要求、扣分 owner、事实规则、底线映射和 Judge 输出 schema。仅更新 prompt、schema、anchor 或维度定义都必须形成新版本/新 hash。

v1 不输出未经校准的 family total 或 universal total。需要权重时，另行声明版本化的 experimental weight profile，不能混入基础 scorecard。

### 6.2 当前建议的六维兼容版本

如果产品继续遵守 Issue #1/T03 的“六维”验收，建议将现有六维正式登记为 `query-six-dimension-v1`：

| Family | Dimension | 火山 PPT 例子 |
|---|---|---|
| Task Success | requirement understanding and content coverage | 第 1 页封面、第 2 页目录、第 3–15 页正文、第 16 页知识回顾是否真的出现 |
| Task Success | factual accuracy and content quality | 第 9 页把“岩浆黏度影响气体逸出”写反，必须引用 Reference Pack 的对应事实 |
| Task Success | narrative and audience fit | 第 2 页目录是否能把“岩浆—气体—压力—喷发”串成适合初中生自读的路径 |
| Presentation Design | visual aesthetics and professional finish | 第 1、10、16 页是否保持统一且完成的视觉语言，而不是只看颜色数量 |
| Presentation Design | layout hierarchy and readability | 第 8 页正文是否有清晰标题/正文层级，长段文字是否能在静态页面直接阅读 |
| Presentation Design | imagery, chart and information expression | 第 7 页剖面图是否解释机制；装饰性火山图不能自动换取高分 |

### 6.3 与框架 v0.8 的冲突（必须决策）

`docs/product/evaluation-framework.md` v0.8 的 Query Task Success 表实际列出 5 个维度：Intent and constraint compliance、Correctness and substance、Coverage and selection、Narrative organization、Audience and occasion fit；Presentation Design 还列出 4 个维度：Visual aesthetics and finish、Layout, hierarchy, and readability、Visual-expression choice and execution、Deck consistency and professional delivery，共 9 个 1–5 维度。Delivery Quality 另行报告，不计入这个维度数。Issue #1/T03 和当前代码则将前者合并成 3 个 Task Success 维度、后者合并成 3 个 Design 维度，共 6 个。

这是一个产品语义选择，不是简单重命名：

- 选择六维：与现有 Issue、Mock、OpenAI schema 和报告保持兼容；但“第 9 页事实写反”和“内容深度不足”仍共享一个事实/内容维度，行动指向较粗。
- 选择九维：能分别指出火山 PPT “第 2 页目录漏掉压力机制”（coverage）和“第 12 页虽然覆盖机制但解释空泛”（correctness/substance），也能单独识别“第 1、10、16 页风格不一致”（deck consistency）；但会改变当前六维 schema、比较 fingerprint、报告列和测试契约。

本草案默认先按六维做 v1 compatibility adapter，不在本阶段修改现有六维代码；正式实现前需要产品经理确认是否将 v0.8 的 9 维作为目标 Rubric。该问题标记为 `NEEDS_USER_DECISION`。

## 7. Mock / 真实 Judge 边界

### Mock

- 只用于测试环境和固定样本；输出必须带 `judge.kind = mock`、`provenance = MOCK` 和明显 `MOCK` ID。
- 可以使用确定性 heuristic 验证接口、证据页、`NOT_ASSESSABLE`、底线映射和 lineage，但不代表真实模型质量，也不能进入 production report。
- 测试不得直接依赖 `src/mock-score.ts` 的内部 helper；应通过 `EvaluationModule.evaluate(input)` 验证公共 seam。

### Real

- 生产模式必须使用真实 Judge，并记录 provider、model、adapterVersion、promptVersion/hash、configHash、schema/rubric hash、response ID、输入和图像 hash。
- Judge 失败保留 Artifact 和失败 lineage，但不伪造 scorecard；底线按规则进入 `UNKNOWN` 或 `FAIL`。
- 真实 Judge 只评静态图片和允许的提取文本，不接收厂商隐藏推理、动画播放状态或参赛厂商内部信息。
- “真实 Judge adapter 已实现”不等于“生产评测已完成”；正式报告仍需真实三厂商 Artifact、完整输入 manifest 和外部验收证据。

## 8. 测试样例和验收矩阵

全部新增评测测试应从 `src/index.ts` 暴露的 `EvaluationModule` seam 进入；低层 Judge/Reference Pack 单测可保留，但不能替代公共接口验收。

| 类别 | 必须覆盖的样例 | 预期断言 |
|---|---|---|
| 公共 happy path | 16 页火山 Mock Artifact，静态渲染忠实，automatic pack | 返回 `SCORED`；六维/最终选定 Rubric 的维度完整；每项有页证据、理由、置信度和 lineage |
| Mock 隔离 | `mode=production` + MOCK Artifact 或 Mock Judge | fail closed；不产生 production scorecard/report lineage |
| 真实隔离 | `mode=mock` + real Judge adapter，或 production 缺 real Judge | fail closed；不把测试输出标成真实 |
| Reference Pack off | 火山 PPT 使用 `off` | 事实维度 `NOT_ASSESSABLE`；不填满分；其他可独立评估维度不被连带清零 |
| 事实错误 | 第 9 页声称“黏稠岩浆让气体更容易逃逸” | 只在事实维度扣分；证据包含页码、修正、`factId`、`sourceIds` |
| 未覆盖事实 | PPT 出现 pack 没有覆盖的地质细节 | 不产生隐藏 deduction；可返回低置信/待评估说明 |
| 打开/渲染失败 | Artifact 不可打开或 fidelity=failed | bottom line `FAIL`；设计维度不返回 1–5 零分 |
| 渲染未知 | Artifact 可读但 canonical/native surface 未证明等价 | bottom line `UNKNOWN` 或对应 gate unknown；禁止直接视觉比较 |
| 证据不足 | Judge 给出分数但无页证据/理由 | 拒绝结果，不落库为 scorecard |
| Rubric 漂移 | 同一 `rubricVersion` 内容 hash 改变 | 拒绝或要求新版本；不可用旧版本 ID 冒充复现 |
| Judge lineage | transport 返回结构化结果一次 | 只允许一次调用；lineage 的 prompt/config/input/image hash 完整 |
| 静态限定 | 输入声明视频/动画或页面缺静态图 | 不进入动画/播放质量评分；返回 `UNKNOWN`/`NOT_ASSESSABLE` |
| A/B 兼容 | 两个不同厂商、相同 Case/track/Rubric/render surface | 模块结果可被 Comparison View 选择；无 `baselineVendor` 字段 |
| 失败保留 | Judge 失败但 Artifact 已捕获 | Artifact 保留，scorecard 不伪造，失败原因可追溯 |
| 人工修正 | 对已有维度追加 adjudication | 原始模型分保留；旧 `NOT_ASSESSABLE` 不被人工直接改成可评估 |

## 9. 阶段拆分

### Stage 1 — 本阶段：审计与规格草案

- 交付本文件、独立分支和 PR 到 `codex/bridge-v2-integration`。
- 不改厂商 Runner、飞书发布和最终报告编排。
- 记录六维/九维、置信度表示、底线映射的 `NEEDS_USER_DECISION`。

### Stage 2 — 建立评测 seam（小改动）

- 新增 `EvaluationModule`、`EvaluationInput`、`EvaluationResult` 与运行时校验。
- 将现有 Mock scorer 包成 Mock adapter，将真实 OpenAI adapter 包成 Real adapter。
- `bakeoff.ts` 只负责组装输入和消费结果；保留 `ArtifactScorecard` compatibility adapter。
- 新增公共接口 happy path 和 mode-isolation acceptance tests。

### Stage 3 — Rubric/证据/底线实现

- 建立 track-aware Rubric registry 和 content hash。
- 统一 `EvidenceRef`、confidence、三态 bottom line、事实引用和 score ownership。
- 先落地已确认的 Query Rubric；Document Rubric 只实现接口注册点，不与 Query 混评。

### Stage 4 — Judge parity 与评测测试

- 让 Mock/Real adapter 共享同一个 result validator。
- 迁移现有 OpenAI strict schema、reference pack、egress 和 idempotency 规则到内部 seam。
- 补齐失败保留、渲染不确定、Rubric 漂移、证据不足和单调用 lineage 测试。

### Stage 5 — 主任务集成验收

- 主任务把真实三厂商捕获的 Artifact/Render 转换为 `EvaluationInput`。
- 验证 dynamic A/B、产品差距卡和报告只读取 `EvaluationResult`/兼容 scorecard。
- 独立验证生产 Judge、静态渲染、Artifact hash、飞书 durable projection 和真实三厂商 acceptance；不能用本模块 Mock 绿测替代。

## 10. 待产品经理确认（NEEDS_USER_DECISION）

### 决策 A：Query v1 使用六维还是九维？

真实例子：对《火山为什么会喷发》，第 2 页目录遗漏“气体与压力”，第 12 页虽然提到气体但解释空泛，第 10 页又与其他页面风格不一致。六维会把这些问题较粗地归入现有内容/视觉维度；九维可以分别落到 Coverage、Correctness/Substance 和 Deck consistency。六维兼容现有 Issue/代码，九维更贴近框架 v0.8 的诊断粒度。请确认 v1 是否先保留六维兼容，还是直接以九维为目标。

### 决策 B：confidence 的产品展示形式

真实例子：第 7 页有清晰剖面图，视觉表达判断可以是 high；第 9 页只有一句“压力变大就喷发”，在没有 Reference Pack 时事实判断应是 `NOT_ASSESSABLE`，不能用 high confidence 掩盖材料不足。草案建议只用 `low | medium | high` 作为解释性元数据，不显示 0–100 概率；请确认是否接受该展示语义。

### 决策 C：底线 `UNKNOWN` 的报告含义

真实例子：PPT 文件能打开，但 canonical render 与网页原生冻结画面未证明等价；内容文字仍可审，设计质量不能直接比较。草案建议底线为 `UNKNOWN`，保留可独立评估的内容维度并禁止视觉比较；请确认是否采用该规则，而不是把它降为 `FAIL`。

## 11. 本阶段验收记录

- [x] 从 `codex/bridge-v2-integration` 的 `c141b45` 审计。
- [x] 读取 `CONTEXT.md`、`docs/agents`、现有评测实现、测试和 GitHub Issues #1/#4/#11。
- [x] 建立独立分支 `codex/ppt-evaluation-v1-spec`。
- [x] 明确模块拥有/不拥有的责任、输入输出 seam、Rubric 分层、Mock/Real 边界、测试样例和阶段拆分。
- [ ] `docs/adr/` 对照：基线缺失该目录，需后续决定是否补建。
- [ ] `npm test`：阻塞于未安装 `tsx`，未声称通过。
- [ ] `npm run typecheck`：阻塞于未安装 `tsc`，未声称通过。
- [ ] 真实 Judge、真实三厂商运行、飞书 durable readback：不属于本阶段，仍由主任务/最终 T10 验收负责。
