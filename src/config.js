export const KEY_NAME = "CORTICO_NATURAL_VOICE_API_KEY";
export const DEFAULT_SPEECH_INSTRUCTION =
  "像和熟悉的人面对面聊天一样自然地说话，根据文字内容表达恰当的情绪，语气亲切，停顿和重音自然，不要播报腔，也不要夸张表演。";

const label = (zh, en) => ({ zh, en });
const apiKey = {
  id: "apiKey",
  label: label("API Key", "API key"),
  required: true,
};
const commonRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
const metadata = (zh, en, docs, extra = {}) => ({
  label: label(zh, en),
  credentials: [apiKey],
  speedMin: 0.25,
  speedMax: 4,
  sampleRates: commonRates,
  docs,
  ...extra,
});

export const PROVIDERS = {
  siliconflow: metadata(
    "硅基流动",
    "SiliconFlow",
    "https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech",
    { sampleRates: [8000, 16000, 24000, 32000, 44100] },
  ),
  openai: metadata(
    "OpenAI",
    "OpenAI",
    "https://developers.openai.com/api/docs/guides/text-to-speech",
    { sampleRates: [24000], showSampleRate: false },
  ),
  compatible: metadata(
    "OpenAI 兼容服务",
    "OpenAI-compatible service",
    "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create",
    { sampleRates: [24000], showSampleRate: false },
  ),
  aliyun: metadata(
    "阿里云百炼 · CosyVoice / Qwen",
    "Alibaba Cloud CosyVoice / Qwen",
    "https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api",
    {
      speedMin: 0.5,
      speedMax: 2,
      sampleRates: [8000, 12000, 16000, 22050, 24000, 44100, 48000],
    },
  ),
  volcengine: metadata(
    "火山引擎 · 豆包语音",
    "Volcano Engine Doubao",
    "https://www.volcengine.com/docs/6561/1598757",
    {
      speedMin: 0.5,
      speedMax: 2,
      modelLabel: label("资源 ID", "Resource ID"),
      credentials: [
        apiKey,
        {
          id: "appId",
          label: label(
            "旧版鉴权 App ID（可选）",
            "Legacy authentication App ID (optional)",
          ),
          required: false,
        },
      ],
    },
  ),
  tencent: metadata(
    "腾讯云语音合成",
    "Tencent Cloud TTS",
    "https://cloud.tencent.com/document/api/1073/37995",
    {
      speedMin: 0.6,
      speedMax: 2.5,
      sampleRates: [8000, 16000, 24000],
      modelLabel: label("ModelType（固定为 1）", "ModelType (1)"),
      credentials: [
        {
          id: "secretId",
          label: label("SecretId", "SecretId"),
          required: true,
        },
        {
          id: "secretKey",
          label: label("SecretKey", "SecretKey"),
          required: true,
        },
        {
          id: "sessionToken",
          label: label(
            "临时凭据 Token（可选）",
            "Temporary session token (optional)",
          ),
          required: false,
        },
      ],
    },
  ),
  minimax: metadata(
    "MiniMax",
    "MiniMax",
    "https://platform.minimax.cn/docs/api-reference/speech-t2a-http",
    {
      speedMin: 0.5,
      speedMax: 2,
      sampleRates: [8000, 16000, 22050, 24000, 32000, 44100],
    },
  ),
  elevenlabs: metadata(
    "ElevenLabs",
    "ElevenLabs",
    "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
    {
      speedMin: 0.7,
      speedMax: 1.2,
      sampleRates: [16000, 22050, 24000, 44100, 48000],
    },
  ),
  azure: metadata(
    "Azure 语音服务",
    "Azure Speech",
    "https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech",
    {
      speedMin: 0.5,
      speedMax: 2,
      sampleRates: [8000, 16000, 22050, 24000, 44100, 48000],
      showModel: false,
    },
  ),
};

