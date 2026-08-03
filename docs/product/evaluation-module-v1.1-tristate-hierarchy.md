# PPT Evaluation Module v1.1：三态标注、分层评测与 Query 题库

状态：Proposal，基于产品讨论待确认  
基线分支：`codex/ppt-evaluation-v1-spec` / `7ab8c6c`  
范围：Query Generation Track；不包含前端、厂商浏览器链路和最终报告 UI

## 1. 本次调整的核心判断

当前不应继续把评测主结果强行压成 1–5。现阶段 Rubric 还没有细到让不同 Judge/标注者稳定地区分 2、3、4 分；继续输出精细分数会制造一致性假象。

v1.1 改为：

1. 原子判断统一使用 `GOOD | BAD | UNCERTAIN`。
2. `UNCERTAIN` 不与 `BAD` 混合；它必须带原因，区分“证据不足”“Rubric 未定义”和“标注分歧”。
3. 评测对象采用树状层级：`Deck → Slide → Evidence`。
4. 聚合不做默认平均，而由每个维度声明自己的聚合规则和分母。
5. 输出原始三态分布、聚合标签、覆盖率和 Batch 一致性；暂不生成未经校准的 1–5 总分或市场排名。
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
    └── Deck Evaluation
        ├── Deck-level dimensions
        └── Slide Evaluation [1..n]
            ├── Slide-level dimensions
            └── Evidence observations [0..n]
```

- `Deck`：整套 PPT 才能回答的问题，例如是否适合目标用户、是否完成任务、叙事是否成立。
- `Slide`：单页才能观察的问题，例如版式、层级、可读性、信息表达和局部内容证据。
- `Evidence`：判断的依据，例如第 7 页的图、文字摘录、视觉观察、Reference Pack fact。Evidence 不是独立的“更细分数”。

### 2.3 Observation Label

每个最小判断的标签为：

| 标签 | 含义 | 不能解释成 |
|---|---|---|
| `GOOD` | 当前目标和证据下满足该标准 | 真实用户一定喜欢 |
| `BAD` | 当前目标和证据下存在明确问题 | 一定是厂商内部某个模块导致 |
| `UNCERTAIN` | 证据、标准或标注结果不足以负责地下结论 | 自动等于 BAD |

`UNCERTAIN` 必须带 `uncertainReason`：

- `insufficient_evidence`：缺少可靠的页面、文本、事实材料或渲染面；
- `rubric_undefined`：标准还没有定义到可以判断；
- `annotator_disagreement`：独立标注结果冲突；
- `reference_missing`：需要外部知识，但没有可辩护 Reference Pack。

更多标注 Batch 只能解决 `annotator_disagreement`，不能凭空解决 `insufficient_evidence` 或 `reference_missing`。

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
    targetPageCount?: number;
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

### 4.3 Evidence-level observations

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
  targetScope: "deck" | "slide" | "evidence";
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
| layout_hierarchy | Slide | 以单页 Evidence 直接判断，不向整套 PPT 自动平均 |
| readability | Slide | 单页判断；Deck 只输出“不可读页面比例/关键页失败” |
| visual_expression | Slide | 单页判断；不能用图片数量替代信息价值 |
| local_content_claim | Slide/Evidence | 事实或内容错误逐页记录，向 Deck 聚合时保留错误页和分母 |

### 6.3 树状结果示例

```text
Deck: audience_fit = GOOD
Deck: narrative_organization = UNCERTAIN
├── Slide 2: 目录与阅读路径 = GOOD
├── Slide 9: 压力机制解释 = BAD
│   └── Evidence: “黏稠岩浆更容易释放气体” = BAD
└── Slide 16: 知识回顾 = UNCERTAIN
    └── Evidence: 只有图片，缺少可验证文本 = insufficient_evidence
```

这里不能简单计算 `(GOOD + BAD + UNCERTAIN) / 3`。`narrative_organization` 的 UNCERTAIN 是因为结尾证据不足，不应被当作 1/3 个好或坏。

## 7. EvaluationInput / EvaluationResult v1.1

### 7.1 输入

```ts
type EvaluationInput = {
  schemaVersion: "evaluation-input-v1.1";
  evaluationId: string;
  mode: "mock" | "production";
  questionBankCase: QuestionBankCase;
  artifact: {
    artifactId: string;
    runId: string;
    jobId: string;
    provenance: "MOCK" | "PRODUCTION";
    contentHash: `sha256:${string}`;
    pageCount: number;
  };
  staticSurface: {
    surfaceClass: "canonical" | "native_frozen";
    renderManifestHash: `sha256:${string}`;
    fidelity: "verified" | "degraded" | "unknown";
    pages: readonly {
      pageNumber: number;
      pageRole?: string;
      imageHash: `sha256:${string}`;
      image: Uint8Array;
      extractedText: string;
      extractedTextHash: `sha256:${string}`;
    }[];
  };
  referencePack: {
    contentHash: `sha256:${string}` | null;
    facts: readonly {
      factId: string;
      statement: string;
      sourceIds: readonly string[];
    }[];
  };
  evaluationProtocol: {
    rubricHash: `sha256:${string}`;
    aggregationSpecHash: `sha256:${string}`;
    batchProtocolHash: `sha256:${string}`;
  };
};

