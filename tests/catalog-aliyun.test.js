import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyOf, serverFor } from './helpers.js';

const load = () => import('../src/catalogs/aliyun.js');
const key = { apiKey: 'catalog-fixture-only' };
const modelPage = models => ({ success: true, output: { total: models.length, models } });
const aliyunServerFor = async (t, handler) => new URL('/api/v1/services/audio/tts/SpeechSynthesizer', await serverFor(t, handler)).href;

test('Aliyun includes the complete official HTTP CosyVoice and Qwen-Audio 3.1 system voice table with exact model membership', async () => {
  let module;
  await assert.doesNotReject(async () => { module = await load(); });
  const catalog = module.builtinAliyunCatalog();
  assert.equal(catalog.source, 'preset');
  assert.equal(catalog.models.length, 7);
  for (const [model, count] of [['cosyvoice-v3-flash', 88], ['cosyvoice-v3-plus', 2], ['cosyvoice-v2', 106], ['qwen-audio-3.1-tts-plus', 4], ['qwen-audio-3.1-tts-flash', 139]]) {
    assert.equal(catalog.voices.filter(voice => voice.models?.includes(model)).length, count, model);
  }
  assert.equal(catalog.voices.filter(voice => voice.models?.some(model => model.startsWith('cosyvoice-v3.5'))).length, 0);
  assert.deepEqual(catalog.voices.find(voice => voice.id === 'longanhuan').models, ['cosyvoice-v3-flash', 'cosyvoice-v3-plus']);
  assert.deepEqual(catalog.voices.find(voice => voice.id === 'longanhuan_v3.1').models, ['qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash']);
  assert.match(catalog.voices.find(voice => voice.id === 'longanyang').label, /龙安洋/);
  assert.equal(new Set(catalog.voices.map(voice => voice.id)).size, catalog.voices.length);
  catalog.voices[0].models.push('mutated');
  assert.ok(!module.builtinAliyunCatalog().voices[0].models.includes('mutated'));
});

test('Aliyun keeps Qwen Plus flagship voices separate from Flash-only voices and invented CosyVoice aliases', async () => {
  const { builtinAliyunCatalog } = await load();
  const catalog = builtinAliyunCatalog();
  const ids = model => catalog.voices.filter(voice => voice.models?.includes(model)).map(voice => voice.id);
  const plus = ids('qwen-audio-3.1-tts-plus');
  const flash = ids('qwen-audio-3.1-tts-flash');
  assert.deepEqual([...plus].sort(), ['longanlingxin_v3.1', 'xunanchuan_v3.1', 'longanhuan_v3.1', 'longanfengyue_v3.1'].sort());
  for (const id of plus) assert.ok(flash.includes(id), id);
  for (const id of ['longanyang_v3.1', 'yuxiaoyun_v3.1', 'Emily_v3.1', 'qwen-audio-3.1-tts-flash-zoria_uk']) {
    assert.ok(flash.includes(id), id);
    assert.ok(!plus.includes(id), id);
  }
  assert.ok(!flash.includes('longxiaochun_v3.1'));
  assert.ok(!flash.includes('emily_v3.1'), 'official voice IDs are case-sensitive');
});

