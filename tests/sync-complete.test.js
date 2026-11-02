import test from 'node:test';
import assert from 'node:assert/strict';
import { NaturalVoiceWorld } from '../src/world.js';
import { DEFAULTS } from '../src/config.js';
import { flushPendingBubbles, setBubbleSyncGate, wrapPetWebSocket } from '../src/pet-sync.js';
import { subscribeStoreAppend } from '../src/store-subscription.js';
import { extractStreamFirstProgress, extractStreamSegments, spokenSegments } from '../src/text.js';
import { say, until, wave } from './helpers.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Match JsonlEventStore's public shape: persist before notifying, void onAppend.
function eventStore(events = []) {
  const rows = [...events];
  const listeners = [];
  return {
    latestCursor: () => rows.at(-1)?.cursor ?? 0,
    range: ({ fromCursor, toCursor }) => rows.filter(row => row.cursor >= fromCursor && row.cursor <= toCursor),
    onAppend(callback) { listeners.push(callback); },
    append(event) {
      const envelope = { ...event, cursor: (rows.at(-1)?.cursor ?? 0) + 1, run: 'sync-fixture' };
      rows.push(envelope);
      for (const callback of listeners) callback(envelope);
      return envelope;
    },
    reset() { rows.length = 0; },
    listeners,
  };
}

function fixture(t, options = {}, overrides = {}) {
  const cfg = { ...DEFAULTS, enabled: true, ...overrides };
  const secrets = new Map([['CORTICO_NATURAL_VOICE_API_KEY', 'fixture-key']]);
  const ctx = { cfg, secret: key => secrets.get(key) ?? '', storeSecret: (key, value) => secrets.set(key, value) };
  const played = [];
  const world = new NaturalVoiceWorld(ctx, {
    pollMs: 60000,
    synthesize: async (config, credentials, text) => Buffer.from(text),
    play: async bytes => { played.push(bytes.toString()); },
    ...options,
  });
  const store = eventStore([say(1, '历史回复不得朗读。')]);
  const warnings = [];
  t.after(async () => { await world.stop(); setBubbleSyncGate(null); });
  return { cfg, ctx, world, played, secrets, store, host: { store, log: { warn: message => warnings.push(message) } }, warnings };
}

function tool(tap, id, name, args = '') {
  tap.onEvent({ type: 'response.output_item.added', item: { type: 'function_call', id, call_id: `call_${id}`, name, arguments: args } });
}

function stream(tap, id, delta) {
  tap.onEvent({ type: 'response.function_call_arguments.delta', item_id: id, delta });
}

function done(tap, id, args) {
  tap.onEvent({ type: 'response.function_call_arguments.done', item_id: id, arguments: args });
}

function sayFrame(id, text) {
  return JSON.stringify({ t: 'say', id, beats: [{ text, actions: [], anchors: [] }] });
}

test('host-shaped void append subscription reacts synchronously, excludes history and deduplicates repeated poll', async t => {
  const calls = [];
  const s = fixture(t, { synthesize: async (cfg, credentials, text) => { calls.push(text); return Buffer.from(text); } });
  await s.world.start(s.host);
  const event = s.store.append(say(0, '追加即触发。'));
  assert.equal(s.world.cursor, event.cursor, 'onAppend must advance before append returns');
  s.world.poll(); s.world.poll();
  await until(() => s.played.length === 1);
  assert.deepEqual(calls, ['追加即触发。']);
  assert.deepEqual(s.played, calls);
  assert.equal(s.store.listeners.length, 1);
});

test('store cursor reset reads new run events and never replays previously consumed replies', async t => {
  const s = fixture(t);
  await s.world.start(s.host);
  s.store.append(say(0, '旧运行的新回复。'));
  await until(() => s.played.length === 1);
  s.store.reset();
  s.store.append(say(0, '重置后的新回复。'));
  await until(() => s.played.length === 2);
  assert.deepEqual(s.played, ['旧运行的新回复。', '重置后的新回复。']);
});

test('real onRoundEnd before tool execution retains completed prewarm and clears parser state', async t => {
  const calls = [];
  const s = fixture(t, { synthesize: async (cfg, credentials, text) => { calls.push(text); return Buffer.from(text); } });
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  const args = JSON.stringify({ script: '完成的预热。' });
  tool(tap, 'round_done', 'pet_say', args);
  done(tap, 'round_done', args);
  await until(() => calls.length === 1);
  tap.onRoundEnd();
  assert.equal(s.world.streamItems.size, 0);
  s.store.append(say(0, '完成的预热。'));
  await until(() => s.played.length === 1);
  assert.deepEqual(calls, ['完成的预热。']);
});