interface EvaluationModule {
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}
```

### 7.2 输出

```ts
type EvaluationResult = {
  schemaVersion: "evaluation-result-v1.1";
  evaluationId: string;
  caseId: string;
  artifactId: string;
  deliveryStatus: "PASS" | "FAIL" | "UNKNOWN";

  tree: {
    rootNodeId: string;
    nodes: readonly {
      nodeId: string;
      parentNodeId: string | null;
      targetScope: "deck" | "slide" | "evidence";
      pageNumber: number | null;
      dimensionId: string;
      consensus: ConsensusSummary;
      evidenceIds: readonly string[];
    }[];
    evidence: readonly {
      evidenceId: string;
      pageNumber: number;
      kind: "visual_observation" | "extracted_text" | "reference_fact" | "gate";
      quoteOrObservation: string;
      sourceFactId?: string;
      sourceIds?: readonly string[];
    }[];
  };

  dimensionProfile: readonly {
    dimensionId: string;
    scope: "deck" | "slide" | "evidence";
    goodCount: number;
    badCount: number;
    uncertainCount: number;
    assessableCount: number;
    resolvedLabel: "GOOD" | "BAD" | "UNCERTAIN";
    aggregationSpecHash: `sha256:${string}`;
  }[];

  comparisonVector: {
    mappingVersion: string;
    axes: readonly {
      axisId: string;
      sourceDimensionIds: readonly string[];
      goodRate: number | null;
      badRate: number | null;
      uncertainRate: number | null;
      denominator: number;
      comparable: boolean;
    }[];
    rankStatus: "NOT_CALIBRATED" | "NOT_COMPARABLE" | "EXPLORATORY_ONLY" | "ELIGIBLE";
  };

  lineage: {
    caseHash: `sha256:${string}`;
    artifactHash: `sha256:${string}`;
    renderManifestHash: `sha256:${string}`;
    rubricHash: `sha256:${string}`;
    aggregationSpecHash: `sha256:${string}`;
    batchProtocolHash: `sha256:${string}`;
    judge: { kind: "mock" | "real"; provider: string; model: string; responseIds: readonly string[] };
  };
};
```

`goodRate/badRate/uncertainRate` 只是分布统计，不是伪装成 1–5 的分数。`rankStatus` 默认不是 `ELIGIBLE`；只有完成 Rubric/标注一致性/样本覆盖校准后，才允许下游生成探索性或正式的市场位置比较。

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
- 为主任务提供不依赖前端的 JSON/TypeScript 数据契约。

### 本线程不负责

- 前端页面、雷达图绘制、可视化交互；
- 厂商网页 Runner、登录、生成、下载、Trace 和耗时；
- Feishu 发布、报告 UI、产品差距卡交付和 GitHub Issue 自动创建；
- 将一次 Case Sample 宣称为稳定市场排名。

## 10. 对现有模块的改造顺序

1. 新增 `QuestionBankCase`，并把现有 `VOLCANO_EVALUATION_CASE` 适配为“老师→初一学生→火山 Query”的 Case；旧 `EvaluationCaseRecord` 暂时保留兼容。
2. 新增 `EvaluationNode`、`Evidence`、`LabelRecord`、`ConsensusSummary` 和 `AggregationSpec` 类型。
3. 新增 `TriStateEvaluationModule` seam；Mock/Real Judge 都只返回三态树和证据。
4. `ArtifactScorecard` 作为 legacy projection，不再作为 v1.1 的权威输入输出；旧 1–5 字段只能标记为兼容/实验结果。
5. 将 `bakeoff.ts` 的评测分支收敛为组装 `EvaluationInput` 和消费 `EvaluationResult`，不让它知道 Judge payload 和聚合实现。
6. 增加公共 seam 测试：Case hash、persona/query 注入、三态标签、UNCERTAIN 原因、Batch 一致性、树状聚合、分母、mapping hash、Mock/Real 隔离。
7. 在产品确认聚合规则和一致性门槛后，再实现 `DimensionMapping` 的探索性比较；不先做总分或正式排名。

## 11. 需要确认的最小决策

以下是实现前真正需要确认的三件事：

1. 是否确认 v1.1 从 1–5 主评分切换为 `GOOD/BAD/UNCERTAIN`，并保留旧 1–5 仅作兼容投影？
2. 是否确认评测树先固定为 `Deck → Slide → Evidence`，暂不把单独的图形/文本框作为正式评分对象？
3. 是否确认题库把“请求者人设”和“PPT 受众”拆成两个字段，并把两者连同场景和 Query 一起注入厂商可见 Prompt？

确认后，下一阶段才进入 TypeScript 类型和公共接口实现；本阶段不需要前端链路。
