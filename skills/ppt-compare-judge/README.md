# PPT 对比评审 Skill

文字与视觉分别验收，可独立配置模型与 API Key。默认文字使用 **TypeSafe JEV**，视觉/图文表达使用 **豆包 Seed 2.0 Pro**。输出带页面对照、优缺点、分项评分和成本的 HTML 报告。

## 安装与使用

本Skill位于私有仓库 `foxbitcoo/ppt-evaluation-harness` 的 `skills/ppt-compare-judge`。需先有仓库访问权限。将该目录复制到 Codex 的 skills 目录并重新加载，然后调用 `$ppt-compare-judge`。

复制 `config.example.json` 为未跟踪的 `config.local.json`，分别设置text和vision的模型、接口与环境变量名。真实Key通过本机环境变量提供，不写入仓库或聊天。载入时不调用付费接口。

- text默认JEV；可改为支持结构化文字判断的Chat模型。
- vision默认Seed 2.0 Pro；可改为支持图片输入的Chat模型。
- 两条流程可用不同厂商、不同Key；协议和模型能力需要匹配。

详见 [配置说明](references/configuration.md)。Python 3即可运行准备与校验脚本；默认视觉调用还需要官方ArkCLI及配套技能。PPT需完整渲染PNG（可使用宿主presentations技能）。

## 验证范围

这是Agent工作流，不是无人值守的一键服务。内置JEV适配器、配置校验、PPT文字抽取和评分结构校验；其他供应商调用及HTML生成由Agent按Skill执行。离线脚本已验证；新版逐图标记和自定义供应商尚未做付费端到端验收。单轮评分不代表稳定性或人工一致性。

更新以此私有仓库为准。反馈用仓库Issues，仅提交脱敏复现信息；不包含凭据、私有PPT或完整模型响应。版本0.2.0。
