import { presentBenchThumbnails } from "./presentbench-thumbnails.js";

const PRESENTBENCH_SITE_REVISION = "34718357045b63ddce246f5e4c2543f5d96e63ea";
const SLIDE_AUDIT_REVISION = "642d490b7c1d2e78a50a631bfd359433397f3ecf";
const PRESENTBENCH_DEMO = `https://raw.githubusercontent.com/PresentBench/PresentBench.github.io/${PRESENTBENCH_SITE_REVISION}/demo/ICML_2025_Accelerating_LLM_Inference_with_Lossless_Speculative_Decoding_Algorithms_for_Heterogeneous_Vocabularies_Oral_6bfb95/generation_task/results/slides.pdf`;
const PRESENTBENCH_RESULT = `https://raw.githubusercontent.com/PresentBench/PresentBench.github.io/${PRESENTBENCH_SITE_REVISION}/demo/ICML_2025_Accelerating_LLM_Inference_with_Lossless_Speculative_Decoding_Algorithms_for_Heterogeneous_Vocabularies_Oral_6bfb95/generation_task/results/gemini-3-flash-preview.yaml`;
const SLIDE_AUDIT_ASSET_ROOT = "./assets/slide-audit";
const SLIDE_AUDIT_ANNOTATIONS = `https://github.com/zhuohaouw/SlideAudit/blob/${SLIDE_AUDIT_REVISION}/data/annotations`;

const slideAuditTaxonomy = [
  {
    category: "构图与版式",
    original: "Composition & Layout",
    criteria: [
      ["视觉层级不清", "Poor Visual Hierarchy"],
      ["布局拥挤", "Cluttered Layout"],
      ["空间分布失衡", "Unbalanced Space Distribution"],
      ["内容对齐问题", "Content Alignment Issues"],
      ["内容溢出或裁切", "Content Overflow/Cut-off"],
      ["内容被遮挡", "Occluded Content"],
    ],
  },
  {
    category: "文字排版",
    original: "Typography",
    criteria: [
      ["字形选择或使用难以辨认", "Illegible Typeface Selection or Usage"],
      ["字号使用不当", "Improper Font Sizing"],
      ["文字量过多", "Excessive Text Volume"],
      ["文本样式使用不当", "Improper Text Styling"],
      ["行距或字距不当", "Improper Line/Character Spacing"],
      ["文本层级不清", "Poor Text Hierarchy"],
    ],
  },
  {
    category: "色彩",
    original: "Color",
    criteria: [
      ["可读性对比不足", "Insufficient Color Contrast for Readability"],
      ["颜色过多或使用不一致", "Excessive or Inconsistent Color Usage"],
      ["配色不当或不匹配", "Inappropriate or Mismatched Color Combinations"],
    ],
  },
  {
    category: "图片与可视化",
    original: "Imagery & Visualizations",
    criteria: [
      ["视觉内容与表达无关", "Irrelevant Visual Content"],
      ["图片质量或编辑不佳", "Poor Image Quality/Editing"],
      ["图片尺寸不当", "Improper Image Sizing"],
      ["视觉风格使用不一致", "Inconsistent Visual Style Usage"],
    ],
  },
];

