import test from 'node:test';
import assert from 'node:assert/strict';
import { FullNaturalVoiceWorld as NaturalVoiceWorld } from '../full/index.js';
import { DEFAULTS } from '../src/config.js';
import { credentialName, saveCredentials } from '../src/credentials.js';
import { say, storeWith, until, wave } from './helpers.js';

function setup(options = {}) {
  const cfg = { ...DEFAULTS, enabled: true };
  const secrets = new Map([['CORTICO_NATURAL_VOICE_API_KEY', 'test-key']]);
  const ctx = { cfg, secret: name => secrets.get(name) ?? '', storeSecret: (name, key) => secrets.set(name, key) };
  const played = [];
  const world = new NaturalVoiceWorld(ctx, { pollMs: 60000, synthesize: async (cfg, key, text) => Buffer.from(text),
    play: async bytes => { played.push(bytes.toString()); }, ...options });
  const store = storeWith([say(1, '历史消息')]);
  const warnings = [];
  const host = { store, log: { warn: message => warnings.push(message) } };
  return { cfg, ctx, world, store, host, played, secrets, warnings };
}

test('catalog RPC reads only draft provider credentials and never changes saved configuration', async () => {
  let received;
  const catalog={models:[{id:'cosyvoice-v3-plus',label:'CosyVoice 3 Plus'}],voices:[],source:'mixed',note:'test'};
  const s=setup({catalog:async(cfg,credentials,signal)=>{received={cfg,credentials,signal};return catalog;}});
  saveCredentials(s.ctx,'aliyun',{apiKey:'aliyun-catalog-private'});
  const before=structuredClone(s.cfg);
  const result=await s.world.webUi('zh').invoke('voice','catalog',[{provider:'aliyun',workspaceId:'ws-test',apiKey:'must-be-ignored'}]);
  assert.deepEqual(result,catalog);
  assert.deepEqual(received.credentials,{apiKey:'aliyun-catalog-private'});
  assert.equal(received.cfg.provider,'aliyun');
  assert.equal(received.cfg.apiKey,undefined);
  assert.deepEqual(s.cfg,before);
  assert.equal(JSON.stringify(s.world.state()).includes('aliyun-catalog-private'),false);
});

test('stopping the World cancels in-flight catalog requests', async () => {
  let active;
  const s=setup({catalog:(cfg,credentials,signal)=>new Promise((resolve,reject)=>{
    active=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })});
  const result=s.world.webUi('zh').invoke('voice','catalog',[]);
  await until(()=>active);
  await s.world.stop();
  assert.equal(active.aborted,true);
  await result;
});

test('catalog failures retain presets without leaking service errors into page or speech status', async () => {
  const s=setup({catalog:async()=>{throw new Error('test-key raw-private-service-error');}});
  const result=await s.world.webUi('zh').invoke('voice','catalog',[]);
  assert.ok(result.models.length);
  assert.equal(result.source,'preset');
  assert.doesNotMatch(JSON.stringify(result),/test-key|raw-private-service-error/);
  assert.equal(s.world.state().error,'');
});

test('starts at the current cursor and speaks each new reply once in order', async t => {
  const s = setup(); t.after(() => s.world.stop());
  await s.world.start(s.host);
  s.store.add(say(2, '第一句')); s.store.add(say(3, '第二句'));
  s.world.poll(); s.world.poll();
  await until(() => s.played.length === 2);
  assert.deepEqual(s.played, ['第一句', '第二句']);
});

