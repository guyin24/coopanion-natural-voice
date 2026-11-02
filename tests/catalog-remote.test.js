import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinRemoteCatalog, fetchRemoteCatalog } from '../src/catalogs/remote.js';
import { serverFor, bodyOf } from './helpers.js';

const ids = items => items.map(item => item.id);
const reply = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };

test('builtin catalogs expose documented voices and protect legacy OpenAI voice compatibility', () => {
  const catalog = builtinRemoteCatalog('openai');
  assert.equal(catalog.source, 'preset');
  assert.ok(ids(catalog.models).includes('gpt-4o-mini-tts'));
  assert.ok(catalog.voices.find(v => v.id === 'coral').models.includes('tts-1'));
  assert.equal(catalog.voices.find(v => v.id === 'marin').models.includes('tts-1'), false);
  catalog.voices[0].models.push('mutated');
  assert.equal(builtinRemoteCatalog('openai').voices[0].models.includes('mutated'), false);
  assert.deepEqual(builtinRemoteCatalog('compatible').voices, []);
});

test('MiniMax queries all voice categories through the configured gateway and keeps static models', async t => {
  let received;
  const endpoint = await serverFor(t, async (req, res) => {
    received = { path: req.url, method: req.method, key: req.headers.authorization, body: await bodyOf(req) };
    reply(res, { system_voice: [{ voice_id: 'sys-voice', voice_name: '系统音色' }], voice_cloning: [{ voice_id: 'clone-voice', description: [] }], voice_generation: [{ voice_id: 'generated-voice' }], base_resp: { status_code: 0, status_msg: 'success' } });
  });
  const catalog = await fetchRemoteCatalog({ provider: 'minimax', endpoint: endpoint.replace('/v1/audio/speech', '/gateway/v1/t2a_v2') }, { apiKey: 'fixture-key' });
  assert.deepEqual(received, { path: '/gateway/v1/get_voice', method: 'POST', key: 'Bearer fixture-key', body: { voice_type: 'all' } });
  assert.equal(catalog.voices.find(v => v.id === 'sys-voice').label, '系统音色');
  assert.equal(catalog.voices.find(v => v.id === 'clone-voice').kind, 'custom');
  assert.ok(ids(catalog.voices).includes('generated-voice'));
  assert.ok(ids(catalog.models).includes('speech-2.8-hd'));
  assert.equal(catalog.source, 'mixed');
});

test('MiniMax rejects business failure without exposing server error text', async t => {
  const endpoint = await serverFor(t, (req, res) => reply(res, { system_voice: [{ voice_id: 'untrusted' }], base_resp: { status_code: 1004, status_msg: 'SECRET fixture-key' } }));
  const catalog = await fetchRemoteCatalog({ provider: 'minimax', endpoint: endpoint.replace('/audio/speech', '/t2a_v2') }, { apiKey: 'fixture-key' });
  assert.equal(ids(catalog.voices).includes('untrusted'), false);
  assert.ok(catalog.voices.length > 0);
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET|fixture-key/);
  assert.match(catalog.note, /未能|失败|预置/);
});

test('ElevenLabs filters TTS models and traverses token-paginated voices on the same gateway', async t => {
  const requests = [];
  const endpoint = await serverFor(t, (req, res) => {
    requests.push({ path: req.url, key: req.headers['xi-api-key'], method: req.method });
    if (req.url === '/gateway/v1/models') return reply(res, [{ model_id: 'new-tts', name: 'New TTS', can_do_text_to_speech: true }, { model_id: 'asr-only', can_do_text_to_speech: false }]);
    if (req.url.includes('next_page_token=')) return reply(res, { voices: [{ voice_id: 'second', name: 'Second' }], has_more: false, next_page_token: null });
    return reply(res, { voices: [{ voice_id: 'first', name: 'First', category: 'cloned', labels: { language: 'zh' } }], has_more: true, next_page_token: 'next + token' });
  });
  const catalog = await fetchRemoteCatalog({ provider: 'elevenlabs', endpoint: endpoint.replace('/v1/audio/speech', '/gateway/v1/text-to-speech/current') }, { apiKey: 'eleven-fixture' });
  assert.ok(ids(catalog.models).includes('new-tts'));
  assert.equal(ids(catalog.models).includes('asr-only'), false);
  assert.ok(ids(catalog.voices).includes('first'));
  assert.ok(ids(catalog.voices).includes('second'));
  assert.equal(catalog.voices.find(v => v.id === 'first').kind, 'custom');
  assert.ok(ids(catalog.models).includes('eleven_multilingual_v2'));
  assert.equal(catalog.source, 'mixed');
  assert.ok(requests.every(req => req.key === 'eleven-fixture' && req.method === 'GET'));
  const pages = requests.filter(req => req.path.startsWith('/gateway/v2/voices'));
  assert.equal(pages.length, 2);
  assert.equal(new URL(pages[0].path, 'http://fixture').searchParams.get('page_size'), '100');
  assert.equal(new URL(pages[1].path, 'http://fixture').searchParams.get('next_page_token'), 'next + token');
});