const cases = [
  {
    id: "PB-DECK-LOGIC",
    source: "PresentBench",
    sourceType: "任务/内容判项",
    axis: "内容结构",
    level: "整套 PPT",
    objectLabel: "17 页学术报告 Deck",
    title: "逻辑推进是否自然？",
    atomic: "从背景与问题，推进到方法、实验、分析和结论；没有打断理解的跳跃或倒序。",
    original: "Logical Flow",
    originalRule: "Does the slide deck follow a logical progression from one point to the next?",
    sourceLabel: "GOOD",
    sourceReason: "原评审认为 1–2 页开场、3–4 页背景与问题、5–9 页方法、10–14 页实验与分析、15–17 页结论，形成 Why → What → How well → So what 的连续推进。",
    evidencePages: [1, 3, 5, 10, 15, 17],
    media: { type: "pdf", url: PRESENTBENCH_DEMO, thumbnailPage: 1 },
    sourceUrl: PRESENTBENCH_RESULT,
    agreement: "official judge result",
  },
  {
    id: "PB-DECK-CONSISTENCY",
    source: "PresentBench",
    sourceType: "视觉判项",
    axis: "视觉一致性",
    level: "整套 PPT",
    objectLabel: "17 页学术报告 Deck",
    title: "跨页设计是否一致？",
    atomic: "字体角色、配色语义、内容页框架与图形风格在整套中保持一致；允许封面做有目的的变化。",
    original: "Design Consistency",
    originalRule: "Is the design consistent across all slides (e.g., font, colors, layout)?",
    sourceLabel: "GOOD",
    sourceReason: "原评审指出标题与正文的字体角色、蓝/橙/灰配色语义、页眉分隔线和右下角标识在 17 页中持续一致；封面的差异被视为有目的。",
    evidencePages: [1, 3, 6, 11, 15, 17],
    media: { type: "pdf", url: PRESENTBENCH_DEMO, thumbnailPage: 6 },
    sourceUrl: PRESENTBENCH_RESULT,
    agreement: "official judge result",
  },
  {
    id: "PB-DECK-CHART-ANNOTATION",
    source: "PresentBench",
    sourceType: "视觉判项",
    axis: "信息表达",
    level: "整套 PPT → 单页 → 图表",
    objectLabel: "结果图表页",
    title: "图表标注是否足以独立读懂？",
    atomic: "图表的轴、类别与数值含义有明确标签，读者不必只靠上下文猜测。",
    original: "Chart Annotation",
    originalRule: "Are all charts clearly annotated with axis labels and meaningful descriptions?",
    sourceLabel: "BAD",
    sourceReason: "原评审认为第 11、12 页条形图缺少纵轴含义标题，第 14 页底部图缺少横轴 Overlap Ratio 标签且类别轴无标题；第 9 页则是合格对照。",
    evidencePages: [11, 12, 14, 9],
    media: { type: "pdf", url: PRESENTBENCH_DEMO, thumbnailPage: 11 },
    sourceUrl: PRESENTBENCH_RESULT,
    agreement: "official judge result",
  },
  {
    id: "PB-CONTENT-LOSSLESS-LOGIC",
    source: "PresentBench",
    sourceType: "材料依赖判项",
    axis: "事实与论证",
    level: "整套 PPT → 单页 → 论证单元",
    objectLabel: "方法论证页",
    title: "“无损”结论是否给出足够数学逻辑？",
    atomic: "不仅声称算法无损，还展示公式与输出分布保持一致之间的推导或关键桥梁。",
    original: "Mathematical Lossless Logic",
    originalRule: "Does the deck present the mathematical logic ensuring the algorithms are lossless?",
    sourceLabel: "BAD",
    sourceReason: "原评审认为第 6–8 页引用定理并给出部分公式，却没有展示这些公式为何保证目标分布不变的关键推导；这是需要论文材料才能判断的判项。",
    evidencePages: [6, 7, 8],
    media: { type: "pdf", url: PRESENTBENCH_DEMO, thumbnailPage: 6 },
    sourceUrl: PRESENTBENCH_RESULT,
    agreement: "official judge result",
  },
  {
    id: "SA-0002-IMAGE-QUALITY",
    source: "SlideAudit",
    sourceType: "视觉缺陷标注",
    axis: "图片质量",
    level: "单页 → 图片元素",
    objectLabel: "slide_0002",
    title: "图片质量与编辑是否合格？",
    atomic: "图片清晰、裁切完整、没有明显低分辨率或粗糙编辑痕迹。",
    original: "Poor Image Quality/Editing",
    originalRule: "Is poor image quality or editing present?",
    sourceLabel: "GOOD",
    sourceReason: "原数据对“Poor Image Quality/Editing”的 response 为 false，且 has_strong_agreement 为 true；即标注者一致认为该缺陷不存在。",
    evidencePages: [1],
    media: { type: "image", url: `${SLIDE_AUDIT_ASSET_ROOT}/slide_0002.png`, width: 1600, height: 900 },
    sourceUrl: "https://github.com/zhuohaouw/SlideAudit",
    agreement: "strong agreement",
    anchors: {
      good: "图片主体清晰，比例与关键内容完整，没有明显像素化、拉伸、粗糙抠图或破坏理解的裁切。",
      bad: "出现明显模糊、像素化、变形、关键区域被裁掉，或拼贴/编辑痕迹妨碍理解。",
      uncertain: "原图未完整加载、展示端二次压缩明显，或关键图片区域不可见。",
      excludes: "不评价图片是否切题、图片大小、页面配色或整体版式；这些属于其他判项。",
    },
    raw: { sourceType: "Gemini", alteration: "texture", imageSize: "1600 × 900", response: false, strong: true, bboxCount: 0, annotationUrl: `${SLIDE_AUDIT_ANNOTATIONS}/slide_0002.json` },
  },
  {
    id: "SA-0003-FONT-SIZE",
    source: "SlideAudit",
    sourceType: "视觉缺陷标注",
    axis: "字体可读性",
    level: "单页 → 文本框",
    objectLabel: "slide_0003",
    title: "正文/标签字号是否合适？",
    atomic: "在常规演示观看距离下，所有承担信息的文本都有足够字号，不出现局部过小。",
    original: "Improper Font Sizing",
    originalRule: "Is improper font sizing present?",
    sourceLabel: "BAD",
    sourceReason: "原数据 response 为 true 且 strong agreement；证据框位于右下方较小的列表项。",
    evidencePages: [1],
    media: { type: "image", url: `${SLIDE_AUDIT_ASSET_ROOT}/slide_0003.png`, width: 1600, height: 900, boxes: [{ x: 61.3, y: 60.8, w: 21.5, h: 19.0 }] },
    sourceUrl: "https://github.com/zhuohaouw/SlideAudit",
    agreement: "strong agreement",
    anchors: {
      good: "标题、正文和标签在演示画面中均可直接辨认，较小文字仍承担得起其信息角色。",
      bad: "一个或多个承担信息的文本明显小于同层文字，必须放大或靠猜测才能阅读。",
      uncertain: "截图分辨率不足、页面缩放异常，或无法确认原始画布尺寸。",
      excludes: "不评价字形风格、粗体/斜体使用、文字量或文本层级。",
    },
    raw: { sourceType: "Gemini", alteration: "texture", imageSize: "1600 × 900", response: true, strong: true, bboxCount: 1, annotationUrl: `${SLIDE_AUDIT_ANNOTATIONS}/slide_0003.json` },
  },
  {
    id: "SA-0011-OCCLUSION",
    source: "SlideAudit",
    sourceType: "视觉缺陷标注",
    axis: "版式可读性",
    level: "单页 → 图文元素",
    objectLabel: "slide_0011",
    title: "内容之间是否没有互相遮挡？",
    atomic: "图表、文本和装饰元素不遮住其他信息，不需要读者猜测被覆盖内容。",
    original: "Occluded Content",
    originalRule: "Is occluded content present?",
    sourceLabel: "BAD",
    sourceReason: "原数据 response 为 true 且 strong agreement；中心气泡图遮挡左侧项目文字。",
    evidencePages: [1],
    media: { type: "image", url: `${SLIDE_AUDIT_ASSET_ROOT}/slide_0011.png`, width: 960, height: 720, boxes: [{ x: 5.7, y: 42.4, w: 45.2, h: 23.3 }, { x: 25.8, y: 39.4, w: 47.5, h: 57.5 }, { x: 30.2, y: 41.5, w: 20.1, h: 8.0 }] },
    sourceUrl: "https://github.com/zhuohaouw/SlideAudit",
    agreement: "strong agreement",
    anchors: {
      good: "文字、图表、图片和装饰元素之间没有覆盖有意义的信息，所有内容可完整识别。",
      bad: "任一元素覆盖文字、数据或图形关键部分，使信息不可读或需要猜测。",
      uncertain: "无法判断重叠是否是有意遮罩，或截图缺少判断所需的完整元素边界。",
      excludes: "不评价元素仅仅靠得太近、对齐不齐或空间分布失衡。",
    },
    raw: { sourceType: "gdcdataset", alteration: "alignment", imageSize: "960 × 720", response: true, strong: true, bboxCount: 3, annotationUrl: `${SLIDE_AUDIT_ANNOTATIONS}/slide_0011.json` },
  },
  {
    id: "SA-0016-CUTOFF",
    source: "SlideAudit",
    sourceType: "视觉缺陷标注",
    axis: "版式可读性",
    level: "单页 → 文本框",
    objectLabel: "slide_0016",
    title: "内容是否完整落在可见画布内？",
    atomic: "正文、图片和图表不越出页面边界，也不被页脚或其他容器裁掉。",
    original: "Content Overflow/Cut-off",
    originalRule: "Is content overflow or cut-off present?",
    sourceLabel: "BAD",
    sourceReason: "原数据 response 为 true 且 strong agreement；左下方大号正文越出画布并被蓝色页脚带遮挡。",
    evidencePages: [1],
    media: { type: "image", url: `${SLIDE_AUDIT_ASSET_ROOT}/slide_0016.png`, width: 1600, height: 900, boxes: [{ x: 5.7, y: 52.2, w: 47.7, h: 46.6 }] },
    sourceUrl: "https://github.com/zhuohaouw/SlideAudit",
    agreement: "strong agreement",
    anchors: {
      good: "所有承担信息的文字和图形都完整落在画布及所属容器内，页脚不截断正文。",
      bad: "文字或图形越出画布/容器，或被页脚、边界直接裁掉。",
      uncertain: "输入截图本身可能被外部裁切，无法区分原 PPT 缺陷与采集缺陷。",
      excludes: "允许不损失语义的背景出血；元素互相覆盖属于“内容被遮挡”判项。",
    },
    raw: { sourceType: "Google", alteration: "texture", imageSize: "1600 × 900", response: true, strong: true, bboxCount: 1, annotationUrl: `${SLIDE_AUDIT_ANNOTATIONS}/slide_0016.json` },
  },
  {
    id: "SA-0021-CONTRAST",
    source: "SlideAudit",
    sourceType: "视觉缺陷标注",
    axis: "色彩可读性",
    level: "单页 → 标题文本",
    objectLabel: "slide_0021",
    title: "文字与背景对比度是否足够？",
    atomic: "重要文字在其实际背景上清晰可辨，不依赖放大或高亮才能阅读。",
    original: "Insufficient Color Contrast for Readability",
    originalRule: "Is insufficient color contrast for readability present?",
    sourceLabel: "BAD",
    sourceReason: "原数据 response 为 true 且 strong agreement；橙色标题落在复杂深色渐变背景上，局部对比不足。",
    evidencePages: [1],
    media: { type: "image", url: `${SLIDE_AUDIT_ASSET_ROOT}/slide_0021.png`, width: 1600, height: 1200, boxes: [{ x: 28.0, y: 9.5, w: 64.0, h: 16.2 }] },
    sourceUrl: "https://github.com/zhuohaouw/SlideAudit",
    agreement: "strong agreement",
    anchors: {
      good: "重要文字与其实际背景能清楚分离，不依赖放大、高亮或猜测即可阅读。",
      bad: "前景与背景亮度或颜色过近，导致标题、正文或数据标签难以辨认。",
      uncertain: "显示设备、色彩配置或透明遮罩疑似改变了原始对比度。",
      excludes: "不评价配色审美、颜色数量或跨页色彩一致性。",
    },
    raw: { sourceType: "gdcdataset", alteration: "texture", imageSize: "1600 × 1200", response: true, strong: true, bboxCount: 1, annotationUrl: `${SLIDE_AUDIT_ANNOTATIONS}/slide_0021.json` },
  },
  {
    id: "SA-0061-TEXT-VOLUME",
    source: "SlideAudit",
    sourceType: "视觉缺陷标注",
    axis: "信息密度",
    level: "单页 → 文本内容区",
    objectLabel: "slide_0061",
    title: "单页文字量是否不过度？",
    atomic: "页面文字量适合演示阅读，观众无需在讲者推进时阅读大段密集正文。",
    original: "Excessive Text Volume",
    originalRule: "Is excessive text volume present?",
    sourceLabel: "BAD",
    sourceReason: "原数据 response 为 true 且 strong agreement；页面由四段长句主导，单位时间阅读负担高。",
    evidencePages: [1],
    media: { type: "image", url: `${SLIDE_AUDIT_ASSET_ROOT}/slide_0061.png`, width: 1600, height: 1200 },
    sourceUrl: "https://github.com/zhuohaouw/SlideAudit",
    agreement: "strong agreement",
    anchors: {
      good: "在演示节奏下可快速扫描，文字承担提炼后的要点，而不是要求观众同步阅读大段正文。",
      bad: "长句或段落主导页面，观众必须持续阅读才能获取主要信息。",
      uncertain: "不知道页面是现场演示还是专供自读，且两种模式会改变合理密度。",
      excludes: "不评价字号、行距、字形或视觉层级；它们应由相邻判项分别判断。",
    },
    raw: { sourceType: "gdcdataset", alteration: "nojitter", imageSize: "1600 × 1200", response: true, strong: true, bboxCount: 0, annotationUrl: `${SLIDE_AUDIT_ANNOTATIONS}/slide_0061.json` },
  },
];

