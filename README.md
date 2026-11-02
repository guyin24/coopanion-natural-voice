# Coopanion 自然语音插件

[English](README.en.md) · [下载安装包](https://github.com/guyin24/coopanion-natural-voice/releases/latest) · [完整配置说明](INSTRUCTIONS.md) · [问题反馈 / agent 代笔](FEEDBACK.md)

让 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 桌宠用自然人声朗读回复。独立维护的第三方 Cortico World API 6 插件，适用于 Windows；安装时无需修改宿主，也不需要额外安装 Node、Python 或 FFmpeg。

## 可以做什么

- 自动朗读桌宠的新发言和提问，支持试听、停止、排队以及收到新输入时打断。
- 适配阿里云百炼、硅基流动、OpenAI、火山引擎/豆包、腾讯云、MiniMax、ElevenLabs、Azure，以及自定义 OpenAI 兼容 TTS 服务。
- 自动获取可用的模型和音色，结合标明来源的官方预设，支持手动填写 ID；提供方列表不等同于账号调用权限。
- 阿里云 WebSocket 连续推流播放、提前握手和首句预合成，减少等待及长句中途空档。
- 支持 Qwen Audio 3.0/3.1 Plus、Flash 的说话风格；默认跟随回复已有表情，可选由回复模型发送简短语气标注。
- 常驻 Windows 播放器支持进程内停止与恢复，同一回复固定增益；气泡同步支持自检和失败降级。

语音是 AI 合成的。需要自备相应平台的 TTS 凭据，朗读文字会发送给所选服务，费用由服务商收取。

## 可能造成的影响

- **数据与费用**：准备朗读的文字会发送给你选择的 TTS 服务，需自备相应 API Key。服务商可能收费；首句预合成、试听和已开始合成后被打断的任务也可能计费，停止播放不等于取消账单。
- **模型输出与等待**：默认表情跟随不增加语气工具输出；可选“模型简短标注”会增加输出，可能多一次模型往返、消耗更多 token 并延迟起声。
- **声音与资源**：使用系统默认音频设备播放回复，并启动隐藏的 Windows PowerShell/waveOut 播放进程，占用计算、内存和网络资源；外放时旁人可能听到回复。
- **界面与排队**：气泡最多等待 1800ms 以对齐起声，失效时直接显示文字。消息过多会排队或跳过；默认新输入会打断朗读，可在设置中关闭。
- **控制与凭据**：可关闭自动朗读、停止当前队列或停用插件。凭据由宿主保存在本机凭据文件，页面不回显密钥；反馈时不要附上 `.env` 或完整配置。

## 局限与支持范围

- 仅提供 Windows 播放，依赖桌宠 World 的新发言事件；没有这些事件的气泡、旧历史、用户输入、思考、图片和提问选项不会自动朗读。此插件不提供语音识别。
- 连续云端推流目前仅覆盖阿里 WebSocket，其他适配器使用完整响应。网络、模型、音频设备和服务限流都会影响延迟；不保证零延迟、逐字或口型同步。
- 全局语气指令和模型简短标注仅适配部分 Qwen Audio 模型；回复模型可能跳过标注，音色表达可能与官网示例不同。切换语气模式后需要按宿主提示重载系统前缀或重启。
- 音色列表含在线结果和官方预设，列表存在不代表账号已获调用权限；自定义兼容服务必须支持语音接口，只有聊天接口不能用。
- 气泡同步仍使用宿主内部兼容挂钩，宿主升级可能影响同步；自检失效时直接显示文字。
- 真实云端主要验证了阿里服务，其他厂商主要经过模拟协议测试。Windows 10/11 是目标平台，干净系统和多音频硬件矩阵尚未完成，故保留实验性标签。

## 问题反馈：普通用户与 agent

[普通用户反馈](https://github.com/guyin24/coopanion-natural-voice/issues/new?template=user-bug.yml) · [agent 整理反馈](https://github.com/guyin24/coopanion-natural-voice/issues/new?template=agent-bug.yml) · [完整反馈说明与代笔提示词](FEEDBACK.md)

**如果不能清晰描述问题，可以让 agent 帮你代笔，核对后再提交。** 不懂技术也可以反馈，未知项写“未知”，不必额外安装开发工具。

普通用户尽量说明版本、安装方式、平台/模型/音色、操作步骤、期望与实际表现及脱敏报错。Agent 应区分用户描述、实测、推测与未验证项，先整理草稿，经用户核对并授权后再发帖；不要附密钥、私人聊天或整个数据目录。

## 安装

市场索引同步后，可在 Coopanion → World 扩展 → 扩展市场搜索 **cortico-world-natural-voice**，安装并按提示重启。npm 包：[cortico-world-natural-voice](https://www.npmjs.com/package/cortico-world-natural-voice)。自动朗读依赖桌宠 World 的新发言事件；普通 Cortico 实例需另外具备这个扩展。

也可以通过 ZIP 本机目录安装：

1. 从 [Releases](https://github.com/guyin24/coopanion-natural-voice/releases/latest) 下载 `Coopanion-Natural-Voice-0.6.2.zip`，完整解压。建议使用英文路径，例如 `D:\Plugins\cortico-world-natural-voice`。
2. 打开 Coopanion → World 扩展 → 手动安装 → 本机目录，选择含 `package.json` 的插件文件夹。
3. 按提示重启进程，启用“自然语音”，打开“语音设置与试听”。
4. 选择平台并填写凭据，点击“保存凭据并读取列表”，选择模型、音色，保存设置后试听。

安装通过链接引用目录，请保留该目录。升级时退出 Coopanion，用新版文件更新原目录，再启动；配置和凭据由宿主保存。源代码 ZIP 中含开发文件，普通使用推荐下载上述发布安装包。

验证宿主：Coopanion 0.2.16 / Cortico 0.2.11 / World API 6。Windows 10/11 为目标平台；本轮真实播放验证在开发机完成，干净系统与多音频设备矩阵尚未覆盖。

## 开发与测试

开发需要 Node.js 22+；无需安装 npm 依赖。

```powershell
git clone https://github.com/guyin24/coopanion-natural-voice.git
cd coopanion-natural-voice
npm test
npm run check
node scripts/preview.js
```

预览面板使用模拟服务，不读取已安装应用的数据，也不调用付费 TTS。Windows 有输出设备时，默认测试包含原生播放、停止和恢复。无音频设备的 CI 可显式设置 `NATURAL_VOICE_SKIP_NATIVE_AUDIO=1`，只跳过真实设备用例；播放器协议测试仍执行。

与实际 Cortico 源码进行宿主集成检查（需要 Node 24 及其依赖）：

```powershell
npm run check:host -- C:\src\Cortico
```

在 Windows 构建安装 ZIP、npm tarball 和校验和：

```powershell
npm run package
```

[验证记录](https://github.com/guyin24/coopanion-natural-voice/blob/main/docs/validation.md)区分自动化、真实云端、安装版和未覆盖的环境。[架构说明](https://github.com/guyin24/coopanion-natural-voice/blob/main/docs/architecture.md)介绍数据流与适配器边界。[贡献指南](https://github.com/guyin24/coopanion-natural-voice/blob/main/CONTRIBUTING.md)说明如何复现问题和提交修改。

## 开源与来源

插件代码采用 [MIT](LICENSE) 许可证。宿主、服务商和音色目录的来源见 [NOTICE](NOTICE.md)。仓库不包含 Coopanion 安装程序、服务凭据、对话数据、生成音频或私人开发记录。
