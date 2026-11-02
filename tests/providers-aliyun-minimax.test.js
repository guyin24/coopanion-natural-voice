import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeAliyun } from '../src/providers/aliyun.js';
import { synthesizeMinimax } from '../src/providers/minimax.js';
import { bodyOf, serverFor, wave } from './helpers.js';

const aliyun = { model: 'cosyvoice-v3-plus', voice: 'longanyang', speed: 1.2, sampleRate: 24000 };
const minimax = { model: 'speech-2.8-hd', voice: 'male-qn-qingse', speed: 0.9, sampleRate: 24000 };

test('Aliyun posts CosyVoice input fields and downloads the completed WAV without API credentials', async t => {
  const audio = wave();
  const requests = [];
  const endpoint = await serverFor(t, async (req, res) => {
    requests.push({ method: req.method, headers: req.headers, body: req.method === 'POST' ? await bodyOf(req) : null });
    if (req.method === 'GET') return res.end(audio);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ request_id: 'request-1', output: { finish_reason: 'stop', audio: { data: '', url: `http://${req.headers.host}/audio.wav`, id: 'audio-1', expires_at: 9999999999 } }, usage: { characters: 5 } }));
  });
  const result = await synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'aliyun-only' }, '你好，世界');
  assert.deepEqual(result, audio);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.authorization, 'Bearer aliyun-only');
  assert.equal(requests[0].headers['content-type'], 'application/json');
  assert.equal(requests[0].headers['x-dashscope-sse'], undefined);
  assert.deepEqual(requests[0].body, { model: 'cosyvoice-v3-plus', input: { text: '你好，世界', voice: 'longanyang', format: 'wav', sample_rate: 24000, rate: 1.2 } });
  assert.equal(requests[1].headers.authorization, undefined);
});

test('Aliyun rejects business failures before following an audio URL and omits raw service messages', async t => {
  let gets = 0;
  const endpoint = await serverFor(t, (req, res) => {
    if (req.method === 'GET') gets++;
    res.end(JSON.stringify({ code: 'InvalidApiKey', message: 'private-key-must-not-echo', request_id: 'bad-1', output: { finish_reason: 'stop', audio: { url: `http://${req.headers.host}/audio.wav` } } }));
  });
  await assert.rejects(synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'private-key-must-not-echo' }, '测试'), error => {
    assert.match(error.message, /Aliyun|阿里云|CosyVoice/);
    assert.match(error.message, /InvalidApiKey/);
    assert.doesNotMatch(error.message, /private-key-must-not-echo/);
    return true;
  });
  assert.equal(gets, 0);
});

test('Aliyun rejects incomplete and missing audio responses', async t => {
  for (const output of [null, { finish_reason: null, audio: { url: 'https://example.com/audio.wav' } }, { finish_reason: 'stop', audio: {} }]) {
    await t.test(JSON.stringify(output), async t => {
      const endpoint = await serverFor(t, (req, res) => res.end(JSON.stringify({ request_id: 'incomplete', output })));
      await assert.rejects(synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '测试'), /完成|音频|audio|CosyVoice/);
    });
  }
});

test('Aliyun refuses an untrusted audio origin', async t => {
  let unrelatedRequests = 0;
  const unrelated = await serverFor(t, (req, res) => { unrelatedRequests++; res.end(wave()); });
  const endpoint = await serverFor(t, (req, res) => res.end(JSON.stringify({ output: { finish_reason: 'stop', audio: { url: unrelated } } })));
  await assert.rejects(synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '测试'));
  assert.equal(unrelatedRequests, 0);
});

test('Aliyun rejects an invalid downloaded WAV', async t => {
  const endpoint = await serverFor(t, (req, res) => {
    if (req.method === 'GET') return res.end('not-wave');
    res.end(JSON.stringify({ output: { finish_reason: 'stop', audio: { url: `http://${req.headers.host}/audio.wav` } } }));
  });
  await assert.rejects(synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '测试'), /WAV|PCM/);
});