const preset = (provider, endpoint, model, voice, extra = {}) => ({
  provider,
  endpoint,
  model,
  voice,
  speed: 1,
  volume: 1,
  sampleRate: 24000,
  region: "",
  workspaceId: "",
  ...extra,
});
export const PRESETS = {
  siliconflow: preset(
    "siliconflow",
    "https://api.siliconflow.cn/v1/audio/speech",
    "FunAudioLLM/CosyVoice2-0.5B",
    "FunAudioLLM/CosyVoice2-0.5B:claire",
  ),
  openai: preset(
    "openai",
    "https://api.openai.com/v1/audio/speech",
    "gpt-4o-mini-tts",
    "coral",
  ),
  compatible: preset("compatible", "", "", ""),
  aliyun: preset(
    "aliyun",
    "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    "cosyvoice-v3-plus",
    "longanyang",
    { region: "cn-beijing" },
  ),
  volcengine: preset(
    "volcengine",
    "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    "seed-tts-2.0",
    "zh_female_vv_uranus_bigtts",
  ),
  tencent: preset(
    "tencent",
    "https://tts.tencentcloudapi.com/",
    "1",
    "101001",
    { sampleRate: 16000, region: "ap-guangzhou" },
  ),
  minimax: preset(
    "minimax",
    "https://api.minimax.cn/v1/t2a_v2",
    "speech-2.8-hd",
    "female-shaonv",
  ),
  elevenlabs: preset(
    "elevenlabs",
    "https://api.elevenlabs.io/v1/text-to-speech/{voice}",
    "eleven_multilingual_v2",
    "JBFqnCBsd6RMkjVDRZzb",
  ),
  azure: preset(
    "azure",
    "https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
    "neural",
    "zh-CN-XiaoxiaoNeural",
    { region: "eastasia" },
  ),
};
export const DEFAULTS = {
  enabled: false,
  ...PRESETS.siliconflow,
  speechInstruction: DEFAULT_SPEECH_INSTRUCTION,
  modelTone: true,
  toneMode: "mood",
  autoRead: true,
  interruptOnInput: true,
  maxChars: 1200,
};

function normalizeAliyunWorkspace(endpoint, workspaceId) {
  let ws = typeof workspaceId === "string" ? workspaceId.trim() : "";
  // v0.4 treated ws- as a protocol prefix. It belongs to the workspace ID.
  // Migrate only that known official template; concrete/custom hosts stay literal.
  const legacy =
    /^((?:https?|wss?):\/\/)ws-\{workspaceId\}(?=\.[a-z0-9-]+\.maas\.aliyuncs\.com(?::\d+)?(?:\/|$))/i;
  if (typeof endpoint === "string" && legacy.test(endpoint)) {
    endpoint = endpoint.replace(legacy, "$1{workspaceId}");
    if (ws && !/^ws-/i.test(ws)) ws = `ws-${ws}`;
  }
  if (typeof endpoint === "string" && !endpoint.includes("{workspaceId}")) {
    try {
      const host = new URL(endpoint).hostname;
      const m =
        /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.[a-z0-9-]+\.maas\.aliyuncs\.com$/i.exec(
          host,
        );
      if (m && (!ws || m[1] === `ws-${ws}`)) ws = m[1];
    } catch {}
  }
  return { endpoint, workspaceId: ws };
}

export function normalizeConfig(cfg = {}) {
  let provider = cfg.provider;
  if (!provider) {
    if (!cfg.endpoint) provider = "siliconflow";
    else {
      let hostname;
      try {
        hostname = new URL(cfg.endpoint).hostname.toLowerCase();
      } catch {
        hostname = "";
      }
      provider =
        hostname === "api.siliconflow.cn"
          ? "siliconflow"
          : hostname === "api.openai.com"
            ? "openai"
            : "compatible";
    }
  }
  if (!Object.hasOwn(PROVIDERS, provider))
    throw new Error("请选择有效的 TTS 服务。");
  const merged = { ...DEFAULTS, ...PRESETS[provider], ...cfg, provider };
  if (typeof merged.speechInstruction === "string")
    merged.speechInstruction = merged.speechInstruction.trim();
  if (merged.volume === undefined) merged.volume = 1;
  if (provider === "aliyun") {
    Object.assign(
      merged,
      normalizeAliyunWorkspace(merged.endpoint, merged.workspaceId),
    );
  }
  return merged;
}

