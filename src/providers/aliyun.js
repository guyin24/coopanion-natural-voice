import {
  clearIdleAliyunSockets,
  prewarmAliyunSocket,
  createAliyunStream,
} from "./aliyun-stream.js";
import { postJson, downloadAudio } from "../transport.js";
import {
  MAX_AUDIO_BYTES,
  pcmToWave,
  validateWave,
  decodeBase64,
} from "../audio.js";
import { DEFAULT_SPEECH_INSTRUCTION } from "../config.js";

// Documented OSS buckets where Alibaba Cloud DashScope / Bailian hosts signed audio results.
const AUDIO_HOSTS = [
  "dashscope-result-bj.oss-cn-beijing.aliyuncs.com",
  "dashscope-result-sh.oss-cn-shanghai.aliyuncs.com",
  "dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com",
  "dashscope-result-hz.oss-cn-hangzhou.aliyuncs.com",
  "dashscope-result-ap-southeast-1.oss-ap-southeast-1.aliyuncs.com",
];

const HTTP_SYNTH_SUFFIX =
  /\/api\/v1\/services\/audio\/tts\/SpeechSynthesizer\/?$/;
const MULTIMODAL_SUFFIX =
  /\/api\/v1\/services\/aigc\/multimodal-generation\/generation\/?$/;
const WS_INFERENCE_SUFFIX = /\/api-ws\/v1\/inference\/?$/;
const WS_NEGATIVE_TTL_MS = 5 * 60 * 1000;

const wsNegativeCache = new Map();

function wsNegativeKey(wsEndpoint, model) {
  return `${wsEndpoint}|${String(model ?? "").trim()}`;
}

export function isAliyunWsNegativelyCached(wsEndpoint, model) {
  if (isAliyunWsModel(model)) return false;
  const key = wsNegativeKey(wsEndpoint, model);
  const expiresAt = wsNegativeCache.get(key);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    wsNegativeCache.delete(key);
    return false;
  }
  return true;
}

export function markAliyunWsUnsupported(wsEndpoint, model) {
  if (isAliyunWsModel(model)) return;
  wsNegativeCache.set(
    wsNegativeKey(wsEndpoint, model),
    Date.now() + WS_NEGATIVE_TTL_MS,
  );
}

export function isAliyunWsModel(model = "") {
  return /^(?:qwen-audio|cosyvoice-v1|sambert)/i.test(String(model).trim());
}

export function isAliyunMultimodalModel(model = "") {
  return /^qwen3?-tts/i.test(String(model).trim());
}

export function normalizeAliyunVoice(model = "", voice = "") {
  const m = String(model).trim();
  const v = String(voice).trim();
  // Keep compatibility for these known system-voice aliases only. Custom IDs
  // are opaque, and adding/removing a suffix can change them into invalid IDs.
  if (m === "qwen-audio-3.1-tts-plus" || m === "qwen-audio-3.1-tts-flash") {
    if (v === "longanhuan" || v === "longanhuan_v3") return "longanhuan_v3.1";
    if (m === "qwen-audio-3.1-tts-flash" && v === "longanyang")
      return "longanyang_v3.1";
  } else if (m === "cosyvoice-v3-plus" || m === "cosyvoice-v3-flash") {
    if (v === "longanyang_v3.1") return "longanyang";
    if (v === "longanhuan_v3.1") return "longanhuan";
  }
  return v;
}

export function toAliyunWsUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.pathname === "/") url.pathname = "/api-ws/v1/inference";
  else
    url.pathname = url.pathname
      .replace(HTTP_SYNTH_SUFFIX, "/api-ws/v1/inference")
      .replace(MULTIMODAL_SUFFIX, "/api-ws/v1/inference");
  return url.href;
}

export function toAliyunHttpUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  if (url.pathname === "/")
    url.pathname = "/api/v1/services/audio/tts/SpeechSynthesizer";
  else
    url.pathname = url.pathname
      .replace(
        WS_INFERENCE_SUFFIX,
        "/api/v1/services/audio/tts/SpeechSynthesizer",
      )
      .replace(
        MULTIMODAL_SUFFIX,
        "/api/v1/services/audio/tts/SpeechSynthesizer",
      );
  return url.href;
}