const variants = [
  { id: "A", name: "逐题盲标", note: "一题一屏，先判断再揭晓" },
  { id: "B", name: "证据对照", note: "样例和判项并排查看" },
  { id: "C", name: "题库审计", note: "一次检查层级、标签与分歧" },
];

const state = {
  index: 0,
  answers: new Map(),
  revealed: new Set(),
  filter: "ALL",
};

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

function currentVariant() {
  const value = new URLSearchParams(location.search).get("variant")?.toUpperCase();
  return variants.some((item) => item.id === value) ? value : "A";
}

function filteredCases() {
  return state.filter === "ALL" ? cases : cases.filter((item) => item.source === state.filter);
}

function metrics() {
  const answered = [...state.answers.entries()];
  const determinate = answered.filter(([, label]) => label !== "UNCERTAIN");
  const diff = determinate.filter(([id, label]) => cases.find((item) => item.id === id)?.sourceLabel !== label);
  return {
    answered: answered.length,
    determinate: determinate.length,
    matched: determinate.length - diff.length,
    uncertain: answered.filter(([, label]) => label === "UNCERTAIN").length,
    diffRate: determinate.length ? Math.round((diff.length / determinate.length) * 100) : 0,
  };
}

function media(caseItem, compact = false) {
  if (caseItem.media.type === "pdf") {
    const page = caseItem.media.thumbnailPage;
    return `<div class="pdf-frame ${compact ? "compact" : ""}">
      <div class="pdf-preview"><img src="${presentBenchThumbnails[page]}" alt="PresentBench 公开 demo 第 ${page} 页" /><span>当前预览 · 第 ${page} 页</span></div>
      <div class="page-strip">${caseItem.evidencePages.map((number) => `<a href="${caseItem.media.url}#page=${number}" target="_blank" rel="noreferrer">证据页 ${number} ↗</a>`).join("")}</div>
      <a class="source-link" href="${caseItem.media.url}" target="_blank" rel="noreferrer">新窗口打开完整 17 页 Deck ↗</a>
    </div>`;
  }

  const boxes = (caseItem.media.boxes ?? []).map((box) => `<span class="evidence-box" style="left:${box.x}%;top:${box.y}%;width:${box.w}%;height:${box.h}%"></span>`).join("");
  return `<div class="image-frame ${compact ? "compact" : ""}" data-image-state="loading">
    <img src="${caseItem.media.url}" alt="${escapeHtml(caseItem.objectLabel)}" width="${caseItem.media.width}" height="${caseItem.media.height}" decoding="async" data-case-image />
    <div class="image-fallback" role="status"><b>样例图片加载失败</b><span>请刷新页面；仍失败时可打开官方来源核对。</span></div>
    ${boxes}
  </div>`;
}

