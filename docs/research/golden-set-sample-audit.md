# Golden Set 样本数据审计：PresentBench 与 SlideAudit

> 审计日期：2026-08-03
>
> 范围：只核验公开数据、字段、标签、资产和许可证边界，并挑选中文背靠背标注候选；本文不是正式 Rubric、HTML 原型或实现规格。
> 固定快照：PresentBench 代码 `e70ff01da962274e1e3cc03f77ec435ad66c5eb6`，PresentBench HuggingFace 数据 `31ec40084405c5f2e6b8b5adedf2999b6060e7e1`，PresentBench 项目页仓库 `34718357045b63ddce246f5e4c2543f5d96e63ea`，SlideAudit `642d490b7c1d2e78a50a631bfd359433397f3ecf`。

## 1. 结论先行

1. **两套数据适合校准不同层级，不能直接合并为一个“总分金标”。** PresentBench 是材料/文档到整套 PPT 的细粒度 checklist，覆盖整套结构、内容完整性、正确性、忠实度及通用视觉规则；SlideAudit 是单页静态图的设计缺陷多标签标注，适合校准版式、排版、颜色和图片问题。
2. **PresentBench 的原始金标是 checklist 的 `yes/no`，不是好/坏/不确定。** `yes` 表示完整满足；部分满足也必须判 `no`。在证据充足时可映射为 `yes → GOOD`、`no → BAD`；`UNCERTAIN` 是我们的新增状态，只能用于材料缺失、渲染不可读、证据冲突等不可判情形，不能把原始 `no` 改写成不确定。
3. **SlideAudit 的 `response` 表示“该缺陷是否存在”。** 因而 `response=true → 该判项 BAD`；`response=false` 只表示没有形成“该缺陷存在”的多数标注，不能推出整页 GOOD。`has_strong_agreement=false` 也不等于我们的 `UNCERTAIN`。
4. **PresentBench 不提供全量生成 PPT。** HuggingFace 数据集公开了 238 个输入案例、指令和 judge checklist，但未包含每个系统的生成结果。项目页仓库只核验到一个 NotebookLM 完整演示（17 页 `slides.pdf`、逐项 judge YAML、汇总分 YAML）。
5. **许可证边界不对称。** SlideAudit 仓库声明整个数据集为 CC BY 4.0；PresentBench 代码为 Apache-2.0，但 HF 数据卡为 `license: other`，原始背景材料逐项继承来源条款，作者自制指令/checklist 仅在其权利范围内按 CC BY-NC 4.0 提供。PresentBench 不宜未经逐源审计就打包公开或用于商业再分发。

## 2. PresentBench（清华，2026-03）

### 2.1 已核验的一手来源