test('onAbort(reason) cancels incomplete duplex work, clears cache, releases text and produces no audio', async t => {
  const signals = [];
  const s = fixture(t, { createDuplexSession: (cfg, credentials, signal) => {
    signals.push(signal);
    const d = deferred();
    signal.addEventListener('abort', () => d.reject(signal.reason), { once: true });
    return { pushText() {}, finishText() {}, promise: d.promise };
  } });
  await s.world.start(s.host);
  const messages = [];
  const socket = wrapPetWebSocket({ send: data => messages.push(JSON.parse(data)) });
  socket.send(sayFrame('aborted', '被取消的内容'));
  const tap = s.world.outputTap();
  tool(tap, 'aborted', 'pet_say');
  stream(tap, 'aborted', '{"script":"被取消的内容');
  assert.equal(signals.length, 1);
  tap.onAbort('preempt');
  assert.equal(signals[0].aborted, true);
  assert.equal(s.world.streamItems.size, 0);
  assert.equal(s.world.prewarmCache.size, 0);
  assert.equal(messages.length, 1);
  assert.deepEqual(s.played, []);
});

test('onRoundEnd cancels an incomplete duplex call that cannot be executed', async t => {
  let signal;
  const s = fixture(t, { createDuplexSession: (cfg, credentials, inputSignal) => {
    signal = inputSignal;
    const d = deferred();
    signal.addEventListener('abort', () => d.reject(signal.reason), { once: true });
    return { pushText() {}, finishText() {}, promise: d.promise };
  } });
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  tool(tap, 'incomplete', 'pet_say');
  stream(tap, 'incomplete', '{"script":"尚未生成完的内容');
  assert.equal(signal.aborted, false);
  tap.onRoundEnd();
  assert.equal(signal.aborted, true, 'round boundary must not orphan unfinished TTS');
  assert.equal(s.world.prewarmCache.size, 0);
});

test('an incomplete later round cannot evict a completed call sharing the same text cache', async t => {
  const calls = [];
  const s = fixture(t, { synthesize: async (cfg, credentials, text, signal) => {
    calls.push({ text, signal });
    return Buffer.from(text);
  } });
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  const args = JSON.stringify({ script: '相同的开场。' });
  tool(tap, 'completed_shared', 'pet_say', args);
  done(tap, 'completed_shared', args);
  await until(() => calls.length === 1);
  tap.onRoundEnd();
  tool(tap, 'incomplete_shared', 'pet_say', args);
  tap.onRoundEnd();
  assert.equal(calls[0].signal.aborted, false);
  s.store.append(say(0, '相同的开场。'));
  await until(() => s.played.length === 1);
  assert.equal(calls.length, 1);
});

test('unknown item done cannot mark a pending pet call complete at a round boundary', async t => {
  const calls = [];
  const s = fixture(t, { synthesize: async (cfg, credentials, text, signal) => {
    calls.push({ text, signal });
    return Buffer.from(text);
  } });
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  tool(tap, 'pet_pending', 'pet_say', JSON.stringify({ script: '尚未完成的工具。' }));
  await until(() => calls.length === 1);
  done(tap, 'unrelated_item', '{}');
  tap.onRoundEnd();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(s.world.prewarmCache.size, 0);
});

for (const [name, override, removeKey] of [
  ['auto-read disabled', { autoRead: false }, false],
  ['credentials missing', {}, true],
]) {
  test(`${name}: exact say/ask frames bypass gating and streaming does not synthesize`, async t => {
    const calls = [];
    const s = fixture(t, { synthesize: async (cfg, credentials, text) => { calls.push(text); return Buffer.from(text); } }, override);
    if (removeKey) s.secrets.clear();
    await s.world.start(s.host);
    const messages = [];
    const socket = wrapPetWebSocket({ send: data => messages.push(JSON.parse(data)) });
    socket.send(sayFrame('disabled', '无需朗读。'));
    socket.send(JSON.stringify({ t: 'ask', id: 'disabled_ask', question: '无需提问？', options: ['好'], own: true }));
    tool(s.world.outputTap(), 'disabled', 'pet_say', JSON.stringify({ script: '无需朗读。' }));
    s.store.append(say(0, '无需朗读。'));
    await Promise.resolve();
    assert.equal(messages.length, 2);
    assert.deepEqual(calls, []);
  });
}