test('stop cancels synthesis and clears all pending replies', async t => {
  let activeSignal;
  const s = setup({ synthesize: (cfg, key, text, signal) => new Promise((resolve, reject) => {
    activeSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }); t.after(() => s.world.stop());
  await s.world.start(s.host);
  s.store.add(say(2, '第一句')); s.store.add(say(3, '第二句')); s.world.poll();
  await until(() => activeSignal);
  await s.world.webUi('zh').invoke('voice', 'stop', []);
  assert.equal(activeSignal.aborted, true);
  await until(() => !s.world.state().busy);
  assert.equal(s.world.state().queued, 0);
  assert.deepEqual(s.played, []);
});

test('new user input interrupts playback and disabling auto-read skips messages', async t => {
  let activeSignal;
  const s = setup({ play: (bytes, signal) => new Promise((resolve, reject) => {
    activeSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }); t.after(() => s.world.stop());
  await s.world.start(s.host);
  s.store.add(say(2, '正在说话')); s.world.poll(); await until(() => activeSignal);
  s.store.add({ ...say(3, '用户输入'), type: 'desktop-pet.message' }); s.world.poll();
  assert.equal(activeSignal.aborted, true);
  s.cfg.autoRead = false; s.store.add(say(4, '不应播放')); s.world.poll();
  await until(() => !s.world.state().busy);
  assert.equal(s.world.state().queued, 0);
});

test('records service failure and can speak a later reply', async t => {
  let fail = true;
  const s = setup({ synthesize: async () => { if (fail) throw new Error('HTTP 429'); return wave(); } });
  t.after(() => s.world.stop()); await s.world.start(s.host);
  s.store.add(say(2, '第一句')); s.world.poll();
  await until(() => s.world.state().error.includes('429'));
  fail = false; s.store.add(say(3, '第二句')); s.world.poll();
  await until(() => s.played.length === 1);
  assert.equal(s.world.state().error, '');
});

test('stores key through the host without exposing it in state or config', async () => {
  const s = setup();
  await s.world.webUi('zh').invoke('voice', 'saveKey', ['new-secret']);
  assert.equal(s.secrets.get(credentialName('siliconflow','apiKey')), 'new-secret');
  assert.equal(s.secrets.get('CORTICO_NATURAL_VOICE_API_KEY'), 'test-key');
  assert.equal(s.world.state().keySet, true);
  assert.equal(JSON.stringify(s.world.state()).includes('new-secret'), false);
  assert.equal(JSON.stringify(s.cfg).includes('new-secret'), false);
  await assert.rejects(s.world.webUi('zh').invoke('voice', 'saveKey', ['bad\nkey']));
});

test('synthesis receives only the selected provider credential object',async t=>{
  let received;
  const s=setup({synthesize:async(cfg,credentials,text)=>{received={cfg,credentials,text};return wave();}});
  t.after(()=>s.world.stop());
  saveCredentials(s.ctx,'minimax',{apiKey:'minimax-private'});
  s.cfg.provider='minimax';s.cfg.model='speech-2.8-hd';s.cfg.voice='female-shaonv';
  await s.world.start(s.host);s.store.add(say(2,'凭据隔离'));s.world.poll();
  await until(()=>s.played.length===1);
  assert.deepEqual(received.credentials,{apiKey:'minimax-private'});
  assert.equal(received.cfg.provider,'minimax');
  assert.equal(JSON.stringify(s.world.state()).includes('minimax-private'),false);
});

test('reports redact credentials from every platform and the legacy key',()=>{
  const s=setup();
  saveCredentials(s.ctx,'aliyun',{apiKey:'other-platform-private'});
  saveCredentials(s.ctx,'tencent',{secretId:'private-identifier',secretKey:'private-secret',sessionToken:'private-token'});
  s.world.report(new Error('test-key other-platform-private private-identifier private-secret private-token'));
  const state=JSON.stringify(s.world.state());
  for(const value of ['test-key','other-platform-private','private-identifier','private-secret','private-token'])assert.equal(state.includes(value),false);
  assert.ok(s.world.state().error.includes('[redacted]'));
});


test('outputTap prewarms first beat during LLM streaming and reuses it on append without duplicate synthesis', async t => {
  const synthCalls = [];
  const s = setup({
    synthesize: async (cfg, credentials, text) => {
      synthCalls.push(text);
      return Buffer.from(text);
    },
  });
  t.after(() => s.world.stop());
  await s.world.start(s.host);

  const tap = s.world.outputTap();
  assert.equal(tap.externalizes(['pet_say']), false);
  tap.onTurnStart();
  tap.onStreamEvent({
    type: 'response.output_item.added',
    item: { id: 'fc_1', type: 'function_call', name: 'pet_say' },
  });
  tap.onStreamEvent({
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    delta: '{"beats":[{"text":"流式预热第一句"',
  });
  await until(() => synthCalls.length === 1);
  assert.deepEqual(synthCalls, ['流式预热第一句']);

  s.store.add(say(2, '流式预热第一句'));
  s.world.poll();
  await until(() => s.played.length === 1);
  assert.deepEqual(s.played, ['流式预热第一句']);
  assert.equal(synthCalls.length, 1);
});

test('multi-beat replies segment and prefetch next beat while current beat is playing', async t => {
  const timeline = [];
  let releaseFirstPlay;
  const firstPlayGate = new Promise(resolve => { releaseFirstPlay = resolve; });
  const s = setup({
    synthesize: async (cfg, credentials, text) => {
      timeline.push(`synth:${text}`);
      return Buffer.from(text);
    },
    play: async bytes => {
      const text = bytes.toString();
      timeline.push(`play-start:${text}`);
      if (text === '第一拍') await firstPlayGate;
      s.played.push(text);
      timeline.push(`play-end:${text}`);
    },
  });
  t.after(() => s.world.stop());
  await s.world.start(s.host);

  s.store.add({
    cursor: 2,
    source: 'desktop-pet',
    type: 'desktop-pet.self',
    payload: '第一拍第二拍',
    meta: {
      kind: 'say',
      beats: [
        { text: '第一拍', emotion: 'happy' },
        { text: '第二拍', emotion: 'calm' },
      ],
    },
  });
  s.world.poll();

  await until(() => timeline.includes('synth:第二拍'));
  assert.deepEqual(timeline, ['synth:第一拍', 'play-start:第一拍', 'synth:第二拍']);
  releaseFirstPlay();
  await until(() => s.played.length === 2);
  assert.deepEqual(s.played, ['第一拍', '第二拍']);
});


test('outputTap.onEvent parses streaming pet_say script and prewarms first sentence before script finishes', async t => {
  const synthCalls = [];
  const s = setup({
    synthesize: async (cfg, credentials, text) => {
      synthCalls.push(text);
      return Buffer.from(text);
    },
  });
  t.after(() => s.world.stop());
  await s.world.start(s.host);

  const tap = s.world.outputTap();
  assert.equal(typeof tap.onEvent, 'function');
  assert.equal(tap.externalizes({ type: 'response.output_item.added' }), false);

  tap.onEvent({
    type: 'response.output_item.added',
    item: { id: 'fc_script', type: 'function_call', name: 'pet_say', arguments: '' },
  });
  // Stream just the first sentence and the start of the second sentence (script string NOT closed yet!)
  tap.onEvent({
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_script',
    delta: '{"script":"【happy】你好呀！<wave>今天',
  });
  await until(() => synthCalls.length === 1);
  assert.deepEqual(synthCalls, ['你好呀！']);

  // Stream the rest of the script and finish the item
  tap.onEvent({
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_script',
    delta: '天气真不错。"}',
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(synthCalls, ['你好呀！'], 'only the first phrase prewarms before a real reply');

  // Now DesktopPetWorld appends the parsed beat to host.store
  s.store.add(say(2, '你好呀！今天天气真不错。'));
  s.world.poll();
  await until(() => s.played.length === 2);
  assert.deepEqual(s.played, ['你好呀！', '今天天气真不错。']);
  // Both segments were served from prewarmCache with 0 extra synthesis calls!
  assert.equal(synthCalls.length, 2);
});

test('bubble sync gate holds pet_say WebSocket message until first audio playback starts', async t => {
  const { wrapPetWebSocket } = await import('../full/pet-sync.js');
  const events = [];
  let releaseSynth;
  const synthGate = new Promise(resolve => { releaseSynth = resolve; });

  const s = setup({
    synthesize: async (cfg, credentials, text) => {
      events.push(`synth-start:${text}`);
      await synthGate;
      events.push(`synth-ready:${text}`);
      return Buffer.from(text);
    },
    play: async bytes => {
      const text = bytes.toString();
      events.push(`play-start:${text}`);
      s.played.push(text);
    },
  });
  t.after(() => s.world.stop());
  await s.world.start(s.host);

  const mockPetWs = wrapPetWebSocket({
    send(data) {
      const msg = JSON.parse(data);
      events.push(`bubble-shown:${msg.t}`);
    },
  });

  // Simulate DesktopPetWorld.say() sending the bubble and appending the store event at t=0
  mockPetWs.send(JSON.stringify({ t: 'say', id: 's1', beats: [{ text: '同步测试' }] }));
  mockPetWs.send(JSON.stringify({ t: 'status', phase: 'idle' }));
  s.store.add(say(2, '同步测试'));
  s.world.poll();

  await until(() => events.includes('synth-start:同步测试'));
  // Bubble must NOT have been shown yet while synthesis is still in flight!
  assert.equal(events.includes('bubble-shown:say'), false);

  // Now complete synthesis: bubble and audio playback must start together!
  releaseSynth();
  await until(() => s.played.length === 1);
  assert.deepEqual(events, [
    'synth-start:同步测试',
    'synth-ready:同步测试',
    'bubble-shown:say',
    'bubble-shown:status',
    'play-start:同步测试',
  ]);
});

test('duplex streaming cleans up intermediate prefix keys so later segments in the same reply prewarm normally', async t => {
  const duplexDeltas = [];
  const synthCalls = [];
  const s = setup({
    createDuplexSession: () => ({
      pushText: delta => duplexDeltas.push(delta),
      finishText: () => {},
      promise: Promise.resolve(Buffer.from('duplex:你好呀主人今天天气真不错我们出去走走吧，')),
    }),
    synthesize: async (cfg, credentials, text) => {
      synthCalls.push(text);
      return Buffer.from(`http:${text}`);
    },
  });
  t.after(() => s.world.stop());
  await s.world.start(s.host);

  const tap = s.world.outputTap();
  tap.onEvent({
    type: 'response.output_item.added',
    item: { id: 'fc_dup', type: 'function_call', name: 'pet_say', arguments: '' },
  });
  const payload = '{"script":"【happy】你好呀主人今天天气真不错我们出去走走吧，然后去吃好吃的。接下来我们看场电影。最后一起回家休息。"}';
  for (const ch of payload) {
    tap.onEvent({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_dup',
      delta: ch,
    });
  }
  tap.onEvent({
    type: 'response.function_call_arguments.done',
    item_id: 'fc_dup',
    arguments: payload,
  });

  // Only 3 distinct entries (seg0 duplex + seg1 + seg2) and at most 6 keys (2 per segment), never 19+ prefix keys
  const distinctEntries = new Set(s.world.prewarmCache.values());
  assert.equal(distinctEntries.size, 1);
  assert.ok(s.world.prewarmCache.size <= 2);
  assert.equal(duplexDeltas.join(''), '你好呀主人今天天气真不错我们出去走走吧，');
  assert.deepEqual(synthCalls, [], 'later phrases wait for playback before prefetch');

  // Append event: matched entries are consumed and any unmatched stale partial entry is immediately cleared
  s.store.add(say(2, '你好呀主人今天天气真不错我们出去走走吧，然后去吃好吃的。接下来我们看场电影。最后一起回家休息。'));
  s.world.poll();
  assert.equal(s.world.prewarmCache.size, 0);
  await until(() => s.played.length === 3);
  assert.deepEqual(s.played, [
    'duplex:你好呀主人今天天气真不错我们出去走走吧，',
    'http:然后去吃好吃的。 接下来我们看场电影。',
    'http:最后一起回家休息。',
  ]);
});

test('duplex session failure automatically falls back to standard synthesize and locks consistent gain across early chunks', async t => {
  const http = await import('node:http');
  let failDuplex = true;
  const playOptions = [];
  const firstChunkWav = wave(40);
  const remainderChunkWav = wave(40);
  for (let i = 44; i < firstChunkWav.length; i += 2) firstChunkWav.writeInt16LE(1200, i);
  for (let i = 44; i < remainderChunkWav.length; i += 2) remainderChunkWav.writeInt16LE(2800, i);

  const s = setup({
    createDuplexSession: (cfg, credentials, signal, options) => {
      if (failDuplex) {
        return {
          pushText: () => {},
          finishText: () => {},
          promise: Promise.reject(new Error('WebSocket duplex handshake rejected')),
        };
      }
      return {
        pushText: () => {},
        finishText: () => {
          options?.onFirstChunk?.(firstChunkWav);
        },
        promise: Promise.resolve(remainderChunkWav),
      };
    },
    synthesize: async (cfg, credentials, text) => Buffer.from(`fallback:${text}`),
    play: async (bytes, signal, opts) => {
      playOptions.push(opts);
      s.played.push(bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF' ? 'wav' : bytes.toString());
    },
  });
  await s.world.start(s.host);

  // 1. Duplex fails -> falls back to standard synthesize without reporting an error
  const tap = s.world.outputTap();
  tap.onEvent({
    type: 'response.output_item.added',
    item: { id: 'fc_fb', type: 'function_call', name: 'pet_say', arguments: '{"script":"回退测试。"}' },
  });
  tap.onEvent({
    type: 'response.function_call_arguments.done',
    item_id: 'fc_fb',
    arguments: '{"script":"回退测试。"}',
  });
  s.store.add(say(2, '回退测试。'));
  s.world.poll();
  await until(() => s.played.length === 1);
  assert.deepEqual(s.played, ['fallback:回退测试。']);
  assert.equal(s.world.state().error, '');

  // 2. Duplex succeeds with early chunk + remainder -> both chunks receive the exact same locked loudness gain
  failDuplex = false;
  playOptions.length = 0;
  tap.onEvent({
    type: 'response.output_item.added',
    item: { id: 'fc_gain', type: 'function_call', name: 'pet_say', arguments: '{"script":"增益一致性测试。"}' },
  });
  tap.onEvent({
    type: 'response.function_call_arguments.done',
    item_id: 'fc_gain',
    arguments: '{"script":"增益一致性测试。"}',
  });
  s.store.add(say(3, '增益一致性测试。'));
  s.world.poll();
  await until(() => s.played.length === 3);
  assert.equal(playOptions.length, 2);
  assert.ok(Number.isFinite(playOptions[0].gain) && playOptions[0].gain > 1);
  assert.equal(playOptions[0].gain, playOptions[1].gain);

  // 3. Stopping the world unhooks http.Server.prototype.emit cleanly
  assert.equal(Boolean(http.Server.prototype[Symbol.for('cortico.naturalVoice.petSyncHooked')]), true);
  await s.world.stop();
  assert.equal(Boolean(http.Server.prototype[Symbol.for('cortico.naturalVoice.petSyncHooked')]), false);
});

test('first-chunk playback failure cancels pending synthesis without an unhandled rejection', async () => {
  const playbackError = new Error('first chunk failed');
  const s = setup({ play: async () => { throw playbackError; } });
  const controller = new AbortController();
  const synthesisController = new AbortController();
  let finishSynthesis;
  const promise = new Promise((resolve, reject) => {
    finishSynthesis = resolve;
    synthesisController.signal.addEventListener('abort', () => reject(synthesisController.signal.reason), { once: true });
  });
  const task = { controller: synthesisController, promise, earlyChunks: [wave()], waitEarly: async () => {} };
  const result = s.world.runSynthTask(task, '测试。', s.cfg, controller).catch(error => error);
  const outcome = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('still pending'), 40))]);
  finishSynthesis(null);
  await result;
  assert.equal(outcome, playbackError);
  assert.equal(synthesisController.signal.aborted, true);
  assert.equal(controller.signal.aborted, false);
});

test('remainder failure cancels and joins active first-chunk playback before rejecting', async () => {
  let playbackStarted = false;
  let playbackSettled = false;
  const s = setup({ play: (bytes, signal) => new Promise((resolve, reject) => {
    playbackStarted = true;
    signal.addEventListener('abort', () => {
      playbackSettled = true;
      reject(signal.reason);
    }, { once: true });
  }) });
  const controller = new AbortController();
  const synthesisController = new AbortController();
  let failSynthesis;
  const promise = new Promise((resolve, reject) => { failSynthesis = reject; });
  const task = { controller: synthesisController, promise, earlyChunks: [wave()], waitEarly: async () => {} };
  const result = s.world.runSynthTask(task, '测试。', s.cfg, controller).catch(error => error);
  await until(() => playbackStarted);
  const synthesisError = new Error('remainder failed');
  failSynthesis(synthesisError);
  const error = await result;
  const settledBeforeResult = playbackSettled;
  controller.abort();
  assert.equal(error, synthesisError);
  assert.equal(settledBeforeResult, true);
  assert.equal(synthesisController.signal.aborted, true);
});

test('cancellation joins active first-chunk playback and preserves the cancellation reason', async () => {
  let playbackStarted = false;
  let playbackSettled = false;
  const s = setup({ play: (bytes, signal) => new Promise((resolve, reject) => {
    playbackStarted = true;
    signal.addEventListener('abort', () => {
      playbackSettled = true;
      reject(signal.reason);
    }, { once: true });
  }) });
  const controller = new AbortController();
  const synthesisController = new AbortController();
  const promise = new Promise((resolve, reject) => {
    synthesisController.signal.addEventListener('abort', () => reject(synthesisController.signal.reason), { once: true });
  });
  const task = { controller: synthesisController, promise, earlyChunks: [wave()], waitEarly: async () => {} };
  const result = s.world.runSynthTask(task, '测试。', s.cfg, controller).catch(error => error);
  await until(() => playbackStarted);
  const reason = new DOMException('fixture cancellation', 'AbortError');
  controller.abort(reason);
  assert.equal(await result, reason);
  assert.equal(playbackSettled, true);
});

test('multiple tool replies pre-synthesize only one first reply and retain ordered playback', async t => {
  const calls = [];
  const s = setup({ synthesize: async (cfg, credentials, text, signal) => {
    calls.push({ text, signal });
    return Buffer.from(text);
  } });
  t.after(() => s.world.stop());
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  for (const [id, text] of [['fc_one', '第一条。'], ['fc_two', '第二条。']]) {
    tap.onEvent({ type: 'response.output_item.added', item: {
      id, type: 'function_call', name: 'pet_say', arguments: JSON.stringify({ script: text }),
    } });
  }
  await until(() => calls.length === 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'later tool calls wait for real reply consumption');
  s.store.add(say(2, '第一条。'));
  s.world.poll();
  s.store.add(say(3, '第二条。'));
  s.world.poll();
  await until(() => s.played.length === 2);
  assert.deepEqual(s.played, ['第一条。', '第二条。']);
  assert.equal(calls.length, 2);
});

test('streaming cleanup that changes an already-fed prefix discards duplex audio and reads the final cleaned text', async t => {
  const sessions = [];
  const s = setup({ createDuplexSession: (cfg, credentials, signal) => {
    let text = '';
    let finish;
    const promise = new Promise((resolve, reject) => {
      finish = () => resolve(Buffer.from(text));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    sessions.push({ signal });
    return { pushText: delta => { text += delta; }, finishText: finish, promise };
  } });
  t.after(() => s.world.stop());
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  tap.onEvent({ type: 'response.output_item.added', item: { id: 'fc_link', type: 'function_call', name: 'pet_say' } });
  const text = '请看[说明](manual)。';
  const payload = JSON.stringify({ script: text });
  for (const ch of payload) tap.onEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_link', delta: ch });
  tap.onEvent({ type: 'response.function_call_arguments.done', item_id: 'fc_link', arguments: payload });
  s.store.add(say(2, text));
  s.world.poll();
  await until(() => s.played.length === 1);
  assert.deepEqual(s.played, ['请看说明。']);
  assert.equal(sessions[0].signal.aborted, true);
});

test('void-return store subscriptions stay bounded across restarts and never poll a stopped World', async t => {
  const s = setup();
  t.after(() => s.world.stop());
  const listeners = [];
  s.store.onAppend = callback => { listeners.push(callback); };
  let polls = 0;
  const originalPoll = s.world.poll.bind(s.world);
  s.world.poll = () => { polls++; originalPoll(); };
  for (let i = 0; i < 3; i++) {
    await s.world.start(s.host);
    for (const callback of listeners) callback();
    await s.world.stop();
  }
  const activePolls = polls;
  for (const callback of listeners) callback();
  assert.equal(listeners.length, 1);
  assert.equal(activePolls, 3);
  assert.equal(polls, activePolls);
});

test('simultaneous Worlds share one void-return store listener and stop independently', async t => {
  const first = setup();
  const second = setup();
  t.after(async () => { await first.world.stop(); await second.world.stop(); });
  const listeners = [];
  first.store.onAppend = callback => { listeners.push(callback); };
  const polls = [0, 0];
  for (const [index, world] of [first.world, second.world].entries()) {
    const originalPoll = world.poll.bind(world);
    world.poll = () => { polls[index]++; originalPoll(); };
    await world.start(first.host);
  }
  for (const callback of listeners) callback();
  assert.equal(listeners.length, 1);
  assert.deepEqual(polls, [1, 1]);
  await first.world.stop();
  for (const callback of listeners) callback();
  assert.deepEqual(polls, [1, 2]);
  await second.world.stop();
  for (const callback of listeners) callback();
  assert.deepEqual(polls, [1, 2]);
});

for (const disposerKind of ['function', 'object']) {
  test(`${disposerKind} store disposer runs only when the last World subscriber stops`, async t => {
    const first = setup();
    const second = setup();
    t.after(async () => { await first.world.stop(); await second.world.stop(); });
    const listeners = new Set();
    let registrations = 0;
    let disposals = 0;
    first.store.onAppend = callback => {
      registrations++;
      listeners.add(callback);
      const dispose = () => { disposals++; listeners.delete(callback); };
      return disposerKind === 'function' ? dispose : { dispose };
    };
    await first.world.start(first.host);
    await second.world.start(first.host);
    assert.equal(registrations, 1);
    assert.equal(listeners.size, 1);
    await first.world.stop();
    assert.equal(disposals, 0);
    assert.equal(listeners.size, 1);
    await second.world.stop();
    assert.equal(disposals, 1);
    assert.equal(listeners.size, 0);
    await first.world.start(first.host);
    assert.equal(registrations, 2);
    assert.equal(listeners.size, 1);
    await first.world.stop();
    assert.equal(disposals, 2);
    assert.equal(listeners.size, 0);
  });
}
