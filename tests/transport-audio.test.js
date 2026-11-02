import test from 'node:test';
import assert from 'node:assert/strict';
import { postJson, postJsonLines, downloadAudio } from '../src/transport.js';
import { decodeBase64, decodeHex, pcmToWave, validateWave } from '../src/audio.js';
import { serverFor, wave } from './helpers.js';
import * as transport from '../src/transport.js';
import { createServer } from 'node:http';

for (const reason of ['abort','timeout']) {
  test(`WebSocket ${reason} closes a connection still waiting for an upgrade response`,async t=>{
    const server=createServer();let socket,seen;
    const received=new Promise(resolve=>{seen=resolve;});
    server.on('upgrade',(req,client)=>{socket=client;client.resume();seen();});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{socket?.destroy();server.closeAllConnections();server.close();});
    const controller=new AbortController();
    const request=transport.openWebSocket(`ws://127.0.0.1:${server.address().port}/pending`,{
      signal:controller.signal,timeoutMs:reason==='timeout'?100:5000,
    });
    const rejected=assert.rejects(request,{name:reason==='timeout'?'TimeoutError':'AbortError'});
    await received;
    const closed=new Promise(resolve=>{socket.once('end',resolve);socket.once('close',resolve);});
    if(reason==='abort')controller.abort();
    await rejected;
    let timer;
    try{
      await Promise.race([closed,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Cancelled WebSocket handshake left its TCP connection open')),700);})]);
    }finally{clearTimeout(timer);}
    assert.ok(socket.readableEnded||socket.destroyed);
  });
}

test('catalog GET JSON uses supplied headers without a request body and rejects redirects', async t => {
  assert.equal(typeof transport.getJson, 'function');
  let request;
  const url=await serverFor(t, async (req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    request={method:req.method,authorization:req.headers.authorization,body:Buffer.concat(chunks).toString()};
    res.end('{"data":[{"id":"speech-model"}]}');
  });
  assert.deepEqual(await transport.getJson(url,{authorization:'Bearer catalog-only'}),{data:[{id:'speech-model'}]});
  assert.deepEqual(request,{method:'GET',authorization:'Bearer catalog-only',body:''});
  const redirect=await serverFor(t,(req,res)=>{res.writeHead(302,{location:url});res.end();});
  await assert.rejects(transport.getJson(redirect),/302/);
});

test('raw 16-bit PCM becomes a correctly sized playable wave', () => {
  const pcm=Buffer.from([1,0,255,127,0,128,0,0]);
  const audio=pcmToWave(pcm,24000);
  assert.equal(audio.readUInt32LE(24),24000);
  assert.equal(audio.readUInt32LE(40),8);
  assert.deepEqual(audio.subarray(44),pcm);
  assert.deepEqual(validateWave(audio),audio);
  assert.throws(()=>pcmToWave(Buffer.from([1]),24000));
});

test('rejects malformed encoded audio rather than partially decoding it', () => {
  assert.deepEqual(decodeBase64('AQD/fw=='),Buffer.from([1,0,255,127]));
  assert.deepEqual(decodeHex('0100ff7f'),Buffer.from([1,0,255,127]));
  for(const value of ['a!aa','A','====','']) assert.throws(()=>decodeBase64(value));
  for(const value of ['abc','zz','']) assert.throws(()=>decodeHex(value));
});

test('decodes a realistic multi-megabyte audio response without regex stack overflow',()=>{
  const pcm=Buffer.alloc(4000000,7);
  assert.deepEqual(decodeBase64(pcm.toString('base64')),pcm);
});

test('WAV validation rejects impossible format fields and truncated containers',()=>{
  for(const mutate of [b=>b.writeUInt16LE(0,22),b=>b.writeUInt32LE(0,24),b=>b.writeUInt16LE(3,32),b=>b.writeUInt32LE(1,28),b=>b.writeUInt32LE(b.length+100,4),b=>b.writeUInt32LE(3,40)]){
    const bytes=wave();mutate(bytes);assert.throws(()=>validateWave(bytes));
  }
});

test('reads JSON and multiple NDJSON/SSE frames without losing a final line',async t=>{
  const json=await serverFor(t,(req,res)=>res.end('{"ok":true}'));
  assert.deepEqual(await postJson(json,{}, {},undefined),{ok:true});
  const lines=await serverFor(t,(req,res)=>res.end('data: {"data":"AQ=="}\n\n{"code":20000000}'));
  assert.deepEqual(await postJsonLines(lines,{}, {},undefined),[{data:'AQ=='},{code:20000000}]);
});

test('audio URL download sends no authorization and rejects a foreign host',async t=>{
  let authorization;
  const url=await serverFor(t,(req,res)=>{authorization=req.headers.authorization;res.end(wave());});
  const bytes=await downloadAudio(url,undefined,{baseUrl:url,allowedSuffixes:['.aliyuncs.com']});
  assert.deepEqual(bytes,wave());
  assert.equal(authorization,undefined);
  await assert.rejects(downloadAudio('https://example.test/internal',undefined,{baseUrl:url,allowedSuffixes:['.aliyuncs.com']}));
  await assert.rejects(downloadAudio('http://127.0.0.1:1/secret',undefined,{baseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/tts',allowedSuffixes:['.aliyuncs.com']}));
});

test('audio downloads reject redirects and pending requests honor abort',async t=>{
  const redirect=await serverFor(t,(req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:1/private'});res.end();});
  await assert.rejects(downloadAudio(redirect,undefined,{baseUrl:redirect}),/302/);
  const pending=await serverFor(t,req=>req.resume());
  const controller=new AbortController();
  const promise=postJson(pending,{}, {},controller.signal);
  controller.abort();
  await assert.rejects(promise,error=>error.name==='AbortError');
});


test('normalizeWaveLoudness boosts quiet 16-bit PCM voices and soft-limits peaks without clipping', async () => {
  const { normalizeWaveLoudness } = await import('../src/audio.js');
  const quietSamples = Buffer.alloc(400);
  for (let i = 0; i < quietSamples.length; i += 2) {
    quietSamples.writeInt16LE((i / 2) % 2 === 0 ? 800 : -800, i);
  }
  const quietWave = pcmToWave(quietSamples, 24000, 1);
  const boosted = normalizeWaveLoudness(quietWave, { volume: 1 });
  assert.equal(boosted.length, quietWave.length);
  const boostedSample = Math.abs(boosted.readInt16LE(44));
  assert.ok(boostedSample >= 4000, `expected quiet sample 800 to be boosted >= 4000, got ${boostedSample}`);

  const louder = normalizeWaveLoudness(quietWave, { volume: 2 });
  const louderSample = Math.abs(louder.readInt16LE(44));
  assert.ok(louderSample > boostedSample && louderSample <= 32767);

  const { measureWaveGain } = await import('../src/audio.js');
  const firstGain = measureWaveGain(quietWave, { volume: 1 });
  assert.ok(Number.isFinite(firstGain) && firstGain >= 5);

  const secondSamples = Buffer.alloc(400);
  for (let i = 0; i < secondSamples.length; i += 2) {
    secondSamples.writeInt16LE((i / 2) % 2 === 0 ? 1500 : -1500, i);
  }
  const secondWave = pcmToWave(secondSamples, 24000, 1);
  const lockedNormalized = normalizeWaveLoudness(secondWave, { volume: 1, gain: firstGain });
  assert.equal(Math.abs(lockedNormalized.readInt16LE(44)), Math.round(1500 * firstGain));
});
