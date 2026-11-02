import { createHash, createHmac, randomUUID } from 'node:crypto';
import { postJson } from '../transport.js';
import { decodeBase64, pcmToWave, MAX_AUDIO_BYTES } from '../audio.js';

const ENDPOINT = 'https://tts.tencentcloudapi.com/';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// payload must be the exact UTF-8 JSON string sent over HTTP.
export function signTencentRequest({ endpoint = ENDPOINT, payload, credentials, timestamp = Math.floor(Date.now() / 1000),
  region, service = 'tts', action = 'TextToVoice', version = '2019-08-23' }) {
  if (!credentials?.secretId?.trim() || !credentials?.secretKey?.trim()) throw new Error('请先配置腾讯云 SecretId 和 SecretKey 密钥。');
  const url = new URL(endpoint);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${url.host.toLowerCase()}\nx-tc-action:${action.toLowerCase()}\n`;
  const canonicalRequest = `POST\n${url.pathname || '/'}\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${credentials.secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign).toString('hex');
  return {
    // Lowercase content-type deliberately replaces the transport's JSON default.
    'content-type': CONTENT_TYPE,
    Host: url.host,
    Authorization: `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': String(timestamp),
    ...(region ? { 'X-TC-Region': region } : {}),
    ...(credentials.sessionToken ? { 'X-TC-Token': credentials.sessionToken } : {}),
  };
}

export function tencentSpeed(multiplier = 1) {
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('腾讯云语速无效。');
  const value = Math.min(2.5, Math.max(0.6, multiplier));
  const points = [[0.6, -2], [0.8, -1], [1, 0], [1.2, 1], [1.5, 2], [2.5, 6]];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (value <= x2) return Number((y1 + (value - x1) / (x2 - x1) * (y2 - y1)).toFixed(2));
  }
}

function splitText(text) {
  const chunks = [];
  let chunk = '', count = 0, bytes = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character, 'utf8');
    if (count >= 140 || bytes + length > 420) { chunks.push(chunk); chunk = ''; count = 0; bytes = 0; }
    chunk += character; count++; bytes += length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function safeError(error, credentials) {
  let detail = `腾讯云语音 ${String(error.Code || 'Error').slice(0, 160)}：${String(error.Message || '合成失败').slice(0, 500)}`;
  for (const value of Object.values(credentials)) {
    if (typeof value === 'string' && value) detail = detail.replaceAll(value, '[已隐藏]');
  }
  return new Error(detail);
}

export async function synthesizeTencent(cfg, credentials, text, signal) {
  signal?.throwIfAborted();
  if (typeof credentials?.secretId !== 'string' || typeof credentials?.secretKey !== 'string' || !credentials.secretId.trim() || !credentials.secretKey.trim()) throw new Error('请先配置腾讯云 SecretId 和 SecretKey 密钥。');
  if (typeof text !== 'string' || !text.trim()) throw new Error('合成文本不能为空。');
  const sampleRate = Number(cfg.sampleRate ?? 16000);
  if (![8000, 16000, 24000].includes(sampleRate)) throw new Error('腾讯云语音采样率只支持 8000、16000 或部分音色的 24000 Hz。');
  const voice = Number(cfg.voice ?? 101001);
  if (!Number.isSafeInteger(voice) || voice < 0) throw new Error('腾讯云音色 VoiceType 必须为非负整数。');
  const model = Number(cfg.model ?? 1);
  if (model !== 1) throw new Error('腾讯云 ModelType 目前只支持 1。');
  const speed = tencentSpeed(Number(cfg.speed ?? 1));
  const endpoint = cfg.endpoint || ENDPOINT;
  const chunks = [];
  let size = 0;
  for (const chunkText of splitText(text)) {
    signal?.throwIfAborted();
    const body = { Text: chunkText, SessionId: randomUUID(), ModelType: model,
      VoiceType: voice, SampleRate: sampleRate, Codec: 'pcm', Speed: speed };
    const headers = signTencentRequest({ endpoint, payload: JSON.stringify(body), credentials, region: cfg.region });
    const envelope = await postJson(endpoint, body, headers, signal);
    signal?.throwIfAborted();
    const response = envelope?.Response;
    if (!response || typeof response !== 'object') throw new Error('腾讯云语音返回了无效的 Response。');
    if (response.Error) throw safeError(response.Error, credentials);
    if (typeof response.Audio !== 'string' || !response.Audio) throw new Error('腾讯云语音没有返回音频。');
    const pcm = decodeBase64(response.Audio);
    if (pcm.length % 2) throw new Error('腾讯云 PCM 音频采样长度无效。');
    size += pcm.length;
    if (size + 44 > MAX_AUDIO_BYTES) throw new Error('TTS 音频超过 16 MB。');
    chunks.push(pcm);
  }
  return pcmToWave(Buffer.concat(chunks, size), sampleRate);
}
