import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, PROVIDERS, normalizeConfig, validateConfig } from '../src/config.js';
import { resolveAliyunEndpoint, toAliyunHttpUrl, toAliyunWsUrl } from '../src/providers/aliyun.js';
import { fetchAliyunCatalog } from '../src/catalogs/aliyun.js';
import client from '../web/client.js';

const workspaceId = 'ws-v1234567890abcdef';
const bareId = 'v1234567890abcdef';
const host = 'ws-v1234567890abcdef.cn-beijing.maas.aliyuncs.com';
const httpPath = '/api/v1/services/audio/tts/SpeechSynthesizer';
const wsPath = '/api-ws/v1/inference';
const multimodalPath = '/api/v1/services/aigc/multimodal-generation/generation';
const httpTemplate = 'https://{workspaceId}.cn-beijing.maas.aliyuncs.com' + httpPath;
const wsTemplate = 'wss://{workspaceId}.cn-beijing.maas.aliyuncs.com' + wsPath;
const baseConfig = { ...DEFAULTS, ...PRESETS.aliyun, workspaceId };

test('Aliyun keeps the complete Workspace ID in canonical HTTP and WebSocket templates', () => {
  for (const [endpoint, expected] of [[httpTemplate, 'https://' + host + httpPath], [wsTemplate, 'wss://' + host + wsPath]]) {
    const config = { ...baseConfig, endpoint };
    assert.equal(normalizeConfig(config).workspaceId, workspaceId);
    assert.equal(validateConfig(config), expected);
  }
});

test('Aliyun protocol and model conversion preserve concrete workspace host identity in every region', () => {
  for (const concreteHost of [host, 'ws-v1234567890abcdef.ap-southeast-1.maas.aliyuncs.com', 'workspace-fixture.cn-shanghai.maas.aliyuncs.com']) {
    const http = 'https://' + concreteHost + httpPath;
    const ws = 'wss://' + concreteHost + wsPath;
    assert.equal(toAliyunWsUrl(http), ws);
    assert.equal(toAliyunHttpUrl(ws), http);
    assert.deepEqual(resolveAliyunEndpoint({ endpoint: ws, model: 'cosyvoice-v3-plus' }), { mode: 'http', endpoint: http });
    assert.deepEqual(resolveAliyunEndpoint({ endpoint: ws, model: 'qwen3-tts-flash' }), { mode: 'multimodal', endpoint: 'https://' + concreteHost + multimodalPath });
    assert.deepEqual(resolveAliyunEndpoint({ endpoint: http, model: 'qwen-audio-3.1-tts-flash' }), { mode: 'ws', endpoint: ws });
  }
});

test('Aliyun migrates legacy ws-placeholder templates once without changing their effective workspace', () => {
  for (const legacyId of [bareId, workspaceId]) {
    const legacy = { ...baseConfig, workspaceId: legacyId, endpoint: 'wss://ws-{workspaceId}.cn-beijing.maas.aliyuncs.com' + wsPath };
    const normalized = normalizeConfig(legacy);
    assert.equal(normalized.workspaceId, workspaceId);
    assert.equal(normalized.endpoint, wsTemplate);
    assert.deepEqual(normalizeConfig(normalized), normalized);
    assert.equal(validateConfig(legacy), 'wss://' + host + wsPath);
    assert.deepEqual(resolveAliyunEndpoint({ ...normalized, model: 'cosyvoice-v3-plus', endpoint: validateConfig(normalized) }), {
      mode: 'http', endpoint: 'https://' + host + httpPath,
    });
  }
});

test('Aliyun infers complete Workspace IDs from official concrete hosts without stripping ws', () => {
  for (const previousId of ['', bareId]) {
    const normalized = normalizeConfig({ ...baseConfig, workspaceId: previousId, endpoint: 'wss://' + host + wsPath });
    assert.equal(normalized.workspaceId, workspaceId);
    assert.equal(normalized.endpoint, 'wss://' + host + wsPath);
  }
  assert.equal(normalizeConfig({ ...baseConfig, workspaceId: '', endpoint: 'https://ws-foreign.ap-southeast-1.maas.aliyuncs.com' + httpPath }).workspaceId, 'ws-foreign');
});

