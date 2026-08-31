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

## WPS 实时 capture-only 预检

第一道实时题固定为 `volcano-query-v1`：16 页（封面、目录、12 页正文、总结、封底），专业模式、允许联网，并选择当前账号零新增付费范围内的最佳档位。协议只允许一次真实提交，最长等待 30 分钟；只有持久记录明确证明尚未提交时，才允许一次前置重试。

```bash
node mvp/live-wps-capture-only.mjs \
  --job-id job-live-volcano-001 \
  --run-id run-live-wps-001 \
  --output-dir tmp/live-wps-volcano-001
```

当前构建缺少经过证明的外部 Chrome 桥接程序，因此命令会有意以状态码 `2` 退出，并记录 `waiting_for_human / not_submitted`。即使尚未提交，它仍会保存冻结后的请求、Trace、分钟耗时和接管说明。流程不会导出 Cookie，也不会重试状态未知或已经提交的任务。

千问与豆包也提供相同的 capture-only CLI 契约。千问使用专家模式并在运行时记录实际模型；豆包使用 `PPT 生成 / 篇幅详细 / 智能匹配`。模型或套餐名称未在界面暴露时记录为 `ui_unavailable`，不会猜测。

统一三厂商入口：

```bash
node mvp/live-three-vendor-job.mjs \
  --job-id job-live-volcano-001 \
  --output-dir tmp/live-three-vendor-volcano-001
```

该 Job 固定按 WPS AI PPT、千问、豆包各执行一次，并在编排层对每家强制 30 分钟截止。某个 Runner 阻塞或异常时，后续厂商仍继续；没有权威提交状态的异常统一记录为 `unknown` 且禁止自动重试。测试注入的 Runner 不能生成 `LIVE_PRODUCTION` 完成状态。只有默认真实 Runner 的三条 Run 都携带真实 `LIVE_PRODUCTION` 产物时，Job 才返回完成状态。

## 已核验实时产物接入评测

浏览器或受信任桥接层已经形成三份完整 capture 目录后，使用下面的入口接入现有静态渲染、自动评分、任意两两比较和短报告：

```bash
node mvp/live-artifact-evaluation.mjs \
  --wps-capture /path/to/wps-capture \
  --qwen-capture /path/to/qwen-capture \
  --doubao-capture /path/to/doubao-capture \
  --output-dir /path/to/an-empty-output-directory
```

每个 capture 目录必须包含 `capture-request.json`、`trace.jsonl`、`run-record.json` 和记录所指向的真实 PPTX。入口拒绝非 `LIVE_PRODUCTION`、非单次提交、缺失提交/下载 Trace、Query 不一致、哈希不一致或页数不一致的输入，避免把历史回放或 Mock 混入实时赛马。

评测完成后，可把题目、运行、评分、三组动态两两对比、短报告及附件幂等写入已配置的飞书 Base：

```bash
node mvp/publish-live-evaluation-to-lark.mjs \
  --base-token <base-token> \
  --evaluation-dir /path/to/evaluation-output
```

发布器按稳定 ID 更新字段，并仅补传同名附件中缺失的文件。运行记录会同时保留原始 PPTX、全套静态单页与总览图；评分记录保留总览图；总报告记录保留 Markdown 报告和结构化 JSON。
