import test from 'node:test';
import assert from 'node:assert/strict';
import { serverFor, bodyOf } from './helpers.js';
import * as volc from '../src/providers/volcengine.js';
import * as tencent from '../src/providers/tencent.js';
const credentials = { secretId: 'test-secret-id', secretKey: 'test-secret-key' };
const cfg = { model: '1', voice: '101001', speed: 1, sampleRate: 24000 };
const pcm = Buffer.from([1, 0, 255, 127]);
const end = { code: 20000000, message: 'OK', data: null };

function assertPcmWave(audio, expected = pcm, sampleRate = 24000) {
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  assert.equal(audio.readUInt16LE(20), 1);
  assert.equal(audio.readUInt16LE(22), 1);
  assert.equal(audio.readUInt16LE(34), 16);
  assert.equal(audio.readUInt32LE(24), sampleRate);
  assert.deepEqual(audio.subarray(44), expected);
  assert.equal(audio.readUInt32LE(40), expected.length);
}

test('Volcano requests PCM with modern auth and concatenates base64 frames before WAV framing', async t => {
  let received;
  const endpoint = await serverFor(t, async (req, res) => {
    received = { headers: req.headers, body: await bodyOf(req) };
    res.setHeader('Content-Type', 'application/x-ndjson');
    // Individual network frames need not end on a 16-bit sample boundary.
    res.end([{ code: 0, message: '', data: 'AQ==' },
      { code: 0, message: '', data: 'AP9/' },
      { code: 0, data: null, sentence: { text: '你好' } }, end].map(x => JSON.stringify(x)).join('\n'));
  });
  const audio = await volc.synthesizeVolcengine({ endpoint, voice: 'zh_female_vv_uranus_bigtts', speed: 1.5, sampleRate: 16000 }, { apiKey: 'volcano-key' }, '你好');
  assertPcmWave(audio, pcm, 16000);
  assert.equal(received.headers['x-api-key'], 'volcano-key');
  assert.equal(received.headers['x-api-app-id'], undefined);
  assert.equal(received.headers['x-api-access-key'], undefined);
  assert.equal(received.headers['x-api-resource-id'], 'seed-tts-2.0');
  assert.match(received.headers['x-api-request-id'], /^[\da-f-]{36}$/i);
  assert.deepEqual(received.body.req_params, { text: '你好', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'pcm', sample_rate: 16000, speech_rate: 50 } });
});

test('Volcano explicitly selected legacy auth sends app ID and access token without modern key', async t => {
  let headers;
  const endpoint = await serverFor(t, async (req, res) => {
    headers = req.headers;
    await bodyOf(req);
    res.end([JSON.stringify({ code: 0, data: pcm.toString('base64') }), JSON.stringify(end)].join('\n'));
  });
  assertPcmWave(await volc.synthesizeVolcengine({ endpoint, model: 'seed-tts-1.0', voice: 'speaker' }, { apiKey: 'legacy-token', appId: '1234' }, 'hi'));
  assert.equal(headers['x-api-app-id'], '1234');
  assert.equal(headers['x-api-access-key'], 'legacy-token');
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['x-api-resource-id'], 'seed-tts-1.0');
});

test('Volcano decodes SSE envelopes through the shared transport', async t => {
  const endpoint = await serverFor(t, async (req, res) => {
    await bodyOf(req);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`event: 352\ndata: ${JSON.stringify({ code: 0, data: pcm.toString('base64') })}\n\nevent: 152\ndata: ${JSON.stringify(end)}\n\n`);
  });
  assertPcmWave(await volc.synthesizeVolcengine({ endpoint, voice: 'speaker' }, { apiKey: 'key' }, 'hi'));
});

for (const [name, frames, pattern] of [
  ['reports a business error after partial audio', [{ code: 0, data: 'AQA=' }, { code: 45000000, message: 'speaker permission denied' }], /45000000.*speaker permission denied/],
  ['rejects an unfinished stream', [{ code: 0, data: 'AQA=' }], /complete|finish|terminal|结束/i],
  ['rejects an empty successful stream', [end], /audio|音频/i],
  ['rejects malformed base64', [{ code: 0, data: '%%%=' }, end], /base64/i],
  ['rejects a missing business status', [{ data: 'AQA=' }, end], /status|code|状态/i],
  ['rejects misaligned PCM after all frames', [{ code: 0, data: 'AQ==' }, end], /PCM|sample|采样/i],
  ['rejects extra frames after completion', [{ code: 0, data: 'AQA=' }, end, { code: 0, data: 'AQA=' }], /结束|finish|complete/i],
]) {
  test(`Volcano ${name}`, async t => {
    const endpoint = await serverFor(t, async (req, res) => {
      await bodyOf(req); res.end(frames.map(x => JSON.stringify(x)).join('\n'));
    });
    await assert.rejects(volc.synthesizeVolcengine({ endpoint, voice: 'speaker' }, { apiKey: 'key' }, 'hi'), pattern);
  });
}