test('Aliyun normalizes the exact streaming WAV length markers returned by live CosyVoice', async t => {
  const expected = wave();
  const audio = Buffer.from(expected);
  audio.writeUInt32LE(0x7fffffbf, 4);
  audio.writeUInt32LE(0x7fffff9b, 40);
  const endpoint = await serverFor(t, (req, res) => {
    if (req.method === 'GET') return res.end(audio);
    res.end(JSON.stringify({ output: { finish_reason: 'stop', audio: { url: `http://${req.headers.host}/audio.wav` } } }));
  });
  const result = await synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '测试');
  assert.deepEqual(result, expected);
});

test('Aliyun streaming-header compatibility still rejects corrupt format, length and samples', async t => {
  for (const mutate of [b => b.writeUInt32LE(0x7fffff9a, 40), b => b.writeUInt16LE(0, 22), b => b.subarray(0, b.length - 1)]) {
    const audio = wave();
    audio.writeUInt32LE(0x7fffffbf, 4);
    audio.writeUInt32LE(0x7fffff9b, 40);
    const changed = mutate(audio);
    const endpoint = await serverFor(t, (req, res) => {
      if (req.method === 'GET') return res.end(Buffer.isBuffer(changed) ? changed : audio);
      res.end(JSON.stringify({ output: { finish_reason: 'stop', audio: { url: `http://${req.headers.host}/audio.wav` } } }));
    });
    await assert.rejects(synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '测试'), /WAV|PCM/);
  }
});

test('MiniMax requests nonstreaming mono WAV hex and decodes its complete result', async t => {
  let received;
  const audio = wave();
  const endpoint = await serverFor(t, async (req, res) => {
    received = { headers: req.headers, body: await bodyOf(req) };
    res.end(JSON.stringify({ data: { audio: audio.toString('hex'), status: 2 }, extra_info: { audio_format: 'wav', audio_sample_rate: 16000, audio_channel: 1, audio_size: audio.length, usage_characters: 2 }, trace_id: 'trace-1', base_resp: { status_code: 0, status_msg: 'success' } }));
  });
  const result = await synthesizeMinimax({ endpoint, ...minimax }, { apiKey: 'minimax-only' }, '你好');
  assert.deepEqual(result, audio);
  assert.equal(received.headers.authorization, 'Bearer minimax-only');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.deepEqual(received.body, { model: 'speech-2.8-hd', text: '你好', stream: false, voice_setting: { voice_id: 'male-qn-qingse', speed: 0.9, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 }, output_format: 'hex' });
});

test('MiniMax checks business status before attempting to decode audio and hides raw service messages', async t => {
  const endpoint = await serverFor(t, (req, res) => res.end(JSON.stringify({ data: { audio: 'malformed', status: 2 }, base_resp: { status_code: 1004, status_msg: 'secret-minimax-key' } })));
  await assert.rejects(synthesizeMinimax({ endpoint, ...minimax }, { apiKey: 'secret-minimax-key' }, '测试'), error => {
    assert.match(error.message, /MiniMax/);
    assert.match(error.message, /1004/);
    assert.doesNotMatch(error.message, /secret-minimax-key|hex|Hex/);
    return true;
  });
});

test('MiniMax requires a numeric successful business status and completed audio', async t => {
  for (const response of [
    { data: { audio: wave().toString('hex'), status: 2 } },
    { data: { audio: wave().toString('hex'), status: 2 }, base_resp: { status_code: '0' } },
    { data: { audio: wave().toString('hex'), status: 1 }, base_resp: { status_code: 0 } },
    { data: null, base_resp: { status_code: 0 } },
    { data: { audio: '', status: 2 }, base_resp: { status_code: 0 } },
  ]) {
    await t.test(JSON.stringify(response).slice(-80), async t => {
      const endpoint = await serverFor(t, (req, res) => res.end(JSON.stringify(response)));
      await assert.rejects(synthesizeMinimax({ endpoint, ...minimax }, { apiKey: 'key' }, '测试'));
    });
  }
});

test('MiniMax rejects malformed hex and decoded non-WAV audio', async t => {
  for (const audio of ['4g', '524', Buffer.from('not-wave').toString('hex')]) {
    await t.test(audio, async t => {
      const endpoint = await serverFor(t, (req, res) => res.end(JSON.stringify({ data: { audio, status: 2 }, base_resp: { status_code: 0 } })));
      await assert.rejects(synthesizeMinimax({ endpoint, ...minimax }, { apiKey: 'key' }, '测试'));
    });
  }
});

