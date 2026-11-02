# Changelog

## 0.6.1

- Prepare the first public npm release as `cortico-world-natural-voice` with the existing World API 6 manifest.
- Include environment prompt metadata in the generated market description and verify it with the upstream describe checker.
- Declare market tags for voice, required service credentials, the desktop-pet extension dependency and limited-environment validation.
- Document market/npm installation; preserve the 0.6.0 voice runtime and configuration behavior.

## 0.6.0

- Follow existing pet mood by default without extra model tokens/tools; optional tones-only ordinal annotations replace duplicated speech bodies.
- Warm Aliyun WebSocket handshakes independently from model/voice/tone, then stream all PCM continuously into a persistent native waveOut player.
- Stop audio in-process, preserve ordered playback, lock gain per reply, and prevent disposed players from reopening through stale tasks.
- Bound speculative synthesis, isolate store-event failures, release rejected reply bubbles immediately, and invalidate cached audio after voice/model/provider settings change.
- Scope bubble discovery to verified loopback pet upgrades, remove active-handle scanning, expose self-check/fail-open status and document the requested upstream hook.
- Keep runtime/user docs in release packages; retain review evidence in source.


## 0.5.0

- Let the reply model annotate each upcoming line with a separate delivery tone through a declared World tool and environment prompt.
- Feed confirmed per-line instructions to supported Qwen Audio 3.0/3.1 models; preserve global style as fallback and add an opt-out toggle.
- Keep annotated beats intact, distinguish punctuation and repeated text, retain tones after truncation and carry instructions with queued/prewarmed audio.
- Bound and expire annotation plans, clear them on cancellation/turn completion, and prevent speculative tool output from controlling actual speech until execution confirms it.
- Validate 254 automated tests and real installed-model generation of two distinct tones with cloud synthesis and native playback.

## 0.4.3

- Add editable Qwen Audio 3.0/3.1 speaking instructions with a natural conversational default; an empty value restores model-default delivery.
- Apply instructions to direct, prewarmed and duplex WebSocket tasks, and separate warm tasks by speaking style.
- Show the style setting only for supported Qwen models; leave other provider protocols unchanged.
- Verify same-text/same-voice live comparisons, browser save/clear behavior and 236 automated tests. Expressiveness remains a listening judgment; official demo settings were not established.

## 0.4.2

- Preserve complete Alibaba workspace IDs and hostnames across HTTP, WebSocket and catalog requests; migrate the legacy duplicated-prefix template.
- Reject malformed inline Base64 and incomplete PCM; cancel owned pending warm handshakes.
- Match each bubble/status group to its own opening segment and ignore late readiness for expired groups.
- Cancel incomplete streamed tool calls at round end while retaining completed pre-synthesis.
- Release synchronized bubbles on the native player's loaded/playing acknowledgement rather than before file preparation.
- Add protocol, endpoint identity, synchronization and native-readiness regression coverage; record live cloud and installed-app validation separately.

## 0.4.1

- Replace generated Qwen voice suffixes with exact official per-model catalogs (Plus: 4; Flash: 139), preserving unknown custom IDs.
- Close pending WebSocket upgrade requests on abort/timeout and reject late upgrades.
- Observe first-chunk playback failures immediately; cancel and join playback when synthesis fails.
- Keep valid pre-synthesis for other tool replies and discard audio whose streamed text differs from the final cleaned text.
- Share store append subscriptions safely across World restarts and preserve later HTTP wrappers when removing the bubble hook.
- Reserve playback submission order before asynchronous WAV preparation without serializing whole playback.
- Lock credential clearing to the selected provider and remove its redundant stop request.

## 0.4.0

- Support Alibaba Cloud DashScope `tts_v2` WebSocket protocol (canonical template after the 0.4.2 identity fix: `wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`, with the complete workspace ID) for `qwen-audio-3.1-tts-plus` and `qwen-audio-3.1-tts-flash` alongside CosyVoice HTTP `SpeechSynthesizer`.
- Automatically converge endpoints, `workspaceId` extraction, and `_v3.1` voice suffixes when switching between CosyVoice and Qwen-Audio 3.1 TTS models, as well as root/base URLs across SiliconFlow, OpenAI, MiniMax, Volcano Engine, Azure and ElevenLabs.
- Synchronize text and audio latency by pre-synthesizing the first beat during LLM streaming (`outputTap`), subscribing to `host.store.onAppend` for 0ms event reaction, splitting multi-beat/long replies into segments with concurrent next-segment synthesis prefetch, and keeping a warm persistent Windows `SoundPlayer` process (`warmPlayer`).

## 0.3.0

- Load provider model and voice catalogs automatically, with readable dropdowns and custom-ID entry.
- Query Aliyun compatible models/account voices, MiniMax voices, ElevenLabs models/voices, Azure voices, SiliconFlow models/account voices and OpenAI-compatible model endpoints.
- Bundle model-bound official system voices where no account listing exists, label live/preset sources, and keep presets on lookup failures.
- Allow credentials to be saved before selecting a model, ignore delayed provider results, and filter unverified Aliyun account voices out of automatic choices.
- Include the live CosyVoice WAV playback fix from 0.2.1.

## 0.2.1

- Finalize the streaming WAV length placeholders observed in real Alibaba CosyVoice responses before Windows playback.
- Keep strict validation for other container lengths, format fields and sample alignment.
- Place generation/playback status and errors next to the preview controls.

## 0.2.0

- Add Alibaba Cloud CosyVoice, Volcano Engine/Doubao, Tencent Cloud, MiniMax, ElevenLabs and Azure Speech adapters.
- Isolate saved credentials by provider; migrate the previous key only to its original endpoint's provider.
- Add workspace/region/sample-rate settings, credential clearing and validation before saving.
- Validate and normalize WAV/PCM audio, decode bounded Base64/hex envelopes, and sign Tencent requests without runtime dependencies.
- Use English package paths and instruction/archive filenames.

## 0.1.0

- Read new pet replies and questions through configurable online TTS.
- Add SiliconFlow and OpenAI presets, key storage, preview and stop controls.
- Serialize Windows WAV playback and interrupt it on new input.