test('pet_ask exact wire and event shapes reuse streaming audio and release question/status before play', async t => {
  const calls = [], timeline = [];
  const synthesis = deferred();
  const s = fixture(t, {
    synthesize: async (cfg, credentials, text) => { calls.push(text); return synthesis.promise; },
    play: async bytes => { timeline.push(`audio:${bytes}`); },
  });
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  tool(tap, 'ask', 'pet_ask', JSON.stringify({ question: '现在喝水吗？', options: ['喝', '不喝'], own: true }));
  await until(() => calls.length === 1);
  const socket = wrapPetWebSocket({ send: data => timeline.push(`wire:${JSON.parse(data).t}`) });
  socket.send(JSON.stringify({ t: 'ask', id: 'ask_1', question: '现在喝水吗？', options: ['喝', '不喝'], own: true }));
  socket.send(JSON.stringify({ t: 'status', status: null }));
  s.store.append({ ...say(0, '现在喝水吗？'), meta: { kind: 'ask', askId: 'ask_1', question: '现在喝水吗？', options: ['喝', '不喝'], own: true } });
  assert.deepEqual(timeline, []);
  synthesis.resolve(Buffer.from('现在喝水吗？'));
  await until(() => timeline.length === 3);
  assert.deepEqual(calls, ['现在喝水吗？']);
  assert.deepEqual(timeline, ['wire:ask', 'wire:status', 'audio:现在喝水吗？']);
});

test('gate passes empty/action-only/malformed/unrelated/binary frames immediately', t => {
  t.after(() => setBubbleSyncGate(null));
  setBubbleSyncGate(() => ({ enabled: true, timeoutMs: 60000 }));
  const sent = [];
  const socket = wrapPetWebSocket({ send: data => sent.push(data) });
  const frames = [
    JSON.stringify({ t: 'say', id: 'empty', beats: [{ text: ' ', actions: [{ name: 'wave' }] }] }),
    JSON.stringify({ t: 'ask', id: 'empty_ask', question: '' }),
    JSON.stringify({ t: 'status', status: null }),
    JSON.stringify({ t: 'ask-close', id: 'old' }),
    '{"t":"say",malformed',
    Buffer.from(sayFrame('binary', '二进制不做文本解析。')),
  ];
  for (const frame of frames) socket.send(frame);
  assert.deepEqual(sent, frames);
});

test('gate timeout releases pending text and status exactly once without an audio callback', async t => {
  t.after(() => setBubbleSyncGate(null));
  setBubbleSyncGate(() => ({ enabled: true, timeoutMs: 15 }));
  const sent = [];
  const socket = wrapPetWebSocket({ send: data => sent.push(JSON.parse(data).t) });
  socket.send(sayFrame('timeout', '服务未及时响应。'));
  socket.send(JSON.stringify({ t: 'status', status: null }));
  assert.deepEqual(sent, []);
  await until(() => sent.length === 2);
  flushPendingBubbles();
  assert.deepEqual(sent, ['say', 'status']);
});

test('wrapping once preserves socket receiver, optional send arguments and cleanup idempotence', t => {
  t.after(() => setBubbleSyncGate(null));
  setBubbleSyncGate(() => ({ enabled: true, timeoutMs: 60000 }));
  const calls = [];
  const socket = { send(...args) { calls.push({ receiver: this, args }); } };
  assert.equal(wrapPetWebSocket(wrapPetWebSocket(socket)), socket);
  const frame = sayFrame('same', '只发送一次。');
  const options = { compress: false }, callback = () => {};
  socket.send(frame, options, callback);
  flushPendingBubbles(); flushPendingBubbles();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, socket);
  assert.deepEqual(calls[0].args, [frame, options, callback]);
});

test('identical wording with distinct ids releases one FIFO bubble group and its socket statuses at a time', t => {
  t.after(() => setBubbleSyncGate(null));
  setBubbleSyncGate(() => ({ enabled: true, timeoutMs: 60000 }));
  const timeline = [];
  const sockets = ['a', 'b'].map(name => wrapPetWebSocket({ send: data => {
    const frame = JSON.parse(data);
    timeline.push(`${name}:${frame.t}:${frame.id ?? frame.status?.text}`);
  } }));
  for (const id of ['first', 'second']) {
    for (const socket of sockets) {
      socket.send(sayFrame(id, '同一句话。'));
      socket.send(JSON.stringify({ t: 'status', status: { kind: 'work', text: id } }));
    }
  }
  flushPendingBubbles('同一句话');
  assert.deepEqual(timeline, ['a:say:first', 'a:status:first', 'b:say:first', 'b:status:first']);
  flushPendingBubbles('同一句话。');
  assert.deepEqual(timeline.slice(4), ['a:say:second', 'a:status:second', 'b:say:second', 'b:status:second']);
});

