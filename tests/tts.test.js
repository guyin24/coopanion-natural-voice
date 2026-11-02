import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesize } from '../src/tts.js';
import { DEFAULTS } from '../src/config.js';
import { wave, serverFor, bodyOf } from './helpers.js';

test('posts authorized speech JSON and returns playable PCM WAV', async t => {
  const audio = wave();
  let received;
  const endpoint = await serverFor(t, async (req, res) => {
    received = { method: req.method, path: req.url, auth: req.headers.authorization, body: await bodyOf(req) };
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(audio);
  });
  const result = await synthesize({ ...DEFAULTS, endpoint, model: 'test-model', voice: 'test-voice' }, 'test-key', '你好', new AbortController().signal);
  assert.deepEqual(result, audio);
  assert.deepEqual(received, { method: 'POST', path: '/v1/audio/speech', auth: 'Bearer test-key',
    body: { model: 'test-model', voice: 'test-voice', input: '你好', speed: 1, response_format: 'wav', sample_rate:24000 } });
});

test('rejects unauthorized responses without exposing provider response secrets', async t => {
  const endpoint = await serverFor(t, (req, res) => { res.writeHead(401); res.end('test-key secret'); });
  await assert.rejects(synthesize({ ...DEFAULTS, endpoint }, 'test-key', '你好'), err =>
    err.message.includes('401') && !err.message.includes('test-key'));
});

test('rejects JSON masquerading as audio and refuses redirects', async t => {
  const bad = await serverFor(t, (req, res) => res.end('{"error":"no audio"}'));
  await assert.rejects(synthesize({ ...DEFAULTS, endpoint: bad }, 'key', '你好'), /WAV/);
  const redirect = await serverFor(t, (req, res) => { res.writeHead(302, { location: bad }); res.end(); });
  await assert.rejects(synthesize({ ...DEFAULTS, endpoint: redirect }, 'key', '你好'), /302/);
});

test('cancellation stops a pending HTTP request', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const endpoint = await serverFor(t, req => { req.resume(); started(); });
  const controller = new AbortController();
  const promise = synthesize({ ...DEFAULTS, endpoint }, 'key', '你好', controller.signal);
  await ready; controller.abort();
  await assert.rejects(promise, err => err.name === 'AbortError');
});

test('rejects unsafe endpoint configuration before sending a request', async () => {
  for (const endpoint of ['http://example.test/v1/audio/speech', 'https://user:pass@example.test/tts', 'https://example.test/tts?key=x']) {
    await assert.rejects(synthesize({ ...DEFAULTS, endpoint }, 'key', '你好'));
  }
  await assert.rejects(synthesize({ ...DEFAULTS, speed: NaN }, 'key', '你好'));
});

test('rejects declared oversized audio without buffering it', async t => {
  const endpoint = await serverFor(t, (req, res) => { res.writeHead(200, { 'content-length': 20000000 }); res.end(); });
  await assert.rejects(synthesize({ ...DEFAULTS, endpoint }, 'key', '你好'), /16 MB/);
});
