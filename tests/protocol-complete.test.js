import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openWebSocket, runWebSocket } from '../src/transport.js';
import {
  synthesizeAliyun, createAliyunDuplexSession, prewarmAliyunWsTask,
  clearWarmAliyunTasks, isAliyunWsNegativelyCached, toAliyunWsUrl,
} from '../src/providers/aliyun.js';
import { serverFor, wave } from './helpers.js';

const cfg = { model: 'qwen-audio-3.1-tts-flash', voice: 'longqiang_v3.1', sampleRate: 24000, speed: 1 };
const credentials = { apiKey: 'fixture-only-key' };

test('Aliyun continuous chunks arrive before task-finished and preserve every PCM byte at 48kHz',async t=>{
  const pcm=Buffer.alloc(48000*2*.72);for(let i=0;i<pcm.length;i++)pcm[i]=i%251;
  const held=deferred();let finishTask;
  const fixture=await wsFixture(t,peer=>{peer.accept();peer.onFrame=({opcode,payload})=>{
    if(opcode!==1)return;const msg=JSON.parse(payload);
    if(msg.header.action==='run-task')peer.send(eventFrame('task-started',msg.header.task_id));
    if(msg.header.action==='finish-task'){
      peer.send(serverFrame(2,pcm.subarray(0,5)));peer.send(serverFrame(2,pcm.subarray(5)));
      finishTask=()=>peer.send(eventFrame('task-finished',msg.header.task_id));held.resolve();
    }
  };});
  const waves=[];let completed=false;
  const p=synthesizeAliyun({...cfg,endpoint:fixture.ws,sampleRate:48000},credentials,'持续推流。',new AbortController().signal,{onAudioChunk:wave=>waves.push(wave)}).then(value=>{completed=true;return value;});
  await held.promise;await new Promise(r=>setTimeout(r,20));assert.equal(completed,false);assert.equal(waves.length,6);assert.ok(waves.every(w=>w.length-44===11520));
  finishTask();assert.equal(await p,null);assert.deepEqual(Buffer.concat(waves.map(w=>w.subarray(44))),pcm);
});

test('callback failures after delivered audio are never retried through HTTP',async t=>{
  let posts=0;
  const fixture=await wsFixture(t,peer=>{peer.accept();peer.onFrame=({opcode,payload})=>{if(opcode!==1)return;const msg=JSON.parse(payload);
    if(msg.header.action==='run-task')peer.send(eventFrame('task-started',msg.header.task_id));
    if(msg.header.action==='finish-task')peer.send(serverFrame(2,Buffer.alloc(12000)));
  };});
  const original=globalThis.fetch;t.mock.method(globalThis,'fetch',async(...args)=>{posts++;return original(...args);});
  await assert.rejects(synthesizeAliyun({...cfg,model:'cosyvoice-v3-plus',voice:'longanyang',endpoint:fixture.endpoint},credentials,'不要重复。',new AbortController().signal,{preferWs:true,onAudioChunk(){throw new Error('fixture playback failure');}}),error=>error.audioEmitted===true);
  assert.equal(posts,0);
});

