# PPT Evaluation Module v1.1：三态标注、分层评测与 Query 题库

状态：Accepted for v1 public contract
基线分支：`codex/ppt-evaluation-v1-spec` / `7ab8c6c`
范围：Query Generation Track；不实现前端、厂商浏览器链路和最终报告 UI，但本模块拥有前端/飞书需要的字段代码、选项值和中文标签

## 1. 本次调整的核心判断

当前不应继续把评测主结果强行压成 1–5。现阶段 Rubric 还没有细到让不同 Judge/标注者稳定地区分 2、3、4 分；继续输出精细分数会制造一致性假象。

v1.1 改为：

1. 原子判断统一使用 `GOOD | BAD | UNCERTAIN`。
2. `UNCERTAIN` 不与 `BAD` 混合；它必须带原因，区分“证据不足”“Rubric 未定义”和“标注分歧”。
3. 评测对象采用树状层级：`Deck → Slide → Element`；Evidence 与对象树分离。
4. 聚合不做默认平均，而由每个维度声明自己的聚合规则和分母。
5. 输出原始三态分布、聚合标签、覆盖率和 Batch 一致性；新公共契约不包含任何序数评分字段。
6. 题库 Case 冻结请求者人设、PPT 受众、使用场景和 Query；厂商可见 Prompt 由这些字段按版本生成。

这不是否定未来的数值映射。数值化或维度图排名只能作为一个版本化的下游 `DimensionMapping`，在标注一致性和样本量达到门槛后启用。

## 2. 领域术语

### 2.1 Question Bank Case

一条可复现的 Query-to-PPT 题库题目，不等于一段 prompt。它包含：

- 请求者是谁，以及其工作/学习背景；
- PPT 给谁看、在什么场合使用；
- 业务/教学场景的结构化字段；
- 原始 Query；
- 厂商可见 Prompt 的组装版本和哈希；
- 评测方隐藏的事实材料、期望覆盖和 Rubric 引用。

### 2.2 Evaluation Object

评测对象分三层：

```text
Question Bank Case
└── Captured Presentation Artifact
    └── Deck Target
        └── Slide Target [1..n]
            └── Element Target [0..n]

Assessments → targetId + dimensionId
Judgments → assessmentId + evidenceIds
Evidence → targetId
```

- `Deck`：整份逻辑 PPT，不是源文档。例如是否适合目标用户、是否完成任务、叙事是否成立。
- `Slide`：单页才能观察的问题，例如版式、层级、可读性、信息表达和局部内容证据。
- `Element`：单页内可独立定位的图片或文本框。图片可判断清晰度、裁切完整性和页面语义匹配；文本框可判断字号、拥挤、溢出和层级。
- `Evidence`：判断的依据，例如元素裁剪、文字摘录、视觉观察、Reference Pack fact。Evidence 不是评分对象。

### 2.3 Observation Label

每个最小判断的标签为：

| 标签 | 含义 | 不能解释成 |
|---|---|---|
| `GOOD` / 好 | 当前目标和证据下满足该标准 | 真实用户一定喜欢 |
| `BAD` / 不好 | 当前目标和证据下存在明确问题 | 一定是厂商内部某个模块导致 |
| `UNCERTAIN` / 不确定 | 证据、标准或标注结果不足以负责地下结论 | 自动等于 BAD |

`UNCERTAIN` 必须带 `uncertainReason`：

- `insufficient_evidence`：缺少可靠的页面、文本、事实材料或渲染面；
- `rubric_undefined`：标准还没有定义到可以判断；
- `annotator_disagreement`：独立标注结果冲突；
- `reference_missing`：需要外部知识，但没有可辩护 Reference Pack。

更多标注 Batch 只能解决 `annotator_disagreement`，不能凭空解决 `insufficient_evidence` 或 `reference_missing`。

### 2.4 置信度不是准确率

`LOW | MEDIUM | HIGH` 表示 Judge 在当前 Rubric 和 Evidence 下对这一条判断的把握度。准确率是将 Judge 结果与独立建立的金标/人工裁决比较后才能统计的 Batch 级校准指标。高置信度可以判错，低置信度也可以判对；不允许用置信度冒充准确率。

