import { randomUUID } from 'node:crypto';
import { postJsonLines } from '../transport.js';
import { decodeBase64, pcmToWave, MAX_AUDIO_BYTES } from '../audio.js';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);

function safeError(code, message, credentials) {
  let detail = `火山语音 ${code}：${String(message || '合成失败').slice(0, 500)}`;
  for (const value of Object.values(credentials)) {
    if (typeof value === 'string' && value) detail = detail.replaceAll(value, '[已隐藏]');
  }
  return new Error(detail);
}

export async function synthesizeVolcengine(cfg, credentials, text, signal) {
  signal?.throwIfAborted();
  if (typeof credentials?.apiKey !== 'string' || !credentials.apiKey.trim()) throw new Error('请先配置火山语音 API Key 或 Access Token 密钥。');
  if (typeof text !== 'string' || !text.trim()) throw new Error('合成文本不能为空。');
  const sampleRate = Number(cfg.sampleRate ?? 24000);
  if (!SAMPLE_RATES.has(sampleRate)) throw new Error('火山语音采样率不受支持。');
  const speed = Number(cfg.speed ?? 1);
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('火山语音语速无效。');
  const speaker = String(cfg.voice || 'zh_female_vv_uranus_bigtts').trim();
  const headers = {
    'X-Api-Resource-Id': String(cfg.model || 'seed-tts-2.0'),
    'X-Api-Request-Id': randomUUID(),
    ...(credentials.appId ? { 'X-Api-App-Id': credentials.appId, 'X-Api-Access-Key': credentials.apiKey }
      : { 'X-Api-Key': credentials.apiKey }),
  };
  const body = { req_params: { text, speaker, audio_params: {
    format: 'pcm', sample_rate: sampleRate, speech_rate: Math.round((Math.min(2, Math.max(0.5, speed)) - 1) * 100),
  } } };
  const frames = await postJsonLines(cfg.endpoint || ENDPOINT, body, headers, signal);
  signal?.throwIfAborted();
  const chunks = [];
  let size = 0;
  let finished = false;
  for (const frame of frames) {
    if (!frame || !Number.isInteger(frame.code)) throw new Error('火山语音响应缺少有效状态 code。');
    if (frame.code !== 0 && frame.code !== 20000000) throw safeError(frame.code, frame.message, credentials);
    if (finished) throw new Error('火山语音结束状态之后仍返回了数据。');
    if (frame.data !== undefined && frame.data !== null && frame.data !== '') {
      const chunk = decodeBase64(frame.data);
      size += chunk.length;
      if (size + 44 > MAX_AUDIO_BYTES) throw new Error('TTS 音频超过 16 MB。');
      chunks.push(chunk);
    }
    if (frame.code === 20000000) finished = true;
  }
  if (!finished) throw new Error('火山语音响应未收到合成结束状态，音频可能不完整。');
  if (!size) throw new Error('火山语音没有返回音频。');
  return pcmToWave(Buffer.concat(chunks, size), sampleRate);
}