test('Aliyun leaves custom hostnames and route prefixes intact when switching protocols', () => {
  for (const gatewayHost of ['ws-tenant.example.test', host]) {
    const gatewayHttp = 'https://' + gatewayHost + '/gateway/tenant' + httpPath;
    const gatewayWs = 'wss://' + gatewayHost + '/gateway/tenant' + wsPath;
    assert.equal(toAliyunWsUrl(gatewayHttp), gatewayWs);
    assert.equal(toAliyunHttpUrl(gatewayWs), gatewayHttp);
  }
  const custom = { ...baseConfig, workspaceId: bareId, endpoint: 'https://ws-{workspaceId}.gateway.example.test/tenant/custom-tts' };
  const normalized = normalizeConfig(custom);
  assert.equal(normalized.endpoint, custom.endpoint);
  assert.equal(normalized.workspaceId, bareId);
  assert.equal(validateConfig(custom), 'https://ws-v1234567890abcdef.gateway.example.test/tenant/custom-tts');
  assert.equal(toAliyunWsUrl('https://gateway.example.test/tenant/custom-tts'), 'wss://gateway.example.test/tenant/custom-tts');
});

test('Aliyun catalog conversion uses the same workspace hostname and gateway prefix for HTTP and WebSocket', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    requests.push({ target, options });
    const output = options.method === 'GET'
      ? { total: 1, models: [{ model: 'cosyvoice-v3-plus' }] }
      : { voice_list: [] };
    return new Response(JSON.stringify({ output }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  for (const endpoint of ['https://' + host + '/gateway/tenant' + httpPath, 'wss://' + host + '/gateway/tenant' + wsPath]) {
    requests.length = 0;
    const catalog = await fetchAliyunCatalog({ endpoint }, { apiKey: 'endpoint-fixture-key' });
    assert.equal(catalog.source, 'mixed');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ target }) => target.origin === 'https://' + host));
    assert.deepEqual(requests.map(({ target }) => target.pathname).sort(), [
      '/gateway/tenant/api/v1/models', '/gateway/tenant/api/v1/services/audio/tts/customization',
    ]);
    assert.ok(requests.every(({ options }) => options.headers.authorization === 'Bearer endpoint-fixture-key'));
  }
});

async function mountEndpointEditor(config) {
  const nodes = [];
  class Element {
    constructor(tag, css, content) { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.type = tag === 'input' ? 'text' : ''; this.textContent = content ?? ''; this.classList = { add() {} }; nodes.push(this); }
    append(...children) { this.children.push(...children); }
    setAttribute() {} replaceWith() {}
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    querySelectorAll() { return nodes.filter(node => ['input', 'select', 'button'].includes(node.tag)); }
  }
  const state = { config, providers: PROVIDERS, presets: PRESETS, credentialStatus: {}, running: true, keySet: false, phase: 'idle' };
  const context = {
    language: 'zh', signal: new AbortController().signal, root: new Element('root'), ui: { h: (...args) => new Element(...args) }, interval() {},
    async invoke(method) {
      if (method === 'state') return state;
      if (method === 'catalog') return { models: [], voices: [], source: 'preset' };
      throw new Error('Unexpected editor fixture method: ' + method);
    },
  };
  await client.panels.voice.mount(context);
  return Object.fromEntries(nodes.filter(node => node.name).map(node => [node.name, node]));
}

test('Aliyun model selection creates a canonical WebSocket template with the complete Workspace ID', async () => {
  const editor = await mountEndpointEditor({ ...baseConfig, endpoint: httpTemplate });
  editor.model.value = 'qwen-audio-3.1-tts-flash'; editor.model.listeners.input();
  assert.equal(editor.endpoint.value, wsTemplate);
  assert.equal(editor.workspaceId.value, workspaceId);
  assert.equal(validateConfig({ ...baseConfig, endpoint: editor.endpoint.value, workspaceId: editor.workspaceId.value }), 'wss://' + host + wsPath);
});

test('Aliyun model selection repairs a legacy template draft without adding or losing ws prefixes', async () => {
  for (const oldId of [bareId, workspaceId]) {
    const editor = await mountEndpointEditor({ ...baseConfig, endpoint: 'wss://ws-{workspaceId}.cn-beijing.maas.aliyuncs.com' + wsPath, workspaceId: oldId });
    editor.model.value = 'qwen-audio-3.1-tts-flash'; editor.model.listeners.input();
    assert.equal(editor.endpoint.value, wsTemplate);
    assert.equal(editor.workspaceId.value, workspaceId);
  }
});