function hierarchy(caseItem) {
  return `<div class="hierarchy" aria-label="判项层级">
    <span>${escapeHtml(caseItem.source)}</span><i>›</i><span>${escapeHtml(caseItem.axis)}</span><i>›</i><strong>${escapeHtml(caseItem.level)}</strong>
  </div>`;
}

function answerControls(caseItem) {
  const answer = state.answers.get(caseItem.id);
  return `<div class="answer-block">
    <div class="answer-heading"><span>你的判断</span><small>只判断这一条原子判项</small></div>
    <div class="answer-buttons" role="group" aria-label="你的判断">
      ${[["GOOD", "好"], ["BAD", "不好"], ["UNCERTAIN", "不确定"]].map(([value, label]) => `<button type="button" data-answer="${value}" class="${answer === value ? "selected" : ""}"><b>${label}</b><span>${value}</span></button>`).join("")}
    </div>
  </div>`;
}

function rubricCard(caseItem) {
  if (!caseItem.anchors) return "";
  return `<section class="rubric-card">
    <div class="rubric-title"><div><span>从 SlideAudit 蒸馏的三态标准</span><b>${escapeHtml(caseItem.original)}</b></div><em>只判断一个缺陷，不给整页总评</em></div>
    <div class="anchor-grid">
      <article class="anchor-good"><span>GOOD 锚点</span><p>${escapeHtml(caseItem.anchors.good)}</p></article>
      <article class="anchor-bad"><span>BAD 锚点</span><p>${escapeHtml(caseItem.anchors.bad)}</p></article>
      <article class="anchor-uncertain"><span>UNCERTAIN 条件</span><p>${escapeHtml(caseItem.anchors.uncertain)}</p></article>
      <article class="anchor-excludes"><span>本项不评价</span><p>${escapeHtml(caseItem.anchors.excludes)}</p></article>
    </div>
  </section>`;
}

