# 海外演示文稿评价标准、Rubric 与公开测试集调研

- 调研日期：2026-08-03
- 调研范围：静态 PPT / presentation / slide deck 的内容、结构、视觉设计、可访问性、事实依据与公开评测数据
- 不在范围：现场演讲技巧、动画效果、PPT 编辑能力、厂商 Runner、最终评分维度与权重决策
- 研究状态：证据清单与候选方案，不是 Evaluation Module 的正式 Rubric

## 1. 摘要结论

1. **没有找到一个可以原样覆盖静态 PPT 全部质量面的通用海外标准。** 成型资料通常只覆盖其中一层：演讲 Rubric 偏 Deck 与现场表现；无障碍规范偏 Slide/Element 的底线检查；设计研究偏视觉缺陷；生成 benchmark 偏内容忠实度或参考图相似度。
2. **目前证据最强、且互补性较好的组合**是：
   - 用 Microsoft PowerPoint Accessibility 与 WCAG 提供可确定检查的底线项；
   - 用 SlideAudit 的静态视觉缺陷分类覆盖 Slide/Element；
   - 用 PresentBench 的“原子化、材料有据、逐项判断”方法覆盖内容完整性、正确性与忠实度；
   - 从 AAC&U、大学 Rubric 与 Plain Language 标准中抽取 Deck 级受众适配、中心信息和组织结构候选，但不能照搬现场演讲项。
3. **GOOD / BAD / UNCERTAIN 可以成立，但不能只把旧的 1–5 分机械压缩为三档。** 更稳妥的转换单位是可核验的正向断言或缺陷断言。例如“正文与背景的对比度达到阈值”可以三态判断；“整体很专业”过于宽泛，不适合作为原子判项。
4. **页级/元素级证据并不是多数传统 Rubric 的原生能力。** SlideAudit 有部分缺陷的边界框；SlideVQA 有证据页选择；Microsoft Accessibility Checker 能定位部分幻灯片和对象。AAC&U、Toastmasters、大学 Rubric 和大多数 LLM judge benchmark 只给总项或自由文本理由，若采用必须由我们的输出契约补充 `slide_index` / `element_ref`。
5. **公开数据集要按用途分开。** SlideAudit 可测试视觉缺陷检测；PresentBench 可测试材料到 PPT 的内容判断；SlideVQA 可测试证据页定位；SciDuet 是文档到幻灯片语料。OmniDocBench、DOCBENCH、PPTBench、PPTArena 分别偏解析、文档问答、原生 PPT 理解/编辑，不能直接当成静态 PPT 质量金标准。
6. **Query→PPT 的公开、带人设与受众字段、同时有 Deck/Slide/Element 质量标注的数据仍是明显空缺。** 现有数据多为文档→PPT、单页生成、学术论文演示或编辑任务；后续题库仍需自建或二次标注。

## 2. 方法与证据分级

### 2.1 纳入与排除方法

- 优先顺序：标准制定机构与产品官方规范 → 同行评审论文及官方数据/代码 → 大学或教育机构官方 Rubric → 预印本及公开仓库 → 设计指南。
- 每个名称均核验其原始论文、官方页面或官方仓库；搜索摘要、博客和商业 SEO 页面不作为结论依据。
- “真实存在”不等于“适合本项目”。本文分别记录来源的评价对象、可复用层级和限制。
- 对最新页面未强行推断首发年份；这类来源标记为“持续更新，访问于 2026”。

### 2.2 证据等级

| 等级 | 定义 | 可承担的角色 |
|---|---|---|
| S | 标准制定机构的规范，或产品官方可访问性/合规说明 | 底线规则和确定性检查依据；仍需确认对 PPTX/渲染图的适用边界 |
| A | 同行评审论文，且有公开数据、代码或可复核材料 | 分类法、测试集或方法候选 |
| B | 官方大学/教育机构/专业协会 Rubric，或同行评审但尚未充分验证的量表 | 候选维度与描述语，不直接继承权重 |
| C | 预印本或较新的开放 benchmark，有论文与公开仓库/数据 | 实验候选；需独立复现和稳定性验证 |
| D | 官方设计原则，或尚无公开代码/数据的独立方法 | 启发和检查清单，不作为金标准 |

证据等级表示来源可复核程度，不表示某一维度的重要性。

## 3. 与现有人工记录的关系