test('Aliyun reuses a handshaken idle connection across styles and sends only the acquired task instruction', async t=>{
  const runs=[];
  const fixture=await wsFixture(t,peer=>{
    peer.accept();peer.onFrame=({opcode,payload})=>{
      if(opcode!==1)return;const msg=JSON.parse(payload);
      if(msg.header.action==='run-task'){runs.push(msg);peer.send(eventFrame('task-started',msg.header.task_id));}
      if(msg.header.action==='finish-task')peer.send(Buffer.concat([serverFrame(2,Buffer.from([1,0,2,0])),eventFrame('task-finished',msg.header.task_id)]));
    };
  });
  const config={...cfg,endpoint:fixture.ws,speechInstruction:'自然、亲切地聊天。'};
  await synthesizeAliyun(config,credentials,'你好呀。',new AbortController().signal);
  assert.equal(runs[0].payload.parameters.instruction,config.speechInstruction);
  const warm=prewarmAliyunWsTask(config,credentials);await warm.readyPromise;
  const other=prewarmAliyunWsTask({...config,speechInstruction:'平静、安慰地说。'},credentials);await other.readyPromise;
  assert.equal(warm,other,'idle sockets have no speaking style until acquired');
  assert.equal(runs.length,1,'warmup must not send run-task');
  const session=createAliyunDuplexSession({...config,speechInstruction:'平静、安慰地说。'},credentials,new AbortController().signal);
  session.pushText('今天怎么样？');session.finishText();await bounded(session.promise,'styled duplex did not finish');
  assert.equal(runs.length,2);assert.equal(runs[1].payload.parameters.instruction,'平静、安慰地说。');
  assert.equal(fixture.upgrades,2,'the acquired style uses the already-handshaken socket');
});

test('Aliyun omits empty style and never forwards Qwen instructions to legacy CosyVoice models', async t=>{
  const runs=[];const fixture=await wsFixture(t,peer=>{
    peer.accept();peer.onFrame=({opcode,payload})=>{if(opcode!==1)return;const msg=JSON.parse(payload);
      if(msg.header.action==='run-task'){runs.push(msg);peer.send(eventFrame('task-started',msg.header.task_id));}
      if(msg.header.action==='finish-task')peer.send(Buffer.concat([serverFrame(2,Buffer.from([1,0])),eventFrame('task-finished',msg.header.task_id)]));
    };
  });
  for(const options of [{speechInstruction:''},{speechInstruction:'   '},{model:'cosyvoice-v1',voice:'longwan',speechInstruction:'不要传给旧模型。'}])
    await synthesizeAliyun({...cfg,endpoint:fixture.ws,...options},credentials,'测试。',new AbortController().signal);
  assert.ok(runs.every(run=>!Object.hasOwn(run.payload.parameters,'instruction')));
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Independent server-side RFC 6455 framing; production encoding is deliberately not reused.
function serverFrame(opcode, payload, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  head[1] = body.length < 126 ? body.length : body.length < 65536 ? 126 : 127;
  if (head.length === 4) head.writeUInt16BE(body.length, 2);
  if (head.length === 10) head.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([head, body]);
}

function jsonFrame(value) { return serverFrame(1, JSON.stringify(value)); }
function eventFrame(event, taskId) { return jsonFrame({ header: { event, task_id: taskId }, payload: {} }); }

async function wsFixture(t, onConnection, httpHandler = (req, res) => {
  req.resume(); res.writeHead(404); res.end();
}) {
  const server = createServer(httpHandler);
  const sockets = new Set();
  let upgrades = 0;
  server.on('upgrade', (req, socket) => {
    upgrades++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const peer = {
      req, socket,
      accept(extra = Buffer.alloc(0), acceptValue = accept) {
        socket.write(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptValue + '\r\n\r\n'), extra]));
      },
      send(frame) { socket.write(frame); },
      onFrame: null,
    };
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const masked = Boolean(buffered[1] & 0x80);
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2)); offset = 10;
        }
        const start = offset + (masked ? 4 : 0);
        if (buffered.length < start + length) return;
        const opcode = buffered[0] & 0x0f;
        const payload = Buffer.from(buffered.subarray(start, start + length));
        if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffered[offset + (i % 4)];
        buffered = buffered.subarray(start + length);
        peer.onFrame?.({ opcode, payload, masked });
      }
    });
    onConnection(peer);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    clearWarmAliyunTasks();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { endpoint: origin + '/api/v1/services/audio/tts/SpeechSynthesizer', ws: origin.replace('http:', 'ws:') + '/api-ws/v1/inference', get upgrades() { return upgrades; } };
}

