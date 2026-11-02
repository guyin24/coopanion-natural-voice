import { getJson, postJson, requestUrl } from '../transport.js';

const MAX_ITEMS = 2000;
const MAX_PAGES = 20;
const OPENAI_MODELS = ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15', 'tts-1', 'tts-1-hd'];
const OPENAI_LEGACY_VOICES = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']);
const SILICONFLOW_MODELS = ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5', 'fishaudio/fish-speech-1.5', 'fishaudio/fish-speech-1.4'];
const SILICONFLOW_VOICES = [
  ['alex', '沉稳男声'], ['benjamin', '低沉男声'], ['charles', '磁性男声'], ['david', '欢快男声'],
  ['anna', '沉稳女声'], ['bella', '激情女声'], ['claire', '温柔女声'], ['diana', '欢快女声'],
];
const modelItems = values => values.map(id => ({ id, label: id }));

function siliconflowVoices(models) {
  return models.flatMap(({ id }) => SILICONFLOW_VOICES.map(([voice, label]) => ({ id: `${id}:${voice}`, label, models: [id], kind: 'system' })));
}

export function builtinRemoteCatalog(provider) {
  let models = [], voices = [], note = '此服务暂无可查询的公开目录，请手动填写模型和音色。';
  switch (provider) {
    case 'minimax':
      models = modelItems(['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo']);
      voices = [['female-shaonv', '少女'], ['male-qn-qingse', '青涩青年'], ['Chinese (Mandarin)_Reliable_Executive', '沉稳高管'], ['Chinese (Mandarin)_News_Anchor', '新闻女声']].map(([id, label]) => ({ id, label, kind: 'system' }));
      note = '模型来自官方预置目录；音色可使用 API Key 刷新。';
      break;
    case 'elevenlabs':
      models = modelItems(['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_v3']);
      voices = [{ id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George', kind: 'system' }];
      note = '预置目录供离线选择；刷新可获取当前账号模型及音色。';
      break;
    case 'azure':
      models = modelItems(['neural']);
      voices = [['zh-CN-XiaoxiaoNeural', '晓晓', 'zh-CN'], ['zh-CN-YunxiNeural', '云希', 'zh-CN'], ['en-US-JennyNeural', 'Jenny', 'en-US']].map(([id, label, locale]) => ({ id, label, locale, kind: 'system' }));
      note = '模型固定为 neural；刷新按当前语音服务地域获取音色。';
      break;
    case 'siliconflow':
      models = modelItems(SILICONFLOW_MODELS.slice(0, 2));
      voices = siliconflowVoices(models);
      note = '系统音色来自官方预置目录；刷新同时获取语音模型及账号自定义音色。';
      break;
    case 'openai':
      models = modelItems(OPENAI_MODELS);
      voices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map(id => ({ id, label: id, kind: 'system', models: OPENAI_LEGACY_VOICES.has(id) ? [...OPENAI_MODELS] : OPENAI_MODELS.slice(0, 2) }));
      note = '音色来自官方固定目录；旧版 tts-1 系列仅支持部分音色。';
      break;
    case 'compatible':
      note = '兼容服务可尝试查询同一地址下的模型列表；音色须按服务文档手动填写，模型列表可能包含非语音模型。';
      break;
  }
  return { models, voices, source: 'preset', note };
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeLabel(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || fallback : fallback;
}

function normalizeItems(rows, convert) {
  const items = [], seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = convert(row);
    if (!item || !validId(item.id) || seen.has(item.id)) continue;
    item.label = safeLabel(item.label, item.id);
    if (item.models) item.models = item.models.filter(validId).slice(0, MAX_ITEMS);
    if (item.locale) item.locale = safeLabel(item.locale, '').slice(0, 64);
    seen.add(item.id); items.push(item);
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

function list(value) {
  if (!Array.isArray(value)) throw new Error('Invalid catalog response');
  return value;
}

function mergeItems(live, presets) {
  return normalizeItems([...live, ...presets], item => ({ ...item, ...(item.models ? { models: [...item.models] } : {}) }));
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('目录刷新已取消。', 'AbortError');
}

// Replace only a known synthesis suffix. Gateways keep both their origin and prefix.
function sibling(endpoint, suffix, replacement) {
  const url = requestUrl(endpoint);
  if (url.search || !suffix.test(url.pathname)) throw new Error('Unsupported catalog endpoint');
  url.pathname = url.pathname.replace(suffix, replacement);
  return url;
}

async function elevenVoices(url, headers, signal) {
  const rows = [], tokens = new Set();
  let token, partial = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    checkCancelled(signal);
    const request = new URL(url);
    request.searchParams.set('page_size', '100');
    request.searchParams.set('include_total_count', 'false');
    if (token) request.searchParams.set('next_page_token', token);
    let body;
    try { body = await getJson(request, headers, signal); list(body?.voices); }
    catch (error) { checkCancelled(signal); if (!rows.length) throw error; partial = true; break; }
    rows.push(...body.voices.slice(0, MAX_ITEMS - rows.length));
    if (!body.has_more) break;
    const next = body.next_page_token;
    if (rows.length >= MAX_ITEMS || page + 1 === MAX_PAGES || !validId(next) || tokens.has(next)) { partial = true; break; }
    tokens.add(next); token = next;
  }
  return { items: normalizeItems(rows, row => ({ id: row.voice_id, label: row.name, kind: ['premade', 'default'].includes(row.category) ? 'system' : 'custom', ...(typeof row.labels?.language === 'string' ? { locale: row.labels.language } : {}) })), partial };
}

export async function fetchRemoteCatalog(cfg, credentials = {}, signal) {
  checkCancelled(signal);
  const base = builtinRemoteCatalog(cfg?.provider);
  const fallback = note => ({ ...base, note: `${base.note} ${note}` });
  if (typeof credentials?.apiKey !== 'string' || !credentials.apiKey.trim()) return fallback('请先填写 API Key，再刷新在线目录。');
  const provider = cfg?.provider, headers = { Authorization: `Bearer ${credentials.apiKey}` };
  let tasks;
  try {
    switch (provider) {
      case 'minimax': {
        const url = sibling(cfg.endpoint, /\/t2a_v2\/?$/, '/get_voice');
        tasks = { voices: async () => {
          const body = await postJson(url, { voice_type: 'all' }, headers, signal);
          if (body?.base_resp?.status_code !== 0) throw new Error('MiniMax catalog request failed');
          const rows = [];
          for (const [key, kind] of [['system_voice', 'system'], ['voice_cloning', 'custom'], ['voice_generation', 'custom']]) {
            if (body[key] === undefined) continue;
            rows.push(...list(body[key]).slice(0, MAX_ITEMS).map(row => ({ ...row, kind })));
          }
          if (!['system_voice', 'voice_cloning', 'voice_generation'].some(key => Array.isArray(body[key]))) throw new Error('Invalid voice catalog');
          return { items: normalizeItems(rows, row => ({ id: row.voice_id, label: row.voice_name, kind: row.kind })) };
        } };
        break;
      }
      case 'elevenlabs': {
        const suffix = /\/v1\/text-to-speech\/[^/]+(?:\/stream)?\/?$/;
        const modelsUrl = sibling(cfg.endpoint, suffix, '/v1/models');
        const voicesUrl = sibling(cfg.endpoint, suffix, '/v2/voices');
        const auth = { 'xi-api-key': credentials.apiKey };
        tasks = {
          models: async () => ({ items: normalizeItems(list(await getJson(modelsUrl, auth, signal)), row => row.can_do_text_to_speech === true ? { id: row.model_id, label: row.name } : null) }),
          voices: () => elevenVoices(voicesUrl, auth, signal),
        };
        break;
      }
      case 'azure': {
        const url = sibling(cfg.endpoint, /\/cognitiveservices\/v1\/?$/, '/cognitiveservices/voices/list');
        tasks = { voices: async () => ({ items: normalizeItems(list(await getJson(url, { 'Ocp-Apim-Subscription-Key': credentials.apiKey }, signal)), row => ({ id: row.ShortName, label: row.LocalName || row.DisplayName, locale: row.Locale, kind: 'system' })) }) };
        break;
      }
      case 'siliconflow': {
        const modelsUrl = sibling(cfg.endpoint, /\/audio\/speech\/?$/, '/models');
        modelsUrl.searchParams.set('type', 'audio');
        const voicesUrl = sibling(cfg.endpoint, /\/audio\/speech\/?$/, '/audio/voice/list');
        tasks = {
          models: async () => ({ items: normalizeItems(list((await getJson(modelsUrl, headers, signal))?.data), row => SILICONFLOW_MODELS.includes(row.id) ? { id: row.id, label: row.id } : null) }),
          voices: async () => ({ items: normalizeItems(list((await getJson(voicesUrl, headers, signal))?.results), row => ({ id: row.uri, label: row.customName, kind: 'custom', ...(validId(row.model) ? { models: [row.model] } : {}) })) }),
        };
        break;
      }
      case 'openai':
      case 'compatible': {
        const url = sibling(cfg.endpoint, /\/audio\/speech\/?$/, '/models');
        tasks = { models: async () => ({ items: normalizeItems(list((await getJson(url, headers, signal))?.data), row => provider === 'openai' && !OPENAI_MODELS.includes(row.id) ? null : { id: row.id, label: row.name || row.id }) }) };
        break;
      }
      default: return fallback('当前服务使用预置目录。');
    }
  } catch { return fallback('当前请求地址无法推导目录接口，请手动填写或使用预置目录。'); }

  const entries = Object.entries(tasks);
  const results = await Promise.allSettled(entries.map(([, task]) => task()));
  checkCancelled(signal);
  const live = {}, notices = [];
  for (let index = 0; index < entries.length; index++) {
    const part = entries[index][0], result = results[index];
    if (result.status === 'rejected') {
      notices.push(`${part === 'models' ? '模型' : '音色'}目录未能刷新，保留预置选项；请检查凭据、权限及网络。`);
    } else {
      live[part] = result.value.items;
      if (result.value.partial) notices.push('音色目录已达到分页上限或分页中断，当前仅显示部分结果。');
    }
  }
  const models = mergeItems(live.models || [], base.models);
  let voices = mergeItems(live.voices || [], base.voices);
  if (provider === 'siliconflow') voices = mergeItems(live.voices || [], siliconflowVoices(models));
  const hasLivePart = Object.keys(live).length > 0;
  const retainedPresets = Object.entries({ models, voices }).some(([part, items]) => {
    const onlineIds = new Set((live[part] || []).map(item => item.id));
    return items.some(item => !onlineIds.has(item.id));
  });
  const source = !hasLivePart ? 'preset' : retainedPresets ? 'mixed' : 'live';
  const liveCount = Object.values(live).reduce((count, items) => count + items.length, 0);
  const countNote = hasLivePart ? `${liveCount ? '已获取在线目录。' : '在线目录未返回可用条目。'}${retainedPresets ? '已合并预置选项。' : ''}` : '';
  return { models, voices, source, note: [base.note, countNote, ...notices].filter(Boolean).join(' ') };
}