test('readiness for a previously timed-out group never releases a newer group with identical text', async t => {
  const first = deferred(), second = deferred();
  let synthesisCalls = 0;
  const s = fixture(t, { synthesize: async () => ++synthesisCalls === 1 ? first.promise : second.promise });
  await s.world.start(s.host);
  let timeoutMs = 15;
  setBubbleSyncGate(() => ({ enabled: true, timeoutMs }));
  const sent = [];
  const socket = wrapPetWebSocket({ send: data => sent.push(JSON.parse(data).id) });
  socket.send(sayFrame('timed_out_first', '相同的文字。'));
  s.store.append(say(0, '相同的文字。'));
  await until(() => sent.length === 1);
  timeoutMs = 60000;
  socket.send(sayFrame('new_second', '相同的文字。'));
  s.store.append(say(0, '相同的文字。'));
  first.resolve(Buffer.from('相同的文字。'));
  await until(() => s.played.length === 1);
  const afterFirstAudio = [...sent];
  second.resolve(Buffer.from('相同的文字。'));
  await until(() => s.played.length === 2);
  assert.deepEqual(afterFirstAudio, ['timed_out_first']);
  assert.deepEqual(sent, ['timed_out_first', 'new_second']);
});

test('opening matching cleans markdown and splits the first nonempty beat before releasing its group', t => {
  t.after(() => setBubbleSyncGate(null));
  setBubbleSyncGate(() => ({ enabled: true, timeoutMs: 60000 }));
  const sent = [];
  const socket = wrapPetWebSocket({ send: data => sent.push(JSON.parse(data).id) });
  socket.send(JSON.stringify({ t: 'say', id: 'beats', beats: [
    { text: '', actions: ['wave'], anchors: [] },
    { text: '**开场的话**，后面继续。', actions: [], anchors: [] },
    { text: '下一拍。', actions: [], anchors: [] },
  ] }));
  socket.send(sayFrame('other', '无关的开场。'));
  flushPendingBubbles('不匹配');
  assert.deepEqual(sent, []);
  flushPendingBubbles('开场的话，');
  assert.deepEqual(sent, ['beats']);
  flushPendingBubbles('无关的开场。');
  assert.deepEqual(sent, ['beats', 'other']);
});

test('one failed socket send never blocks later queued text during cleanup', t => {
  t.after(() => setBubbleSyncGate(null));
  setBubbleSyncGate(() => ({ enabled: true, timeoutMs: 60000 }));
  const sent = [];
  const closed = wrapPetWebSocket({ send() { throw new Error('closed fixture'); } });
  const open = wrapPetWebSocket({ send: data => sent.push(JSON.parse(data).id) });
  closed.send(sayFrame('closed', '已断开。'));
  open.send(sayFrame('open', '仍然发送。'));
  assert.doesNotThrow(() => setBubbleSyncGate(null));
  assert.deepEqual(sent, ['open']);
});