- [论文 HTML（arXiv 2603.07244）](https://arxiv.org/html/2603.07244)：核验数据规模、五个评价维度、逐项二元判断和聚合方法。
- [官方代码仓库固定提交](https://github.com/PresentBench/PresentBench/tree/e70ff01da962274e1e3cc03f77ec435ad66c5eb6)：核验下载脚本、PDF 转页图、judge 与 scoring 流程。该仓库本身不含 benchmark 数据目录。
- [HuggingFace 数据集固定修订](https://huggingface.co/datasets/PresentBench/PresentBench/tree/31ec40084405c5f2e6b8b5adedf2999b6060e7e1)：实际读取 `hf/metadata.json`、各 domain 公共 judge 配置、五份权重文件和候选案例 JSON/Markdown/PDF。
- [官方项目页](https://presentbench.github.io/)及[项目页仓库固定提交](https://github.com/PresentBench/PresentBench.github.io/tree/34718357045b63ddce246f5e4c2543f5d96e63ea)：核验唯一公开完整生成样例及其评分产物。

论文和实际 `hf/metadata.json` 均为 238 个 case，其中英语 219、中文 19；实际 domain 分布为 academia 91、advertising 16、economics 41、education 60、talk 30。逐条展开 `materials[]` 后共有 273 个输入材料文件：PDF 241、Markdown 31、JSON 1；一个 case 可以有多个材料。

### 2.2 真实目录和字段

HF 实际叶子目录如下；数据卡示例中的 `generation_prompt.md` 已过时，真实文件名是 `instructions.md`。

```text
<domain>/
├── common_judge_prompt.json
├── judge_weights.yaml
└── <source>/<case>/
    ├── material.pdf | material.md | material_N.*
    └── generation_task/
        ├── instructions.md
        ├── judge_prompt.json
        └── statistics.yaml
hf/metadata.json
```

实际读取的 [`hf/metadata.json`](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/hf/metadata.json) 每条包含：

- 标识和路径：`id`、`split`、`domain`、`source`、`case_name`、`case_path`；
- 材料：`materials[]`（内部有 `path/name/extension`）、`material_count`、`material_extensions`；
- 任务文件：`instructions_path`、`judge_prompt_path`、`statistics_path`；
- 统计：`category`、`total_input_tokens`、`generation_prompt_tokens`、`materials_total_tokens`、`pdf_total_pages`、`checklist_total_count`。

实例 `judge_prompt.json` 有两个数组：

- `material_dependent_checklist_1`：Content Completeness；
- `material_dependent_checklist_2`：Content Correctness。

domain 的 `common_judge_prompt.json` 提供通用判项和提示词，包括 Presentation Fundamentals、Visual Design and Layout，以及按输出页动态展开的 Content Fidelity。五个 domain 的 `judge_weights.yaml` 均把五个维度各设为 20%。论文报告每个 case 平均 54.1 个非动态 checklist；实际 judge 还会按每页增加 fidelity 判项。

### 2.3 原始标签语义与三态映射

| 来源语义 | 原始值 | 我们的建议映射 | 必须保留的边界 |
|---|---|---|---|
| PresentBench checklist | `yes` | `GOOD` | 只在该 criterion 被完整满足时成立 |
| PresentBench checklist | `no` | `BAD` | 缺失、错误或仅部分满足都属于 `no`，不是“不确定” |
| PresentBench 无此原始金标 | — | `UNCERTAIN` | 仅用于输入/渲染/证据不足或冲突；需记录原因，不参与与原始二元金标的直接准确率分母 |

PresentBench 的逐项 judge 结果实际为 `answer` 与 `explanation`；官网样例的汇总 YAML 另有 `yes_count`、`valid_count`、`not_applicable_count` 和各类百分比。虽然评分产物模式预留了 `not_applicable_count`，论文核心 checklist 与提示词仍以逐项 `yes/no` 为主，不能据此声称原始数据已有第三种不确定标签。

### 2.4 生成 PPT / 样本图资产位置

- HF 数据集树中未发现生成 `pptx`、生成 `slides.pdf`、逐页 PNG/JPG 或 `results/`；它提供的是输入材料与评测配置。
- 代码仓库 README 约定待评结果放在 `<RESULT_ROOT>/<case>/generation_task/results/slides.pdf`，这是运行时输入约定，不是仓库自带资产。
- 官网仓库公开了一个 NotebookLM 生成样例：
  - case：`academia/ICML_2025/ICML_2025_Accelerating_LLM_Inference_with_Lossless_Speculative_Decoding_Algorithms_for_Heterogeneous_Vocabularies_Oral_6bfb95`；
  - [17 页生成 slides.pdf](https://github.com/PresentBench/PresentBench.github.io/blob/34718357045b63ddce246f5e4c2543f5d96e63ea/demo/ICML_2025_Accelerating_LLM_Inference_with_Lossless_Speculative_Decoding_Algorithms_for_Heterogeneous_Vocabularies_Oral_6bfb95/generation_task/results/slides.pdf)（约 12.2 MB；可下载后用 PDF 渲染器逐页转 PNG）；
  - [逐项 judge 结果](https://github.com/PresentBench/PresentBench.github.io/blob/34718357045b63ddce246f5e4c2543f5d96e63ea/demo/ICML_2025_Accelerating_LLM_Inference_with_Lossless_Speculative_Decoding_Algorithms_for_Heterogeneous_Vocabularies_Oral_6bfb95/generation_task/results/gemini-3-flash-preview.yaml)；
  - [评分汇总](https://github.com/PresentBench/PresentBench.github.io/blob/34718357045b63ddce246f5e4c2543f5d96e63ea/demo/ICML_2025_Accelerating_LLM_Inference_with_Lossless_Speculative_Decoding_Algorithms_for_Heterogeneous_Vocabularies_Oral_6bfb95/generation_task/results/gemini-3-flash-preview_score.yaml)：42 个 yes / 71 个 valid，算术加权总分约 59.78%。

因此，下面候选 PresentBench 判项可以直接核验 criterion 与来源材料，但若要做“人类对官方生成结果”的背靠背演示，除官网这一例外，需要我们自己运行生成器或取得作者未公开的输出。

### 2.5 中文背靠背标注候选：5 个细粒度判项

说明：表中“原始 criterion”保留可检索的英文短锚点；完整原文以固定修订 JSON 的数组索引为准。第一轮应把官方 verdict 隐藏，只给标注者材料、指令、生成 PPT 和单个判项。

| 编号 | 层级 / 原维度 | 原始 case 与 criterion 定位 | 原始 criterion 短锚点 | 中文标注问题 | 证据要求与选择理由 |
|---|---|---|---|---|---|
| PB-01 | Slide/元素；Content Completeness | `talk/middle_school_presentation/03/generation_task/judge_prompt.json` → `material_dependent_checklist_1[5]`；[JSON](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/talk/middle_school_presentation/03/generation_task/judge_prompt.json)；[材料](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/talk/middle_school_presentation/03/material.md) | `Significance of Change` + `diagram` | “变革的意义”部分是否包含表达三个意义领域关系的图示？ | 需给页码并指出图示。对象明确、视觉可见，适合测试“有装饰图”和“有关系图”是否被混淆。缺失或只有文字为 BAD；图太糊无法识别为 UNCERTAIN。 |
| PB-02 | Slide/文本；Content Correctness | 同一 case → `material_dependent_checklist_2[3]`；[JSON](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/talk/middle_school_presentation/03/generation_task/judge_prompt.json) | `The only constant in life is change.` | 引言页的赫拉克利特引语是否逐字准确？ | 需抄录 PPT 中实际文本并给页码。判定边界窄，适合先测人工和模型对“轻微改写是否 BAD”的一致性。 |
| PB-03 | Deck/结构；Content Correctness | `talk/ted_chinese/10/generation_task/judge_prompt.json` → `material_dependent_checklist_2[2]`；[JSON](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/talk/ted_chinese/10/generation_task/judge_prompt.json)；[中文材料](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/talk/ted_chinese/10/material.md) | `three core questions` | 整套 PPT 是否保留原演讲的三个核心问题，并维持其逻辑关系：坏人为何也应获辩护、何为有效辩护、有效辩护最终惠及谁？ | 需列出对应页码和问题顺序。它能检验“Deck 级结构”而非单页美观，也能暴露合并、漏项和逻辑重排。该原始项一次检查三个子条件，严格说仍是复合项，后续正式 Rubric 应再拆。 |
| PB-04 | Deck/数据；Content Correctness | `economics/TESLA_update_letter/2019Q2/generation_task/judge_prompt.json` → `material_dependent_checklist_2[3]`；[JSON](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/economics/TESLA_update_letter/2019Q2/generation_task/judge_prompt.json)；[材料 PDF](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/economics/TESLA_update_letter/2019Q2/material.pdf) | `Cash Flow & Liquidity` | PPT 是否正确说明 50 亿美元现金余额的来源，包括 6.14 亿美元自由现金流和 24 亿美元股权/可转债净融资，并避免把增长全归因于经营？ | 需同时给 PPT 页码、材料页码/表格和数字。适合测试事实准确性与来源证据；任一数字/归因错或内容缺失均为 BAD。原始项还要求定量内容有清晰来源，因此它也是复合项。 |
| PB-05 | Slide/图片；Content Completeness | `education/THU_DSA/Lecture1/generation_task/judge_prompt.json` → `material_dependent_checklist_1[12]`；[JSON](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/education/THU_DSA/Lecture1/generation_task/judge_prompt.json)；[指令](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/education/THU_DSA/Lecture1/generation_task/instructions.md) | `Figure 1.1` + `own page` | “古埃及绳索计算机及其算法”图 1.1 是否有独立一页呈现？ | 需给独立页页码和图像位置。适合验证图片作为评分对象以及“存在图片”与“满足指定版面位置”两个条件；若图像被裁切但仍在独立页，原始 completeness 可为 GOOD，而图片质量判项应另判 BAD。 |

### 2.6 数据质量与适用性风险

- **轨道不完全一致：** PresentBench 本质是“材料/文档 → PPT”，不是无材料的 Query → PPT；它适合内容和结构校准，但不能直接代表 Query 题库表现。
- **所谓 checklist 并非都是真正原子项：** 多个 criterion 同时要求若干事实、顺序、来源引用或图表条件。正式 Rubric 若追求可解释三态，需要拆成更小子项，并保留到原始数组索引的 lineage。
- **维度重叠：** Content Correctness 的提示明确规定“内容缺失也判 no”，因此会与 Completeness 重叠。不能把五维分数当成统计独立变量。
- **指令存在模板残留：** 抽查 iPhone、Tesla、THU DSA 的 `instructions.md` 发现与主题无关的固定叙事措辞；官方 checklist 并不总能覆盖这些异常。Golden Set 应保存原始指令并单独标记此类污染。
- **静态输出经过 PDF 化：** 官方流程会把 PPTX 转为 PDF，且按最大页数截断；原始动画、讲者备注和超限页面不属于该评测面。

### 2.7 许可证与可再分发边界

- [代码仓库 LICENSE](https://github.com/PresentBench/PresentBench/blob/e70ff01da962274e1e3cc03f77ec435ad66c5eb6/LICENSE) 是 Apache-2.0，只覆盖代码，不自动覆盖 HF 背景材料。
- [HF 数据卡许可证段](https://huggingface.co/datasets/PresentBench/PresentBench/blob/31ec40084405c5f2e6b8b5adedf2999b6060e7e1/README.md#licensing-information)声明 `license: other`：背景材料继续受各原来源条款约束；作者自制指令和 checklist 在其持权范围内按 CC BY-NC 4.0 提供。
- **内部、非商业校准：** 可链接固定修订、记录 attribution，并只缓存所需少量案例。
- **公开或商业页面：** 不应直接打包这些 PDF、全文材料、生成 PPT 或大量缩略图；应逐 case 核验来源许可，优先深链官方资源。作者措辞中的“to the extent that we hold rights”意味着 CC BY-NC 也不是对所有嵌入内容的统一授权。

## 3. SlideAudit

### 3.1 已核验的一手来源与规模

- [论文 HTML（arXiv 2508.03630）](https://arxiv.org/html/2508.03630)：核验 taxonomy、数据构造、三人标注、多数决、强一致性和边界框规则。
- [官方仓库固定提交](https://github.com/zhuohaouw/SlideAudit/tree/642d490b7c1d2e78a50a631bfd359433397f3ecf)：实际读取 2,400 份 annotation JSON、2,400 份 description JSON、metadata CSV，并人工查看本节 8 张 PNG。
- 数据由 600 张原始单页和每张 3 个受控改动版本组成，共 2,400 张。论文 taxonomy 有 27 类、5 个上层维度；公开 evaluation annotation 文件实际包含 19 个静态可评缺陷，分布于 Composition & Layout 6、Typography 6、Color 3、Imagery & Visualizations 4。
- 实际 `data/metadata.csv` 有 2,400 行：`source_type` 为 `Gemini`、`Google`、`gdcdataset`，各 800；`alteration` 为 `nojitter`、`alignment`、`layout`、`texture`，各 600。这里记录的是仓库原值，不把 `texture` 擅自改名成论文中的 typography alteration。

### 3.2 真实目录、字段及 README 漂移

```text
data/
├── images/slide_XXXX.png
├── annotations/slide_XXXX.json
├── descriptions/slide_XXXX.json
└── metadata.csv
examples/alteration_example_{1,2,3}.jpg
LICENSE
README.md
CITATION.cff
```

README 写的是 `slide_XXXX.jpg` 和 `metadata/slideaudit_metadata.csv`，实际提交分别为 PNG 和 `data/metadata.csv`。README 还把 annotation 的 `slide_id` 示例写成字符串；实际 annotation JSON 是数字（如 `3`），description JSON 才是字符串（如 `slide_0003`）。接入时应以真实文件和固定提交为准，并对 ID 做显式规范化。

实际字段：

- annotation 顶层：`slide_id`（number）、`annotations[]`、`image_dimensions{width,height}`；
- 每个缺陷：`design_deficiency_category`、`design_deficiency`、`response`（boolean）、`has_strong_agreement`（boolean）、可选 `bounding_boxes[{x,y,width,height}]`；
- description 顶层：`slide_id`（string）、`elements[]`；每个元素有 `objectId`、`type`、`positionAndSize.normalized`，并按类型提供 `textContent` 或图片元数据；
- metadata：`id`、`source_type`、`alteration`、`image_width`、`image_height`。README 少写了 `alteration`，并把 `id` 写成了 `slide_id`。

论文描述每页由 3 名标注者判断。`response=true` 表示至少 2/3 认为该缺陷存在；`has_strong_agreement=true` 表示 3/3 一致。论文称只为 9 个可局部定位类别开放 bbox，且至少两人框重叠才保留；但本次遍历实际 JSON，发现 10 个不同 label 下至少出现过一个非空 `bounding_boxes`。这是论文与发布数据的一个可复现差异，接入时应按每条记录是否真的有 bbox 判断，不能硬编码“9 类”。论文报告总体 Fleiss' κ 为 0.26（fair），说明该数据适合做校准起点，不应直接视为无噪声真理。

### 3.3 原始标签语义与三态映射

| 原始字段组合 | 含义 | 对单个缺陷判项的建议映射 |
|---|---|---|
| `response=true` | 多数标注者认为缺陷存在 | `BAD`；证据给页号、缺陷名，若有 bbox 则给区域 |
| `response=false` | 未形成缺陷存在的多数票 | 只能说“该缺陷未检出”；在这个单一判项上可作为 GOOD 对照，不代表整页 GOOD |
| `has_strong_agreement=true` | 三人一致 | 是原始一致性元数据，不是置信度或准确率 |
| `has_strong_agreement=false` | 非三人一致 | 不自动映射 `UNCERTAIN`；仍可能是有效的 2/3 多数金标 |
| 我们新增 `UNCERTAIN` | 图片不可读、裁剪后缺失关键区域、判项定义不能覆盖、或证据真正冲突 | 单独记录原因，不篡改原 `response`；计算与原金标一致率时同时报告 uncertain rate |

### 3.4 中文背靠背标注候选：8 个单页缺陷

全部候选都实际读取了 annotation JSON 并人工查看 PNG。为减少首轮争议，主判项均选择 `response=true` 且 `has_strong_agreement=true`；SA-07 特意保留为多缺陷边界案例。图片可通过 raw 链接直接下载，annotation 链接可审计原标签；正式盲标时应先隐藏 annotation。

| 编号 | slide / 原始主标签 | 原始值 | 公开资产 | 中文观察与选择理由 |
|---|---|---|---|---|
| SA-01 | `slide_0001` — `Unbalanced Space Distribution`（空间分布失衡） | `response=true`；strong=true；无 bbox；唯一阳性标签 | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0001.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0001.json) | 内容集中在上半部，下半部大面积闲置。单标签、无需识字即可判断，适合作为版面空间分布的简单 BAD 锚点。 |
| SA-02 | `slide_0003` — `Improper Font Sizing`（字号使用不当） | true；strong=true；1 bbox；同页另有字形可读性、文本样式两项 strong 阳性 | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0003.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0003.json) | 字号层级和正文可读性明显异常，且有局部框。用于检验标注者是否能只回答“字号”而不把所有字体问题合并成一个判断。 |
| SA-03 | `slide_0004` — `Cluttered Layout`（布局拥挤） | true；strong=true；无 bbox；同页 Content Alignment Issues strong=true，Poor Visual Hierarchy strong=false | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0004.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0004.json) | 双栏文字和中心图示挤压，适合区分“拥挤”“对齐”“层级”三个相邻概念；也是原始标签非完全独立的实例。 |
| SA-04 | `slide_0011` — `Occluded Content`（内容被遮挡） | true；strong=true；3 bboxes；另有空间失衡 weak 阳性 | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0011.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0011.json) | Venn 图覆盖项目符号文字，局部证据明确。适合作为“对象遮挡文本”的低歧义底线 BAD 案例。 |
| SA-05 | `slide_0016` — `Content Overflow/Cut-off`（内容溢出/裁切） | true；strong=true；1 bbox；另有对齐、字号、文本层级 weak 阳性 | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0016.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0016.json) | 下方文字越过可用区域并被页脚裁切。用于校准“溢出/裁切”与“遮挡”的边界。 |
| SA-06 | `slide_0021` — `Insufficient Color Contrast for Readability`（可读性颜色对比不足） | true；strong=true；1 bbox；唯一阳性标签 | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0021.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0021.json) | 橙色标题置于蓝色背景，可读性差。单缺陷且有 bbox，适合颜色判项的简单 BAD 锚点。 |
| SA-07 | `slide_0048` — `Poor Image Quality/Editing`（图片质量/编辑不佳） | true；strong=true；无 bbox；同页另有视觉层级、空间失衡、遮挡 strong 阳性及文本层级 weak 阳性 | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0048.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0048.json) | 截图/视频画面压在标题和正文上，既有图片编辑问题又造成遮挡。特意作为“同一视觉现象可触发多个原子判项”的困难样本，不能用一个总的 BAD 代替逐项判断。 |
| SA-08 | `slide_0061` — `Excessive Text Volume`（文字量过多） | true；strong=true；无 bbox；唯一阳性标签 | [PNG](https://raw.githubusercontent.com/zhuohaouw/SlideAudit/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/images/slide_0061.png) / [annotation](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/data/annotations/slide_0061.json) | 四段长项目文字造成信息密度过高。用于讨论“文本多但可读”与“已过量”的人工边界，是预期分歧可能高于遮挡类的案例。 |

首轮可先用以上 8 个阳性缺陷测 BAD 召回；若要测 GOOD/BAD 的对称一致性，下一批必须为每个主标签补 `response=false` 的匹配对照页，且不能把“该缺陷 absent”包装成“整页 GOOD”。

### 3.5 许可证与可再分发边界

- [仓库 LICENSE](https://github.com/zhuohaouw/SlideAudit/blob/642d490b7c1d2e78a50a631bfd359433397f3ecf/LICENSE)声明数据集为 CC BY 4.0，可共享和改编，也允许商业使用，但必须正确署名、链接许可证并说明修改。
- 用于内部标注演示时，可以缓存上述少量 PNG/JSON，并在记录中保留数据集、论文、作者和固定提交。
- 用于公开网页或仓库时，CC BY 4.0 要求仍然适用；同时图片可能含第三方品牌、人物或原演示内容。仓库许可证并不能自动清除商标、肖像、隐私或第三方素材风险。稳妥做法是优先使用官方 raw 深链或少量带 attribution 的缩略图，不批量复制整个数据集。

## 4. 建议的背靠背演示协议（非正式规格）

1. **PresentBench 批次：** 每题只展示背景材料、生成 PPT、中文 criterion；标注者提交 `GOOD / BAD / UNCERTAIN`、PPT 页码、材料页码、证据和理由。官方 yes/no 在提交前隐藏。
2. **SlideAudit 批次：** 每题只展示 PNG 和一个中文缺陷判项；提交三态、问题区域和理由。原始 `response`、agreement、bbox 在提交前隐藏。
3. **对齐方式：** PresentBench 在可判样本上比较 `GOOD↔yes`、`BAD↔no`；SlideAudit 对单个缺陷比较 `BAD↔present`、`GOOD↔absent`。`UNCERTAIN` 单独报告比例和原因，不强行算成错误，也不能从金标反推。
4. **先看原子项，不先算总分：** 分别报告每个 criterion 的一致/分歧、分歧证据和人工边界；样本量扩展后再决定维度聚合。SlideAudit 的多标签页和 PresentBench 的复合 checklist 应在分析中显式标记。

## 5. 下载、资产与许可证阻塞

- **PresentBench 生成资产阻塞：** HF 没有全量生成 PPT/逐页图；只有官网一个完整输出样例。要展示本文其余 5 个 criterion 的实际 GOOD/BAD 页面，仍需自行生成、取得作者输出，或另行制作可授权的对照样本。
- **PresentBench 再分发阻塞：** 背景材料没有统一可再分发许可，且作者 rubric 是非商业许可。未逐源审计前，不建议把原 PDF/Markdown/PPT 复制进产品前端、公开仓库或商业报告附件。
- **SlideAudit 下载状态：** GitHub 大归档下载曾中断；本次仍成功实际读取全量 2,400 annotation、2,400 description、完整 metadata，并逐文件取得/查看了所选 8 张 PNG。若后续离线演示需要全量图片，应使用可校验哈希的断点续传或逐文件下载，而不是把本次不完整归档当成已交付资产。
- **SlideAudit 权利提醒：** 数据集层面为 CC BY 4.0，但公开再分发仍应保留 attribution，并对页面中的第三方内容作额外风险检查。

## 6. 本审计不做出的结论

- 不把 PresentBench 或 SlideAudit 直接定为本项目正式 Golden Set；
- 不据此冻结五维/八维框架、聚合权重或市场排名；
- 不把 agreement 当成模型置信度或事实准确率；
- 不把 `response=false` 当成整页优质，也不把 PresentBench `no` 当成 `UNCERTAIN`；
- 不声称已取得未公开的生成 PPT、全量可再分发许可或人工背靠背结果。