for (const [name, synthesize, cfg] of [['Aliyun', synthesizeAliyun, aliyun], ['MiniMax', synthesizeMinimax, minimax]]) {
  test(`${name} returns finite WAV headers when its encoder leaves streaming size placeholders`, async t => {
    const audio = wave();
    audio.writeUInt32LE(0xffffffff, 4);
    audio.writeUInt32LE(0xffffffff, 40);
    const endpoint = await serverFor(t, (req, res) => {
      if (req.method === 'GET') return res.end(audio);
      const response = name === 'Aliyun'
        ? { output: { finish_reason: 'stop', audio: { url: `http://${req.headers.host}/audio.wav` } } }
        : { data: { audio: audio.toString('hex'), status: 2 }, base_resp: { status_code: 0 } };
      res.end(JSON.stringify(response));
    });
    const result = await synthesize({ endpoint, ...cfg }, { apiKey: 'key' }, '测试');
    assert.equal(result.readUInt32LE(4), result.length - 8);
    assert.equal(result.readUInt32LE(40), result.length - 44);
  });

  test(`${name} propagates cancellation while the synthesis request is in progress`, async t => {
    let seen;
    const requestSeen = new Promise(resolve => { seen = resolve; });
    const endpoint = await serverFor(t, (req, res) => { seen(); });
    const controller = new AbortController();
    const result = synthesize({ endpoint, ...cfg }, { apiKey: 'key' }, '测试', controller.signal);
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await requestSeen;
    controller.abort();
    await rejected;
  });

  test(`${name} propagates HTTP authentication failures`, async t => {
    const endpoint = await serverFor(t, (req, res) => { res.statusCode = 401; res.end('{}'); });
    await assert.rejects(synthesize({ endpoint, ...cfg }, { apiKey: 'key' }, '测试'), /401/);
  });
}

test('Aliyun cancellation also stops the audio download', async t => {
  let seen;
  const downloadSeen = new Promise(resolve => { seen = resolve; });
  const endpoint = await serverFor(t, (req, res) => {
    if (req.method === 'GET') return seen();
    res.end(JSON.stringify({ output: { finish_reason: 'stop', audio: { url: `http://${req.headers.host}/slow.wav` } } }));
  });
  const controller = new AbortController();
  const result = synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '测试', controller.signal);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await downloadSeen;
  controller.abort();
  await rejected;
});