test('Aliyun refreshes same-origin models and account voices, gets target models, and excludes unavailable or incompatible voices', async t => {
  const requests = [];
  const endpoint = await aliyunServerFor(t, async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const body = req.method === 'POST' ? await bodyOf(req) : null;
    requests.push({ url, body, headers: req.headers, method: req.method });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(modelPage([
      { model: 'cosyvoice-v3-flash', name: 'CosyVoice 3 Flash' },
      { model: 'qwen3-tts-flash', name: 'Qwen' },
      { model: 'cosyvoice-v1', name: 'WebSocket only' },
    ])));
    if (body.input.action === 'list_voice') return res.end(JSON.stringify({ output: { voice_list: [
      { voice_id: 'voice-ready', status: 'OK' },
      { voice_id: 'voice-qwen', status: 'OK' },
      { voice_id: 'voice-pending', status: 'DEPLOYING' },
      { voice_id: 'voice-unverified', status: 'OK' },
    ] } }));
    if (body.input.voice_id === 'voice-unverified') return res.end(JSON.stringify({ code: 'Denied', message: 'catalog-fixture-only-private-response' }));
    res.end(JSON.stringify({ output: { status: 'OK', target_model: body.input.voice_id === 'voice-qwen' ? 'qwen3-tts-flash' : 'cosyvoice-v3-flash' } }));
  });
  const { fetchAliyunCatalog } = await load();
  const result = await fetchAliyunCatalog({ endpoint }, key);
  assert.equal(result.source, 'mixed');
  assert.deepEqual(result.models.map(model => model.id), ['cosyvoice-v3-flash']);
  assert.deepEqual(result.voices.find(voice => voice.id === 'voice-ready')?.models, ['cosyvoice-v3-flash']);
  assert.equal(result.voices.find(voice => voice.id === 'voice-ready')?.kind, 'custom');
  assert.equal(result.voices.some(voice => voice.id === 'voice-qwen'), false);
  assert.equal(result.voices.some(voice => voice.id === 'voice-pending'), false);
  const unverified = result.voices.find(voice => voice.id === 'voice-unverified');
  assert.ok(unverified);
  assert.equal(unverified.models, undefined);
  assert.match(unverified.label, /待确认/);
  assert.match(result.note, /待确认|手动/);
  assert.doesNotMatch(JSON.stringify(result), /private-response/);
  assert.ok(requests.every(request => request.url.origin === new URL(endpoint).origin));
  assert.ok(requests.every(request => request.headers.authorization === 'Bearer catalog-fixture-only'));
  assert.equal(requests[0].url.pathname, '/api/v1/models');
  assert.equal(requests[0].url.searchParams.get('capabilities'), 'TTS');
  assert.equal(requests[1].url.pathname, '/api/v1/services/audio/tts/customization');
  assert.equal(requests[1].body.model, 'voice-enrollment');
});

test('Aliyun falls back each list independently and hides raw service errors', async t => {
  const { fetchAliyunCatalog } = await load();
  for (const fail of ['models', 'voices', 'both']) {
    await t.test(fail, async t => {
      const endpoint = await aliyunServerFor(t, async (req, res) => {
        const models = req.method === 'GET';
        if (fail === 'both' || (models ? fail === 'models' : fail === 'voices')) {
          return res.end(JSON.stringify({ code: 'InvalidApiKey', message: 'raw-private-cloud-error' }));
        }
        res.end(JSON.stringify(models ? modelPage([{ model: 'cosyvoice-v2' }]) : { output: { voice_list: [] } }));
      });
      const result = await fetchAliyunCatalog({ endpoint }, key);
      assert.ok(result.models.length > 0);
      assert.ok(result.voices.some(voice => voice.id === 'longanyang'));
      assert.equal(result.source, fail === 'both' ? 'preset' : 'mixed');
      assert.doesNotMatch(result.note, /raw-private-cloud-error/);
      assert.match(result.note, /预置|内置|系统/);
    });
  }
});

test('Aliyun model and voice pagination obey 20-page and 2000-entry bounds with no unbounded detail fan-out', async t => {
  const { fetchAliyunCatalog } = await load();
  const pages = { models: [], voices: [] };
  let details = 0;
  let active = 0;
  let peak = 0;
  const endpoint = await aliyunServerFor(t, async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page_no'));
      pages.models.push(page);
      return res.end(JSON.stringify({ output: { total: 999999, models: Array.from({ length: 100 }, (_, i) => ({ model: i === 0 ? 'cosyvoice-v2' : `unrelated-${page}-${i}` })) } }));
    }
    const body = await bodyOf(req);
    if (body.input.action === 'list_voice') {
      const page = body.input.page_index;
      pages.voices.push(page);
      return res.end(JSON.stringify({ output: { voice_list: Array.from({ length: 100 }, (_, i) => ({ voice_id: `custom-${page}-${i}`, status: 'OK' })) } }));
    }
    details++;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    res.end(JSON.stringify({ output: { target_model: 'cosyvoice-v2', status: 'OK' } }));
  });
  const result = await fetchAliyunCatalog({ endpoint }, key);
  assert.equal(pages.models.length, 20);
  assert.equal(pages.voices.length, 20);
  assert.deepEqual(pages.voices, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(result.voices.filter(voice => voice.kind === 'custom').length, 2000);
  assert.ok(details > 0 && details <= 100);
  assert.ok(peak <= 4);
  assert.match(result.note, /上限|部分|待确认/);
});