## 3. Query 题库输入

### 3.1 人设要拆成两种角色

“模拟用户身份”和“PPT 面向的受众”不能合并，否则会出现“老师在为学生制作 PPT”和“学生自己要学习”无法区分的问题。

```ts
type PersonaProfile = {
  personaId: string;
  role: "student" | "teacher" | "employee" | "manager" | "founder" | "other";
  experienceLevel: "beginner" | "intermediate" | "expert" | "unknown";
  domain: string;
  subject?: string;
  grade?: string;
  institutionType?: "primary_school" | "middle_school" | "high_school" | "university" | "company" | "independent" | "other";
  organizationContext?: string;
  locale?: string;
};

type PresentationAudience = {
  audienceId: string;
  description: string;
  ageOrGrade?: string;
  priorKnowledge: "low" | "medium" | "high" | "unknown";
  readingMode: "self_reading" | "presented_with_speaker";
};
```

例如“老师为初一学生制作火山科普 PPT”和“初一学生自己要学习火山”必须是两个不同 Case，即使 Query 文本相似。

### 3.2 QuestionBankCase v1

```ts
type QuestionBankCase = {
  schemaVersion: "question-bank-case-v1";
  caseId: string;
  caseVersion: number;
  track: "query_generation";

  requesterPersona: PersonaProfile;
  presentationAudience: PresentationAudience;
  useContext: {
    occasion: "classroom" | "homework" | "meeting" | "sales" | "self_learning" | "other";
    objective: string;
    expectedDurationMinutes?: number;
    targetPageCount: number;
  };

  query: string;
  vendorPrompt: {
    templateVersion: string;
    text: string;
    contentHash: `sha256:${string}`;
  };

  evaluatorContext: {
    explicitRequirements: readonly string[];
    requiredFacts: readonly string[];
    expectedCoverage: readonly string[];
    referencePackMode: "automatic" | "force" | "off";
    rubricRef: {
      rubricId: string;
      rubricVersion: string;
      rubricHash: `sha256:${string}`;
    };
  };

  caseHash: `sha256:${string}`;
  author: string;
  reviewState: "draft" | "reviewed" | "retired";
};
```

`targetPageCount` 是 Query 题库必填字段，v1 限制在 1–20 页。这个限制控制题库意图和预期成本；如果厂商实际生成超过目标页数，Artifact 仍应被捕获，并由 `task_fit` 判断是否违反要求。

### 3.3 厂商意图确认

题库 Case 保留 `intentConfirmation.status/source/confirmedAt`。若厂商在意图识别环节确认或修正了“请求者人设”、“PPT 受众”或“目标页数”，调用方以确认值创建新 `caseVersion`，并标记 `source=vendor_confirmation`。已冻结 Case 不就地篡改，否则无法还原厂商实际收到的 Prompt。

`vendorPrompt.text` 应由 `requesterPersona + presentationAudience + useContext + query` 按模板生成，而不是由调用方随意拼接。`evaluatorContext` 不进入厂商 Prompt，避免把答案和隐藏评测标准泄露给厂商。

### 3.3 火山题示例

```json
{
  "requesterPersona": {
    "role": "teacher",
    "experienceLevel": "intermediate",
    "domain": "education",
    "subject": "earth_science",
    "grade": "middle_school_grade_1",
    "institutionType": "middle_school"
  },
  "presentationAudience": {
    "description": "初一学生自主阅读",
    "ageOrGrade": "初一",
    "priorKnowledge": "low",
    "readingMode": "self_reading"
  },
  "useContext": {
    "occasion": "classroom",
    "objective": "让学生理解火山喷发的基本机制",
    "targetPageCount": 16
  },
  "query": "制作一份《火山为什么会喷发》的科普 PPT，要求适合初一学生自主阅读。"
}
```

真实学校名、学生姓名等字段默认不进入题库；使用类别、年级和合成机构上下文即可满足可复现性并降低隐私风险。

## 4. 分层评测对象与维度

### 4.1 Deck-level dimensions