test('Aliyun automatically resolves endpoints and voice suffixes between CosyVoice HTTP and Qwen-Audio 3.1 WebSocket', async () => {
  const { resolveAliyunEndpoint, normalizeAliyunVoice } = await import('../src/providers/aliyun.js');
  const { validateConfig } = await import('../src/config.js');

  const wsFromHttp = resolveAliyunEndpoint({
    endpoint: validateConfig({
      provider: 'aliyun',
      workspaceId: 'ws-public-example',
      endpoint: 'https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
      model: 'qwen-audio-3.1-tts-plus',
      voice: 'longanhuan_v3.1',
    }),
    model: 'qwen-audio-3.1-tts-plus',
  });
  assert.deepEqual(wsFromHttp, {
    mode: 'ws',
    endpoint: 'wss://ws-public-example.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
  });

  const httpFromWs = resolveAliyunEndpoint({
    endpoint: validateConfig({
      provider: 'aliyun',
      endpoint: 'wss://ws-public-example.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
      model: 'cosyvoice-v3-plus',
      voice: 'longanyang',
    }),
    model: 'cosyvoice-v3-plus',
  });
  assert.deepEqual(httpFromWs, {
    mode: 'http',
    endpoint: 'https://ws-public-example.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  });

  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-plus', 'longanhuan'), 'longanhuan_v3.1');
  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-plus', 'longanhuan_v3'), 'longanhuan_v3.1');
  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-plus', 'longanhuan_v3.1'), 'longanhuan_v3.1');
  assert.equal(normalizeAliyunVoice('cosyvoice-v3-plus', 'longanyang_v3.1'), 'longanyang');
});

test('Aliyun normalizes only known aliases belonging to the requested model and preserves custom voice IDs', async () => {
  const { normalizeAliyunVoice } = await import('../src/providers/aliyun.js');
  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-plus', 'longanyang'), 'longanyang');
  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-flash', 'longanyang'), 'longanyang_v3.1');
  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-plus', 'longcustom'), 'longcustom');
  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-flash', 'longcustom_v3'), 'longcustom_v3');
  assert.equal(normalizeAliyunVoice('cosyvoice-v3-plus', 'longcustom_v3.1'), 'longcustom_v3.1');
  assert.equal(normalizeAliyunVoice('cosyvoice-v3-plus', 'longanlingxin_v3.1'), 'longanlingxin_v3.1');
  assert.equal(normalizeAliyunVoice('qwen-audio-3.1-tts-flash', 'Emily_v3.1'), 'Emily_v3.1');
});

test('Aliyun synthesizes qwen-audio-3.1-tts-plus via DashScope tts_v2 WebSocket duplex protocol', async t => {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const receivedFrames = [];
  let upgradeHeaders = null;
  const pcmSample = Buffer.alloc(480, 0x12);

  const encodeServerFrame = (opcode, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const header = data.length < 126
      ? Buffer.from([0x80 | opcode, data.length])
      : Buffer.from([0x80 | opcode, 126, (data.length >> 8) & 0xff, data.length & 0xff]);
    return Buffer.concat([header, data]);
  };

  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    upgradeHeaders = req.headers;
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 6) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 8) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        }
        if (buf.length < offset + 4 + len) return;
        const mask = buf.subarray(offset, offset + 4);
        const payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
        buf = buf.subarray(offset + 4 + len);
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x1) {
          const msg = JSON.parse(payload.toString('utf8'));
          receivedFrames.push(msg);
          const action = msg.header?.action;
          const taskId = msg.header?.task_id;
          if (action === 'run-task') {
            socket.write(encodeServerFrame(0x1, JSON.stringify({
              header: { task_id: taskId, event: 'task-started' },
              payload: {},
            })));
          } else if (action === 'finish-task') {
            socket.write(encodeServerFrame(0x2, pcmSample));
            socket.write(encodeServerFrame(0x1, JSON.stringify({
              header: { task_id: taskId, event: 'task-finished' },
              payload: { output: {} },
            })));
          }
        }
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/v1/services/audio/tts/SpeechSynthesizer`;

  const result = await synthesizeAliyun({
    endpoint,
    model: 'qwen-audio-3.1-tts-plus',
    voice: 'longanhuan_v3.1',
    speed: 1.1,
    sampleRate: 24000,
  }, { apiKey: 'ws-secret-key' }, 'How is the weather today?');

  assert.equal(upgradeHeaders.authorization, 'Bearer ws-secret-key');
  assert.equal(receivedFrames.length, 3);
  assert.equal(receivedFrames[0].header.action, 'run-task');
  assert.equal(receivedFrames[0].payload.model, 'qwen-audio-3.1-tts-plus');
  assert.equal(receivedFrames[0].payload.parameters.voice, 'longanhuan_v3.1');
  assert.equal(receivedFrames[1].header.action, 'continue-task');
  assert.equal(receivedFrames[1].payload.input.text, 'How is the weather today?');
  assert.equal(receivedFrames[2].header.action, 'finish-task');
  assert.equal(result.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(result.subarray(44), pcmSample);
});

test('Aliyun prewarms WebSocket task, streams duplex text deltas, and emits first audio chunk early', async t => {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const { prewarmAliyunWsTask, createAliyunDuplexSession, clearWarmAliyunTasks } = await import('../src/providers/aliyun.js');

  let upgradeCount = 0;
  const receivedTexts = [];
  const bigPcm1 = Buffer.alloc(30000, 0);
  const bigPcm2 = Buffer.alloc(4800, 0x05);

  const encodeServerFrame = (opcode, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const header = data.length < 126
      ? Buffer.from([0x80 | opcode, data.length])
      : Buffer.from([0x80 | opcode, 126, (data.length >> 8) & 0xff, data.length & 0xff]);
    return Buffer.concat([header, data]);
  };

  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    upgradeCount++;
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 6) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 8) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        }
        if (buf.length < offset + 4 + len) return;
        const mask = buf.subarray(offset, offset + 4);
        const payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
        buf = buf.subarray(offset + 4 + len);
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x1) {
          const msg = JSON.parse(payload.toString('utf8'));
          const action = msg.header?.action;
          const taskId = msg.header?.task_id;
          if (action === 'run-task') {
            socket.write(encodeServerFrame(0x1, JSON.stringify({
              header: { task_id: taskId, event: 'task-started' },
              payload: {},
            })));
          } else if (action === 'continue-task') {
            receivedTexts.push(msg.payload?.input?.text);
            if (receivedTexts.length === 1) {
              socket.write(encodeServerFrame(0x2, bigPcm1));
            }
          } else if (action === 'finish-task') {
            socket.write(encodeServerFrame(0x2, bigPcm2));
            socket.write(encodeServerFrame(0x1, JSON.stringify({
              header: { task_id: taskId, event: 'task-finished' },
              payload: { output: {} },
            })));
          }
        }
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { clearWarmAliyunTasks(); server.close(); });
  const { port } = server.address();
  const cfg = {
    endpoint: `ws://127.0.0.1:${port}/api-ws/v1/inference`,
    model: 'qwen-audio-3.1-tts-flash',
    voice: 'longqiang_v3.1',
    speed: 1,
    sampleRate: 24000,
  };

  // Pre-warm during thinking phase
  const warm = prewarmAliyunWsTask(cfg, { apiKey: 'test-key' });
  await warm.startedPromise;
  assert.equal(upgradeCount, 1);

  const earlyWaves = [];
  const session = createAliyunDuplexSession(cfg, { apiKey: 'test-key' }, undefined, {
    onFirstChunk: wav => earlyWaves.push(wav),
  });
  session.pushText('现在晴间');
  session.pushText('多云，');
  session.finishText();

  const remainderWav = await session.promise;
  // Reused the pre-warmed connection without opening a second socket!
  assert.equal(upgradeCount, 1);
  assert.deepEqual(receivedTexts, ['现在晴间', '多云，']);
  assert.equal(earlyWaves.length, 1);
  assert.equal(earlyWaves[0].toString('ascii', 0, 4), 'RIFF');
  assert.ok(remainderWav && remainderWav.toString('ascii', 0, 4) === 'RIFF');
});

