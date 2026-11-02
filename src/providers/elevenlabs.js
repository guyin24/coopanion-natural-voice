import { postAudio } from '../transport.js';
import { pcmToWave } from '../audio.js';

export async function synthesizeElevenlabs(cfg,credentials,text,signal){
  const sampleRate=cfg.sampleRate??24000;
  if(![16000,22050,24000,44100,48000].includes(sampleRate))throw new Error('ElevenLabs 不支持此 PCM 采样率。');
  const endpoint=new URL(cfg.endpoint.replace('{voice}',encodeURIComponent(cfg.voice)));
  if(/\/v1\/text-to-speech\/[^/]+$/.test(endpoint.pathname)){
    endpoint.pathname=endpoint.pathname.replace(/\/v1\/text-to-speech\/[^/]+$/,`/v1/text-to-speech/${encodeURIComponent(cfg.voice)}`);
  }
  endpoint.searchParams.set('output_format',`pcm_${sampleRate}`);
  const pcm=await postAudio(endpoint,{text,model_id:cfg.model,voice_settings:{speed:cfg.speed}},
    {'xi-api-key':credentials.apiKey},signal);
  return pcmToWave(pcm,sampleRate);
}