test('canceling pending synthesis releases the held bubble without late sound or duplicate sends', async t => {
  let signal;
  const s = fixture(t, { synthesize: (cfg, credentials, text, inputSignal) => {
    signal = inputSignal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await s.world.start(s.host);
  const sent = [];
  const socket = wrapPetWebSocket({ send: data => sent.push(JSON.parse(data).id) });
  socket.send(sayFrame('cancel', '用户取消朗读。'));
  s.store.append(say(0, '用户取消朗读。'));
  await until(() => signal);
  assert.deepEqual(sent, []);
  await s.world.webUi('zh').invoke('voice', 'stop', []);
  await until(() => !s.world.state().busy);
  assert.equal(signal.aborted, true);
  flushPendingBubbles();
  assert.deepEqual(sent, ['cancel']);
  assert.deepEqual(s.played, []);
  assert.equal(s.world.state().error, '');
});

for (const inputType of ['desktop-pet.message', 'desktop-pet.speech', 'desktop-pet.answer']) {
  test(`${inputType} interrupts playback and drops the already queued reply`, async t => {
    let playingSignal;
    const played = [];
    const s = fixture(t, { play: (bytes, signal) => {
      played.push(bytes.toString());
      playingSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    await s.world.start(s.host);
    s.store.append(say(0, '朗读中的第一条。'));
    s.store.append(say(0, '排队的第二条。'));
    await until(() => playingSignal);
    s.store.append({ ...say(0, '用户的新输入'), type: inputType, senderKey: inputType });
    await until(() => !s.world.state().busy);
    assert.equal(playingSignal.aborted, true);
    assert.equal(s.world.state().queued, 0);
    assert.deepEqual(played, ['朗读中的第一条。']);
    assert.equal(s.world.state().error, '');
  });
}

test('synthesis failure releases text and the next reply still synchronizes and plays', async t => {
  const failed = deferred(), sent = [];
  let calls = 0;
  const s = fixture(t, { synthesize: async (cfg, credentials, text) => {
    calls++;
    if (calls === 1) return failed.promise;
    return Buffer.from(text);
  } });
  await s.world.start(s.host);
  const socket = wrapPetWebSocket({ send: data => sent.push(JSON.parse(data).id) });
  socket.send(sayFrame('failure', '首条失败。'));
  s.store.append(say(0, '首条失败。'));
  await until(() => calls === 1);
  failed.reject(new Error('fixture HTTP 503'));
  await until(() => s.world.state().error.includes('503'));
  assert.deepEqual(sent, ['failure']);
  socket.send(sayFrame('recovery', '下一条恢复。'));
  s.store.append(say(0, '下一条恢复。'));
  await until(() => s.played.length === 1);
  assert.deepEqual(sent, ['failure', 'recovery']);
  assert.deepEqual(s.played, ['下一条恢复。']);
  assert.equal(s.world.state().error, '');
});

test('first reply readiness does not release a second reply whose synthesis is not ready', async t => {
  const first = deferred(), firstPlay = deferred(), second = deferred(), timeline = [];
  const s = fixture(t, {
    synthesize: async (cfg, credentials, text) => text === '第一条。' ? first.promise : second.promise,
    play: async bytes => { timeline.push(`audio:${bytes}`); if (bytes.toString() === '第一条。') await firstPlay.promise; },
  });
  await s.world.start(s.host);
  const socket = wrapPetWebSocket({ send: data => timeline.push(`wire:${JSON.parse(data).id}`) });
  socket.send(sayFrame('first', '第一条。'));
  s.store.append(say(0, '第一条。'));
  socket.send(sayFrame('second', '第二条。'));
  s.store.append(say(0, '第二条。'));
  first.resolve(Buffer.from('第一条。'));
  await until(() => timeline.includes('audio:第一条。'));
  const beforeSecondReady = [...timeline];
  firstPlay.resolve(); second.resolve(Buffer.from('第二条。'));
  await until(() => timeline.includes('audio:第二条。'));
  assert.deepEqual(beforeSecondReady, ['wire:first', 'audio:第一条。'], 'future reply text must wait for its own sound');
  assert.deepEqual(timeline, ['wire:first', 'audio:第一条。', 'wire:second', 'audio:第二条。']);
});

test('a later beat never releases a future reply with the same opening text', async t => {
  const firstPlay = deferred(), laterBeatPlay = deferred(), timeline = [];
  let repeatedPlays = 0;
  const s = fixture(t, { play: async bytes => {
    const text = bytes.toString();
    timeline.push(`audio:${text}`);
    if (text === '开场。') await firstPlay.promise;
    if (text === '重复。' && ++repeatedPlays === 1) await laterBeatPlay.promise;
  } });
  await s.world.start(s.host);
  const socket = wrapPetWebSocket({ send: data => timeline.push(`wire:${JSON.parse(data).id}`) });
  socket.send(JSON.stringify({ t: 'say', id: 'multiple_beats', beats: [
    { text: '开场。', actions: [], anchors: [] }, { text: '重复。', actions: [], anchors: [] },
  ] }));
  s.store.append({ ...say(0, '开场。重复。'), meta: { kind: 'say', beats: [{ text: '开场。' }, { text: '重复。' }] } });
  await until(() => timeline.includes('audio:开场。'));
  socket.send(sayFrame('future_reply', '重复。'));
  s.store.append(say(0, '重复。'));
  firstPlay.resolve();
  await until(() => repeatedPlays === 1);
  const duringLaterBeat = [...timeline];
  laterBeatPlay.resolve();
  await until(() => repeatedPlays === 2);
  assert.deepEqual(duringLaterBeat, ['wire:multiple_beats', 'audio:开场。', 'audio:重复。']);
  assert.deepEqual(timeline, [...duringLaterBeat, 'wire:future_reply', 'audio:重复。']);
});

test('interleaved pet_say and pet_ask item ids prewarm separately and survive real round boundary', async t => {
  const calls = [];
  const s = fixture(t, { synthesize: async (cfg, credentials, text) => { calls.push(text); return Buffer.from(text); } });
  await s.world.start(s.host);
  const tap = s.world.outputTap();
  tool(tap, 'interleaved_say', 'pet_say');
  tool(tap, 'interleaved_ask', 'pet_ask');
  stream(tap, 'interleaved_say', '{"script":"你好呀。"}');
  stream(tap, 'interleaved_ask', '{"question":"吃饭了吗？","options":["吃了"],"own":true}');
  done(tap, 'interleaved_say', '{"script":"你好呀。"}');
  done(tap, 'interleaved_ask', '{"question":"吃饭了吗？","options":["吃了"],"own":true}');
  tap.onRoundEnd();
  s.store.append(say(0, '你好呀。'));
  s.store.append({ ...say(0, '吃饭了吗？'), meta: { kind: 'ask', question: '吃饭了吗？', options: ['吃了'], own: true } });
  await until(() => s.played.length === 2);
  assert.deepEqual(calls, ['你好呀。', '吃饭了吗？']);
  assert.deepEqual(s.played, calls);
});

test('streaming JSON escapes and action/mood markup agree with final host beat text', () => {
  const question = '先说“你好”\n再喝水吗？';
  const questionArgs = JSON.stringify({ question, options: ['好'], own: true });
  const event = { ...say(1, question), meta: { kind: 'ask', question, options: ['好'], own: true } };
  assert.deepEqual(extractStreamSegments('pet_ask', questionArgs, true), spokenSegments(event, 1200));
  const script = '【happy】你好呀！<wave>我们一起喝水。';
  assert.deepEqual(extractStreamSegments('pet_say', JSON.stringify({ script }), true), ['你好呀！', '我们一起喝水。']);
  assert.deepEqual(extractStreamFirstProgress('pet_say', '{"script":"【happy】你好呀！<wa', false), { text: '你好呀！', closed: true });
  assert.deepEqual(extractStreamSegments('unrelated_tool', questionArgs, true), []);
});

test('early first WAV plays while remainder synthesizes and ordered remainder uses same gain', async t => {
  const timeline = [], playOptions = [];
  const first = wave(30), remainder = wave(50), firstPlay = deferred(), synthesis = deferred();
  const s = fixture(t, { play: async (bytes, signal, options) => {
    timeline.push(bytes === first ? 'first:start' : 'remainder:start');
    playOptions.push(options);
    if (bytes === first) await firstPlay.promise;
    timeline.push(bytes === first ? 'first:end' : 'remainder:end');
  } });
  const controller = new AbortController();
  const task = { controller: new AbortController(), promise: synthesis.promise, earlyChunks: [first], waitEarly: () => Promise.resolve() };
  const running = s.world.runSynthTask(task, '分片内容', s.cfg, controller);
  await until(() => timeline.includes('first:start'));
  assert.deepEqual(timeline, ['first:start']);
  synthesis.resolve(remainder);
  await Promise.resolve();
  assert.deepEqual(timeline, ['first:start']);
  firstPlay.resolve();
  await running;
  assert.deepEqual(timeline, ['first:start', 'first:end', 'remainder:start', 'remainder:end']);
  assert.equal(playOptions[0].gain, playOptions[1].gain);
  assert.equal(controller.signal.aborted, false);
});

test('store subscription callback failure is isolated and a failed registration can be retried', () => {
  let registrations = 0, listener;
  const store = { onAppend(callback) {
    if (++registrations === 1) throw new Error('fixture registration failure');
    listener = callback;
  } };
  assert.throws(() => subscribeStoreAppend(store, () => {}), /registration failure/);
  const disposeFirst = subscribeStoreAppend(store, () => { throw new Error('fixture callback failure'); });
  const received = [];
  const disposeSecond = subscribeStoreAppend(store, event => received.push(event));
  const event = say(1, '订阅者异常隔离。');
  assert.doesNotThrow(() => listener(event));
  assert.deepEqual(received, [event]);
  disposeFirst(); disposeSecond();
  assert.equal(registrations, 2);
  listener(say(2, '已停止。'));
  assert.deepEqual(received, [event]);
});