test('WebSocket reassembles UTF-8 and extended-length binary fragments across interleaved ping frames', async t => {
  const receivedJson = [];
  const receivedBinary = [];
  const clientFrames = [];
  const expectedPcm = Buffer.alloc(66000, 0x53);
  const fixture = await wsFixture(t, peer => {
    peer.accept();
    peer.onFrame = frame => {
      clientFrames.push(frame);
      if (frame.opcode === 1) {
        const text = Buffer.from('{"text":"你好"}');
        const first = serverFrame(1, text.subarray(0, 10), false);
        // Split the frame header itself over TCP writes, and split a multibyte character over continuation frames.
        peer.send(first.subarray(0, 1));
        setImmediate(() => peer.send(Buffer.concat([
          first.subarray(1), serverFrame(9, 'ping-fixture'), serverFrame(0, text.subarray(10)),
          serverFrame(2, expectedPcm.subarray(0, 65000), false), serverFrame(0, expectedPcm.subarray(65000)),
        ])));
      } else if (frame.opcode === 10) peer.send(jsonFrame({ done: true }));
    };
  });
  await runWebSocket(fixture.ws, {
    timeoutMs: 1500,
    onOpen(ws) { ws.sendJson({ begin: true }); },
    onJson(msg, ws) { if (msg.done) ws.finish(); else receivedJson.push(msg); },
    onBinary(bytes) { receivedBinary.push(bytes); },
  });
  assert.deepEqual(receivedJson, [{ text: '你好' }]);
  assert.deepEqual(receivedBinary, [expectedPcm]);
  assert.deepEqual(clientFrames.filter(frame => frame.opcode === 1).map(frame => JSON.parse(frame.payload)), [{ begin: true }]);
  const pong = clientFrames.find(frame => frame.opcode === 10);
  assert.equal(pong?.payload.toString(), 'ping-fixture');
  assert.ok(clientFrames.every(frame => frame.masked), 'client JSON and pong must be masked');
});

test('WebSocket preserves audio and completion frames delivered with the HTTP upgrade response', async t => {
  const fixture = await wsFixture(t, peer => peer.accept(Buffer.concat([
    serverFrame(2, Buffer.from([1, 0, 2, 0])), jsonFrame({ done: true }),
  ])));
  const chunks = [];
  const result = await runWebSocket(fixture.ws, {
    timeoutMs: 1500,
    onBinary(bytes) { chunks.push(bytes); },
    onJson(msg, ws) { if (msg.done) ws.finish('complete'); },
  });
  assert.equal(result, 'complete');
  assert.deepEqual(chunks, [Buffer.from([1, 0, 2, 0])]);
});

test('WebSocket rejects a wrong handshake accept hash and sanitized HTTP authorization failures', async t => {
  const fixture = await wsFixture(t, peer => peer.accept(Buffer.alloc(0), 'incorrect-accept'));
  await assert.rejects(openWebSocket(fixture.ws), /握手/);
  const endpoint = await serverFor(t, (req, res) => {
    req.resume(); res.writeHead(401); res.end('fixture-only-key: raw provider detail');
  });
  await assert.rejects(openWebSocket(endpoint.replace('http:', 'ws:'), { headers: { authorization: 'Bearer fixture-only-key' } }), error => {
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /fixture-only-key|raw provider detail/);
    return true;
  });
});

test('WebSocket fails malformed JSON and a close before task completion', async t => {
  for (const [name, frame, pattern] of [
    ['malformed JSON', serverFrame(1, '{broken'), /JSON/],
    ['remote close', serverFrame(8, Buffer.from([3, 232])), /关闭/],
  ]) await t.test(name, async t => {
    const fixture = await wsFixture(t, peer => peer.accept(frame));
    await assert.rejects(runWebSocket(fixture.ws, { timeoutMs: 1500 }), pattern);
  });
});

