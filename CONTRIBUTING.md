# 贡献与问题反馈

普通用户先看 [FEEDBACK.md](FEEDBACK.md)，不用先学习开发流程。可以填写[普通用户表单](https://github.com/guyin24/coopanion-natural-voice/issues/new?template=user-bug.yml)，也可以让 agent 根据现象代笔，核对后提交。Agent 使用[专用表单](https://github.com/guyin24/coopanion-natural-voice/issues/new?template=agent-bug.yml)，区分实测、推测和未验证项，未做的检查写 `not_run`。

开发需要 Node 22+；运行 `npm run check` 及适合改动的测试。请遵守 [AGENTS.md](AGENTS.md)，不要为复现问题擅自修改用户安装来源或配置、读取私人数据、调用收费服务或发帖。真实云端与实际设备证据须单独报告。

## Development details / 开发细则

Use Node 22+ and run `npm test` plus `npm run check` before submitting a change. No dependency installation is needed. Use `node scripts/preview.js` to check the actual settings panel against simulated services.

Keep provider authentication, endpoint validation, audio validation, cancellation and cache identity behavior intact. Use loopback HTTP/WebSocket fixtures and synthetic credentials for protocol tests. Avoid coupling adapters to installed user data.

On Windows with an audio device, tests include real native playback, cancellation and process reuse. On headless CI, `NATURAL_VOICE_SKIP_NATIVE_AUDIO=1` explicitly skips that single hardware case. Record which checks ran; a successful mock or compile does not prove audible playback. Cloud-provider tests require your own credentials and may incur charges.

Build installation packages on Windows with `npm run package`. Build output is ignored. The release archive must contain only the npm package file list, including `src/native/PcmPlayer.cs`, and preserve the package's `cortico` manifest. The package script checks every ZIP entry against the source hashes.

For a bug report, include the plugin/host/Windows version, provider/model/voice IDs, the visible error, and a short synthetic reproduction. Remove API keys, full workspace IDs, account IDs, personal paths, chat history and signed download URLs from reports and screenshots.

Source files are MIT licensed. Do not add provider recordings, model weights or host code without their appropriate permissions and attribution.
