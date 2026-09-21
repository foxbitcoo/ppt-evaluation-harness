# 独立模型配置

复制根目录 config.example.json 到你自己的 config.local.json。不要覆盖仓库示例；本地配置与 .env 被忽略。配置仅保存环境变量名，不保存真实Key。模型调用由用户要求评测时授权，载入Skill本身不发付费请求。

|流程|默认|可选协议|输入|
|---|---|---|---|
|text|JEV|typesafe / openai-chat|任务、提取文字、rubric、有限参考包|
|vision|Seed 2.0 Pro|ark-responses / openai-chat|任务、逐图page_id、完整图片、视觉rubric|

text 与 vision 分别配置 model、base_url、api_key_env，互不覆盖。Ark按量另填现有 endpoint_id（ep-...），并核对其绑定模型。接口URL填写 /v1 或 /api/v3 根路径，不填写具体操作后缀。仅HTTPS，不接受URL中的账号、Key、query参数。自定义服务需用户明确选择该目的地，不能把原厂Key自动转发给代理。

环境变量应在本机终端或宿主的安全凭据配置中设置：TYPESAFE_API_KEY 与 ARK_API_KEY 可分别提供。示例不含有效Key。Skill不会自动读取任意本机密钥文件。

准备材料时，将配置的text.model写入prepare输入中的jev_model字段；该字段沿用历史命名，自定义Chat文字模型时只把生成结果作为rubric和文字素材，由Agent按Chat协议转换，不调用JEV适配器。

运行 `python3 scripts/check_config.py config.local.json`：无网络、只检查结构、输出缺失环境变量名，不输出值。第一轮未填endpoint仍可准备材料，实际调用前必须补齐。

JEV：`python3 scripts/ask_jev.py --config config.local.json < jev-request-A.json`。配置覆盖请求model，使用配置指定的环境变量名。此适配器只向官方 TypeSafe 发送请求；typesafe协议自定义base_url会拒绝，不能把它当兼容代理调用器。

其他文字模型：配置text.protocol=openai-chat，由Agent使用目标服务官方SDK或可用连接器的Chat Completions接口调用，要求符合冻结rubric的JSON答案。不要将JEV的choice协议直接发给Chat接口。

视觉：ark-responses使用现有ArkCLI技能与接入点；openai-chat按该服务官方图片输入协议发送 text + image_url，图片上传方式、数量限制、输出结构和价格需按该服务核对。已有vision-input.json是Responses形态，转换为Chat消息时必须将input_text→text、input_image→image_url对象，并正确上传本地图片，不能只换model字段。对于声明无图片能力的模型直接报告不支持。

范围：本包提供配置校验、JEV专用适配器及Agent编排说明，不声称内置全部供应商的自动调用器。更换模型后，成本、版本、rubric、缓存键都要区分。概率缺失标不可用；非JEV的自报置信度不能当JEV校准概率。