function convergeEndpointPath(provider, url, voice, local) {
  if (local) return;
  const p = url.pathname;
  if (
    provider === "siliconflow" ||
    provider === "openai" ||
    (provider === "compatible" &&
      (url.protocol === "https:" || url.protocol === "http:"))
  ) {
    if (p === "/" || p === "/v1" || p === "/v1/")
      url.pathname = "/v1/audio/speech";
  } else if (provider === "aliyun") {
    if (p === "/api-ws/v1/inference" || p === "/api-ws/v1/inference/") {
      if (url.protocol === "https:") url.protocol = "wss:";
      url.pathname = "/api-ws/v1/inference";
    }
    if (url.protocol === "wss:") {
      if (
        p === "/" ||
        p === "/api-ws" ||
        p === "/api-ws/v1" ||
        p === "/api-ws/v1/"
      )
        url.pathname = "/api-ws/v1/inference";
    } else if (url.protocol === "https:") {
      if (p === "/" || p === "/api" || p === "/api/v1" || p === "/api/v1/") {
        url.pathname = "/api/v1/services/audio/tts/SpeechSynthesizer";
      }
    }
  } else if (provider === "minimax") {
    if (p === "/" || p === "/v1" || p === "/v1/") url.pathname = "/v1/t2a_v2";
  } else if (provider === "volcengine") {
    if (p === "/" || p === "/api/v3/tts" || p === "/api/v3/tts/")
      url.pathname = "/api/v3/tts/unidirectional";
  } else if (provider === "azure") {
    if (p === "/") url.pathname = "/cognitiveservices/v1";
  } else if (provider === "elevenlabs") {
    if (
      p === "/" ||
      p === "/v1" ||
      p === "/v1/text-to-speech" ||
      p === "/v1/text-to-speech/"
    ) {
      url.pathname = `/v1/text-to-speech/${encodeURIComponent(voice)}`;
    }
  }
}

export function validateConfig(value) {
  const cfg = normalizeConfig(value);
  if (
    typeof cfg.speechInstruction !== "string" ||
    Array.from(cfg.speechInstruction).length > 500
  )
    throw new Error(
      "说话风格须为不超过 500 字的文本，可留空使用模型默认语气。",
    );
  if (typeof cfg.modelTone !== "boolean")
    throw new Error("每句语气开关须为布尔值。");
  if (!["mood", "ordinal"].includes(cfg.toneMode))
    throw new Error("请选择表情跟随或简短语气标注。");
  const platform = PROVIDERS[cfg.provider];
  let endpoint = cfg.endpoint;
  if (typeof endpoint !== "string" || !endpoint.trim())
    throw new Error("请填写 TTS 请求地址。");
  if (endpoint.includes("{workspaceId}")) {
    if (
      typeof cfg.workspaceId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(cfg.workspaceId)
    )
      throw new Error("请填写有效的 Workspace ID（阿里云北京业务空间）。");
    endpoint = endpoint.replaceAll("{workspaceId}", cfg.workspaceId);
  }
  if (endpoint.includes("{region}")) {
    if (
      typeof cfg.region !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(cfg.region)
    )
      throw new Error("请填写有效的语音服务地域。");
    endpoint = endpoint.replaceAll("{region}", cfg.region);
  }
  if (
    typeof cfg.model !== "string" ||
    !cfg.model.trim() ||
    typeof cfg.voice !== "string" ||
    !cfg.voice.trim()
  )
    throw new Error("请填写 TTS 模型和音色。");
  endpoint = endpoint.replaceAll("{voice}", encodeURIComponent(cfg.voice));
  if (/[{}]/.test(endpoint))
    throw new Error("TTS 请求地址仍有未填写的占位参数。");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("请填写有效的 TTS 请求地址。");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowWs = cfg.provider === "aliyun" || cfg.provider === "compatible";
  const validProto =
    url.protocol === "https:" ||
    (local && url.protocol === "http:") ||
    (allowWs && (url.protocol === "wss:" || (local && url.protocol === "ws:")));
  if (!validProto || url.username || url.password || url.search || url.hash)
    throw new Error(
      "TTS 地址须使用 HTTPS（本机可用 HTTP），不得包含账号、查询参数或片段。",
    );
  convergeEndpointPath(cfg.provider, url, cfg.voice, local);
  if (
    !Number.isFinite(cfg.speed) ||
    cfg.speed < platform.speedMin ||
    cfg.speed > platform.speedMax
  )
    throw new Error(
      `此服务的语速须在 ${platform.speedMin} 到 ${platform.speedMax} 之间。`,
    );
  if (!Number.isFinite(cfg.volume) || cfg.volume < 0.25 || cfg.volume > 3)
    throw new Error("音量倍率须在 0.25 到 3 之间。");
  if (
    !Number.isInteger(cfg.maxChars) ||
    cfg.maxChars < 50 ||
    cfg.maxChars > 4000
  )
    throw new Error("单条字数须在 50 到 4000 之间。");
  if (
    !Number.isInteger(cfg.sampleRate) ||
    !platform.sampleRates.includes(cfg.sampleRate)
  )
    throw new Error("此服务不支持所选采样率。");
  if (
    cfg.provider === "tencent" &&
    (cfg.model !== "1" ||
      !/^\d+$/.test(cfg.voice) ||
      !Number.isSafeInteger(Number(cfg.voice)))
  )
    throw new Error("腾讯云 ModelType 须为 1，VoiceType 须为非负整数。");
  return url.href;
}