test('Tencent TC3 signature matches the official independent published fixture', () => {
  const headers = tencent.signTencentRequest({
    endpoint: 'https://cvm.tencentcloudapi.com/',
    payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
    credentials: { secretId: 'AKID********************************', secretKey: '********************************' },
    timestamp: 1551113065, service: 'cvm', action: 'DescribeInstances', version: '2017-03-12', region: 'ap-guangzhou',
  });
  assert.equal(headers.Authorization, 'TC3-HMAC-SHA256 Credential=AKID********************************/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f');
  assert.equal(headers['X-TC-Timestamp'], '1551113065');
});

test('Tencent sends signed PCM requests, converts speed, and never sends SecretKey', async t => {
  let received;
  const endpoint = await serverFor(t, async (req, res) => {
    received = { headers: req.headers, body: await bodyOf(req) };
    res.end(JSON.stringify({ Response: { Audio: pcm.toString('base64'), SessionId: received.body.SessionId, RequestId: 'request' } }));
  });
  assertPcmWave(await tencent.synthesizeTencent({ ...cfg, endpoint, speed: 1.35, region: 'ap-shanghai' }, { ...credentials, sessionToken: 'temporary-token' }, '你好'));
  assert.equal(received.body.Text, '你好');
  assert.equal(received.body.Speed, 1.5);
  assert.equal(received.body.ModelType, 1);
  assert.equal(received.body.VoiceType, 101001);
  assert.equal(received.body.SampleRate, 24000);
  assert.equal(received.body.Codec, 'pcm');
  assert.match(received.body.SessionId, /^[\da-f-]{36}$/i);
  assert.equal(received.headers['x-tc-action'], 'TextToVoice');
  assert.equal(received.headers['x-tc-version'], '2019-08-23');
  assert.equal(received.headers['x-tc-region'], 'ap-shanghai');
  assert.equal(received.headers['x-tc-token'], 'temporary-token');
  assert.equal(received.headers['content-type'], 'application/json; charset=utf-8');
  assert.match(received.headers.authorization, /Credential=test-secret-id\/\d{4}-\d\d-\d\d\/tts\/tc3_request/);
  assert.ok(!JSON.stringify(received).includes(credentials.secretKey));
});

test('Tencent omitted sample rate uses 16k compatible with the default voice', async t => {
  let received;
  const endpoint = await serverFor(t, async (req, res) => {
    received = await bodyOf(req);
    res.end(JSON.stringify({ Response: { Audio: pcm.toString('base64'), RequestId: 'request' } }));
  });
  assertPcmWave(await tencent.synthesizeTencent({ endpoint }, credentials, '你好'), pcm, 16000);
  assert.equal(received.VoiceType, 101001);
  assert.equal(received.SampleRate, 16000);
});

