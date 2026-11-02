import { normalizeConfig, validateConfig, PROVIDERS } from './config.js';
import { validateWave } from './audio.js';
import { postAudio } from './transport.js';
import {
  synthesizeAliyun,
  prewarmAliyunWsTask,
  createAliyunDuplexSession,
  clearWarmAliyunTasks,
  isAliyunMultimodalModel,
  isAliyunWsModel,
} from './providers/aliyun.js';
import { synthesizeMinimax } from './providers/minimax.js';
import { synthesizeVolcengine } from './providers/volcengine.js';
import { synthesizeTencent } from './providers/tencent.js';
import { synthesizeAzure } from './providers/azure.js';
import { synthesizeElevenlabs } from './providers/elevenlabs.js';

export { validateWave } from './audio.js';
export { clearWarmAliyunTasks } from './providers/aliyun.js';

const adapters = {
  aliyun: synthesizeAliyun, minimax: synthesizeMinimax, volcengine: synthesizeVolcengine,
  tencent: synthesizeTencent, azure: synthesizeAzure, elevenlabs: synthesizeElevenlabs,
};
const SF_SYSTEM_VOICES = new Set(['alex', 'anna', 'bella', 'benjamin', 'charles', 'claire', 'david', 'diana']);

export function prewarmConnection(input, credentials) {
  try {
    const cfg = normalizeConfig(input);
    cfg.endpoint = validateConfig(cfg);
    if (typeof credentials === 'string') credentials = { apiKey: credentials };
    if (cfg.provider === 'aliyun' && credentials?.apiKey) {
      return prewarmAliyunWsTask(cfg, credentials);
    }
  } catch {}
  return null;
}

export function createDuplexSession(input, credentials, signal, options = {}) {
  try {
    const cfg = normalizeConfig(input);
    cfg.endpoint = validateConfig(cfg);
    if (typeof credentials === 'string') credentials = { apiKey: credentials };
    if (cfg.provider === 'aliyun' && credentials?.apiKey && !isAliyunMultimodalModel(cfg.model)) {
      const url = new URL(cfg.endpoint);
      if (isAliyunWsModel(cfg.model) || options.preferWs || url.protocol === 'ws:' || url.protocol === 'wss:' || url.hostname.endsWith('.aliyuncs.com')) {
        return createAliyunDuplexSession(cfg, credentials, signal, options);
      }
    }
  } catch {}
  return null;
}

export async function synthesize(input, credentials, text, signal, options = {}) {
  const cfg = normalizeConfig(input);
  cfg.endpoint = validateConfig(cfg);
  if (typeof credentials === 'string') credentials = { apiKey: credentials };
  if (!credentials || typeof credentials !== 'object') throw new Error('请保存此平台的凭据。');
  for (const field of PROVIDERS[cfg.provider].credentials) {
    const value = credentials[field.id];
    if (field.required && (!value || typeof value !== 'string' || /\s/.test(value))) {
      throw new Error('请保存有效的 ' + (typeof field.label==='string'?field.label:field.label.zh) + '。');
    }
  }
  const timeout = AbortSignal.timeout(90000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const adapter = adapters[cfg.provider];
  const voice = cfg.provider === 'siliconflow' && !cfg.voice.includes(':') && SF_SYSTEM_VOICES.has(cfg.voice.toLowerCase())
    ? `${cfg.model}:${cfg.voice.toLowerCase()}`
    : cfg.voice;
  const bytes = adapter ? await adapter(cfg, credentials, text, combined, options) : await postAudio(cfg.endpoint,
    { model: cfg.model, voice, input: text, speed: cfg.speed, response_format: 'wav', ...(cfg.provider==='siliconflow'?{sample_rate:cfg.sampleRate}:{}) },
    { authorization: 'Bearer ' + credentials.apiKey }, combined);
  if (bytes === null && (typeof options?.onFirstChunk === 'function'||typeof options?.onAudioChunk === 'function')) return null;
  return validateWave(bytes);
}