这些问题不能靠单页独立回答：

- `task_fit`：是否完成请求者的目标和显式约束；
- `audience_fit`：整体内容、术语、密度是否适合目标受众；
- `coverage_and_selection`：是否覆盖并取舍了目标内容；
- `narrative_organization`：从开头到结尾是否形成可理解的路径；
- `deck_consistency`：跨页的版式、样式、组件和信息语言是否形成系统。

### 4.2 Slide-level dimensions

这些问题应在单页或代表性页面上判断：

- `layout_hierarchy`：标题、正文、重点和阅读顺序；
- `readability`：字号、密度、对比度、裁切和可读性；
- `visual_expression`：图、图表、示意图或纯文字是否真正增加信息价值；
- `visual_finish`：页面是否存在明显未完成或视觉执行问题；
- `local_content_claim`：本页文字/数字/图示是否有明确内容问题。

### 4.3 Element-level dimensions

- `image_clarity`：图片在当前静态渲染下是否清晰；
- `image_crop_integrity`：主体、标注或关键信息是否被不当裁切；
- `image_context_fit`：图片语义是否服务当前页面任务；
- `text_size`：文本框字号是否过小或过大；
- `text_density_and_overflow`：文本是否拥挤、溢出、截断或层级失衡。

### 4.4 Evidence observations

Evidence 只记录：

- 页码和页面角色；
- 文本摘录或文本哈希；
- 视觉观察；
- Reference Pack 的 `factId/sourceIds`；
- 观察来源是 `canonical` 还是 `native_frozen` 静态面；
- 该证据是否足以支持当前判断。

同一个 Evidence 可以支持一个或多个维度，但每个维度仍要声明自己的 owner，防止同一个缺陷重复扣除。

## 5. 标注 Batch 与一致性

### 5.1 原始标注不可覆盖

```ts
type LabelRecord = {
  batchId: string;
  annotatorId: string;
  targetNodeId: string;
  dimensionId: string;
  label: "GOOD" | "BAD" | "UNCERTAIN";
  uncertainReason?: "insufficient_evidence" | "rubric_undefined" | "annotator_disagreement" | "reference_missing";
  evidenceIds: readonly string[];
  rationale: string;
  rubricHash: `sha256:${string}`;
  createdAt: string;
};
```

重复 Batch 必须保留原始标签、Batch ID、标注者/Judge、Rubric hash、顺序随机种子和输入 hash。不能把第二批结果直接覆盖第一批。

### 5.2 Batch 类型

- `initial`：第一次独立判断；
- `repeat`：背靠背重复判断，用于检查稳定性；
- `calibration`：带 Anchor Set 的标准校准批次；
- `adjudication`：只处理冲突或争议，不伪装成独立样本。

### 5.3 Consensus 输出

```ts
type ConsensusSummary = {
  goodCount: number;
  badCount: number;
  uncertainCount: number;
  totalCount: number;
  resolvedLabel: "GOOD" | "BAD" | "UNCERTAIN";
  rule: "unanimous" | "declared_majority" | "unresolved";
  agreementStatus: "consistent" | "mixed" | "insufficient";
  uncertainReasons: readonly string[];
};
```

`resolvedLabel` 必须依据 Rubric 版本中预先声明的规则生成：没有达到规则时返回 `UNCERTAIN`，不能为了排名强行二选一。

## 6. 聚合规则

### 6.1 聚合不是平均分

不同维度的子节点含义不同，不能共享一个默认平均公式。每个维度需要声明：

```ts
type AggregationSpec = {
  aggregationId: string;
  targetScope: "DECK" | "SLIDE" | "ELEMENT";
  childSelection: "all" | "required" | "representative_and_worst";
  rule: "all_required" | "majority" | "coverage_threshold" | "worst_case" | "direct_judgment";
  minimumEvidenceCount: number;
  uncertainPolicy: "propagate" | "exclude_with_denominator" | "resolve_by_batch";
  version: string;
};
```

### 6.2 推荐的初始规则

