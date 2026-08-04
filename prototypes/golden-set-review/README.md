# Golden Set 中文盲标原型

这是一次性的 Rubric 验证工具，不是生产 Harness 前端，也不是已经确认的 Golden Set。它先用两个公开来源的真实样例验证：

- PresentBench：整套 PPT、任务与内容层面的判项；公开 demo 为 17 页学术演示文稿。
- SlideAudit：单页与元素层面的视觉缺陷标注；样例使用 strong agreement 标注。

适用边界：PresentBench 本身是材料/文档 → PPT，不是 Query → PPT 题库。本原型只借它校准“整套结构、材料依赖事实与证据”的判项方法；Query 题库仍需另建。SlideAudit 只校准静态视觉缺陷，不代表整套 PPT 的任务适用性。

运行：

```bash
node prototypes/golden-set-review/serve.mjs
```

然后打开 `http://127.0.0.1:4317/?variant=A`。A/B/C 是三种信息架构，数据和临时标注状态共用，但刷新后会清空。

## SlideAudit 标准与现场还原

- C 版“题库审计”展示公开 annotation schema 中实际出现的 4 类、19 个静态视觉缺陷；绿色圆点表示首批 6 个案例已覆盖的判项。
- 每个 SlideAudit 案例在作答前展示蒸馏后的 GOOD 锚点、BAD 锚点、UNCERTAIN 条件和排除边界。
- 揭晓后展示按公开字段还原的标注现场：样本来源、受控改动类型、单缺陷问题、三人投票、`response`、`has_strong_agreement`、证据框数量和三态映射。
- 该现场不是作者原标注工具的截图。原数据未公开标注者身份；只有在 `has_strong_agreement=true` 时，三人同票才能由聚合字段唯一反推。

## 标签映射

- PresentBench 原始 `yes` 映射为 `GOOD`，`no` 映射为 `BAD`。
- SlideAudit 的缺陷 `response: true` 映射为 `BAD`，缺陷 `response: false` 映射为 `GOOD`。
- 两个来源都没有原生 `UNCERTAIN` 标签。原型把用户的 `UNCERTAIN` 单列统计，不把它直接算作错误；“差异率”只在用户给出 GOOD/BAD 时计算。

## 来源与许可

- [PresentBench repository](https://github.com/PresentBench/PresentBench)（代码 Apache-2.0；数据集页面标注为 `other`，本原型缓存官方公开 demo 的 4 张低清内部审阅缩略图，不包含完整 Deck 或材料，不应直接公开发布或商业再分发）
- [PresentBench public demo](https://presentbench.github.io/)
- [SlideAudit repository](https://github.com/zhuohaouw/SlideAudit)（数据集 CC BY 4.0；为保证盲标原型可复现，本原型缓存固定 revision 的 6 张样本并保留来源、许可与文件校验信息）

页面内容为中文工作翻译，英文原判项和官方来源链接保留在每个样例中。