test('ElevenLabs bounds repeated pagination tokens and retains fetched entries', async t => {
  let pages = 0;
  const endpoint = await serverFor(t, (req, res) => {
    if (req.url === '/v1/models') return reply(res, []);
    pages++;
    return reply(res, { voices: [{ voice_id: `voice-${pages}`, name: 'Voice' }], has_more: true, next_page_token: 'same-token' });
  });
  const catalog = await fetchRemoteCatalog({ provider: 'elevenlabs', endpoint: endpoint.replace('/audio/speech', '/text-to-speech/current') }, { apiKey: 'key' });
  assert.ok(pages <= 2);
  assert.ok(ids(catalog.voices).includes('voice-1'));
  assert.match(catalog.note, /分页|部分|上限/);
});

test('ElevenLabs enforces the twenty-page catalog limit', async t => {
  let pages = 0;
  const endpoint = await serverFor(t, (req, res) => {
    if (req.url === '/v1/models') return reply(res, []);
    pages++;
    return reply(res, { voices: Array.from({ length: 100 }, (_, i) => ({ voice_id: `v-${pages}-${i}`, name: 'Voice' })), has_more: true, next_page_token: `page-${pages}` });
  });
  const catalog = await fetchRemoteCatalog({ provider: 'elevenlabs', endpoint: endpoint.replace('/audio/speech', '/text-to-speech/current') }, { apiKey: 'key' });
  assert.equal(pages, 20);
  assert.ok(catalog.voices.length <= 2000);
  assert.match(catalog.note, /上限|部分/);
});

test('Azure derives voice listing for regional and custom-resource paths with key authentication', async t => {
  const requests = [];
  const endpoint = await serverFor(t, (req, res) => {
    requests.push({ path: req.url, key: req.headers['ocp-apim-subscription-key'] });
    reply(res, [{ ShortName: 'zh-CN-CustomNeural', LocalName: '本地名', DisplayName: 'Display', Locale: 'zh-CN', VoiceType: 'Neural' }]);
  });
  for (const suffix of ['/cognitiveservices/v1', '/tts/cognitiveservices/v1']) {
    const catalog = await fetchRemoteCatalog({ provider: 'azure', endpoint: endpoint.replace('/v1/audio/speech', suffix) }, { apiKey: 'azure-fixture' });
    assert.equal(catalog.voices.find(v => v.id === 'zh-CN-CustomNeural').label, '本地名');
    assert.equal(catalog.voices.find(v => v.id === 'zh-CN-CustomNeural').locale, 'zh-CN');
    assert.deepEqual(ids(catalog.models), ['neural']);
  }
  assert.deepEqual(requests, [{ path: '/cognitiveservices/voices/list', key: 'azure-fixture' }, { path: '/tts/cognitiveservices/voices/list', key: 'azure-fixture' }]);
});