function reconstructedScene(caseItem) {
  if (!caseItem.raw) return "";
  const detected = caseItem.raw.response;
  const voteLabel = detected ? "检出缺陷" : "未检出缺陷";
  const voteClass = detected ? "vote-bad" : "vote-good";
  return `<section class="annotation-scene">
    <div class="scene-title"><div><span>原始打分现场 · 按公开数据还原</span><b>${escapeHtml(caseItem.objectLabel)} / ${escapeHtml(caseItem.original)}</b></div><em>不是作者原标注工具截图</em></div>
    <div class="scene-flow">
      <article><span>① 输入样本</span><b>${escapeHtml(caseItem.raw.sourceType)}</b><small>${escapeHtml(caseItem.raw.alteration)} · ${escapeHtml(caseItem.raw.imageSize)}</small></article>
      <i>→</i>
      <article><span>② 单缺陷提问</span><b>${escapeHtml(caseItem.original)}</b><small>${caseItem.raw.bboxCount} 个公开证据框</small></article>
      <i>→</i>
      <article><span>③ 三人投票</span><div class="votes ${voteClass}"><b>A</b><b>B</b><b>C</b></div><small>三人均${voteLabel}</small></article>
      <i>→</i>
      <article><span>④ 多数聚合</span><b>response: ${caseItem.raw.response}</b><small>strong agreement: ${caseItem.raw.strong}</small></article>
      <i>→</i>
      <article><span>⑤ 本项目映射</span><b class="mapped-${caseItem.sourceLabel.toLowerCase()}">${caseItem.sourceLabel}</b><small>${detected ? "缺陷存在 → BAD" : "缺陷未检出 → GOOD"}</small></article>
    </div>
    <p class="scene-caveat">三人同票可由 <code>response</code> 与 <code>has_strong_agreement=true</code> 唯一反推；原数据未公开标注者身份和当时界面。该票只针对当前缺陷，不能推导整页整体质量。</p>
    <a href="${caseItem.raw.annotationUrl}" target="_blank" rel="noreferrer">查看固定版本 annotation JSON ↗</a>
  </section>`;
}

