# 在线模型与音色目录

核验日期：2026-10-31。实现位于 `src/catalogs/remote.js`，通过已有凭据对象中的 `apiKey` 获取目录。本文引用公开官方文档；未读取用户密钥、调用真实服务或验证账号权限。

## 公共行为

- `builtinRemoteCatalog(provider)` 返回独立的预置目录，`source: 'preset'`。
- `fetchRemoteCatalog(cfg, credentials, signal)` 接收已解析占位参数的合成地址，返回 `{models, voices, source, note}`。模型项为 `{id,label}`，音色项另可带 `models`、`locale`、`kind`。
- 仅替换已知的合成 URL 后缀，保留原始 origin 和网关前缀。无法识别的地址不猜测接口。兼容服务仅尝试 `/audio/speech` 的同级 `/models`。
- 各列表独立刷新，按 ID 合并在线结果与预置选项；失败不丢弃另一列表的成功结果。选项存在不代表账号已开通对应模型。
- 缺少密钥时不请求网络。取消会抛出固定中文 `AbortError`；其他错误只返回固定中文提示，不回显服务响应、请求地址或凭据。
- 每类最多 2000 项；ID 必须是非空字符串、最多 512 字符且不含控制字符，标签最多 200 字符。ElevenLabs 最多 20 页，重复或缺失分页令牌会停止并提示部分结果。
- `source` 按返回内容的实际来源判定：没有成功获取任何在线列表时为 `preset`，包括未填密钥、地址无法推导和所有请求失败；在线列表成功且结果仍保留未被在线列表返回的预置项时为 `mixed`；返回项均已由在线列表返回时才为 `live`。合法的空账号列表仍按成功响应处理，同时明确提示未返回可用条目及是否合并预置选项。

## MiniMax

`POST {origin}{prefix}/v1/get_voice`，使用 `Authorization: Bearer <apiKey>`、`Content-Type: application/json`，请求体 `{ "voice_type": "all" }`。可选分类为 `system`、`voice_cloning`、`voice_generation`、`all`，未文档化分页。

解析 `system_voice`、`voice_cloning`、`voice_generation` 中的 `voice_id`、`voice_name`；必须先确认数字型 `base_resp.status_code === 0`。克隆/生成音色在成功用于合成后才可列出。[查询可用音色 ID](https://platform.minimax.cn/docs/api-reference/voice-management-get)

模型使用合成接口列出的 2.8、2.6、02、01 系列 HD/Turbo 预置值。[同步语音合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)

官方另有通用 `GET /v1/models`，返回 `{object:'list',data:[{id,object,created,owned_by}]}`。文档示例只有语言模型，未明确覆盖语音或提供模态过滤，因此本次不将其作为语音模型枚举依据。[通用模型列表](https://platform.minimax.cn/docs/api-reference/models/openai/list-models)

## ElevenLabs

`GET /v1/models`，使用 `xi-api-key: <apiKey>`；响应为数组，保留 `can_do_text_to_speech === true`，取 `model_id` 与 `name`。该接口没有分页参数。[模型列表](https://elevenlabs.io/docs/api-reference/models/list)

`GET /v2/voices?page_size=100&include_total_count=false`，同样使用 `xi-api-key`。读取 `voices[].voice_id/name/category/labels.language`；使用 `has_more` 与 `next_page_token` 继续分页，不依赖会变化的 `total_count`。令牌使用 URLSearchParams 编码。接口还支持 search、sort、voice_type、category、language 等过滤；当前实现完整获取后由界面筛选。[音色列表及分页](https://elevenlabs.io/docs/api-reference/voices/search)

离线模型预置 Multilingual v2、Flash v2.5、Turbo v2.5、v3；Turbo 已被官方列为旧模型。v4 属于另一种 Text to Dialogue 接口，本插件的 Text to Speech 适配器不主动预置它。[模型说明](https://elevenlabs.io/docs/overview/models)

## Azure Speech

地域地址使用 `GET https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list`；自定义资源地址使用 `/tts/cognitiveservices/voices/list`。直接传 `Ocp-Apim-Subscription-Key: <apiKey>`，不进行额外 Token 交换。[地域及自定义资源路径](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-private-link)

响应为 JSON 数组；取 `ShortName` 为音色 ID、`LocalName || DisplayName` 为标签、`Locale` 为语言地域。官方还返回 VoiceType、Status、StyleList 等，本插件不扩展这些合成能力。未文档化分页；地区不同可能导致预览音色可用性不同。模型保留本插件既有 `neural` 值。[TTS REST 与音色响应](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)

## SiliconFlow

`GET /v1/models?type=audio`，使用 `Authorization: Bearer <apiKey>`；响应为 `{object:'list',data:[{id,...}]}`。`audio` 也可能包括 ASR；文档未列出 `sub_type=text-to-speech`，因此不能发送该筛选。当前实现仅接受官方文档中的 CosyVoice2、MOSS-TTSD、fish-speech 1.4/1.5 ID，排除 SenseVoice 等识别模型。没有分页参数。[模型列表](https://docs.siliconflow.com/en/api-reference/models/get-model-list)

`GET /v1/audio/voice/list`，同样使用 Bearer Key，返回 `{results:[{model,customName,text,uri}]}`。这里列出账号自定义参考音频；音色 ID 是 `uri`，并绑定返回的 `model`，没有分页。[中国站参考音频列表](https://api-docs.siliconflow.cn/docs/api/audio-voice-list-get)

系统音色按模型组成 `<model>:alex` 等 ID；每个模型有 alex、benjamin、charles、david、anna、bella、claire、diana 八种。默认离线模型采用中国站当前合成接口列出的 CosyVoice2 与 MOSS-TTSD；fish-speech 仅在在线列表返回时纳入。[系统音色约定](https://docs.siliconflow.com/en/userguide/capabilities/text-to-speech)、[中国站合成模型](https://api-docs.siliconflow.cn/docs/api/audio-speech-post)

## OpenAI 与兼容服务

`GET /v1/models`，使用 Bearer Key，返回 `data[].id`；接口没有语音能力字段，也未提供分页。本插件仅保留 Speech API 文档明确支持的模型 ID。兼容服务无法据此判断模型模态，因此展示该服务返回的合法 ID，并提示可能存在非语音模型。[OpenAI 模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)

OpenAI 使用官方固定的 13 种音色，不猜测 `GET /audio/voices`。tts-1/tts-1-hd 的音色限制通过每项 `models` 表达；marin、cedar、ballad、verse 不绑定这两个旧模型。自定义兼容服务音色保持手填。[语音合成指南](https://developers.openai.com/api/docs/guides/text-to-speech)

官方当前标记 Speech API 模型于 2027-01-06 停用；本次保持用户已有 `/audio/speech` 适配器，未把只适用 Realtime 的替代模型加入该接口目录。[Speech API 参考](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)

## 验证边界

`node --test tests/catalog-remote.test.js` 使用本机临时 HTTP 服务验证路径、鉴权、schema、分页限制、独立回退、固定音色限制、畸形 ID 与取消。全部测试不访问云 API，不消耗真实服务额度。
