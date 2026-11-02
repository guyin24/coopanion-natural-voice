# 火山引擎与腾讯云适配器

接口资料核对：2026-10-31。验证使用本机 HTTP 服务与公开签名样例，未调用付费云合成，未验证账号额度、音色授权或实际发音质量。

## 火山引擎 / 豆包语音

使用 [V3 HTTP Chunked/SSE 官方协议](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh)；默认完整地址为 `https://openspeech.bytedance.com/api/v3/tts/unidirectional`。配置完整 SSE 地址也可读取。

- 新版凭据填 `apiKey`，发送 `X-Api-Key`。旧版同时填写 `appId` 与 Access Token（仍保存到 `apiKey`），发送 `X-Api-App-Id` / `X-Api-Access-Key`。两种方式互斥。
- `cfg.model` 是资源 ID（`X-Api-Resource-Id`），默认 `seed-tts-2.0`；`cfg.voice` 是 speaker ID，默认 `zh_female_vv_uranus_bigtts`。资源与音色须匹配且已获授权。每次请求生成 UUID。
- `req_params.audio_params` 请求单声道 16 位 PCM；逐帧解码 base64 并拼接后包一层 WAV。采样率默认 24000，可选 8000、16000、22050、24000、32000、44100、48000。统一倍速转为 `speech_rate=(speed-1)*100`，范围限制到 -50～100，取整数。
- `code=0` 是音频或字幕数据帧，`code=20000000` 为成功结束。任何业务失败、缺失状态、缺失结束帧、空音频或无效 PCM 均拒绝播放，避免读出不完整结果。

[新版 HTTP 参数页](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh) 的 `req_params.model` 是复刻音色的模型子版本，与资源 ID 不是同一字段；本版本未提供该子版本配置，默认使用普通 TTS 音色。

## 腾讯云

使用 [TextToVoice 官方 API](https://cloud.tencent.com/document/api/1073/37995)，默认地址 `https://tts.tencentcloudapi.com/`，Action=`TextToVoice`，Version=`2019-08-23`。使用 Node 内置加密库执行 [TC3-HMAC-SHA256](https://cloud.tencent.com/document/api/1073/37990)，无额外 SDK。

- 凭据为 `secretId` / `secretKey`；临时密钥还可填写 `sessionToken`，作为 `X-TC-Token`。SecretKey 只用于本地签名。Region 可选，填写时发送 `X-TC-Region`。
- `cfg.model` 对应整数 ModelType，目前仅支持 `1`。音色为数字 VoiceType；默认 `101001`（智瑜），省略采样率时使用 16000。支持 8000、16000，部分音色还支持 24000；[音色与采样率官方列表](https://cloud.tencent.com/document/product/1073/92668) 中 101001 只支持 8k/16k。
- 原接口限制中文 150 字、英文 500 字母。适配器保守拆成每段最多 140 Unicode 码点且不超过 420 UTF-8 字节，不拆开代理对；各段顺序请求 `Codec=pcm`，使用不同 SessionId，最终拼接并封装 WAV。取消会停止正在进行的请求及后续分段。
- 统一倍速使用[官方换算示例](https://sdk-1300466766.cos.ap-shanghai.myqcloud.com/sample/speed_sample.tar.gz)的分段线性插值：0.6→-2、0.8→-1、1→0、1.2→1、1.5→2、2.5→6。超出范围时限制到 0.6～2.5 倍，Speed 保留两位小数。

签名使用 UTC 日期、实际 JSON 请求原文与同一 Content-Type。测试直接比较腾讯官方公开 CVM fixture 的完整签名，避免用实现本身计算预期值。两适配器的上游业务错误会移除已知凭据值；不会返回请求体或鉴权头。整体 WAV 限制 16 MiB。
