# Coopanion 自然语音扩展 0.6.2

Owner: `src/config.js`、`src/credentials.js`、`src/tts.js`、`src/providers/`、`src/world.js`、`web/client.js`。

支持 Windows 10 / 11，自动朗读桌宠的新回复。内置 8 个平台预设，以及自定义 OpenAI 兼容接口。无需重新编译 Coopanion，不需要额外安装 Python、FFmpeg 或 Node。

## 安装或升级

**已通过本机目录安装：** 直接更新原来安装时选择的扩展目录，再完全退出并重启 Coopanion，即可升级。无需卸载或重新安装；原有语音配置和 Key 会保留，旧版 Key 在首次启动时自动迁移。本机链接安装不通过 npm 的“检查更新”按钮升级。

首次安装，或需要改为引用另一个目录时：

1. 完整解压 `Coopanion-Natural-Voice-0.6.2.zip`（或直接使用本源码文件夹）。解压目录的完整路径使用英文、数字或横线，避免中文路径被 Coopanion 安装器拒绝。
2. 打开 Coopanion 设置 → World 扩展 → 手动安装 → 本机目录，选择**含 package.json 的 cortico-world-natural-voice 文件夹**。
3. 如果原来引用其他目录，选择新版本目录后按页面提示重启进程。同名扩展会更新安装来源；不要删除原有记忆或配置。
4. 启用“自然语音”World，打开“语音设置与试听”。
5. 选择语音平台并填写地址、地域或 Workspace ID 和凭据，点击“保存凭据并读取列表”。从列表选择模型、音色，点击“保存设置”，再点击“试听”。修改平台、模型或凭据后，需要先保存设置才能试听。

本机安装通过链接引用文件夹，安装后保留该目录。设置窗口关闭后，后台朗读继续运行。

## 自动跟随回复语气

使用 Qwen Audio 3.0/3.1 Plus、Flash 时，默认勾选“自动跟随回复语气”，模式为“跟随已有表情（更快）”。插件将桌宠回复原有的开心、安慰、惊讶等表情映射成语音指令，不增加模型输出或工具调用。没有对应表情时使用全局说话风格。

需要更细的语气时，可以选择“模型简短标注（更细）”。模型只给出短语气数组，按顺序对应下一次发言的各句，不会复述正文；此模式会增加少量模型输出，也可能增加一次工具往返。修改模式后保存，再按宿主提示重载系统前缀，或重启 Coopanion，新的工具清单才会生效。模型未标注时仍可使用已有表情和全局风格。关闭自动语气后仅使用全局风格。

## 全局说话风格

使用 Qwen Audio 3.0/3.1 Plus、Flash 时，音色下面会显示“说话风格”。默认使用自然聊天的表达，可以填写“温柔、安慰地聊天”或“开心、有一点惊喜，语气轻松”等指令，保存后试听。留空并保存会恢复模型默认语气；其他平台与不支持的模型不显示、不发送此参数。

当前音色和语速保留，不会为了增加情感自动换音色。语气改善程度请实际试听判断，无法保证与官网示例完全一致。

## 协议与同步功能

1. **阿里云 CosyVoice 与 Qwen-Audio 3.1 TTS 双协议自动适配**
   - 同时支持百炼 CosyVoice HTTP 接口（`https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`）与 DashScope `tts_v2` WebSocket 接口（`wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`）。两者使用相同的完整业务空间 ID；若 ID 以 `ws-` 开头，应保留，不能当作协议标记删除。
   - 切换模型时推导相应接口地址，并按该模型的官方目录筛选音色。Qwen 3.1 Plus 有 4 个系统音色，Flash 有 139 个；不能将 CosyVoice 音色统一改成 `_v3.1` 后缀使用。仅转换明确支持的别名，自定义音色 ID 保留原值。
2. **多平台接口与音色参数收敛**
   - 支持从完整地址提取业务空间 ID，兼容旧版 `ws-{workspaceId}` 模板，转换协议时保留完整主机名和网关前缀。
   - 各平台填写根域名或简写路径时自动补全标准合成路径；硅基流动填写裸系统音色名（如 `claire`）自动补全 `${model}:${voice}`；ElevenLabs 修改音色后自动更新路径中的音色段。
3. **文字与语音低延迟同步与响度归一化**
   - 提前完成语音服务的连接握手，确定本句语气后才创建合成任务；只预合成首句，实际播放时顺序预取下一句。阿里云 WebSocket 音频按采样率持续推送到播放器，长句不再等待整段生成完才播放剩余部分。兼容的 CosyVoice 请求在 WebSocket 失败时可回退 HTTP；只支持 WebSocket 的模型仍需该连接可用。
   - 桌宠气泡按回复分组，等待 Windows 播放器开始提交声音后释放；最多等待 1800 毫秒，超时或语音失败时继续显示文字。后续回复不会被前一条的就绪消息提前释放。此机制减少起声错位，不保证零延迟或逐字同步；网络、模型和音频设备仍会影响等待时间。
   - 常驻播放器通过进程内停止清空音频队列，打断后保留进程；按原文顺序播放。同一回复固定自动增益，配合音量倍率（`0.25`～`3`，默认 `1`）减少分段响度跳变；播放失败、取消和重复启停会清理相应任务。启动时检查气泡同步挂钩，未验证到桌宠连接时会直接显示文字，页面显示降级状态。

