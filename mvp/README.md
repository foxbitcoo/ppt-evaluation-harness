# 历史产物对比 M0

这个入口只导入三份现有 PPTX，并将它们标记为 `PRODUCTION_REPLAY / 历史产物对比`。它不会提交实时厂商任务，也不会补造任务 ID、Trace 或耗时。

M0 绑定历史真实 8 页 Query：`为初中生制作一份《火山为什么会喷发？》的 8 页科普课堂 PPT，包含成因、喷发过程、典型案例、安全常识和课堂小测，风格清晰活泼、配示意图。` 千问、豆包实际 8 页；WPS 灵犀实际 12 页，按偏差 `+4` 页原样保留。

```bash
node mvp/historical-m0.mjs \
  --qwen-pptx /path/to/qwen.pptx \
  --doubao-pptx /path/to/doubao.pptx \
  --lingxi-pptx /path/to/lingxi.pptx \
  --output-dir /path/to/an-empty-output-directory
```

默认评分器是 `/Applications/ChatGPT.app/Contents/Resources/codex`，模型为 `gpt-5.6-sol`，推理档位为 `xhigh`。每份 PPT 的所有静态页均通过单独的 `-i` 参数输入；会保存 schema、prompt、Codex JSONL 事件、原始结果和解析后的 Scorecard。

测试可增加 `--score-fixture /path/to/fixture.json`，以严格同构的 JSON fixture 跳过模型调用。这个开关生成的评分会明确标注 `scoreSource: FIXTURE`，不得作为真实模型评分对外使用。

输出包含：

- `artifacts/`：三份原始 PPTX 的按产品副本；
- `renders/`：Presentations 受信任 Artifact Tool helper 生成的逐页 PNG；
- `judge/`：每份产物的模型输入 schema、原始/解析结果；
- `comparisons/`：三组动态两两对比，不设置固定基线；
- `report.md`：只包含关键差距、页证据和产品建议的短报告；
- `m0-summary.json`：可供后续接入现有评测底座的完整本地结果。

用户可见的排序指标是 `experimentalAssessableMean`（可评五维实验均值）。它不包含 `NOT_ASSESSABLE` 的事实维度，未经过标尺校准，只用于本次探索比较，不应解释为权威综合评分。

默认渲染器为 Presentations 技能自带的 `container_tools/render_slides.py`，它使用 bundled Artifact Tool。可通过 `PRESENTATIONS_RENDER_HELPER` 与 `PRESENTATIONS_PYTHON` 环境变量覆盖；命令会校验输出页数、每张 PNG 的签名、尺寸和 SHA-256。命令不会自行声称完成了人工逐页验收。
