# 给仓库协作 agent 的说明

- 先读 `README.md` 和 `FEEDBACK.md`。这是独立的 Coopanion/Cortico World API 6 Windows 语音插件，不包含宿主或模型。
- 在用户已授权范围内直接推进，保护未提交改动。只要求整理反馈时先给草稿，不自动发帖、改设置、重装或调用收费 TTS。
- 反馈区分用户描述、agent 实测、源码推断和未验证项。未知不编造，未做写 `not_run`；用户表达不清时帮助代笔并请其核对。
- 不公开真实凭据、`.env`、完整用户配置、私人聊天或签名下载链接；复现使用合成文本和模拟凭据。
- 运行 `npm run check` 及适合改动的测试。Windows 有音频设备时 `npm test` 含原生播放；无设备 CI 显式使用 `NATURAL_VOICE_SKIP_NATIVE_AUDIO=1`，不能将跳过写成通过。有可用上游源码时运行 `npm run check:host -- <Cortico路径>`。
- `describe.json` 含工具、事件和环境提示词。修改工具或提示词后更新它，并用上游 `checkDescribe` 校验，不能只比较 tools/events。
- npm 发布需明确授权。发布前核对版本、说明、归档文件、隐私、宿主清单和入口；登录/发布身份验证由账号本人在 npm 官网页面完成，已发布版本不覆盖。
- 分别报告代码、自动测试、真实云端、实际应用/设备和安装包证据；完成声明以本次验证为准。
