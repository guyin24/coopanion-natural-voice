# 阿里云与区域厂商音色目录

官方资料核对日期：2026-11-01。目录不代表账号已经购买或获授每个模型、音色的调用权限。

## 阿里云系统目录范围

`src/catalogs/aliyun-voices.json` 提取自[阿里云 CosyVoice 官方系统音色表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)，保留每行音色 ID、名称、简短特质和所属模型；相同 ID 合并模型成员关系。目前包含全部 194 个唯一系统音色：

| 当前适配器支持的 CosyVoice 模型 | 官方系统音色数 |
| --- | ---: |
| cosyvoice-v3-flash | 88 |
| cosyvoice-v3-plus | 2 |
| cosyvoice-v2 | 106 |
| cosyvoice-v3.5-flash | 0 |
| cosyvoice-v3.5-plus | 0 |

两个 Plus 系统音色也属于 Flash，因此成员数之和为 196。3.5 系列只使用账号复刻或设计音色；v1 可手动填写并使用 WebSocket，但不属于预置模型。接口及模型兼容性参见[模型介绍](https://help.aliyun.com/zh/model-studio/tts-model/)和[CosyVoice HTTP API](https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api)。

`src/catalogs/qwen-voices.json` 独立提取自 [Qwen-Audio-TTS 官方音色表](https://help.aliyun.cn/zh/model-studio/qwen-audio-tts-voice-list)，保留大小写和逐模型成员关系，不从 CosyVoice ID 添加后缀生成。当前 WebSocket 适配器的两个 Qwen 预置模型分别为：

| Qwen-Audio 3.1 模型 | 官方系统音色数 |
| --- | ---: |
| qwen-audio-3.1-tts-plus | 4 |
| qwen-audio-3.1-tts-flash | 139 |

Plus 仅列出 `longanlingxin_v3.1`、`xunanchuan_v3.1`、`longanhuan_v3.1`、`longanfengyue_v3.1`；这四个音色也可用于 Flash。Flash 另有中文、英文及小语种音色，不能因此用于 Plus；例如 `longanyang_v3.1` 仅列入 Flash。官方表说明部分 Flash 音色仅支持北京地域，使用其他地域或网关前需核对官方范围。目录不把模型之间的同名音色视为通用音色。

合成器仅保留少量已确认的旧系统音色别名，例如 `longanhuan` / `longanhuan_v3` 在两个 Qwen 3.1 模型中映射为 `longanhuan_v3.1`，`longanyang` 仅在 Qwen Flash 中映射为 `longanyang_v3.1`。未知或自定义音色 ID 保持原样，不再批量增删版本后缀。

## 阿里云在线查询

全部地址由当前阿里云合成端点派生，保留网关路径前缀，均使用 `Authorization: Bearer <API Key>`，不读取其他厂商凭据，不跟随跳转，也不请求响应中的任意地址。识别路径末尾 `/api/v1/services/audio/tts/SpeechSynthesizer` 或 `/api-ws/v1/inference`（允许末尾 `/`），将它替换为对应目录路径。WebSocket 协议转换为 HTTP(S) 时保留完整主机名：`ws-` 若出现在业务空间 ID 中，也是 ID 的组成部分，不能去除。旧版官方 `ws-{workspaceId}` 模板会迁移为 `{workspaceId}` 与完整 ID，保持原有效主机地址。例如 `/gateway/tenant/api/v1/services/audio/tts/SpeechSynthesizer` 派生出 `/gateway/tenant/api/v1/models` 与 `/gateway/tenant/api/v1/services/audio/tts/customization`。未知后缀或带查询参数的合成端点不推断目录地址，不发送请求，直接显示预置目录并允许手动填写。北京业务空间示例 origin 为 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`。

模型使用 `GET /api/v1/models?capabilities=TTS&language=zh-CN&page_no=1&page_size=100`。官方返回 `output.models`、`output.total`、`output.page_no`、`output.page_size`，模型 ID 字段为 `model`，展示名字段为 `name`。从第一页开始递增；本模块只采用预置的五种 CosyVoice 和两种 Qwen-Audio 3.1 模型，展示名使用本地中文标签。[查询模型列表](https://help.aliyun.com/zh/model-studio/list-models)

自定义音色使用 `POST /api/v1/services/audio/tts/customization`：

```json
{
  "model": "voice-enrollment",
  "input": { "action": "list_voice", "page_index": 0, "page_size": 100 }
}
```

该接口可选 `prefix`，返回 `output.voice_list`，条目含 `voice_id`、`gmt_create`、`gmt_modified`、`status`，不含总数或目标模型。默认页码为 0，默认每页 10；实现使用每页 100，遇不足一页结束。`OK` 可合成，`DEPLOYING` 尚未就绪，`UNDEPLOYED` 不可调用；本模块只列出 `OK` 条目。

目标模型通过同地址 `{"model":"voice-enrollment","input":{"action":"query_voice","voice_id":"..."}}` 查询，读取 `output.target_model` 与 `output.status`；账号音色在创建时绑定模型，不能跨模型使用。已确认属于其他模型或尚未就绪的条目不显示。详情失败、缺少模型或超过详情预算的条目标注“模型待确认”，不填 `models`，供手动确认原有模型后使用。[声音复刻 HTTP API](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)

模型和账号音色分别限 20 页、2000 条；最多查询前 100 个音色的详情，并发不超过 4。两个列表独立查询、独立回退。系统音色始终来自官方静态表，所以成功合并在线结果时 `source` 为 `mixed`，均失败时为 `preset`。网络和服务错误不会把原始消息、密钥或响应体放入提示。取消信号继续向调用方传播。分页达到上限及模型未确认均在 `note` 说明。

## 火山引擎与腾讯云

火山提供官方 `POST https://open.volcengineapi.com/?Action=ListSpeakers&Version=2025-05-20`。请求含必填 `ResourceIDs`（如 `seed-tts-2.0`），可选 `VoiceTypes`、`Page`、`Limit`；结果为 `Result.Total` 和 `Result.Speakers`，后者含 `VoiceType`、`Name`、`ResourceID`、语言、情感与试听信息。它使用 `HMAC-SHA256` 云 API AK/SK 签名，区域 `cn-beijing`、服务 `speech_saas_prod`；当前插件已支持的语音 API Key/AppID 不足以调用该接口。因此 `builtinRegionalCatalog('volcengine')` 提供[官方 2.0 音色表](https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh)中的 12 个常用音色，并明确标为预置。[官方 ListSpeakers API](https://docs.volcengine.com/docs/doubao-voice/list-speakers-large-model-sound-list-new-interface?lang=zh)

腾讯 TTS 的 CAM 文档列有 `DescribeVoices`，但本次核对的[公开 TTS API 概览](https://cloud.tencent.com/document/api/1073/127845)没有该操作的公开请求/响应定义；媒体处理 MPS 的同名接口属于其他服务，不能拿来充当 TTS 目录。本模块采用[官方基础语音合成音色表](https://cloud.tencent.com/document/product/1073/92668)中 23 个常用 ID 与中文名称，绑定当前适配器 `ModelType=1`，明确标为预置，允许手动填写其他音色。

火山和腾讯的内置目录是常用子集，不宣称完整列表或当前账号授权。自动化协议验证采用本机 fixture；阿里云真实账号目录刷新和合成结果单独记录在 [0.4.2 实测报告](live-validation-2026-11-01.md)。