function taxonomyMap() {
  const sampled = new Set(cases.filter((item) => item.source === "SlideAudit").map((item) => item.original));
  return `<section class="taxonomy-map">
    <div class="taxonomy-heading"><div><span>SlideAudit 标准蒸馏</span><h3>4 类 · 19 个静态视觉缺陷</h3></div><p>绿色圆点表示首批盲标已抽样。这里保留缺陷级语义，暂不把 19 项直接压成一个美学总分。</p></div>
    <div class="taxonomy-grid">${slideAuditTaxonomy.map((group) => `<article><header><b>${group.category}</b><span>${group.original}</span></header><ul>${group.criteria.map(([label, original]) => `<li class="${sampled.has(original) ? "sampled" : ""}"><i></i><span>${label}<small>${original}</small></span></li>`).join("")}</ul></article>`).join("")}</div>
  </section>`;
}

function sourceResult(caseItem, always = false) {
  const revealed = always || state.revealed.has(caseItem.id);
  if (!revealed) {
    return `<div class="source-result locked"><div><b>原始标注已隐藏</b><span>先提交你的判断，减少锚定影响</span></div><button type="button" data-reveal="${caseItem.id}">揭晓原标注</button></div>`;
  }
  const answer = state.answers.get(caseItem.id);
  const comparison = !answer ? "尚未作答" : answer === "UNCERTAIN" ? "不确定：不计入 Good/Bad 差异率" : answer === caseItem.sourceLabel ? "与原标注一致" : "与原标注不同";
  return `<div class="source-result revealed ${caseItem.sourceLabel.toLowerCase()}">
    <div class="source-label"><span>来源标注</span><b>${caseItem.sourceLabel}</b><em>${escapeHtml(comparison)}</em></div>
    <p>${escapeHtml(caseItem.sourceReason)}</p>
    <details><summary>查看英文原判项与来源</summary><p><b>${escapeHtml(caseItem.original)}</b><br />${escapeHtml(caseItem.originalRule)}</p><a href="${caseItem.sourceUrl}" target="_blank" rel="noreferrer">打开官方来源 ↗</a></details>
  </div>${always ? "" : reconstructedScene(caseItem)}`;
}