export function resolveAliyunEndpoint(cfg, options = {}) {
  const url = new URL(cfg.endpoint);
  const model = String(cfg.model ?? "").trim();
  if (
    isAliyunWsModel(model) ||
    (options.preferWs && !isAliyunMultimodalModel(model))
  ) {
    return { mode: "ws", endpoint: toAliyunWsUrl(url.href) };
  }
  if (isAliyunMultimodalModel(model)) {
    if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol === "ws:") url.protocol = "http:";
    if (url.pathname === "/")
      url.pathname = "/api/v1/services/aigc/multimodal-generation/generation";
    else
      url.pathname = url.pathname
        .replace(
          HTTP_SYNTH_SUFFIX,
          "/api/v1/services/aigc/multimodal-generation/generation",
        )
        .replace(
          WS_INFERENCE_SUFFIX,
          "/api/v1/services/aigc/multimodal-generation/generation",
        );
    return { mode: "multimodal", endpoint: url.href };
  }
  if (
    (url.protocol === "ws:" || url.protocol === "wss:") &&
    !url.hostname.endsWith(".maas.aliyuncs.com")
  ) {
    return { mode: "ws", endpoint: url.href };
  }
  return { mode: "http", endpoint: toAliyunHttpUrl(url.href) };
}

function finalizeWave(audio) {
  // Live CosyVoice can leave these exact length placeholders in a completed
  // canonical PCM WAV. Finalize that header; keep all other WAV checks strict.
  if (
    audio.length >= 44 &&
    audio.toString("ascii", 0, 4) === "RIFF" &&
    audio.toString("ascii", 8, 16) === "WAVEfmt " &&
    audio.readUInt32LE(16) === 16 &&
    audio.toString("ascii", 36, 40) === "data" &&
    audio.readUInt32LE(4) === 0x7fffffbf &&
    audio.readUInt32LE(40) === 0x7fffff9b
  ) {
    audio = Buffer.from(audio);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.writeUInt32LE(audio.length - 44, 40);
  }
  return validateWave(audio);
}

function speakingStyle(cfg) {
  if (!/^qwen-audio-3\.[01]-tts-(plus|flash)$/.test(String(cfg.model ?? "")))
    return {};
  const value =
    cfg.speechInstruction === undefined
      ? DEFAULT_SPEECH_INSTRUCTION
      : cfg.speechInstruction;
  const instruction = typeof value === "string" ? value.trim() : "";
  return instruction ? { instruction } : {};
}

export function clearWarmAliyunTasks() {
  clearIdleAliyunSockets();
  wsNegativeCache.clear();
}
export function prewarmAliyunWsTask(cfg, credentials) {
  if (!credentials?.apiKey) return null;
  try {
    const resolved = resolveAliyunEndpoint(cfg, { preferWs: true });
    if (
      resolved.mode !== "ws" ||
      isAliyunWsNegativelyCached(resolved.endpoint, cfg.model)
    )
      return null;
    return prewarmAliyunSocket(resolved.endpoint, credentials);
  } catch {
    return null;
  }
}
export function createAliyunDuplexSession(
  cfg,
  credentials,
  signal,
  options = {},
) {
  const resolved = resolveAliyunEndpoint(cfg, { preferWs: true });
  if (isAliyunWsNegativelyCached(resolved.endpoint, cfg.model)) return null;
  return createAliyunStream(
    resolved.endpoint,
    { ...cfg, voice: normalizeAliyunVoice(cfg.model, cfg.voice) },
    credentials,
    signal,
    options,
    speakingStyle(cfg),
    finalizeWave,
  );
}
async function synthesizeAliyunWs(
  endpoint,
  cfg,
  credentials,
  text,
  signal,
  options = {},
) {
  const session = createAliyunDuplexSession(
    { ...cfg, endpoint },
    credentials,
    signal,
    options,
  );
  if (!session) throw new Error("该端点暂不支持 WebSocket 语音合成。");
  session.pushText(text);
  session.finishText();
  return session.promise;
}

