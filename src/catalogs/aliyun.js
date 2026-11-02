import systemVoices from './aliyun-voices.json' with { type: 'json' };
import qwenVoices from './qwen-voices.json' with { type: 'json' };
import { getJson, postJson, requestUrl, wsRequestUrl } from '../transport.js';

// Models supported by the Aliyun HTTP SpeechSynthesizer and DashScope tts_v2 WebSocket adapters.
const MODELS = [
  { id: 'cosyvoice-v3-flash', label: 'CosyVoice 3 Flash · 情感表达' },
  { id: 'cosyvoice-v3-plus', label: 'CosyVoice 3 Plus · 精选音色' },
  { id: 'cosyvoice-v3.5-flash', label: 'CosyVoice 3.5 Flash · 复刻/设计音色' },
  { id: 'cosyvoice-v3.5-plus', label: 'CosyVoice 3.5 Plus · 复刻/设计音色' },
  { id: 'cosyvoice-v2', label: 'CosyVoice 2 · 丰富音色' },
  { id: 'qwen-audio-3.1-tts-plus', label: 'Qwen-Audio 3.1 TTS Plus · 超自然拟人（WS）' },
  { id: 'qwen-audio-3.1-tts-flash', label: 'Qwen-Audio 3.1 TTS Flash · 快速合成（WS）' },
];
const MODEL_IDS = new Set(MODELS.map(model => model.id));
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_ENTRIES = 2000;
const MAX_DETAILS = 100;
const DETAIL_CONCURRENCY = 4;
const SYNTHESIS_SUFFIX = /\/(?:api\/v1\/services\/audio\/tts\/SpeechSynthesizer|api-ws\/v1\/inference)\/?$/;

// Each model has its own official voice table. IDs cannot be derived from
// CosyVoice names or assumed to work across Qwen Plus and Flash.
const PRESET_VOICES = [...systemVoices, ...qwenVoices];

function cancelled(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('操作已取消。', 'AbortError');
}

function outputOf(response) {
  if (!response || response.code || response.error || response.success === false || !response.output) {
    throw new Error('阿里云目录暂不可用。');
  }
  return response.output;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value);
}

function catalogEndpoints(endpoint) {
  const raw = new URL(endpoint);
  const url = (raw.protocol === 'ws:' || raw.protocol === 'wss:') ? wsRequestUrl(endpoint) : requestUrl(endpoint);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  // Replace a documented suffix only: gateways retain their tenant path, and
  // unknown routes/query parameters must not send credentials to guessed URLs.
  if (url.search || !SYNTHESIS_SUFFIX.test(url.pathname)) throw new Error('阿里云目录请求地址无法识别。');
  const models = new URL(url);
  models.pathname = models.pathname.replace(SYNTHESIS_SUFFIX, '/api/v1/models');
  const voices = new URL(url);
  voices.pathname = voices.pathname.replace(SYNTHESIS_SUFFIX, '/api/v1/services/audio/tts/customization');
  return { models, voices };
}

export function builtinAliyunCatalog() {
  return {
    models: MODELS.map(model => ({ ...model })),
    voices: PRESET_VOICES.map(voice => ({ ...voice, models: [...voice.models] })),
    source: 'preset',
    note: '阿里云官方系统音色预置目录（含 CosyVoice 与 Qwen-Audio 3.1 TTS）；3.5 系列仅支持账号的复刻或设计音色。',
  };
}

async function listModels(endpoint, headers, signal) {
  const found = new Map();
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES && seen < MAX_ENTRIES; page++) {
    cancelled(signal);
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ capabilities: 'TTS', language: 'zh-CN', page_no: String(page), page_size: String(PAGE_SIZE) });
    const output = outputOf(await getJson(url.href, headers, signal));
    if (!Array.isArray(output.models)) throw new Error('阿里云模型目录格式无效。');
    for (const entry of output.models.slice(0, Math.min(PAGE_SIZE, MAX_ENTRIES - seen))) {
      seen++;
      const known = MODELS.find(model => model.id === entry?.model);
      if (known) found.set(known.id, { ...known });
    }
    const total = Number(output.total);
    if (output.models.length < PAGE_SIZE || (Number.isSafeInteger(total) && total >= 0 && seen >= total)) {
      return { models: [...found.values()], truncated: false };
    }
  }
  return { models: [...found.values()], truncated: true };
}

