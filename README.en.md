# Natural Voice for Coopanion

[中文](README.md) · [Download](https://github.com/guyin24/coopanion-natural-voice/releases/latest) · [Configuration guide (Chinese)](INSTRUCTIONS.md)

An independently maintained Windows plugin that reads [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) pet replies aloud through online TTS. It implements Cortico World API 6 without rebuilding the host. End users do not need Node, Python, FFmpeg or runtime npm dependencies.

## Features

- Read new pet replies/questions, preview voices, queue speech and stop or interrupt it.
- Adapters for Alibaba Cloud, SiliconFlow, OpenAI, Volcano Engine/Doubao, Tencent Cloud, MiniMax, ElevenLabs, Azure and custom OpenAI-compatible TTS.
- Model/voice discovery with labeled official presets and custom IDs. An available catalog entry does not imply account authorization.
- Continuous Aliyun WebSocket PCM playback, handshake prewarming, bounded speculative synthesis and a persistent interruptible Windows waveOut player.
- Qwen Audio 3.0/3.1 Plus/Flash speaking instructions and expression following. Optional `tones` annotations avoid repeating the spoken text.
- Per-reply gain, ordered playback, credential isolation and bubble synchronization with self-check/fail-open behavior.

Supply your own TTS credentials. Spoken text goes to the selected provider, which may charge for usage. Voices are AI-generated.

## Install and update

After the market index syncs, search **cortico-world-natural-voice** under Coopanion’s World extension market. Install it and restart when prompted. [npm package](https://www.npmjs.com/package/cortico-world-natural-voice). Automatic speech requires the desktop-pet World’s reply events; a plain Cortico deployment must supply that extension separately.

For manual ZIP installation:

1. Download `Coopanion-Natural-Voice-0.6.1.zip` from [Releases](https://github.com/guyin24/coopanion-natural-voice/releases/latest) and extract it completely to an ASCII path such as `D:\Plugins\cortico-world-natural-voice`.
2. In Coopanion, open **World extensions → Manual install → Local directory** and select the directory containing `package.json`.
3. Restart when prompted, enable **Natural Voice**, and open **Voice settings and preview**.
4. Save your provider credentials, choose a model/voice, save settings and preview.

Keep the linked directory in place. To update, exit Coopanion, replace files in that directory with the new release, and start it again. The host preserves configuration and secrets. GitHub's source archives include development files; use the named release ZIP for installation.

Validated host: Coopanion 0.2.16, Cortico 0.2.11, World API 6. Windows 10/11 are target platforms; clean-system and multi-device audio matrices have not been completed.

## Delivery and limitations

Default expression following adds no model tool or output; missing expressions use the global style. Optional ordinal annotations can add generation time or a model round and may be skipped by the reply model. After changing modes, save and reload the host's system prefix or restart.

Bubble gating waits up to 1800ms for native playback submission. A private compatibility hook is still needed until the host offers a supported gate API; failed verification displays text immediately. Network and device latency remain. Word-by-word and lip synchronization are not implemented. Continuous provider streaming currently covers Aliyun WebSocket only.

## Development

Node 22+; no npm dependencies to install.

```powershell
npm test
npm run check
node scripts/preview.js
```

The panel preview uses synthetic services without installed user data or paid cloud calls. Windows tests run a real audio-device case by default. CI without an audio device explicitly sets `NATURAL_VOICE_SKIP_NATIVE_AUDIO=1`; mocked player protocol tests still run. Host integration needs Node 24 and a Cortico checkout with its dependencies:

```powershell
npm run check:host -- C:\src\Cortico
npm run package
```

Packaging runs on Windows and emits the installation ZIP, npm tarball and SHA-256 sums. See [validation](https://github.com/guyin24/coopanion-natural-voice/blob/main/docs/validation.md), [architecture](https://github.com/guyin24/coopanion-natural-voice/blob/main/docs/architecture.md), and [contributing](https://github.com/guyin24/coopanion-natural-voice/blob/main/CONTRIBUTING.md).

Plugin code is [MIT licensed](LICENSE). [NOTICE](NOTICE.md) identifies the host projects and provider catalog sources. Host binaries, credentials, chat records and generated audio are excluded.