async function synthesizeAliyunMultimodal(
  endpoint,
  cfg,
  credentials,
  text,
  signal,
) {
  const sampleRate = cfg.sampleRate ?? 24000;
  const response = await postJson(
    endpoint,
    {
      model: cfg.model,
      input: {
        text,
        voice: cfg.voice,
      },
    },
    { authorization: `Bearer ${credentials.apiKey}` },
    signal,
  );

  if (response?.code || response?.error) {
    const code =
      typeof response.code === "string" && /^[\w.-]{1,100}$/.test(response.code)
        ? `（${response.code}）`
        : "";
    throw new Error(
      `阿里云语音合成失败${code}，请检查地域、密钥、模型与音色。`,
    );
  }
  const inlineData = response?.output?.audio?.data;
  if (typeof inlineData === "string" && inlineData.trim()) {
    const buf = decodeBase64(inlineData.trim());
    if (
      buf.length >= 44 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WAVE"
    ) {
      return finalizeWave(buf);
    }
    return pcmToWave(buf, sampleRate);
  }
  const url = response?.output?.audio?.url;
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("阿里云语音合成未返回完成的音频下载地址。");
  }
  const audio = await downloadAudio(url, signal, {
    baseUrl: endpoint,
    allowedSuffixes: AUDIO_HOSTS,
  });
  return finalizeWave(audio);
}

async function synthesizeAliyunHttp(endpoint, cfg, credentials, text, signal) {
  const voice = normalizeAliyunVoice(cfg.model, cfg.voice);
  const response = await postJson(
    endpoint,
    {
      model: cfg.model,
      input: {
        text,
        voice,
        format: "wav",
        sample_rate: cfg.sampleRate ?? 24000,
        rate: cfg.speed ?? 1,
      },
    },
    { authorization: `Bearer ${credentials.apiKey}` },
    signal,
  );

  if (response?.code || response?.error) {
    const code =
      typeof response.code === "string" && /^[\w.-]{1,100}$/.test(response.code)
        ? `（${response.code}）`
        : "";
    throw new Error(
      `阿里云 CosyVoice 合成失败${code}，请检查地域、密钥、模型与音色。`,
    );
  }
  const url = response?.output?.audio?.url;
  if (
    response?.output?.finish_reason !== "stop" ||
    typeof url !== "string" ||
    !url.trim()
  ) {
    throw new Error("阿里云 CosyVoice 未返回完成的音频下载地址。");
  }
  const audio = await downloadAudio(url, signal, {
    baseUrl: endpoint,
    allowedSuffixes: AUDIO_HOSTS,
  });
  return finalizeWave(audio);
}

export async function synthesizeAliyun(
  cfg,
  credentials,
  text,
  signal,
  options = {},
) {
  const { mode, endpoint } = resolveAliyunEndpoint(cfg);
  if (mode === "ws") {
    return synthesizeAliyunWs(
      endpoint,
      cfg,
      credentials,
      text,
      signal,
      options,
    );
  }
  if (mode === "multimodal") {
    return synthesizeAliyunMultimodal(endpoint, cfg, credentials, text, signal);
  }
  // For CosyVoice models on Alibaba Cloud (*.aliyuncs.com) or when preferWs is enabled,
  // try low-latency DashScope tts_v2 WebSocket first, and automatically fall back to HTTP if WS fails.
  const parsedUrl = new URL(endpoint);
  let wsFailed = false;
  let wsEndpoint = null;
  if (options.preferWs || parsedUrl.hostname.endsWith(".aliyuncs.com")) {
    wsEndpoint = toAliyunWsUrl(endpoint);
    if (!isAliyunWsNegativelyCached(wsEndpoint, cfg.model)) {
      try {
        return await synthesizeAliyunWs(
          wsEndpoint,
          cfg,
          credentials,
          text,
          signal,
          options,
        );
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError" || err?.audioEmitted)
          throw err;
        wsFailed = true;
      }
    }
  }
  const httpAudio = await synthesizeAliyunHttp(
    endpoint,
    cfg,
    credentials,
    text,
    signal,
  );
  if (wsFailed && wsEndpoint) {
    markAliyunWsUnsupported(wsEndpoint, cfg.model);
  }
  return httpAudio;
}