test('SiliconFlow merges per-model system voices with account custom voices and filters ASR', async t => {
  const requests = [];
  const endpoint = await serverFor(t, (req, res) => {
    requests.push({ path: req.url, key: req.headers.authorization });
    if (req.url.startsWith('/gateway/v1/models')) return reply(res, { object: 'list', data: [{ id: 'FunAudioLLM/CosyVoice2-0.5B' }, { id: 'fnlp/MOSS-TTSD-v0.5' }, { id: 'FunAudioLLM/SenseVoiceSmall' }, { id: 'deepseek-ai/DeepSeek-V3' }] });
    reply(res, { results: [{ uri: 'speech:my-voice:123:abc', customName: '我的音色', model: 'FunAudioLLM/CosyVoice2-0.5B', text: '参考文本' }] });
  });
  const catalog = await fetchRemoteCatalog({ provider: 'siliconflow', endpoint: endpoint.replace('/v1/audio/speech', '/gateway/v1/audio/speech') }, { apiKey: 'sf-fixture' });
  assert.ok(requests.every(req => req.key === 'Bearer sf-fixture'));
  assert.equal(new URL(requests.find(req => req.path.includes('/models')).path, 'http://fixture').searchParams.get('type'), 'audio');
  assert.ok(requests.some(req => req.path === '/gateway/v1/audio/voice/list'));
  assert.equal(ids(catalog.models).includes('FunAudioLLM/SenseVoiceSmall'), false);
  assert.equal(ids(catalog.models).includes('deepseek-ai/DeepSeek-V3'), false);
  assert.deepEqual(catalog.voices.find(v => v.id === 'speech:my-voice:123:abc').models, ['FunAudioLLM/CosyVoice2-0.5B']);
  assert.ok(catalog.voices.some(v => v.id === 'fnlp/MOSS-TTSD-v0.5:alex'));
  assert.equal(catalog.source, 'mixed');
});

test('a failed model request does not discard a successful voice catalog or expose credentials', async t => {
  const endpoint = await serverFor(t, (req, res) => {
    if (req.url.startsWith('/v1/models')) { res.statusCode = 401; return res.end('SECRET fixture-key'); }
    reply(res, { results: [{ uri: 'speech:voice:fixture', customName: '可用音色', model: 'FunAudioLLM/CosyVoice2-0.5B' }] });
  });
  const catalog = await fetchRemoteCatalog({ provider: 'siliconflow', endpoint }, { apiKey: 'fixture-key' });
  assert.ok(ids(catalog.voices).includes('speech:voice:fixture'));
  assert.ok(ids(catalog.models).includes('FunAudioLLM/CosyVoice2-0.5B'));
  assert.doesNotMatch(catalog.note, /SECRET|fixture-key|127\.0\.0\.1/);
  assert.equal(catalog.source, 'mixed');
});

test('OpenAI queries model IDs but uses documented built-in voices without guessing a list route', async t => {
  const requests = [];
  const endpoint = await serverFor(t, (req, res) => { requests.push(req.url); reply(res, { object: 'list', data: [{ id: 'gpt-4o-mini-tts-2025-12-15' }, { id: 'gpt-4o' }, { id: 'whisper-1' }, { id: 'tts-1' }] }); });
  const catalog = await fetchRemoteCatalog({ provider: 'openai', endpoint }, { apiKey: 'key' });
  assert.deepEqual(requests, ['/v1/models']);
  assert.ok(ids(catalog.models).includes('gpt-4o-mini-tts-2025-12-15'));
  assert.equal(ids(catalog.models).includes('gpt-4o'), false);
  assert.equal(ids(catalog.models).includes('whisper-1'), false);
  assert.ok(ids(catalog.voices).includes('coral'));
  assert.equal(catalog.source, 'mixed');
});

test('compatible services preserve gateway prefixes and leave voice selection manual', async t => {
  const requests = [];
  const endpoint = await serverFor(t, (req, res) => { requests.push(req.url); reply(res, { data: [{ id: 'Vendor/custom-speech' }] }); });
  const catalog = await fetchRemoteCatalog({ provider: 'compatible', endpoint: endpoint.replace('/v1/audio/speech', '/proxy/v2/audio/speech') }, { apiKey: 'key' });
  assert.deepEqual(requests, ['/proxy/v2/models']);
  assert.deepEqual(ids(catalog.models), ['Vendor/custom-speech']);
  assert.deepEqual(catalog.voices, []);
  assert.equal(catalog.source, 'live');
  assert.match(catalog.note, /手动|手填/);
  const fallback = await fetchRemoteCatalog({ provider: 'compatible', endpoint: endpoint.replace('/audio/speech', '/say') }, { apiKey: 'key' });
  assert.equal(fallback.source, 'preset');
  assert.equal(requests.length, 1);
});

