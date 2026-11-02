# Coopanion 自然语音插件

[English](README.en.md) · [下载安装包](https://github.com/guyin24/coopanion-natural-voice/releases/latest) · [完整配置说明](INSTRUCTIONS.md)

让 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 桌宠用自然人声朗读回复。独立维护的第三方 Cortico World API 6 插件，适用于 Windows；安装时无需修改宿主，也不需要额外安装 Node、Python 或 FFmpeg。

## 可以做什么

- 自动朗读桌宠的新发言和提问，支持试听、停止、排队以及收到新输入时打断。
- 适配阿里云百炼、硅基流动、OpenAI、火山引擎/豆包、腾讯云、MiniMax、ElevenLabs、Azure，以及自定义 OpenAI 兼容 TTS 服务。
- 自动获取可用的模型和音色，结合标明来源的官方预设，支持手动填写 ID；提供方列表不等同于账号调用权限。
- 阿里云 WebSocket 连续推流播放、提前握手和首句预合成，减少等待及长句中途空档。
- 支持 Qwen Audio 3.0/3.1 Plus、Flash 的说话风格；默认跟随回复已有表情，可选由回复模型发送简短语气标注。
- 常驻 Windows 播放器支持进程内停止与恢复，同一回复固定增益；气泡同步支持自检和失败降级。

语音是 AI 合成的。需要自备相应平台的 TTS 凭据，朗读文字会发送给所选服务，费用由服务商收取。

## 安装

1. 从 [Releases](https://github.com/guyin24/coopanion-natural-voice/releases/latest) 下载 `Coopanion-Natural-Voice-0.6.0.zip`，完整解压。建议使用英文路径，例如 `D:\Plugins\cortico-world-natural-voice`。
2. 打开 Coopanion → World 扩展 → 手动安装 → 本机目录，选择含 `package.json` 的插件文件夹。
3. 按提示重启进程，启用“自然语音”，打开“语音设置与试听”。
4. 选择平台并填写凭据，点击“保存凭据并读取列表”，选择模型、音色，保存设置后试听。

安装通过链接引用目录，请保留该目录。升级时退出 Coopanion，用新版文件更新原目录，再启动；配置和凭据由宿主保存。源代码 ZIP 中含开发文件，普通使用推荐下载上述发布安装包。

验证宿主：Coopanion 0.2.16 / Cortico 0.2.11 / World API 6。Windows 10/11 为目标平台；本轮真实播放验证在开发机完成，干净系统与多音频设备矩阵尚未覆盖。

## 情感与同步

“跟随已有表情”不增加模型工具或输出；没有对应表情时使用全局说话风格。“模型简短标注”只传 `tones` 数组，不重复正文，但会增加少量生成时间，可能增加一次模型往返，模型也可能跳过标注。切换模式后保存，并按宿主提示重载系统前缀或重启。

气泡按回复等待音频开始提交到 Windows，最多等待 1800ms。宿主暂无正式气泡门控 API，本插件使用带自检的兼容挂钩，失效时直接显示文字。网络、模型和设备仍可能带来延迟；不提供逐字或口型同步。

目前连续云端推流仅覆盖阿里 WebSocket。其他平台仍按现有适配器接收完整响应。音色的实际表现请使用自己的配置试听。

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