| 维度 | 对象 | 初始聚合建议 |
|---|---|---|
| task_fit | Deck | `all_required`；任一硬约束明确 BAD，则 Deck BAD；证据缺失则 UNCERTAIN |
| audience_fit | Deck | `direct_judgment`；不能从单页平均推出 |
| narrative_organization | Deck | `representative_and_worst`；查看目录/转折/结尾及最差关键页 |
| coverage_and_selection | Deck + required topics | `coverage_threshold`；分母是已声明的 required topics |
| deck_consistency | Slide set | `majority` 或 `worst_case`，需在 Rubric 中明确 |
| layout_hierarchy | Slide | 以单页判断，不向整套 PPT 自动平均 |
| readability | Slide | 单页判断；Deck 只输出“不可读页面比例/关键页失败” |
| visual_expression | Slide | 单页判断；不能用图片数量替代信息价值 |
| local_content_claim | Slide/Element | 事实或内容错误逐页/逐元素记录，向 Deck 聚合时保留错误页和分母 |

### 6.3 树状结果示例

```text
Deck: audience_fit = GOOD
└── Slide 9: layout_hierarchy = BAD
    ├── Image volcano-1: image_crop_integrity = BAD
    │   └── Evidence: 火山口在元素裁剪上沿之外
    └── TextBox explanation-1: text_size = UNCERTAIN
        └── Evidence: 元素裁剪分辨率不足 = INSUFFICIENT_EVIDENCE
```

这里不能简单计算 `(GOOD + BAD + UNCERTAIN) / 3`。`narrative_organization` 的 UNCERTAIN 是因为结尾证据不足，不应被当作 1/3 个好或坏。

## 7. 三个公共接口

权威 TypeScript 定义和公共入口位于 `evaluation/index.ts`，验收测试只通过该入口使用它们。它暂不从现有 `src/index.ts` 重导出，因为 `src/` 属于已冻结生产 Runner 可执行归档；主任务后续接线时再在独立迁移 PR 中更新 Runner manifest。

### 7.1 `QuestionBankCase`

拥有 Query 题库的请求者人设、PPT 受众、使用场景、目标页数、Query、意图确认溯源、厂商 Prompt 及隐藏评测上下文。`createQuestionBankCase` 验证 1–20 页限制，按固定模板注入人设 + 受众 + Query，并生成 prompt/case hash。

### 7.2 `EvaluationInput`

只接收冻结的 `QuestionBankCase`、Artifact 身份、静态渲染页、页内 `IMAGE | TEXT_BOX` 元素、Reference Pack 和版本化评测协议。`createEvaluationInput` 验证题库枚举与 Rubric hash、页码/元素唯一性、产物与渲染页数一致性，并在 `production` 模式拒绝 Mock Judge。输出增加 canonical `evaluationInputHash`；图片字节按 copy-on-read 暴露，调用方无法通过索引、`subarray()` 或 `.buffer` 改写已验证快照，同时仍可直接传给标准哈希接口。

### 7.3 `EvaluationResult`

输出分为四层：

1. `tree.targets`：`DECK → SLIDE → ELEMENT` 评测对象树；
2. `tree.assessments`：`targetId + dimensionId` 上的原始 Batch 判断和 Consensus；
3. `tree.evidence`：支持判断的页面/元素/事实证据；
4. `dimensionProfile + comparisonVector`：三态分布与版本化维度映射，不含序数总分。

`createEvaluationResult` 强制 `UNCERTAIN` 原因、Evidence 引用、对象树关系和 Mock/Real 边界。结果必须携带并重新验证原始 `EvaluationInput`，其身份、Reference Pack、Artifact/Render/Rubric/Prompt/Judge lineage 及非空 response ID 必须逐项一致；Target 树必须完整覆盖输入页面和元素，`REFERENCE_FACT` Evidence 必须绑定输入中已验证的 fact/source。比较轴只接受内置、哈希化的 Mapping Registry，不能由调用方选择性漏掉不利维度。事实材料不足时用 `assessmentStatus=NOT_ASSESSABLE + label=UNCERTAIN + uncertainReason=REFERENCE_MISSING`表达。

### 7.4 前端和飞书字段契约