用户提供的[内部人工评测明细](https://365.kdocs.cn/l/cs1wyhstcSIe)包含内容提炼、准确性、逻辑、结构、数据引用、风格一致性、元素丰富度、排版、配色、留白和版式多样性等项，并使用内容 60% / 视觉 40% 与 10 分制。本文只把这些项目及开放理由中的现象词作为检索线索；**不把内部权重、10 分制或已有结论当作海外标准，也不据此预设最终维度。**

交叉核验后的处理建议：

| 内部人工项 | 建议处理 | 原因 |
|---|---|---|
| 内容提炼、逻辑、结构 | 保留但拆为内容取舍、叙事结构等原子判断 | 海外 Deck Rubric 与 PresentBench 均支持，但不应混成一个总体印象分 |
| 准确性、数据与引用 | 保留，并要求 Reference Pack、页码和来源证据 | 只有可追溯材料时才能负责地判断事实；没有材料时不能默认 GOOD |
| 风格一致性 | 保留为 Deck 级跨页判断 | 单页平均不能替代整套视觉系统判断 |
| 排版、配色、字体、图片 | 拆到 Slide / Element 的可定位缺陷 | SlideAudit、WCAG 和 Microsoft 均支持更具体的页面或元素证据 |
| 元素丰富度 | 改写为“视觉表达是否必要且有效” | 图片、图表或装饰数量多不等于信息表达好；不应奖励堆元素 |
| 留白 | 改写为“空间、边距和密度是否平衡” | 留白过少和过多都可能损害阅读，不能把留白量单向当作质量 |
| 版式多样性 | 不作为独立加分项 | 多样本身不是质量；只有重复或变化已经损害沟通时才记录问题 |
| 60/40 权重与 10 分制 | 不继承 | 当前缺少权重效度与细档一致性证据，应先做三态原子标注与校准 |

## 4. 四类来源总览

| 来源 | 分类 | 证据 | 最适合的用途 | 不应承担的用途 |
|---|---|---:|---|---|
| WCAG 2.2 | 1 可直接转维度 | S | 对比度、非文本内容、颜色依赖、阅读顺序等底线候选 | 宣称整个 PPTX 已实现 WCAG 合规；审美总分 |
| Microsoft PowerPoint Accessibility | 1 可直接转维度 | S | PowerPoint 对象、幻灯片级可访问性检查 | 视觉风格排名 |
| CAN-ASC-3.1:2025 Plain Language | 1 可直接转维度 | S | 受众适配、清晰表达、结构与视觉支持 | PPT 专属评分标准 |
| SlideAudit | 1 + 3 | A | 静态视觉缺陷分类、页级与部分元素级测试 | 内容事实、Deck 叙事完整性 |
| AWSM | 1 | B | 幻灯片设计检查项候选 | 直接继承 100 分权重 |
| 大学 Presentation Rubrics | 1 + 2 | B | Deck 组织、信息量、可读性、视觉辅助项 | 把演讲表现当静态 PPT 质量 |
| AAC&U VALUE Rubric | 2，部分可转 1 | B | 组织、中心信息、支持材料、受众意识 | 交付技巧、眼神、声音等静态评分 |
| Toastmasters Evaluation Resources | 2 | B | 识别“视觉辅助是否支持主题” | 静态 PPT 综合 Rubric |
| PresentBench | 3，方法可转 1 | C | 材料有据的原子化内容检查 | 无背景材料的事实裁决；原生审美标准 |
| PPTAgent / PPTEval / Zenodo10K | 3 | A | 内容/设计/连贯性基线、真实 deck 语料 | 原样采用 1–5 分与粗粒度 Judge |
| SlidesGen-Bench | 3 | C | 内容、审美、可编辑性的多方法评测参考 | 将可编辑性混入本期静态质量 |
| AutoPresent / SlidesBench | 3 | A | 单页生成、布局和参考图实验 | 全 Deck 内容与受众适配 |
| SciDuet | 3 | A | 学术文档→幻灯片语料 | Query→PPT 或审美金标准 |
| Persona-Aware D2S | 3 | A | 人设/受众/长度条件的题库设计参考 | 通用质量 benchmark |
| SlideVQA | 3 | A | 证据页选择、Deck 内容检索 | 设计或美学评分 |
| PPTBench / PPTArena | 3 | C | 原生 PPT 理解、布局与编辑回归 | 静态生成质量总分 |
| OmniDocBench / DOCBENCH | 3，相关但非质量集 | A | 解析/OCR/阅读系统能力测试 | PPT 质量标准 |
| MIT / AEA Slide Design Guides | 4 只有设计原则 | D | 形成假设和检查项措辞 | 量表、标注金标准 |
| SlideBench.org | 3/4，尚不可完整复核 | D | 观察行业评测方法 | 当前正式基准或唯一标准 |

## 5. 可直接转为静态 PPT 候选维度的来源

### 5.1 WCAG 2.2

- **名称、机构、年份、链接**：[Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/)，W3C，2023；当前 Recommendation 页面于 2024-12-12 再发布。
- **评价对象**：Web 内容的可访问性，不是 PPT 专属标准。
- **可复用维度**：
  - [1.1.1 Non-text Content](https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html)：信息性非文本内容需要文本替代；
  - [1.3.2 Meaningful Sequence](https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence)：内容顺序影响含义时，程序可确定的阅读顺序应正确；
  - [1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)：颜色不能是传达信息、动作或区分元素的唯一方式；
  - [1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)：普通文本至少 4.5:1，大号文本至少 3:1；
  - [1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast?level=0)：理解内容所需的图形对象及状态通常至少 3:1；
  - [1.4.5 Images of Text](https://www.w3.org/WAI/WCAG22/Understanding/images-of-text.html)：可用真实文本实现时避免用图片文字。
- **量表**：逐项 Success Criterion 的满足/不满足，不是审美分数。
- **页级证据**：规范本身不产出页码；实现到 PPT 时可定位到 Slide 和 Element，并记录颜色值、对比度、对象类型、阅读顺序。
- **GOOD/BAD/UNCERTAIN 与树结构**：适合将明确阈值或明确对象要求转为 GOOD/BAD；若无法可靠取得实际前景/背景、透明叠加、语义用途或阅读顺序，则为 UNCERTAIN。主要落在 Slide/Element，少量跨页一致性可在 Deck 汇总。
- **限制**：不能把采用若干 WCAG 条款等同于“PPTX 整体 WCAG 合规”；投影环境、屏幕校准和复杂背景会影响视觉结果；对比度合格也不代表美观或内容清楚。

### 5.2 Microsoft PowerPoint Accessibility Guidance

- **名称、机构、年份、链接**：[Make your PowerPoint presentations accessible to people with disabilities](https://support.microsoft.com/en-us/accessibility/powerpoint/make-your-powerpoint-presentations-accessible-to-people-with-disabilities) 与 [Make slides easier to read by using the Reading Order pane](https://support.microsoft.com/en-us/powerpoint/make-slides-easier-to-read-by-using-the-reading-order-pane)，Microsoft，持续更新，访问于 2026-08-03。
- **评价对象**：PowerPoint 演示文稿、幻灯片和对象的可访问性。
- **维度**：唯一标题、逻辑阅读顺序、图像替代文本与装饰性标记、足够颜色对比、颜色非唯一信息载体、字体可读性、简洁表格结构、有意义的链接文字。
- **量表**：Accessibility Checker 的错误/警告/提示和官方建议，不提供审美总分。官方还建议面向可访问性的演示采用较大的无衬线字体、足够留白，并在相关场景使用至少 18pt 左右的字号；这属于产品指导，不应误写为普适硬阈值。
- **页级证据**：部分检查可定位幻灯片及对象；阅读顺序窗格能直接检查对象层级。复杂背景上的透明文字等情况可能无法被 Checker 完整发现。
- **GOOD/BAD/UNCERTAIN 与树结构**：Deck 可检查标题唯一性与整体可导航性；Slide 可检查标题存在、阅读顺序；Element 可检查 alt text、文本、图形和表格。明确违反为 BAD，明确满足为 GOOD，检查器能力之外或对象语义不明为 UNCERTAIN。
- **限制**：官方说明面向可访问性而非审美；某些信息依赖原生 PPTX 对象，单纯静态图片无法验证 alt text、阅读顺序和表格结构。

### 5.3 CAN-ASC-3.1:2025 Plain Language

- **名称、机构、年份、链接**：[CAN-ASC-3.1:2025 Plain Language](https://accessible.canada.ca/standards-and-technical-guides/standards-and-technical-guides-database/can-asc-312025-plain-language?mode=full-html)，Accessibility Standards Canada，2025。
- **评价对象**：面向目标受众的书面和视觉沟通，不是 PPT 专属。
- **维度**：明确目的和受众；选择受众能理解的内容与词汇；逻辑组织；标题与信息层级；视觉应支持而非替代含义；控制细节量；使用留白；颜色含义应有其他线索。
- **量表**：标准中的规范性要求与指导，不是数值分。
- **页级证据**：标准不提供页级输出；落地时可在 Deck 判断目的/受众/结构，在 Slide/Element 判断标题、术语、细节密度、图文关系。
- **GOOD/BAD/UNCERTAIN 与树结构**：很适合 Deck 级“是否适合指定受众”的候选判断，但前提是输入中有受众、人设与场景。没有受众信息或专业知识包不足时应为 UNCERTAIN，而不是 BAD。
- **限制**：广义沟通标准；“清楚”“受众可理解”等项目仍需场景知识或标注者校准，不能只靠格式规则。

### 5.4 SlideAudit：静态视觉缺陷分类与数据集

- **名称、机构、年份、链接**：[SlideAudit: A Dataset and Taxonomy for Automated Evaluation of Presentation Slides](https://zhuohaozhang.com/slideaudit.pdf)，University of Washington，UIST 2025；[官方仓库](https://github.com/zhuohaouw/SlideAudit)。
- **评价对象**：单张静态幻灯片中的设计缺陷。
- **维度**：完整 taxonomy 有 27 类、5 个上位类：Composition & Layout、Typography、Color、Imagery、Animation & Interaction。数据研究聚焦 19 个静态缺陷，包括视觉层级弱、拥挤、边距/留白不当、错位、溢出/截断、遮挡；字体不可读、字号不当、文字过密、样式不一致、行/字间距不当、文本层级弱；对比度不足、颜色过多或不一致、色彩组合刺眼；图片不相关、低清/变形、缩放或尺寸不当、视觉风格不一致。
- **量表**：缺陷类别的存在/不存在；模型实验用 precision、recall、F1。不是整页美学分。
- **页级证据**：数据以 slide image 为单位；其中 9 类缺陷带边界框。公开数据含 `TEXT_BOX`、`IMAGE` 等元素描述及归一化位置。
- **GOOD/BAD/UNCERTAIN 与树结构**：天然适合 Slide/Element。对于正向断言，证据充分且无缺陷可为 GOOD，发现缺陷为 BAD，图像模糊、元素边界或语义无法可靠判断时为 UNCERTAIN。跨页布局一致性与内容逻辑虽在 taxonomy 中讨论，但未进入该静态实验集。
- **限制**：2,400 张图来自 600 张原始 slide 加 1,800 张受控修改；受控缺陷不完全等同真实生成错误。论文中的模型检测 F1 约 0.331–0.655，说明仅靠通用视觉模型判断仍有明显误差。仓库当前说明评分工具仍待上传，不能把论文结果当成现成生产 Judge。

### 5.5 Applied Weighted Slide Metric (AWSM)

- **名称、机构、年份、链接**：[The Applied Weighted Slide Metric (AWSM) Tool: Creation of a Standard Slide Design Rubric](https://escholarship.org/uc/item/97m7096w)，Sudario 等，UC Irvine School of Medicine，2022。
- **评价对象**：教育演示中的幻灯片设计，由医学教育者参与形成。
- **维度**：19 项，包括图表/数据可读性、避免拥挤、图片相关性、重点突出、字号、对比度、总结、学习目标、标题清晰、样式一致等。
- **量表**：项目权重合计 100；权重来自 225 名医学教育者对重要性的调查。
- **页级证据**：量表本身没有结构化页码或元素证据；多数项目可在 Slide/Element 执行，目标与总结等项目更偏 Deck。
- **GOOD/BAD/UNCERTAIN 与树结构**：19 个项目可拆成原子三态检查，但不建议继承分值。诸如“图片相关”“不拥挤”需要页面证据和解释；无法看到动态指示、演讲者动作或原始图表时可判 UNCERTAIN。
- **限制**：样本集中在医学教育者且为自愿参与；作者明确指出权重尚不能证明真实质量代表性，需要信度和效度验证；静态审查无法捕捉动画和现场指示。

### 5.6 大学官方 Presentation Rubrics

#### University of Arkansas HESC-MS Oral Presentation Rubric

- **机构、年份、链接**：University of Arkansas，2023 修订，[官方 PDF](https://human-environmental-sciences.uark.edu/_resources/pdf/23-24MS_Oral_Presentation_Rubric.pdf)。
- **评价对象**：研究生口头演示，包含静态视觉辅助与现场表达。
- **维度**：组织、主题掌握、视觉辅助、口头呈现、问题回答。视觉项明确提到文字不应过多、字体和图形应可读、图形不模糊、对比适当、视觉应促进理解；组织项强调目标、结论、take-home message、逻辑顺序和信息量。
- **量表**：0–5。
- **页级证据**：无；可把视觉项改为 Slide/Element 证据，把组织项改为 Deck/Slide 证据。
- **三态适用性与限制**：视觉和组织描述可拆为 GOOD/BAD/UNCERTAIN；声音、肢体和问答必须排除。学术研究演示场景较窄，不能直接代表营销、汇报或教学 PPT。

#### MIT Weather and Climate Lab Presentation Rubrics

- **机构、年份、链接**：MIT Weather & Climate Lab，页面所载 Rubric 访问于 2026，[官方 PDF](https://weatherclimatelab.mit.edu/wp-content/uploads/2022/02/rubrics.pdf)。
- **评价对象**：课程中的科学演示。
- **维度**：Slide Design、Organization、Motivation、Data Analysis、Discussion；设计描述包含 key-point title、视觉聚焦、文字简洁且足够大、辅助图清楚，组织描述包含逻辑连接。
- **量表**：1–4。
- **页级证据**：无结构化页码；Slide Design 可页级化，Organization/Motivation 更适合 Deck。
- **三态适用性与限制**：适合抽取“标题表达关键点”“视觉聚焦”“逻辑连接”等判断，但数据分析维度高度依赖课程任务；不能继承 1–4 档位。

#### University of Chicago Data Science Clinic Final Video Rubric

- **机构、年份、链接**：University of Chicago Data Science Clinic，持续更新，[官方 Rubric](https://clinic.ds.uchicago.edu/rubrics/final-video.html)。
- **评价对象**：数据科学项目最终视频与幻灯片。
- **维度**：Slide Quality、Presentation Quality、Organization。静态项包括语法、风格一致与可读、避免拥挤、图表标注、画面比例、Logo 不遮挡内容。
- **量表**：按项目分值，Slide Quality 10、Presentation Quality 15、Organization 5。
- **页级证据**：无；静态项可以要求 Slide/Element 证据。
- **三态适用性与限制**：适合补充图表标注、Logo 遮挡等具体缺陷；视频节奏、声音、转场和发言表现与本项目无关。

#### Stony Brook University Course Presentation Rubric

- **机构、年份、链接**：Stony Brook University，2026 课程页面，[官方 Rubric](https://www.math.stonybrook.edu/~moira/courses/mat336-sp2026/slides/)。
- **评价对象**：数学课程演示文稿。
- **维度**：Typography & Design、Content、References、Structure；包含文字量、图像署名、参考文献、必要页面等。
- **量表**：Good / Needs Work / Not Demonstrated。
- **页级证据**：无结构化证据；多项可定位到 Slide/Element。
- **三态适用性与限制**：它证明教育 Rubric 中存在非 1–5 的低粒度等级，但 `Needs Work` 表示质量中间态，**不等于**证据不足的 `UNCERTAIN`；课程规定的必备页面不能泛化为通用 PPT 要求。

## 6. 主要评价现场演讲、不能整体用于静态 PPT 的来源

### 6.1 AAC&U Oral Communication VALUE Rubric

- **名称、机构、年份、链接**：Oral Communication VALUE Rubric，Association of American Colleges and Universities (AAC&U)，2009；可在[VALUE Rubrics 汇编 PDF](https://www.dcu.ie/sites/default/files/inline-files/all_rubrics_0.pdf)中核验，术语见[AAC&U VALUE Institute Glossary](https://valuesupport.aacu.org/support/solutions/articles/48000269306-value-institute-glossary)。
- **评价对象**：单一演讲者的现场或录像口头表达，不是独立观看的静态 slide deck。
- **维度**：Organization、Language、Delivery、Supporting Material、Central Message。
- **量表**：Capstone 4、Milestones 3/2、Benchmark 1；实施方可对低于 Benchmark 的表现记 0。AAC&U 还允许对无法判读的材料标记 unscorable。
- **页级证据**：无；原始证据单位是整段演讲。
- **GOOD/BAD/UNCERTAIN 与树结构**：Organization、Supporting Material、Central Message 可改写为 Deck 级候选；Language 可部分用于幻灯片文本。Delivery 不可用于静态评测。若中心信息需要演讲音频才能成立，静态 Deck 应为 UNCERTAIN，而不是推断 BAD。
- **限制**：Rubric 明确面向口头沟通；照搬会把演讲者声音、姿势、眼神等错误归因给 PPT 文件。四档也不能直接当作三态判断。

### 6.2 Toastmasters “Creating Effective Visual Aids” Evaluation Resource

- **名称、机构、年份、链接**：[Creating Effective Visual Aids — Evaluation Resource](https://www.toastmasters.org/resources/-/media/d389e83787464044bd66639ef0e8113b.ashx)，Toastmasters International，2016 修订；来自[官方 Resource Library](https://www.toastmasters.org/resources/resource-library?c=%7B06DBA098-FF9B-4DC6-8DE2-D8629602812F%7D&page=9)。
- **评价对象**：带视觉辅助的现场演讲。
- **维度**：Clarity、Vocal Variety、Eye Contact、Gestures、Audience Awareness、Comfort Level、Interest、Visual Aid、Topic。
- **量表**：5 个表现等级：Exemplary、Excels、Accomplished、Emerging、Developing。
- **页级证据**：无。
- **GOOD/BAD/UNCERTAIN 与树结构**：只有“视觉辅助是否支持主题和演讲”“主题是否连贯”可作为 Deck/Slide 的弱候选；声音、眼神、手势、舒适度必须排除。
- **限制**：即使标题含 Visual Aids，评价主体仍是演讲者；不能据此构造静态 PPT 综合评分。

### 6.3 处理原则

这类 Rubric 不应整套移植。可接受的做法是保留与成品 deck 本身有关的少数断言，并把来源、改写方式和排除项写入 Rubric 版本；演讲现场才可观察到的项目统一标记为不适用，而不是 BAD。

## 7. 可作为测试集、语料或评测方法参考的公开项目

### 7.1 优先候选

#### PresentBench

- **名称、作者/机构、年份、链接**：[PresentBench: A Fine-Grained Rubric-Based Benchmark for Slide Generation](https://arxiv.org/abs/2603.07244)，2026 预印本；[官方仓库](https://github.com/PresentBench/PresentBench)。
- **评价对象**：给定真实背景材料后生成的完整演示文稿。
- **维度**：presentation fundamentals、visual design & layout、content completeness、content correctness、content fidelity；238 个专家整理样例，覆盖 Academia、Education、Economics、Talk、Advertising，平均每例约 54.1 个原子二元检查项。
- **量表**：每个原子项独立 yes/no；不完全满足也按 no 处理，代码再按维度聚合。公开 Judge 协议没有为证据不足单设三态，因此需要由我们的协议补充 `UNCERTAIN`。
- **页级证据**：Judge 的 explanation 是自由文本，当前 schema 未强制结构化页码；需要我们的接口另加 `slide_index` / `element_ref`。
- **GOOD/BAD/UNCERTAIN 与树结构**：二元原子项很适合映射 GOOD/BAD；模型失败、背景材料不足或页面无法读取可转 UNCERTAIN；不适用项应在进入 Judge 前通过规则路由排除，而不是默认 GOOD。内容项可落 Deck/Slide，视觉项可落 Slide/Element。
- **限制**：预印本尚未完成同行评审；主要是有材料的文档/任务→PPT，不是纯 Query→PPT；Judge 与题项生成仍受模型影响。论文报告的人类相关性优于 PPTEval，但仍不是无误金标准。

#### SlideAudit

SlideAudit 同时是维度来源和测试集。公开集的 2,400 张 slide image、19 类静态缺陷及部分边界框，最适合做视觉 Judge 的离线回归与 Element 证据测试。其受控合成方式和中等模型 F1 决定了它更适合做“缺陷检测基准的一部分”，不能单独代表真实产品质量分布。详见 5.4。

### 7.2 完整 deck 生成与评价基线

#### PPTAgent / PPTEval / Zenodo10K

- **名称、作者/机构、年份、链接**：[PPTAgent: Generating and Evaluating Presentations Beyond Text-to-Slides](https://aclanthology.org/2025.emnlp-main.728/)，EMNLP 2025；[官方仓库](https://github.com/icip-cas/PPTAgent)。
- **评价对象**：完整演示文稿生成与评价；Zenodo10K 包含 10,448 个公开来源的 presentation，覆盖 Culture、Education、Science、Society、Technology。
- **维度**：PPTEval 使用 Content、Design、Coherence；Content 和 Design 逐 slide，Coherence 看完整 Deck。描述涉及文字简洁与语法、图像相关性、配色、布局可读性、视觉元素、结构推进和必要背景。
- **量表**：1–5，并生成理由。
- **页级证据**：Content/Design 在 slide 级调用，但结果理由没有强制统一的页码/元素引用结构；Coherence 是 Deck 级。
- **GOOD/BAD/UNCERTAIN 与树结构**：层级划分值得参考，但不应继承 1–5；可把每项描述拆成三态原子断言。Zenodo10K 可作为无标签或弱标签真实 deck 语料。
- **限制**：维度较粗、Judge 为实例无关评分。PresentBench 论文报告其与人类判断的 Spearman 相关较低（约 0.303，对比 PresentBench 约 0.532）；不宜当唯一 Judge。

#### SlidesGen-Bench

- **名称、作者、年份、链接**：[SlidesGen-Bench: Evaluating Slides Generation via Computational and Quantitative Metrics](https://arxiv.org/abs/2601.09487)，2026 预印本；[官方仓库](https://github.com/YunqiaoYang/SlidesGen-Bench)。
- **评价对象**：幻灯片生成系统，强调渲染结果的系统无关评价。
- **维度**：Content、Aesthetics、Editability；内容含 QuizBank，审美结合计算指标、LLM rating 和 arena，另有 Slides-Align1.5K 偏好数据。
- **量表**：多种定量指标、LLM 评分和成对比较/Elo，不是单一 Rubric。
- **页级证据**：指标可在页面渲染上计算，但公开描述并未把每个结论统一为结构化页码/元素证据。
- **GOOD/BAD/UNCERTAIN 与树结构**：可借鉴“内容与审美分开”和渲染评测；Editability 不属于当前静态范围。其连续分、偏好排名需要另行定义到三态的转换，不能直接映射。
- **限制**：近期预印本；混合 Judge 的可复现性依赖模型版本；偏好数据反映相对选择，不等于绝对 GOOD/BAD。

### 7.3 单页、布局与参考图 benchmark

#### AutoPresent / SlidesBench

- **名称、作者/机构、年份、链接**：[AutoPresent: Designing Structured Visuals from Scratch](https://openaccess.thecvf.com/content/CVPR2025/papers/Ge_AutoPresent_Designing_Structured_Visuals_from_Scratch_CVPR_2025_paper.pdf)，CVPR 2025；[官方仓库](https://github.com/para-lost/AutoPresent)。
- **评价对象**：根据自然语言指令和单张参考 slide 生成一张结构化幻灯片。
- **维度**：参考相关的位置、文字和颜色指标，以及参考无关的内容、格式和整体设计指标。SlidesBench 含约 7,000 个训练和 585 个测试样例，来源于 310 份公开 deck、10 个领域。
- **量表**：自动指标和人工/模型设计评价组合。
- **页级证据**：天然为单页；部分布局指标可落 Element。
- **GOOD/BAD/UNCERTAIN 与树结构**：适合 Slide/Element 的布局回归，不适合 Deck 结构。参考差异只能说明“不像参考图”，不能自动判为 BAD；没有唯一正确版式时应保留 UNCERTAIN 或仅作为诊断指标。
- **限制**：单页任务；参考匹配会惩罚同样优秀但不同的设计；不能评价事实、受众适配和跨页叙事。

### 7.4 文档→PPT 与人设/受众语料

#### SciDuet

- **名称、作者/机构、年份、链接**：[SciDuet: A Multi-modal Dataset for Scientific Document and Presentation Understanding](https://aclanthology.org/2021.naacl-main.111.pdf)，Sun 等，IBM Research，NAACL 2021；[GEM 官方数据卡](https://huggingface.co/datasets/GEM/SciDuet)。
- **评价对象**：科学论文与对应演示幻灯片的配对，用于文档→幻灯片生成和理解。
- **维度/量表**：它是语料，不是质量 Rubric；原论文生成评价以 ROUGE 和人工质量判断为主。
- **页级证据**：论文内容与 slide 有配对关系，但不含本项目所需的逐页质量问题与元素证据标签。
- **GOOD/BAD/UNCERTAIN 与树结构**：不能直接映射三态；可用于文档→PPT 的内容选择、覆盖与忠实度测试素材。
- **限制**：集中于 NLP/ML 学术论文；公开子集受版权条件影响；不覆盖 Query→PPT、职场或基础教育人设。

#### Persona-Aware Document-to-Slides Generation

- **名称、作者、年份、链接**：[Presentations by the Humans and For the Humans: Harnessing LLMs for Persona-Aware Slides Generation](https://aclanthology.org/2024.eacl-long.163.pdf)，Mondal 等，EACL 2024；论文给出的[项目仓库](https://github.com/Ishani-Mondal/Persona-Aware-D2S)。
- **评价对象**：根据受众专业度和期望长度生成科研演示；从 SciDuet 取 75 篇论文，构造 expert/non-expert × short/long 四种配置。
- **维度/量表**：研究受众与长度条件对内容选择、可理解性和生成结果的影响，不是通用静态设计 Rubric。
- **页级证据**：主要在 deck/配置层评价，没有标准化元素证据。
- **GOOD/BAD/UNCERTAIN 与树结构**：对题库中的 requester persona、audience、page budget 分字段有直接启发；只有给定目标受众和长度后才能在 Deck 判断是否适配，否则应为 UNCERTAIN。
- **限制**：样本小、科学论文领域窄；不能证明同样的人设字段足以覆盖教学、销售或管理汇报。

### 7.5 内容检索与证据页定位

#### SlideVQA

- **名称、作者/机构、年份、链接**：[SlideVQA: A Dataset for Document Visual Question Answering on Multiple Images](https://ojs.aaai.org/index.php/AAAI/article/download/26598/26370)，AAAI 2023；[官方仓库](https://github.com/nttmdlab-nlp/SlideVQA)。
- **评价对象**：跨多页幻灯片的视觉问答与证据页选择；含 2,619 个 deck、约 52,000 张 slide image 和约 14,500 个问题。
- **维度/量表**：答案准确率与证据 slide 选择，不评价审美、结构或整体适用性。
- **页级证据**：有明确 evidence slide 任务，是本次来源中少数原生要求页级定位的数据集。
- **GOOD/BAD/UNCERTAIN 与树结构**：可测试评测器能否在 Deck 中找到支持某个内容判断的 Slide；不能把 QA 答对直接映射成 PPT GOOD。OCR/答案不充分时可用于验证 UNCERTAIN 路径。
- **限制**：问答分布不等于质量缺陷分布；公开版本的 OCR/边界框可用性与原始内部资源并不完全相同，应在接入前做下载和许可证核查。

### 7.6 相关但不能当静态 PPT 质量标准的 benchmark

| 名称、年份、链接 | 真实用途与规模 | 量表/证据 | 对本项目的适用性 | 限制 |
|---|---|---|---|---|
| [PPTBench](https://arxiv.org/abs/2512.02624)，2025 预印本 | 原生 PPTX 的 Detection、Understanding、Modification、Generation；论文报告 958 个 PPTX、4,439 个样本 | 任务成功率、结构/布局结果；可到 page/element | 测评估器能否理解重叠、错位和原生对象 | 不是成品 deck 质量 Rubric；代码与数据仍需接入前复核 |
| [PPTArena](https://arxiv.org/abs/2512.03042)，2025 预印本 | 演示文稿编辑 benchmark；100 个 deck、2,125 张 slide、800+ 编辑 | 结构 diff、渲染图和编辑成功 | 未来 Element 编辑回归 | 当前只评静态生成质量，不应纳入主分 |
| [OmniDocBench](https://openaccess.thecvf.com/content/CVPR2025/html/Ouyang_OmniDocBench_Benchmarking_Diverse_PDF_Document_Parsing_with_Comprehensive_Annotations_CVPR_2025_paper.html)，CVPR 2025；[仓库](https://github.com/opendatalab/OmniDocBench) | 多类型 PDF 解析，含 slide 页面、布局块和阅读顺序 | OCR、公式、表格、阅读顺序等解析指标；页/块级标注 | 验证 OCR、版面解析和证据抽取前置能力 | 解析正确不等于 PPT 内容或设计优秀 |
| [DOCBENCH](https://aclanthology.org/2025.knowledgenlp-1.29.pdf)，ACL 2025 | LLM 文档阅读系统 benchmark | 文档问答指标 | 只与长文档理解间接相关 | 名称容易与 slide/document benchmark 混淆；不是 PPT 质量集 |
| [SlideBench.org Methodology](https://www.slidebench.org/methodology)，2026 页面 | 独立网站提出多模型 Judge、质量与可塑性两轨、7 个维度 | 100 分与相对比较；页面称 GitHub 即将开放 | 可观察行业测法 | 当前缺少可公开复核的代码、数据和同行评审，证据等级 D |

## 8. 只有设计原则、没有成型量表的来源

### 8.1 MIT Communication Lab Slide Design

- **名称、机构、链接**：[Slide Design](https://mitcommlab.mit.edu/aeroastro/commkit/slide-design/)，MIT AeroAstro Communication Lab。
- **评价对象与原则**：科学和工程演示的 slide 设计；强调一页的核心信息、图像与文字配合、避免直接复制论文中密集且过小的图表、为现场解释服务。
- **量表与证据**：无量表、无页级标注。
- **适用性**：可形成“图表是否适合投影阅读”“一页是否有清楚重点”等候选断言；不能当训练标签或权重来源。
- **限制**：教学指南而非经验证的 Rubric。

### 8.2 American Evaluation Association Slide Design Guidelines

- **名称、机构、链接**：[Slide Design Guidelines](https://www.eval.org/Education-Programs/Potent-Presentations/Slide-Design-Guidelines)，American Evaluation Association。
- **评价对象与原则**：演示幻灯片；建议使用高质量、相关的图像，避免模糊、水印和拥挤，减少不必要文字。
- **量表与证据**：无量表、无结构化证据。
- **适用性**：与 Image Element 的清晰度、相关性和 Slide 的信息密度一致，可作检查项措辞参考。
- **限制**：属于设计原则；没有证明这些建议如何聚合为整体质量或厂商排名。

## 9. 对 Deck / Slide / Element 树和三态判断的启示

以下只是从来源交叉归纳出的**候选维度族**，不是最终 Rubric：

| 候选维度族 | 主要对象 | 可要求的证据 | 主要来源 |
|---|---|---|---|
| 任务与受众适配 | Deck | 输入 persona/audience、目标、相关页及理由 | CAN Plain Language、AAC&U、Persona-Aware D2S、大学 Rubric |
| 叙事与结构 | Deck → Slide | 大纲、章节顺序、关键转折页、缺失或重复页 | AAC&U、Arkansas、MIT、PresentBench、PPTEval |
| 内容完整性、正确性、忠实度 | Deck → Slide → Element | 背景材料片段、页码、文本框/图表 | PresentBench、PPTEval、SciDuet、SlideVQA |
| 信息压缩与认知负荷 | Slide → Text Element | 字数、字号、区域占比、拥挤位置及理由 | AWSM、Arkansas、MIT、SlideAudit |
| 视觉层级、排版与空间 | Slide → Element | 元素框、对齐关系、遮挡/溢出/边距 | SlideAudit、AutoPresent、UChicago |
| 字体与可读性 | Slide → Text Element | 字号、字形、行距、密度、对比度 | SlideAudit、Microsoft、WCAG、AWSM |
| 颜色与对比度 | Slide → Element | 前景/背景颜色值、比值、颜色编码用途 | WCAG、Microsoft、SlideAudit |
| 图片与图表质量 | Slide → Image/Chart Element | 清晰度、裁切框、变形、相关性、标签 | SlideAudit、AWSM、Arkansas、AEA |
| 可访问性语义 | Deck/Slide/Element | 标题、阅读顺序、alt text、表格头、链接 | Microsoft、WCAG |

### 9.1 三态不是中间分

建议在后续规格讨论中区分以下语义，本文不替产品做最终决定：

- **GOOD**：对一个足够原子的正向断言，有充分证据表明满足；或对缺陷断言，有充分证据表明不存在。
- **BAD**：有可定位证据表明断言不满足或缺陷存在。
- **UNCERTAIN**：证据不足、渲染或解析失败、需要但缺少背景知识、图像无法可靠辨别、Judge 冲突，或现有材料不能支持判断。
- **NOT APPLICABLE**：判断不适用于当前样本，例如没有图表就不评“图表标签”。它更像规则路由状态，不宜默认为 GOOD，也不等于 UNCERTAIN。若公共接口最终只保留三态，需要明确 N/A 是被过滤、单独记录，还是折叠到 UNCERTAIN。

因此，Stony Brook 的 `Needs Work`、传统 1–5 的中间档和 Toastmasters 的 `Emerging` 都是质量程度，不是证据不确定性，不能直接映射成 UNCERTAIN。

### 9.2 证据结构的最低候选要求

多数外部来源没有统一证据 schema。若转入本项目，至少可考虑记录：

```text
criterion_id
judgment: GOOD | BAD | UNCERTAIN
target_level: DECK | SLIDE | ELEMENT
slide_index: optional
element_ref: optional
evidence: rendered region / extracted text / source-material span / measured value
reason
confidence
uncertainty_reason: optional
rubric_version
judge_model_and_prompt_version
```

这里的 `confidence` 表示判断证据与模型把握程度，不是“准确率”；准确率需要对有金标的数据集做批量比较后才能计算。

### 9.3 聚合边界

- 先保留原子判断，再聚合到 Element → Slide → Deck；不要先生成一个总分再反推证据。
- 底线项与质量项分开。WCAG/Microsoft 的明确违规可以进入底线候选，但“符合底线”不能自动提升美学排名。
- Deck 级受众适配不能简单取所有 Slide 的多数票；结构和任务完成度也不能只平均页面质量。
- 来源没有为 GOOD/BAD/UNCERTAIN 提供可靠权重，因此本轮不建议确定雷达图权重、总分公式或排名算法。

## 10. 推荐进入下一轮验证的候选（不等于采纳）

### 第一优先级：可直接做小样验证

1. **SlideAudit taxonomy + 公开图像/边界框**：验证 Slide/Element 视觉缺陷 Judge、证据定位和三态失败路径。
2. **Microsoft PowerPoint Accessibility + WCAG 子集**：实现可计算或可检查的底线候选，明确哪些需要原生 PPTX、哪些可从静态渲染判断。
3. **PresentBench 的原子检查方法与部分开放样例**：验证“背景材料→逐项事实/完整性判断→理由”的流程，但把 yes/no 扩展为证据不足时的 UNCERTAIN。
4. **AAC&U / CAN Plain Language / Arkansas / MIT 中的 Deck 静态子项**：只抽取中心信息、支持材料、受众、组织、信息量和视觉辅助，不采用现场 delivery 项。

### 第二优先级：补充实验

1. **AWSM 19 项清单**：用于覆盖率审查，不采用其调查权重。
2. **Persona-Aware D2S**：验证题库中 requester persona、audience、page budget 是否真的改变期望内容。
3. **SlideVQA**：测试 Judge 能否找到支持判断的页，而不是把它当质量金标。
4. **AutoPresent / SlidesBench 与 SlidesGen-Bench**：补充布局、渲染指标和成对偏好实验，检查它们与三态人工标注的一致性。
5. **Zenodo10K / SciDuet**：作为真实 deck 或文档→PPT 语料池，先完成许可、可下载性和领域偏差核查。

### 暂不建议作为正式标准

- 原样采用 AAC&U、Toastmasters 或大学 Rubric 的全部现场演讲项；
- 原样采用 AWSM、PPTEval 或任何 1–5 / 100 分权重；
- 用 SlideVQA、OmniDocBench、DOCBENCH 的 QA/解析成绩代表 PPT 质量；
- 在代码和数据公开、复现前把 SlideBench.org 当作金标准；
- 用单一参考图相似度判定所有不同设计的好坏。

## 11. 局限与待验证问题

1. 本轮核验到论文/标准/官方页面和主要仓库层级，**尚未逐个下载全量数据、执行许可证审计或跑通 benchmark**；数据接入前必须再做下载 smoke test、字段检查和许可证记录。
2. 海外官方 Rubric 主要来自英语教育、学术报告和医学/科学演示，可能低估中文排版、中文字体、政企汇报、营销提案和基础教育课件中的特殊问题。
3. Query→PPT 的公开测试集明显少于文档→PPT；现有 benchmark 很少同时提供 requester persona、audience、page budget、事实知识包和三层质量金标。
4. 许多来源依赖原生 PPTX 结构；仅有静态渲染时，alt text、阅读顺序、可编辑性、隐藏对象和动画均不可判断。应明确返回 UNCERTAIN 或不路由，不能假装等价。
5. “事实准确”需要可引用背景材料或场景知识包。只有 deck 本身时，SlideVQA 可测内部取证，但不能证明外部世界事实。
6. 公开 benchmark 的模型 Judge、提示词和底层模型会变化；正式生产报告仍需记录模型、提示词、Rubric 与数据版本，并用固定标注 batch 检查一致性。
7. 本文没有决定最终维度数量、维度命名、权重、树上聚合公式或厂商排名方法；这些应在小样背靠背标注和 Judge 一致性实验之后决定。