test('Aliyun hands an unstarted warm task to duplex input once, preserving delta order and task identity', async t => {
  const runSeen = deferred();
  const actions = [];
  let peer;
  const fixture = await wsFixture(t, connection => {
    peer = connection;
    peer.accept();
    peer.onFrame = ({ opcode, payload }) => {
      if (opcode !== 1) return;
      const msg = JSON.parse(payload);
      actions.push(msg);
      if (msg.header.action === 'run-task') runSeen.resolve(msg.header.task_id);
      if (msg.header.action === 'finish-task') peer.send(Buffer.concat([
        serverFrame(2, Buffer.from([1, 0, 2, 0])), eventFrame('task-finished', msg.header.task_id),
      ]));
    };
  });
  const config = { ...cfg, endpoint: fixture.ws };
  const warm = prewarmAliyunWsTask(config, credentials);
  await warm.readyPromise;
  assert.equal(actions.length,0,'warmup performs the handshake only');
  const session = createAliyunDuplexSession(config, credentials);
  session.pushText('第一段'); session.pushText('第二段'); session.finishText(); session.finishText();
  session.pushText('完成后不得提交');
  const taskId = await bounded(runSeen.promise,'acquired task was never submitted');
  assert.deepEqual(actions.map(msg => msg.header.action), ['run-task']);
  peer.send(eventFrame('task-started', taskId));
  const audio = await bounded(session.promise, 'duplex handoff lost its startup event');
  assert.equal(fixture.upgrades, 1);
  assert.deepEqual(actions.map(msg => msg.header.action), ['run-task', 'continue-task', 'continue-task', 'finish-task']);
  assert.deepEqual(actions.filter(msg => msg.header.action === 'continue-task').map(msg => msg.payload.input.text), ['第一段', '第二段']);
  assert.ok(actions.every(msg => msg.header.task_id === taskId));
  assert.deepEqual(audio.subarray(44), Buffer.from([1, 0, 2, 0]));
});

test('Aliyun cancellation after WebSocket startup closes the socket without HTTP fallback or negative caching', async t => {
  const continued = deferred();
  const disconnected = deferred();
  let httpCalls = 0;
  const fixture = await wsFixture(t, peer => {
    peer.accept();
    peer.socket.once('end', disconnected.resolve);
    peer.socket.once('close', disconnected.resolve);
    peer.onFrame = ({ opcode, payload }) => {
      if (opcode !== 1) return;
      const msg = JSON.parse(payload);
      if (msg.header.action === 'run-task') peer.send(eventFrame('task-started', msg.header.task_id));
      if (msg.header.action === 'continue-task') continued.resolve();
    };
  }, (req, res) => { httpCalls++; req.resume(); res.end('{}'); });
  const controller = new AbortController();
  const result = synthesizeAliyun({ ...cfg, model: 'cosyvoice-v3-plus', voice: 'longanyang', endpoint: fixture.endpoint }, credentials, '取消测试', controller.signal, { preferWs: true });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await bounded(continued.promise, 'WebSocket did not start text input');
  controller.abort();
  await rejected;
  await bounded(disconnected.promise, 'canceled synthesis kept an established WebSocket alive');
  assert.equal(httpCalls, 0);
  assert.equal(isAliyunWsNegativelyCached(toAliyunWsUrl(fixture.endpoint), 'cosyvoice-v3-plus'), false);
});

test('Aliyun rejects truncated odd-byte PCM in both one-shot and duplex completion', async t => {
  for (const duplex of [false, true]) await t.test(duplex ? 'duplex' : 'one-shot', async t => {
    const fixture = await wsFixture(t, peer => {
      peer.accept();
      peer.onFrame = ({ opcode, payload }) => {
        if (opcode !== 1) return;
        const msg = JSON.parse(payload);
        if (msg.header.action === 'run-task') peer.send(eventFrame('task-started', msg.header.task_id));
        if (msg.header.action === 'finish-task') peer.send(Buffer.concat([
          serverFrame(2, Buffer.from([1, 0, 255])), eventFrame('task-finished', msg.header.task_id),
        ]));
      };
    });
    const config = { ...cfg, endpoint: fixture.ws };
    const result = duplex ? (() => {
      const session = createAliyunDuplexSession(config, credentials);
      session.pushText('截断数据'); session.finishText(); return session.promise;
    })() : synthesizeAliyun(config, credentials, '截断数据');
    await assert.rejects(result, /PCM|采样|音频/);
  });
});

