import { postAudio } from '../transport.js';
import { validateWave } from '../audio.js';

const escapeXml=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

export async function synthesizeAzure(cfg,credentials,text,signal){
  const sampleRate=cfg.sampleRate??24000;
  if(![8000,16000,22050,24000,44100,48000].includes(sampleRate))throw new Error('Azure 不支持此 WAV 采样率。');
  const locale=cfg.voice.match(/^[a-z]{2,3}-[A-Z]{2}/)?.[0]??'zh-CN';
  const percent=Math.round((cfg.speed-1)*100);
  const ssml=`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${escapeXml(cfg.voice)}"><prosody rate="${percent>=0?'+':''}${percent}%">${escapeXml(text)}</prosody></voice></speak>`;
  const rate=[22050,44100].includes(sampleRate)?`${sampleRate}hz`:`${sampleRate/1000}khz`;
  const bytes=await postAudio(cfg.endpoint,ssml,{'content-type':'application/ssml+xml','ocp-apim-subscription-key':credentials.apiKey,
    'x-microsoft-outputformat':`riff-${rate}-16bit-mono-pcm`,'user-agent':'Coopanion-Natural-Voice'},signal);
  return validateWave(bytes);
}