测试范围与结果见[验证记录](https://github.com/guyin24/coopanion-natural-voice/blob/main/docs/validation.md)。

## 自动获取模型和音色

打开设置或切换平台会自动加载目录。已保存凭据时会查询平台公开接口，也可点击“刷新模型和音色”。首次配置可先点击“保存凭据并读取列表”，不必先知道模型 ID。

- 模型和音色列表显示名称及 ID，切换模型会筛选匹配音色。选择“手动输入 ID…”可继续使用自定义模型或音色；原先的自定义值会保留。
- 阿里云模型和账号复刻/设计音色在线读取；CosyVoice 使用官方表的 194 个系统音色，Qwen 3.1 分别使用官方 Plus（4 个）和 Flash（139 个）目录。CosyVoice v3 Plus 有两个系统音色，v3.5 系列需要账号复刻/设计音色。模型绑定待确认的账号音色仅供手动填写，避免自动选择不匹配的音色。
- MiniMax 在线读取账号音色，模型使用官方预设；ElevenLabs 在线读取模型和音色；Azure 按地域读取音色。
- 硅基流动在线读取语音模型及账号自定义音色，系统音色来自官方预设。OpenAI 在线读取语音模型，音色来自官方固定目录；兼容服务可尝试同源模型接口，音色仍需按该服务说明填写。
- 火山、腾讯使用当前鉴权方式可用的官方常用音色预设。火山完整音色目录需要额外的云 AK/SK，当前语音 API Key 不适用。

页面明确标注“在线目录”“官方预设”或两者混合。预设目录不代表账号已开通权限；查询失败会保留预设及自定义输入。目录查询总时限 20 秒，最多 20 页/2000 项。协议依据见源码 `docs/catalog-aliyun.md` 与 `docs/catalog-remote.md`。

## 平台配置

| 平台 | 需要填写的凭据或信息 | 默认模型 / 音色 |
|---|---|---|
| 硅基流动 | API Key | CosyVoice2 / claire 温柔女声 |
| OpenAI | OpenAI API Key | gpt-4o-mini-tts / coral |
| 阿里云百炼 | 北京地域 API Key、Workspace ID | cosyvoice-v3-plus / longanyang 或 qwen-audio-3.1-tts-plus / longanhuan_v3.1 |
| 火山引擎 / 豆包 | 新版 API Key；或旧版 Access Token 加 App ID | seed-tts-2.0 / zh_female_vv_uranus_bigtts |
| 腾讯云 | SecretId、SecretKey；临时凭据还需 Token | ModelType 1 / VoiceType 101001，16000 Hz |
| MiniMax | MiniMax API Key | speech-2.8-hd / female-shaonv |
| ElevenLabs | ElevenLabs API Key | eleven_multilingual_v2 / George 示例音色 |
| Azure Speech | Speech Resource Key、资源所在地域 | zh-CN-XiaoxiaoNeural |
| 自定义兼容服务 | 请求地址、模型、音色、API Key | 需兼容 OpenAI audio/speech 并返回 PCM WAV |

“平台开通与接口说明”链接会打开对应的官方文档。模型和音色是否可用、费用和用量限制以你的平台账号为准。本扩展不提供平台额度。

### 阿里云百炼

选择“阿里云百炼 · CosyVoice”，填写百炼北京业务空间的 Workspace ID 和相同地域的 API Key。默认请求地址中的 `{workspaceId}` 会自动替换，无需手动拼接。

同时支持 CosyVoice 系列以及 Qwen-Audio 3.1 TTS WebSocket 模型。音色必须属于所选模型；请优先从筛选后的列表选择，不要自行替换版本后缀。Qwen Plus 可选择 `longanlingxin_v3.1`、`xunanchuan_v3.1`、`longanhuan_v3.1`、`longanfengyue_v3.1`。如使用 `cosyvoice-v2`，请选择该版本音色（例如 `longxiaochun_v2`）。阿里云“智能语音交互”的 Appkey / NLS Token 接口是另一项服务。

依据：[百炼 CosyVoice HTTP](https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api)、[CosyVoice 音色](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)。

### 火山引擎 / 豆包

新版鉴权：填写 API Key，App ID 留空。

旧版鉴权：在 API Key 输入框填写 Access Token，并填写 App ID。资源 ID 和音色要属于同一个模型版本。切换鉴权方式时，可以先“清除此平台凭据”，再重新填写。

当前提供普通 TTS 音色的 V3 HTTP 适配。复刻音色所需的 `req_params.model` 子版本选择未单独开放。

依据：[火山 V3 HTTP 协议](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh)。

### 腾讯云

使用云 API 的 SecretId / SecretKey，不是其他平台的 API Key。采用 TC3-HMAC-SHA256 签名，SecretKey 不会直接放入请求体。

腾讯基础接口对单次文本较短，本扩展会顺序分段合成再拼接播放。默认 VoiceType `101001` 使用 16000 Hz；24000 Hz 需要选择支持该采样率的音色。

依据：[TextToVoice](https://cloud.tencent.com/document/api/1073/37995)、[音色采样率](https://cloud.tencent.com/document/product/1073/92668)。

### MiniMax、ElevenLabs 与 Azure

- MiniMax 默认中国大陆接口 `https://api.minimax.cn/v1/t2a_v2`，使用对应平台的 Key。可修改模型和音色 ID。
- ElevenLabs 可将示例音色 ID 换成账号中可用的音色。默认 24000 Hz PCM；更高采样率可能需要对应套餐权限。
- Azure 使用 Speech 资源密钥，地域要与资源一致。请求地址中的 `{region}` 自动替换；Azure OpenAI 的 Key 不等于 Speech Resource Key。

依据：[MiniMax HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)、[Azure Speech REST](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)。

### 硅基流动、OpenAI 与自定义兼容服务

原来的两个平台继续支持。硅基流动默认 `FunAudioLLM/CosyVoice2-0.5B`，音色 `FunAudioLLM/CosyVoice2-0.5B:claire`。OpenAI 使用独立的 API Key，Coopanion 的 ChatGPT 登录不会自动提供 TTS 凭据。

自定义服务必须支持 `model`、`voice`、`input`、`speed`、`response_format: "wav"` 的请求，并返回 PCM WAV 二进制。仅支持聊天接口不代表支持语音合成。本机网关可使用 HTTP；远程接口要求 HTTPS。

依据：[硅基流动 TTS](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech)、[OpenAI Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)。

## 凭据管理

- 每个平台分别保存凭据，不会把上一平台的 Key 自动发送给另一个平台。
- Key 通过 Cortico 的 `storeSecret` 存到本机部署目录 `.env`，不写入 config.json，也不会在页面回显。输入框留空保留已保存的值。
- 0.1.0 的旧 Key 首次升级时只迁移到原请求地址对应的兼容平台。
- 切换平台会清空尚未保存的凭据输入。“清除此平台凭据”只清除所选平台的凭据，并停止其当前朗读。
- 腾讯云等临时凭据过期后需要更新。若要移除旧 Token 或旧 App ID，可以清除此平台凭据后重新填写。

模型、音色、请求地址等草稿在当前面板中切换平台时保留；重新打开面板只加载最后保存的配置。凭据仍分别保存在每个平台下。

## 朗读行为

- 只朗读扩展启用后桌宠实际发出的新发言和提问；跳过启动历史、用户输入、思考过程、工具活动、图片和提问选项。
- 代码块和图片标记会被去除，链接只朗读标题。默认每条最多 1200 字，超出后说“后文省略”；可设置为 50～4000 字。
- 逐条播放，最多保留 6 条等待消息。默认收到新的文字、语音或选项回答即停止当前朗读。
- “停止朗读”取消当前请求、音频和等待队列；下一条新回复仍可自动朗读。
- “试听”使用已经保存的配置，并替换当前队列。可以关闭“自动朗读”而仅使用试听。
- 整个合成任务最多 90 秒，每个网络请求最多 45 秒；解码音频最多 16 MiB。错误会显示在状态行，桌宠聊天继续工作。

支持首句预合成、阿里 WebSocket 持续推流、下一句顺序预取与桌宠气泡同步显示；当前不包含口型同步。新手引导等没有记入 `desktop-pet.self` 的气泡不在自动朗读范围。

Windows waveOut 播放器使用当前默认输出设备，音频通过管道持续提交，不为每块创建临时 WAV 文件。插件没有独立的代理/PAC 设置。

## 验证范围

平台协议、鉴权/签名、返回格式、URL 下载边界、凭据隔离、取消与播放均通过本机模拟接口测试，并进行了真实浏览器面板操作和 Windows 播放验证。

阿里云 CosyVoice 已在本机实际安装的 Coopanion 中使用已保存凭据完成云端合成与 Windows 播放，并修复了真实响应中的 WAV 长度占位标记兼容问题。其他平台目前使用模拟接口验证；账号权限、音质和云端延迟仍需使用自己的凭据试听确认。目标宿主为 Coopanion 0.2.16 / World API 6。

## 问题反馈与 agent 代笔

[反馈说明](FEEDBACK.md)包含普通用户和 agent 的填写方式与模板。不清楚如何描述问题时，可以先让 agent 代笔，核对后再提交。请说明版本、平台/模型/音色、步骤、期望/实际及脱敏报错；未知项写未知，不附密钥、完整配置或私人对话。Agent 应分别标注实测、推测和未验证项。