test('malformed identifiers are dropped and remote item counts stay bounded', async t => {
  const endpoint = await serverFor(t, (req, res) => reply(res, { data: [{ id: 123 }, { id: 'x'.repeat(513) }, { id: 'bad\u0000id' }, { id: 'valid', name: 'Valid' }, { id: 'valid', name: 'Duplicate' }, ...Array.from({ length: 2100 }, (_, i) => ({ id: `model-${i}` }))] }));
  const catalog = await fetchRemoteCatalog({ provider: 'compatible', endpoint }, { apiKey: 'key' });
  assert.equal(ids(catalog.models).includes('valid'), true);
  assert.equal(catalog.models.filter(item => item.id === 'valid').length, 1);
  assert.ok(catalog.models.every(item => typeof item.id === 'string' && item.id.length <= 512 && !/[\u0000-\u001f]/.test(item.id)));
  assert.ok(catalog.models.length <= 2000);
});

test('missing credentials do not send catalog requests', async t => {
  let requests = 0;
  const endpoint = await serverFor(t, (req, res) => { requests++; reply(res, {}); });
  const catalog = await fetchRemoteCatalog({ provider: 'openai', endpoint }, {});
  assert.equal(requests, 0);
  assert.ok(catalog.models.length > 0);
  assert.equal(catalog.source, 'preset');
  assert.match(catalog.note, /API Key/);
});

test('failed HTTP catalog requests report preset source for every remote provider', async t => {
  const endpoint = await serverFor(t, (req, res) => { res.statusCode = 401; res.end('SECRET fixture-key'); });
  const cases = [
    ['minimax', '/v1/t2a_v2'], ['elevenlabs', '/v1/text-to-speech/current'], ['azure', '/cognitiveservices/v1'],
    ['siliconflow', '/v1/audio/speech'], ['openai', '/v1/audio/speech'], ['compatible', '/v1/audio/speech'],
  ];
  for (const [provider, suffix] of cases) {
    await t.test(provider, async () => {
      const catalog = await fetchRemoteCatalog({ provider, endpoint: endpoint.replace('/v1/audio/speech', suffix) }, { apiKey: 'fixture-key' });
      assert.equal(catalog.source, 'preset');
      assert.doesNotMatch(catalog.note, /SECRET|fixture-key/);
    });
  }
});

test('ElevenLabs reports live only when the resulting options all came from the online lists', async t => {
  const endpoint = await serverFor(t, (req, res) => {
    if (req.url === '/v1/models') return reply(res, [
      { model_id: 'eleven_multilingual_v2', can_do_text_to_speech: true },
      { model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true },
      { model_id: 'eleven_turbo_v2_5', can_do_text_to_speech: true },
      { model_id: 'eleven_v3', can_do_text_to_speech: true },
    ]);
    reply(res, { voices: [{ voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'Account George', category: 'premade' }], has_more: false });
  });
  const catalog = await fetchRemoteCatalog({ provider: 'elevenlabs', endpoint: endpoint.replace('/audio/speech', '/text-to-speech/current') }, { apiKey: 'key' });
  assert.equal(catalog.source, 'live');
  assert.equal(catalog.voices[0].label, 'Account George');
  assert.doesNotMatch(catalog.note, /合并|保留预置选项/);
});

test('successful empty ElevenLabs lists remain valid while retained presets are marked mixed', async t => {
  const endpoint = await serverFor(t, (req, res) => reply(res, req.url === '/v1/models' ? [] : { voices: [], has_more: false }));
  const catalog = await fetchRemoteCatalog({ provider: 'elevenlabs', endpoint: endpoint.replace('/audio/speech', '/text-to-speech/current') }, { apiKey: 'key' });
  assert.equal(catalog.source, 'mixed');
  assert.ok(ids(catalog.models).includes('eleven_multilingual_v2'));
  assert.ok(ids(catalog.voices).includes('JBFqnCBsd6RMkjVDRZzb'));
  assert.match(catalog.note, /空|未返回/);
  assert.match(catalog.note, /预置选项/);
  assert.doesNotMatch(catalog.note, /未能刷新|失败/);
});

test('cancelled catalog discovery stops without returning stale fallback data', async t => {
  const endpoint = await serverFor(t, (req, res) => reply(res, {}));
  const controller = new AbortController(); controller.abort('SECRET cancellation reason');
  await assert.rejects(fetchRemoteCatalog({ provider: 'openai', endpoint }, { apiKey: 'key' }, controller.signal), error => error.name === 'AbortError' && !error.message.includes('SECRET'));
});
