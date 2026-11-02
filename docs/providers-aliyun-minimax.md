# Alibaba Cloud CosyVoice and MiniMax HTTP adapters

Contract verified against official documentation on 2026-10-31. These adapters use the shared bounded transport and WAV validation. Tests use loopback HTTP fixtures; real paid synthesis and account availability are not verified.

## Alibaba Cloud Model Studio CosyVoice

- Endpoint: `https://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`. Replace `YOUR_WORKSPACE_ID` with the Beijing workspace ID; use that region's Model Studio API key. A generic DashScope or OpenAI-compatible endpoint is a different contract.
- Recommended initial model/voice: `cosyvoice-v3-plus` / `longanyang`, matching the official HTTP example. `cosyvoice-v3-flash` also lists `longanyang` for Mandarin/English. Select another voice from its model's own list; custom voices require a compatible target model.
- Authentication: `Authorization: Bearer <apiKey>`. The adapter sends `model` and `input.{text,voice,format,sample_rate,rate}`, requests `format: wav`, and does not enable SSE.
- Sampling rates: 8000, 12000, 16000, 22050, 24000, 44100, 48000 Hz. Adapter default: 24000 Hz. Speed: 0.5–2.0, default 1.0. Use short desktop replies; the HTTP reference does not specify a single universal text-character ceiling, so do not infer one from a different WebSocket or SDK interface.
- A successful nonstreaming response must contain `output.finish_reason: stop` and `output.audio.url`. The signed audio URL expires after 24 hours and is consumed immediately. Native business errors with `code` are rejected before any download; raw service messages are not echoed.
- The documented Beijing audio host is `dashscope-result-bj.oss-cn-beijing.aliyuncs.com`. Only this host/suffix and an exact loopback fixture origin are passed to the download helper. The shared helper upgrades that approved host's HTTP sample URL to HTTPS, blocks redirects, and never forwards the API key to audio downloads. Additional regions/CDN hosts require verified documentation and an explicit allowlist update.

Sources: [HTTP reference](https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api), [model-specific voice list](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list), [error codes](https://help.aliyun.com/zh/model-studio/error-code).

## MiniMax

- Endpoint: `https://api.minimax.cn/v1/t2a_v2`. Recommended initial model/voice: `speech-2.8-hd` / `male-qn-qingse` (Mandarin, youthful male), both present in the current official examples/list. `female-shaonv` and `female-tianmei` are other listed Mandarin system voices.
- Authentication: `Authorization: Bearer <apiKey>`. The current synchronous HTTP contract does not require an additional GroupId field. Use an API key for this platform/endpoint, with speech access and available balance.
- Requests explicitly set `stream: false`, `output_format: hex`, `voice_setting.{voice_id,speed,vol:1,pitch:0}`, and `audio_setting.{sample_rate,format:wav,channel:1}`. WAV is supported in nonstreaming mode. Bitrate is omitted because it applies to MP3.
- Sampling rates: 8000, 16000, 22050, 24000, 32000, 44100 Hz. Adapter default: 24000 Hz. Speed: 0.5–2.0, default 1.0. Text must be shorter than 10000 characters; documentation recommends streaming above 3000, so keep desktop chunks within 3000.
- The adapter checks numeric `base_resp.status_code === 0` before decoding any audio and requires `data.status === 2`. Hex must be valid and its decoded bytes must pass PCM WAV validation. Incomplete streams, URL output, MP3 payloads and malformed/missing status envelopes are rejected. Business status is checked even when HTTP returns 200; codes such as 1004 (authentication), 1002/1039 (limits), and 2013 (parameters) remain visible without raw service text.

Sources: [synchronous HTTP API](https://platform.minimax.cn/docs/api-reference/speech-t2a-http), [full API schema](https://platform.minimax.cn/docs/api-reference/speech-t2a-http.md), [system voices](https://platform.minimax.cn/docs/faq/system-voice-id).

## Verification

`node --test tests/providers-aliyun-minimax.test.js` exercises real local HTTP requests, authorization and body mapping, signed-URL credential isolation, provider failures, completed-response requirements, malformed audio, untrusted download origins, HTTP 401, and cancellation during synthesis/download. Global configuration validation owns endpoint/credential/range validation before dispatch; these modules own protocol mapping and response validation.