test('Aliyun cancellation propagates while absent keys only return local presets', async t => {
  const { fetchAliyunCatalog } = await load();
  let requests = 0;
  const endpoint = await aliyunServerFor(t, (req, res) => { requests++; res.end('{}'); });
  assert.equal((await fetchAliyunCatalog({ endpoint }, {})).source, 'preset');
  assert.equal(requests, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchAliyunCatalog({ endpoint }, key, controller.signal), error => error.name === 'AbortError');
});

test('Aliyun preserves gateway prefixes for models, account listing and voice details', async t => {
  const { fetchAliyunCatalog } = await load();
  const requests = [];
  const base = await serverFor(t, async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const body = req.method === 'POST' ? await bodyOf(req) : null;
    requests.push({ url, body, authorization: req.headers.authorization });
    if (req.method === 'GET') return res.end(JSON.stringify(modelPage([{ model: 'cosyvoice-v2' }])));
    const output = body.input.action === 'list_voice'
      ? { voice_list: [{ voice_id: 'gateway-voice', status: 'OK' }] }
      : { target_model: 'cosyvoice-v2', status: 'OK' };
    res.end(JSON.stringify({ output }));
  });
  for (const trailing of ['', '/']) {
    requests.length = 0;
    const endpoint = new URL(`/gateway/tenant/api/v1/services/audio/tts/SpeechSynthesizer${trailing}`, base).href;
    const result = await fetchAliyunCatalog({ endpoint }, key);
    assert.equal(result.source, 'mixed');
    assert.deepEqual(result.voices.find(voice => voice.id === 'gateway-voice')?.models, ['cosyvoice-v2']);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.url.origin === new URL(endpoint).origin));
    assert.ok(requests.every(request => request.url.pathname.startsWith('/gateway/tenant/api/v1/')));
    assert.equal(requests.find(request => !request.body).url.pathname, '/gateway/tenant/api/v1/models');
    assert.ok(requests.filter(request => request.body).every(request => request.url.pathname === '/gateway/tenant/api/v1/services/audio/tts/customization'));
    assert.ok(requests.every(request => request.authorization === 'Bearer catalog-fixture-only'));
  }
});

test('Aliyun unknown synthesis suffixes and query-bearing endpoints return presets without guessing catalog routes', async t => {
  const { fetchAliyunCatalog } = await load();
  let requests = 0;
  const base = await serverFor(t, (req, res) => {
    requests++;
    res.end(JSON.stringify(req.method === 'GET' ? modelPage([{ model: 'cosyvoice-v2' }]) : { output: { voice_list: [] } }));
  });
  for (const path of ['/gateway/tenant/custom-synthesis', '/api/v1/services/audio/tts/SpeechSynthesizer?key=fixture-only']) {
    const result = await fetchAliyunCatalog({ endpoint: new URL(path, base).href }, key);
    assert.equal(result.source, 'preset');
    assert.ok(result.voices.length > 0);
    assert.match(result.note, /地址|预置/);
  }
  assert.equal(requests, 0);
});

test('regional catalogs mark official presets explicitly and retain provider-specific model bindings', async () => {
  const { builtinRegionalCatalog } = await import('../src/catalogs/regional.js');
  const volc = builtinRegionalCatalog('volcengine');
  const tencent = builtinRegionalCatalog('tencent');
  assert.equal(volc.source, 'preset');
  assert.ok(volc.voices.some(voice => voice.id === 'zh_female_vv_uranus_bigtts' && voice.models.includes('seed-tts-2.0')));
  assert.equal(tencent.source, 'preset');
  assert.ok(tencent.voices.some(voice => voice.id === '101001' && voice.label.includes('智瑜')));
  assert.ok(tencent.voices.every(voice => voice.models.includes('1')));
  assert.match(volc.note, /预置|静态/);
});
