import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeAzure } from '../src/providers/azure.js';
import { synthesizeElevenlabs } from '../src/providers/elevenlabs.js';
import { wave, serverFor, bodyOf } from './helpers.js';

test('Azure authenticates with resource key and escapes user text in SSML',async t=>{
  let received;
  const endpoint=await serverFor(t,async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received={headers:req.headers,body:Buffer.concat(chunks).toString()};res.end(wave());
  });
  const bytes=await synthesizeAzure({endpoint,voice:'zh-CN-XiaoxiaoNeural',speed:1.2,sampleRate:24000},{apiKey:'azure-key'},'你好 <tag> & "世界"');
  assert.deepEqual(bytes,wave());
  assert.equal(received.headers['ocp-apim-subscription-key'],'azure-key');
  assert.equal(received.headers['x-microsoft-outputformat'],'riff-24khz-16bit-mono-pcm');
  assert.match(received.body,/rate="\+20%"/);
  assert.match(received.body,/&lt;tag&gt; &amp;/);
  assert.equal(received.body.includes('<tag>'),false);
});

test('ElevenLabs uses voice path, xi-api-key and wraps PCM output',async t=>{
  let received;
  const endpoint=await serverFor(t,async(req,res)=>{received={url:req.url,key:req.headers['xi-api-key'],body:await bodyOf(req)};res.end(Buffer.from([1,0,2,0]));});
  const bytes=await synthesizeElevenlabs({endpoint:endpoint.replace('/v1/audio/speech','/v1/text-to-speech/{voice}'),voice:'test-voice',model:'test-model',sampleRate:24000,speed:1},{apiKey:'eleven-key'},'你好');
  assert.equal(received.url,'/v1/text-to-speech/test-voice?output_format=pcm_24000');
  assert.equal(received.key,'eleven-key');
  assert.deepEqual(received.body,{text:'你好',model_id:'test-model',voice_settings:{speed:1}});
  assert.equal(bytes.readUInt32LE(24),24000);
  assert.deepEqual(bytes.subarray(44),Buffer.from([1,0,2,0]));
});

test('Azure uses the documented 44100hz output-format name',async t=>{
  let format;
  const endpoint=await serverFor(t,(req,res)=>{format=req.headers['x-microsoft-outputformat'];res.end(wave());});
  await synthesizeAzure({endpoint,voice:'zh-CN-XiaoxiaoNeural',speed:1,sampleRate:44100},{apiKey:'key'},'你好');
  assert.equal(format,'riff-44100hz-16bit-mono-pcm');
});