function caseMeta(caseItem) {
  return `<div class="case-meta"><span>${escapeHtml(caseItem.id)}</span><span>${escapeHtml(caseItem.sourceType)}</span><span>${escapeHtml(caseItem.agreement)}</span></div>`;
}

function renderVariantA() {
  const pool = filteredCases();
  if (state.index >= pool.length) state.index = 0;
  const caseItem = pool[state.index];
  return `<main class="focus-layout">
    <section class="focus-media">${media(caseItem)}</section>
    <section class="judge-panel">
      ${caseMeta(caseItem)}
      ${hierarchy(caseItem)}
      <div class="criterion"><span>原子判项</span><h2>${escapeHtml(caseItem.title)}</h2><p>${escapeHtml(caseItem.atomic)}</p></div>
      ${rubricCard(caseItem)}
      ${answerControls(caseItem)}
      ${sourceResult(caseItem)}
      <nav class="case-nav"><button type="button" data-prev>← 上一题</button><span>${state.index + 1} / ${pool.length}</span><button type="button" data-next>下一题 →</button></nav>
    </section>
  </main>`;
}

function renderVariantB() {
  const pool = filteredCases();
  if (state.index >= pool.length) state.index = 0;
  const caseItem = pool[state.index];
  return `<main class="compare-layout">
    <aside class="case-rail">${pool.map((item, index) => `<button type="button" data-case-index="${index}" class="${index === state.index ? "active" : ""}"><span>${escapeHtml(item.axis)}</span><b>${escapeHtml(item.title)}</b><em>${state.answers.get(item.id) ?? "未标"}</em></button>`).join("")}</aside>
    <section class="compare-media">${media(caseItem)}</section>
    <section class="compare-panel">${caseMeta(caseItem)}${hierarchy(caseItem)}<h2>${escapeHtml(caseItem.title)}</h2><p class="atomic">${escapeHtml(caseItem.atomic)}</p>${rubricCard(caseItem)}${answerControls(caseItem)}${sourceResult(caseItem)}</section>
  </main>`;
}

function renderVariantC() {
  const pool = filteredCases();
  return `<main class="audit-layout">
    <section class="audit-intro"><div><span>层级审计视图</span><h2>先看测试集质量，再决定 Rubric</h2></div><p>每行只对应一个原子判项。对象层级、证据范围和来源标签分开显示，避免把“整套适用性”和“单个元素缺陷”混为一项。</p></section>
    ${state.filter !== "PresentBench" ? taxonomyMap() : ""}
    <section class="audit-table">
      <div class="audit-row audit-head"><span>样例</span><span>层级 / 原子判项</span><span>你的判断</span><span>原始结果</span></div>
      ${pool.map((item, index) => `<article class="audit-row">
        <div class="audit-thumb" data-open-case="${index}">${media(item, true)}<small>${escapeHtml(item.id)}</small></div>
        <div>${hierarchy(item)}<h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.atomic)}</p></div>
        <div class="mini-answers">${[["GOOD", "好"], ["BAD", "不好"], ["UNCERTAIN", "不确定"]].map(([value, label]) => `<button type="button" data-row-answer="${item.id}:${value}" class="${state.answers.get(item.id) === value ? "selected" : ""}">${label}</button>`).join("")}</div>
        <div>${sourceResult(item, true)}</div>
      </article>`).join("")}
    </section>
  </main>`;
}