test('Aliyun multimodal rejects corrupted Base64 instead of decoding a valid-looking PCM prefix', async t => {
  for (const data of ['AQACAA==!', 'AQACAA===']) await t.test(data, async t => {
    const endpoint = await serverFor(t, (req, res) => {
      req.resume(); res.end(JSON.stringify({ output: { audio: { data } } }));
    });
    await assert.rejects(synthesizeAliyun({ ...cfg, model: 'qwen3-tts-flash', endpoint }, credentials, '畸形音频'), /Base64|音频/);
  });
});

test('Aliyun duplex cancellation closes a pending WebSocket handshake promptly', async t => {
  const upgradeSeen = deferred();
  const disconnected = deferred();
  const fixture = await wsFixture(t, peer => {
    peer.socket.once('end', disconnected.resolve);
    peer.socket.once('close', disconnected.resolve);
    upgradeSeen.resolve();
    // Deliberately do not send an upgrade response; cancel must release the pending TCP request.
  });
  const controller = new AbortController();
  const session = createAliyunDuplexSession({ ...cfg, endpoint: fixture.ws }, credentials, controller.signal);
  const rejected = assert.rejects(session.promise, { name: 'AbortError' });
  await bounded(upgradeSeen.promise, 'duplex never opened its handshake');
  controller.abort();
  await rejected;
  await bounded(disconnected.promise, 'canceled duplex left its pending WebSocket handshake open', 350);
});

test('Aliyun preserves every PCM byte across early audio, odd network chunks, and the final remainder', async t => {
  const expected = Buffer.alloc(32000);
  for (let i = 0; i < expected.length / 2; i++) expected.writeInt16LE(((i % 41) - 20) * 100, i * 2);
  const firstChunkSeen = deferred();
  const early = [];
  let peer;
  const fixture = await wsFixture(t, connection => {
    peer = connection; peer.accept();
    peer.onFrame = ({ opcode, payload }) => {
      if (opcode !== 1) return;
      const msg = JSON.parse(payload);
      if (msg.header.action === 'run-task') peer.send(eventFrame('task-started', msg.header.task_id));
      if (msg.header.action === 'continue-task') peer.send(serverFrame(2, expected.subarray(0, 30001)));
      if (msg.header.action === 'finish-task') peer.send(Buffer.concat([
        serverFrame(2, expected.subarray(30001)), eventFrame('task-finished', msg.header.task_id),
      ]));
    };
  });
  const session = createAliyunDuplexSession({ ...cfg, endpoint: fixture.ws }, credentials, undefined, {
    onFirstChunk(audio) { early.push(audio); firstChunkSeen.resolve(); },
  });
  session.pushText('先收到可播放的音频，再提交最终文本');
  await bounded(firstChunkSeen.promise, 'early audio was withheld until task completion');
  session.finishText();
  const remainder = await bounded(session.promise, 'final remainder did not finish');
  assert.equal(early.length, 1);
  assert.equal(early[0].readUInt32LE(24), 24000);
  assert.equal(remainder.readUInt32LE(24), 24000);
  assert.deepEqual(Buffer.concat([early[0].subarray(44), remainder.subarray(44)]), expected);
});