export function configGroup(language = "zh") {
  const text = (zh, en) => (language === "zh" ? zh : en);
  const fields = {
    provider: {
      type: "string",
      enum: Object.keys(PROVIDERS),
      title: text("语音服务", "Speech service"),
    },
    endpoint: { type: "string", title: text("TTS 请求地址", "TTS endpoint") },
    model: {
      type: "string",
      title: text("模型或资源 ID", "Model or resource ID"),
    },
    voice: { type: "string", title: text("音色", "Voice") },
    speechInstruction: {
      type: "string",
      maxLength: 500,
      title: text("说话风格（Qwen Audio）", "Speaking style (Qwen Audio)"),
    },
    modelTone: {
      type: "boolean",
      title: text(
        "让回复模型决定每句语气",
        "Let the reply model choose each line’s tone",
      ),
    },
    toneMode: {
      type: "string",
      enum: ["mood", "ordinal"],
      title: text("语气来源", "Tone source"),
    },
    speed: {
      type: "number",
      minimum: 0.25,
      maximum: 4,
      title: text("语速", "Speed"),
    },
    volume: {
      type: "number",
      minimum: 0.25,
      maximum: 3,
      title: text(
        "音量倍率（自动均衡基础上调节）",
        "Volume multiplier (over auto-normalized level)",
      ),
    },
    sampleRate: {
      type: "integer",
      enum: [8000, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
      title: text("采样率（Hz）", "Sample rate (Hz)"),
    },
    region: { type: "string", title: text("地域", "Region") },
    workspaceId: {
      type: "string",
      title: text("阿里云 Workspace ID", "Alibaba Cloud workspace ID"),
    },
    autoRead: {
      type: "boolean",
      title: text("自动朗读新回复", "Read new replies automatically"),
    },
    interruptOnInput: {
      type: "boolean",
      title: text("收到新输入时停止朗读", "Stop speech on new input"),
    },
    maxChars: {
      type: "integer",
      minimum: 50,
      maximum: 4000,
      title: text("单条最多朗读字数", "Maximum characters per reply"),
    },
  };
  return {
    id: "world:natural-voice",
    owner: "world:natural-voice",
    schema: {
      type: "object",
      title: text("自然语音", "Natural Voice"),
      properties: Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [
          `worlds.natural-voice.${key}`,
          { ...field, "x-hot": true },
        ]),
      ),
    },
  };
}