test('Aliyun CosyVoice prefers WebSocket when preferWs is set and falls back to HTTP on WS failure', async t => {
  const { clearWarmAliyunTasks, isAliyunWsNegativelyCached, prewarmAliyunWsTask, toAliyunWsUrl } = await import('../src/providers/aliyun.js');
  clearWarmAliyunTasks();
  t.after(() => clearWarmAliyunTasks());
  const audio = wave();
  let httpCalls = 0;
  let wsUpgrades = 0;
  const endpoint = await serverFor(t, (req, res) => {
    if (req.method === 'GET') return res.end(audio);
    httpCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: { finish_reason: 'stop', audio: { url: `http://${req.headers.host}/audio.wav` } } }));
  });
  // First call: WS fails (no upgrade handler), falls back to HTTP and caches WS as unsupported for this endpoint+model
  const result = await synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '回退测试', undefined, { preferWs: true });
  assert.equal(httpCalls, 1);
  assert.deepEqual(result, audio);
  assert.equal(isAliyunWsNegativelyCached(toAliyunWsUrl(endpoint), aliyun.model), true);
  assert.equal(prewarmAliyunWsTask({ endpoint, ...aliyun }, { apiKey: 'key' }), null);

  // Second call: skips doomed WS attempt and goes directly to HTTP
  const result2 = await synthesizeAliyun({ endpoint, ...aliyun }, { apiKey: 'key' }, '第二次直接走HTTP', undefined, { preferWs: true });
  assert.equal(httpCalls, 2);
  assert.equal(wsUpgrades, 0);
  assert.deepEqual(result2, audio);
});