`EVALUATION_FIELD_CATALOG` 是选项值的唯一代码真相，当前包含：三态标签、置信度、不确定原因、对象层级、元素类型、人设角色和目标页数范围。前端和飞书投影使用英文 code 作稳定存储/传输值，使用 `labelZh` 展示；飞书三态写入值为“好 / 不好 / 不确定”。前端模块不复制或自定义这些枚举。

`goodRate/badRate/uncertainRate` 只是分布统计。`rankStatus` 默认不是 `ELIGIBLE`；只有完成 Rubric、标注一致性和样本覆盖校准后，才允许下游生成正式市场位置比较。

## 8. “维度图”与市场比较

建议分成两层：

1. **原子 Rubric 维度**：用于标注和诊断，例如 `coverage`、`readability`、`visual_expression`。
2. **战略比较轴**：用于跨厂商展示，例如 `task_fit`、`content_truth`、`narrative`、`visual_system`、`readability`。

战略轴通过版本化 `DimensionMapping` 从原子维度映射而来，不能由前端临时拼接。映射必须保留：来源维度、聚合规则、分母、`UNCERTAIN` 处理方式和版本 hash。

初期比较只输出：

- 各轴 GOOD/BAD/UNCERTAIN 分布；
- 样本和分母；
- 是否可比较；
- 差异对应的页面证据。

不建议在单次火山题或少量题目上直接输出“WPS 市场排名”。更稳妥的路径是：

```text
原子标签
  → Batch 一致性
  → 维度聚合
  → DimensionMapping
  → 多 Case / 多 Batch 比较
  → 探索性位置
  → 校准后市场位置
```

WPS 仍然不是固定 baseline；A/B 的两侧由比较请求动态选择。

## 9. 本线程负责与不负责

### 本线程负责

- Query Generation 题库 Case 的 schema、版本、审查状态和 Prompt 组装；
- Persona、受众、场景、Query、隐藏评测上下文的冻结和哈希；
- Evaluation Object 树、Rubric、三态标签、Evidence、Batch、Consensus、AggregationSpec；
- `EvaluationInput`、`EvaluationResult`、`DimensionMapping` 和比较所需的原始分布；
- Mock/Real Judge 的统一适配接口和评测测试；
- 为主任务提供不依赖前端的 JSON/TypeScript 数据契约，并拥有前端/飞书消费的字段代码和中文标签。

### 本线程不负责

- 前端页面、雷达图绘制、可视化交互；
- 厂商网页 Runner、登录、生成、下载、Trace 和耗时；
- Feishu 发布、报告 UI、产品差距卡交付和 GitHub Issue 自动创建；
- 将一次 Case Sample 宣称为稳定市场排名。

## 10. 对现有模块的改造顺序

1. 已新增 `QuestionBankCase`、`EvaluationInput`、`EvaluationResult` 三个公共接口和验收测试。
2. 已将评测对象树与维度 Assessment/Evidence 分离，并支持图片、文本框元素。
3. 已在新公共契约中排除序数评分字段；旧 `ArtifactScorecard` 仅因集成分支尚有 Judge/报告/飞书消费者而保留在 legacy 代码中，后续通过迁移 PR 物理删除。
4. 下一阶段将 `bakeoff.ts` 的评测分支收敛为组装 `EvaluationInput` 和消费 `EvaluationResult`，但不修改厂商 Runner。
5. 在产品确认各维度聚合规则和一致性门槛后，再实现权威 `AggregationSpec/DimensionMapping`；不先做总分或正式排名。

## 11. 已确认决策与后续待决策

已确认：新契约统一三态；对象树为 `Deck → Slide → Element`；Evidence 不是评分对象；图片和文本框是正式 Element；请求者人设与 PPT 受众拆分；目标页数必填且不超过 20；前端/飞书选项由本模块导出。

仍待产品确认：各维度分别采用 `all_required`、`majority`、`coverage_threshold`、`worst_case` 还是 `direct_judgment`；Batch 一致性达到什么门槛才允许进入探索性市场位置比较。在此之前，`dimensionProfile` 只聚合三态数量和可评估分母，不生成默认维度总标签。
