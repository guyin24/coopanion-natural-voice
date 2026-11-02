export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export function validateWave(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes=Buffer.from(bytes);
  if(bytes.length>MAX_AUDIO_BYTES) throw new Error('TTS 音频超过 16 MB。');
  if(bytes.length<44 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE') throw new Error('TTS 没有返回 PCM WAV 音频。');
  const riffSize=bytes.readUInt32LE(4);
  if(riffSize!==0xffffffff&&riffSize!==bytes.length-8)throw new Error('WAV 容器长度与音频文件不一致。');
  let format=false,data=false,streamAt=-1,alignment=0;
  const dataLengths=[];
  for(let at=12;at+8<=bytes.length;){
    const kind=bytes.toString('ascii',at,at+4),length=bytes.readUInt32LE(at+4);
    if(kind==='data' && length===0xffffffff){data=at+8<bytes.length;streamAt=at+4;dataLengths.push(bytes.length-at-8);break;}
    if(at+8+length>bytes.length)throw new Error('WAV 音频不完整。');
    if(kind==='fmt '){
      if(length<16 || bytes.readUInt16LE(at+8)!==1 || ![8,16].includes(bytes.readUInt16LE(at+22)))throw new Error('仅支持 8/16 位 PCM WAV 音频。');
      const channels=bytes.readUInt16LE(at+10),rate=bytes.readUInt32LE(at+12),bits=bytes.readUInt16LE(at+22);
      alignment=channels*bits/8;
      if(![1,2].includes(channels)||rate<8000||rate>192000||bytes.readUInt16LE(at+20)!==alignment||bytes.readUInt32LE(at+16)!==rate*alignment)throw new Error('WAV 声道、采样率或帧格式无效。');
      format=true;
    }
    if(kind==='data' && length>0){data=true;dataLengths.push(length);}
    at+=8+length+(length%2);
  }
  if(!format||!data)throw new Error('WAV 音频缺少格式或声音数据。');
  if(dataLengths.some(length=>length%alignment!==0))throw new Error('WAV 音频采样长度未对齐。');
  if(streamAt!==-1 || bytes.readUInt32LE(4)===0xffffffff){
    bytes=Buffer.from(bytes);bytes.writeUInt32LE(bytes.length-8,4);
    if(streamAt!==-1)bytes.writeUInt32LE(bytes.length-streamAt-4,streamAt);
  }
  return bytes;
}

function analyzeWaveLoudness(bytes, { volume = 1 } = {}) {
  const valid = validateWave(bytes);
  let bits = 16;
  const dataChunks = [];
  for (let at = 12; at + 8 <= valid.length;) {
    const kind = valid.toString('ascii', at, at + 4);
    const length = valid.readUInt32LE(at + 4);
    if (at + 8 + length > valid.length) break;
    if (kind === 'fmt ' && length >= 16) bits = valid.readUInt16LE(at + 22);
    else if (kind === 'data' && length > 0) dataChunks.push({ start: at + 8, length });
    at += 8 + length + (length % 2);
  }
  const vol = Number.isFinite(volume) && volume > 0 ? Math.min(3, Math.max(0.1, volume)) : 1;
  if (bits !== 16 || !dataChunks.length) {
    return { valid, bits, dataChunks, peak: 0, autoGain: 1, vol, gain: 1 };
  }

  let peak = 0;
  let sumSq = 0;
  let activeCount = 0;
  for (const { start, length } of dataChunks) {
    const end = start + length;
    for (let pos = start; pos + 2 <= end; pos += 2) {
      const s = valid.readInt16LE(pos);
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
      if (abs >= 160) {
        sumSq += s * s;
        activeCount++;
      }
    }
  }
  if (peak === 0) {
    return { valid, bits, dataChunks, peak: 0, autoGain: 1, vol, gain: 1 };
  }

  const rms = activeCount > 0 ? Math.sqrt(sumSq / activeCount) : peak * 0.5;
  const rmsGain = 7500 / Math.max(rms, 1);
  const peakFloorGain = 20000 / peak;
  const autoGain = Math.min(6.0, Math.max(0.5, Math.max(rmsGain, Math.min(peakFloorGain, 4.0))));
  const gain = autoGain * vol;
  return { valid, bits, dataChunks, peak, autoGain, vol, gain };
}

export function measureWaveGain(bytes, options = {}) {
  const { peak, gain } = analyzeWaveLoudness(bytes, options);
  return peak > 0 ? gain : null;
}

export function normalizeWaveLoudness(bytes, options = {}) {
  const { valid, bits, dataChunks, peak, vol, gain: computedGain } = analyzeWaveLoudness(bytes, options);
  if (bits !== 16 || !dataChunks.length || peak === 0) return valid;

  const lockedGain = options?.gain;
  let gain = computedGain;
  if (Number.isFinite(lockedGain) && lockedGain > 0) {
    const safePeakCap = Math.max(computedGain, (27000 / Math.max(peak, 1)) * Math.max(1, vol));
    gain = Math.min(lockedGain, safePeakCap);
  }
  if (Math.abs(gain - 1) < 0.03 && peak * gain <= 29000) return valid;

  const out = Buffer.from(valid);
  for (const { start, length } of dataChunks) {
    const end = start + length;
    for (let pos = start; pos + 2 <= end; pos += 2) {
      let v = out.readInt16LE(pos) * gain;
      const abs = Math.abs(v);
      if (abs > 27000) {
        const sign = v < 0 ? -1 : 1;
        v = sign * (27000 + 5700 * Math.tanh((abs - 27000) / 5700));
      }
      const sample = Math.max(-32767, Math.min(32767, Math.round(v)));
      out.writeInt16LE(sample, pos);
    }
  }
  return out;
}

export function pcmToWave(pcm,sampleRate=24000,channels=1){
  if(!Buffer.isBuffer(pcm))pcm=Buffer.from(pcm);
  if(!pcm.length || pcm.length%(2*channels)!==0 || !Number.isInteger(sampleRate) || sampleRate<8000 || sampleRate>192000 || ![1,2].includes(channels))throw new Error('PCM 音频长度或采样率无效。');
  if(pcm.length+44>MAX_AUDIO_BYTES)throw new Error('TTS 音频超过 16 MB。');
  const out=Buffer.alloc(44+pcm.length);
  out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);
  out.writeUInt16LE(1,20);out.writeUInt16LE(channels,22);out.writeUInt32LE(sampleRate,24);out.writeUInt32LE(sampleRate*channels*2,28);
  out.writeUInt16LE(channels*2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);
  return out;
}

export function decodeBase64(value){
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(MAX_AUDIO_BYTES/3)*4||value.length%4!==0)throw new Error('TTS 返回了无效的 Base64 音频。');
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
  for(let i=0;i<value.length-padding;i++){
    const code=value.charCodeAt(i);
    if(!((code>=65&&code<=90)||(code>=97&&code<=122)||(code>=48&&code<=57)||code===43||code===47))throw new Error('TTS 返回了无效的 Base64 音频。');
  }
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>MAX_AUDIO_BYTES||bytes.toString('base64')!==value)throw new Error('TTS 返回了无效的 Base64 音频。');
  return bytes;
}

export function decodeHex(value){
  if(typeof value!=='string'||!value.length||value.length>MAX_AUDIO_BYTES*2||value.length%2!==0||!/^[a-fA-F0-9]+$/.test(value))throw new Error('TTS 返回了无效的十六进制音频。');
  return Buffer.from(value,'hex');
}