async function listVoices(endpoint, headers, signal) {
  const found = new Map();
  let seen = 0;
  for (let page = 0; page < MAX_PAGES && seen < MAX_ENTRIES; page++) {
    cancelled(signal);
    const output = outputOf(await postJson(endpoint, {
      model: 'voice-enrollment',
      input: { action: 'list_voice', page_index: page, page_size: PAGE_SIZE },
    }, headers, signal));
    if (!Array.isArray(output.voice_list)) throw new Error('阿里云音色目录格式无效。');
    for (const voice of output.voice_list.slice(0, Math.min(PAGE_SIZE, MAX_ENTRIES - seen))) {
      seen++;
      if (validId(voice?.voice_id) && voice.status === 'OK') found.set(voice.voice_id, voice);
    }
    if (output.voice_list.length < PAGE_SIZE) return { voices: [...found.values()], truncated: false };
  }
  return { voices: [...found.values()], truncated: true };
}

async function resolveVoiceModels(rows, endpoint, headers, signal) {
  const resolved = new Array(rows.length);
  let next = 0;
  let unverified = 0;
  async function worker() {
    while (next < rows.length) {
      const index = next++;
      cancelled(signal);
      const row = rows[index];
      let target;
      if (index < MAX_DETAILS) {
        try {
          const output = outputOf(await postJson(endpoint, {
            model: 'voice-enrollment', input: { action: 'query_voice', voice_id: row.voice_id },
          }, headers, signal));
          if (output.status && output.status !== 'OK') continue;
          if (typeof output.target_model === 'string') {
            // Confirmed voices for another API/model are not offered by this adapter.
            if (!MODEL_IDS.has(output.target_model)) continue;
            target = output.target_model;
          }
        } catch {
          cancelled(signal);
        }
      }
      const voice = { id: row.voice_id, label: `自定义音色 · ${row.voice_id}`, kind: 'custom' };
      if (target) voice.models = [target];
      else {
        voice.label = `自定义音色（模型待确认） · ${row.voice_id}`;
        unverified++;
      }
      resolved[index] = voice;
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, rows.length) }, worker));
  return { voices: resolved.filter(Boolean), unverified };
}

export async function fetchAliyunCatalog(cfg, credentials, signal) {
  cancelled(signal);
  const preset = builtinAliyunCatalog();
  if (!credentials?.apiKey?.trim()) {
    return { ...preset, note: `未配置阿里云 API Key，显示官方预置目录。${preset.note}` };
  }
  let endpoints;
  try {
    endpoints = catalogEndpoints(cfg.endpoint);
  } catch {
    return { ...preset, note: '阿里云请求地址无法推导目录接口，显示官方预置目录；可手动填写。' };
  }
  const endpoint = endpoints.voices.href;
  const headers = { authorization: `Bearer ${credentials.apiKey}` };
  const [modelsResult, voicesResult] = await Promise.allSettled([
    listModels(endpoints.models, headers, signal),
    listVoices(endpoint, headers, signal),
  ]);
  cancelled(signal);
  const notes = ['系统音色来自阿里云官方预置表。'];
  let models = preset.models;
  let live = false;
  if (modelsResult.status === 'fulfilled' && modelsResult.value.models.length) {
    models = modelsResult.value.models;
    live = true;
    if (modelsResult.value.truncated) notes.push('模型查询已达分页上限，仅显示已取得的兼容模型。');
  } else notes.push('在线模型目录暂不可用，保留预置模型。');

  let customVoices = [];
  if (voicesResult.status === 'fulfilled') {
    live = true;
    const details = await resolveVoiceModels(voicesResult.value.voices, endpoint, headers, signal);
    customVoices = details.voices;
    if (voicesResult.value.truncated) notes.push('账号音色查询已达 2000 条或 20 页上限。');
    if (details.unverified) notes.push('部分自定义音色的模型待确认，请按原有模型手动填写使用。');
    else notes.push(`已查询账号可用自定义音色 ${customVoices.length} 个。`);
  } else notes.push('账号音色查询暂不可用，可使用系统音色或手动填写音色 ID。');
  cancelled(signal);
  const voices = new Map(preset.voices.map(voice => [voice.id, voice]));
  for (const voice of customVoices) if (!voices.has(voice.id)) voices.set(voice.id, voice);
  return { models, voices: [...voices.values()], source: live ? 'mixed' : 'preset', note: notes.join('') };
}