test('Tencent splits mixed Unicode within both service limits without dropping text and concatenates PCM once', async t => {
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const endpoint = await serverFor(t, async (req, res) => {
    active++; maximumActive = Math.max(maximumActive, active);
    const body = await bodyOf(req); requests.push(body);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; res.end(JSON.stringify({ Response: { Audio: pcm.toString('base64'), SessionId: body.SessionId, RequestId: 'request' } }));
  });
  const text = '中'.repeat(139) + '😀'.repeat(110) + 'abcdef '.repeat(60);
  const audio = await tencent.synthesizeTencent({ ...cfg, endpoint }, credentials, text);
  assert.equal(requests.map(x => x.Text).join(''), text);
  assert.ok(requests.length > 2);
  for (const request of requests) {
    assert.ok(Array.from(request.Text).length <= 140);
    assert.ok(Buffer.byteLength(request.Text, 'utf8') <= 420);
    assert.ok(!/[\uD800-\uDBFF]$/.test(request.Text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(request.Text));
  }
  assert.equal(maximumActive, 1);
  assert.equal(new Set(requests.map(x => x.SessionId)).size, requests.length);
  assertPcmWave(audio, Buffer.concat(requests.map(() => pcm)));
});

test('Tencent speed conversion follows the published piecewise curve and clamps unsupported multipliers', () => {
  for (const [input, expected] of [[0.5, -2], [0.6, -2], [0.7, -1.5], [0.8, -1], [1, 0], [1.2, 1], [1.35, 1.5], [1.5, 2], [2, 4], [2.5, 6], [4, 6]]) {
    assert.equal(tencent.tencentSpeed(input), expected);
  }
});

for (const [name, response, pattern] of [
  ['reports Cloud API business errors', { Response: { Error: { Code: 'UnsupportedOperation.PkgExhausted', Message: 'quota exhausted' }, RequestId: 'request' } }, /PkgExhausted.*quota exhausted/],
  ['rejects missing audio', { Response: { RequestId: 'request' } }, /audio|音频/i],
  ['rejects malformed base64', { Response: { Audio: '%%%' } }, /base64/i],
  ['rejects misaligned PCM', { Response: { Audio: 'AQ==' } }, /PCM|sample|采样/i],
]) {
  test(`Tencent ${name}`, async t => {
    const endpoint = await serverFor(t, async (req, res) => { await bodyOf(req); res.end(JSON.stringify(response)); });
    await assert.rejects(tencent.synthesizeTencent({ ...cfg, endpoint }, credentials, 'hi'), pattern);
  });
}

test('Tencent cancellation prevents the next chunk from being submitted', async t => {
  let calls = 0;
  const controller = new AbortController();
  const endpoint = await serverFor(t, async (req, res) => {
    calls++; await bodyOf(req); controller.abort();
    res.end(JSON.stringify({ Response: { Audio: pcm.toString('base64'), RequestId: 'request' } }));
  });
  await assert.rejects(tencent.synthesizeTencent({ ...cfg, endpoint }, credentials, '中'.repeat(300), controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('both adapters reject missing credentials and invalid local settings before any HTTP request', async () => {
  await assert.rejects(volc.synthesizeVolcengine({ voice: 'speaker' }, {}, 'hi'), /API.?Key|凭据|密钥/i);
  await assert.rejects(tencent.synthesizeTencent(cfg, { secretId: 'id' }, 'hi'), /SecretKey|凭据|密钥/i);
  await assert.rejects(tencent.synthesizeTencent({ ...cfg, voice: 'not-a-number' }, credentials, 'hi'), /voice|音色/i);
  await assert.rejects(tencent.synthesizeTencent({ ...cfg, sampleRate: 48000 }, credentials, 'hi'), /sample|采样/i);
  await assert.rejects(volc.synthesizeVolcengine({ voice: 'speaker', sampleRate: 12345 }, { apiKey: 'key' }, 'hi'), /sample|采样/i);
  await assert.rejects(tencent.synthesizeTencent(cfg, credentials, ' '), /text|文本/i);
});

for (const [name, synthesize, config, secrets, failure] of [
  ['Volcano', volc.synthesizeVolcengine, { voice: 'speaker' }, { apiKey: 'private-volcano-key', appId: 'private-app-id' },
    { code: 45000000, message: 'private-volcano-key private-app-id are invalid' }],
  ['Tencent', tencent.synthesizeTencent, cfg, { ...credentials, sessionToken: 'private-session-token' },
    { Response: { Error: { Code: 'AuthFailure.InvalidSecretId', Message: 'test-secret-id test-secret-key private-session-token are invalid' } } }],
]) {
  test(`${name} does not expose credentials reflected by an upstream error`, async t => {
    const endpoint = await serverFor(t, async (req, res) => { await bodyOf(req); res.end(JSON.stringify(failure)); });
    await assert.rejects(synthesize({ ...config, endpoint }, secrets, 'hi'), error => {
      for (const value of Object.values(secrets)) assert.ok(!error.message.includes(value));
      return true;
    });
  });
  test(`${name} propagates cancellation during a pending HTTP request`, async t => {
    let arrived;
    const started = new Promise(resolve => { arrived = resolve; });
    const endpoint = await serverFor(t, async req => { await bodyOf(req); arrived(); });
    const controller = new AbortController();
    const pending = synthesize({ ...config, endpoint }, secrets, 'hi', controller.signal);
    await started;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
}