test('Aliyun multimodal accepts canonical inline PCM and complete inline WAV', async t => {
  for (const [name, input] of [['PCM', Buffer.from([1, 0, 255, 127])], ['WAV', wave()]]) await t.test(name, async t => {
    const endpoint = await serverFor(t, (req, res) => {
      req.resume(); res.end(JSON.stringify({ output: { audio: { data: input.toString('base64') } } }));
    });
    const audio = await synthesizeAliyun({ ...cfg, model: 'qwen3-tts-flash', endpoint }, credentials, '有效音频');
    if (name === 'WAV') assert.deepEqual(audio, input);
    else {
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
      assert.equal(audio.readUInt32LE(24), 24000);
      assert.deepEqual(audio.subarray(44), input);
    }
  });
});

test('Aliyun canceling one acquired warm handshake preserves a different credential-owned warm task', async t => {
  const peers = new Map();
  const bothUpgraded = deferred();
  const firstDisconnected = deferred();
  const firstCredentials = { apiKey: 'fixture-owner-a' };
  const secondCredentials = { apiKey: 'fixture-owner-b' };
  const fixture = await wsFixture(t, peer => {
    peers.set(peer.req.headers.authorization, peer);
    if (peer.req.headers.authorization === 'Bearer fixture-owner-a') {
      peer.socket.once('end', firstDisconnected.resolve);
      peer.socket.once('close', firstDisconnected.resolve);
    }
    peer.onFrame = ({ opcode, payload }) => {
      if (opcode !== 1) return;
      const msg = JSON.parse(payload);
      if (msg.header.action === 'run-task') peer.send(eventFrame('task-started', msg.header.task_id));
      if (msg.header.action === 'finish-task') peer.send(Buffer.concat([
        serverFrame(2, Buffer.from([7, 0, 8, 0])), eventFrame('task-finished', msg.header.task_id),
      ]));
    };
    if (peers.size === 2) bothUpgraded.resolve();
  });
  const config = { ...cfg, endpoint: fixture.ws };
  prewarmAliyunWsTask(config, firstCredentials);
  const secondWarm = prewarmAliyunWsTask(config, secondCredentials);
  await bounded(bothUpgraded.promise, 'both independent warm handshakes did not arrive');
  const controller = new AbortController();
  const first = createAliyunDuplexSession(config, firstCredentials, controller.signal);
  const rejected = assert.rejects(first.promise, { name: 'AbortError' });
  controller.abort();
  await rejected;
  await bounded(firstDisconnected.promise, 'the owned canceled handshake remained open');
  peers.get('Bearer fixture-owner-b').accept();
  await bounded(secondWarm.startedPromise, 'canceling the first consumer destroyed the second warm task');
  const second = createAliyunDuplexSession(config, secondCredentials);
  second.pushText('第二个会话应正常合成'); second.finishText();
  const audio = await bounded(second.promise, 'the preserved warm task did not finish');
  assert.equal(fixture.upgrades, 2);
  assert.deepEqual(audio.subarray(44), Buffer.from([7, 0, 8, 0]));
});

test('Aliyun duplex with an already aborted signal does not leave a pending connection', async t => {
  const fixture = await wsFixture(t, peer => { peer.accept(); });
  const controller = new AbortController(); controller.abort();
  const session = createAliyunDuplexSession({ ...cfg, endpoint: fixture.ws }, credentials, controller.signal);
  await assert.rejects(session.promise, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.upgrades, 0);
});

test('Aliyun failed WebSocket and failed HTTP fallback do not negatively cache a usable endpoint', async t => {
  let httpCalls = 0;
  const fixture = await wsFixture(t, peer => {
    peer.socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }, (req, res) => { httpCalls++; req.resume(); res.writeHead(502); res.end(); });
  await assert.rejects(synthesizeAliyun({ ...cfg, model: 'cosyvoice-v3-plus', endpoint: fixture.endpoint }, credentials, '服务暂时失败', undefined, { preferWs: true }), /502/);
  assert.equal(httpCalls, 1);
  assert.equal(fixture.upgrades, 1);
  assert.equal(isAliyunWsNegativelyCached(toAliyunWsUrl(fixture.endpoint), 'cosyvoice-v3-plus'), false);
});
