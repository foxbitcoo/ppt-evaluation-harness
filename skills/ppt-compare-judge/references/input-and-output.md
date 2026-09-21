# 配置与输出

使用绝对路径。images 必须按实际页序列出全部 PNG；源 PPT 与渲染对应关系需要事先核对。prepare 会校验数量和文件哈希，但无法判断某PNG是否渲染自该PPT。

配置结构：
```json
{
  "task": "原始生成任务全文及目标读者/场景",
  "jev_model": "jev-1.13.0",
  "rubric": "/absolute/path/rubric.json",
  "samples": [
    {"id":"A", "label":"候选厂商名", "pptx":"/absolute/path/a.pptx", "images":["/absolute/path/slide-01.png"]},
    {"id":"B", "label":"候选厂商名", "pptx":"/absolute/path/b.pptx", "images":["/absolute/path/slide-01.png"]}
  ]
}
```
示例只有一页占位，实际输入全量文件。ID须为短字母数字编号，不含品牌。

rubric.json：`{"version":"topic-v1","questions":{...},"reference_pack":[]}`，questions 用 ask-jev 原生结构。必须先按任务写好，而不是套用无限泛化的“好/差”。

本地准备：
```
python3 SKILL_DIR/scripts/prepare.py config.json output-directory
```
输出目录必须不存在；失败不发请求。manifest.json 保留原文件和哈希（仅本地）；text-ID.json 包含原生提取文字；jev-request-ID.json可送ask-jev；vision-input.json为交错的text/image内容数组，本地file URL须由受支持SDK上传，不能直接发未解析file URL。视觉prompt需另外加在序列前。

视觉评委 JSON 契约：
```json
{
 "ranking":[["A"],["B"]],
 "decks":[
  {"id":"A","scores":{"readability":4,"layout":4,"explanation":4,"consistency":4},"evidence":[{"dimension":"readability","page_id":"A-p001","observation":"具体可见元素","polarity":"positive"}]},
  {"id":"B","scores":{"readability":3,"layout":3,"explanation":3,"consistency":3},"evidence":[{"dimension":"readability","page_id":"B-p001","observation":"具体可见元素","polarity":"negative"}]}
 ],
 "winner_reason":"基于页面的理由",
 "uncertainties":[]
}
```
示例省略其他维度证据；正式输出每家每维至少一条证据，包含优点和缺点（没有缺点不强行编造）。看不清用null分数、说明unknown证据。ranking允许并列，须覆盖全部候选且无重复。