function header() {
  const value = metrics();
  return `<header class="topbar">
    <div class="brand"><span>PROTOTYPE · 一次性 Rubric 验证工具</span><h1>Golden Set 中文盲标</h1></div>
    <div class="filters"><button type="button" data-filter="ALL" class="${state.filter === "ALL" ? "active" : ""}">全部 10</button><button type="button" data-filter="PresentBench" class="${state.filter === "PresentBench" ? "active" : ""}">PresentBench 4</button><button type="button" data-filter="SlideAudit" class="${state.filter === "SlideAudit" ? "active" : ""}">SlideAudit 6</button></div>
    <div class="metrics"><div><b>${value.answered}</b><span>已标</span></div><div><b>${value.uncertain}</b><span>不确定</span></div><div><b>${value.diffRate}%</b><span>Good/Bad 差异率</span></div></div>
  </header>`;
}

function switcher(variant) {
  return `<div class="variant-switcher" aria-label="原型版本切换"><button type="button" data-variant-prev aria-label="上一种布局">←</button>${variants.map((item) => `<button type="button" data-variant="${item.id}" class="${variant === item.id ? "active" : ""}"><b>${item.id} · ${item.name}</b><span>${item.note}</span></button>`).join("")}<button type="button" data-variant-next aria-label="下一种布局">→</button></div>`;
}

function render() {
  const variant = currentVariant();
  document.body.dataset.variant = variant;
  const content = variant === "A" ? renderVariantA() : variant === "B" ? renderVariantB() : renderVariantC();
  document.querySelector("#app").innerHTML = `${header()}<div class="scope-notice"><b>适用性边界</b><span>PresentBench 是文档→PPT，只校准 Deck/内容判项方法；SlideAudit 只校准单页静态视觉缺陷。它们都不是 Query→PPT 的完整 Golden Set。</span></div>${content}${switcher(variant)}`;
  bind();
}

function renderAtTop() {
  render();
  window.scrollTo(0, 0);
}

function setVariant(id) {
  const url = new URL(location.href);
  url.searchParams.set("variant", id);
  history.replaceState({}, "", url);
  renderAtTop();
}

function stepVariant(direction) {
  const index = variants.findIndex((item) => item.id === currentVariant());
  setVariant(variants[(index + direction + variants.length) % variants.length].id);
}

function bind() {
  document.querySelectorAll("[data-case-image]").forEach((image) => {
    const frame = image.closest(".image-frame");
    const updateState = () => { frame.dataset.imageState = image.naturalWidth > 0 ? "loaded" : "error"; };
    if (image.complete) updateState();
    image.addEventListener("load", updateState, { once: true });
    image.addEventListener("error", updateState, { once: true });
  });
  document.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
    const item = filteredCases()[state.index];
    state.answers.set(item.id, button.dataset.answer);
    render();
  }));
  document.querySelectorAll("[data-row-answer]").forEach((button) => button.addEventListener("click", () => {
    const [id, answer] = button.dataset.rowAnswer.split(":");
    state.answers.set(id, answer);
    render();
  }));
  document.querySelectorAll("[data-reveal]").forEach((button) => button.addEventListener("click", () => {
    state.revealed.add(button.dataset.reveal);
    render();
  }));
  document.querySelector("[data-prev]")?.addEventListener("click", () => { const count = filteredCases().length; state.index = (state.index - 1 + count) % count; renderAtTop(); });
  document.querySelector("[data-next]")?.addEventListener("click", () => { state.index = (state.index + 1) % filteredCases().length; renderAtTop(); });
  document.querySelectorAll("[data-case-index]").forEach((button) => button.addEventListener("click", () => { state.index = Number(button.dataset.caseIndex); renderAtTop(); }));
  document.querySelectorAll("[data-open-case]").forEach((button) => button.addEventListener("click", () => { state.index = Number(button.dataset.openCase); setVariant("A"); }));
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.filter; state.index = 0; renderAtTop(); }));
  document.querySelectorAll("[data-variant]").forEach((button) => button.addEventListener("click", () => setVariant(button.dataset.variant)));
  document.querySelector("[data-variant-prev]")?.addEventListener("click", () => stepVariant(-1));
  document.querySelector("[data-variant-next]")?.addEventListener("click", () => stepVariant(1));
}

window.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (event.key === "ArrowLeft") stepVariant(-1);
  if (event.key === "ArrowRight") stepVariant(1);
});

render();
