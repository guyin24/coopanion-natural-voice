import { postJson } from '../transport.js';
import { decodeHex, validateWave } from '../audio.js';

export async function synthesizeMinimax(cfg, credentials, text, signal) {
  const response = await postJson(cfg.endpoint, {
    model: cfg.model,
    text,
    stream: false,
    voice_setting: { voice_id: cfg.voice, speed: cfg.speed ?? 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: cfg.sampleRate ?? 24000, format: 'wav', channel: 1 },
    output_format: 'hex',
  }, { authorization: `Bearer ${credentials.apiKey}` }, signal);

  const code = response?.base_resp?.status_code;
  if (code !== 0) {
    const detail = Number.isSafeInteger(code) ? `（状态码 ${code}）` : '（缺少有效状态码）';
    throw new Error(`MiniMax 合成失败${detail}，请检查密钥、余额、模型与音色。`);
  }
  if (response?.data?.status !== 2 || typeof response.data.audio !== 'string' || !response.data.audio) {
    throw new Error('MiniMax 未返回完成的音频数据。');
  }
  const audio = decodeHex(response.data.audio);
  return validateWave(audio);
}
