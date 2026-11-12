import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { FullNaturalVoiceWorld as NaturalVoiceWorld } from "../full/index.js";
import { DEFAULTS, PRESETS } from "../src/config.js";
import { TONE_TOOL, DeliveryPlans } from "../src/delivery.js";
import {
  wrapPetWebSocket,
  setBubbleSyncGate,
  getBubbleSyncDiagnostics,
} from "../full/pet-sync.js";
import { say, storeWith, wave, until } from "./helpers.js";

function fixture(t, config = {}) {
  const cfg = {
    ...DEFAULTS,
    ...PRESETS.aliyun,
    model: "qwen-audio-3.1-tts-flash",
    voice: "anyuqing_v3.1",
    workspaceId: "review-fixture",
    enabled: true,
    ...config,
  };
  const store = storeWith(),
    requests = [],
    played = [],
    mapping = new WeakMap();
  const world = new NaturalVoiceWorld(
    { cfg, secret: () => "fixture-key", storeSecret() {} },
    {
      pollMs: 60000,
      synthesize: async (c, key, text) => {
        const record = {
          text,
          voice: c.voice,
          model: c.model,
          instruction: c.speechInstruction,
        };
        requests.push(record);
        const wav = wave(30);
        mapping.set(wav, record);
        return wav;
      },
      play: async (wav) => {
        played.push(mapping.get(wav));
      },
    },
  );
  t.after(() => world.stop());
  return {
    world,
    cfg,
    store,
    requests,
    played,
    start: () => world.start({ store, log: { warn() {} } }),
  };
}
test("ordinal tone binding preserves bodies longer than the legacy annotation limit", () => {
  const plans = new DeliveryPlans();
  const plan = plans.register({ tones: ["轻声安慰"] }, "long-ordinal", true);
  const text = "慢慢来。".repeat(350);
  plans.bind(plan, [{ text, closed: true }]);
  assert.equal(plans.claim(text), "轻声安慰");
});
test("default expression mode adds no model tool or prompt and maps the existing beat mood", async (t) => {
  const s = fixture(t);
  assert.equal(s.cfg.toneMode, "mood");
  assert.deepEqual(s.world.tools(), []);
  assert.equal(s.world.envPromptVars(), null);
  await s.start();
  s.store.add({
    ...say(1, "真替你高兴！"),
    meta: {
      kind: "say",
      beats: [{ text: "真替你高兴！", mood: { id: "happy", zh: "开心" } }],
    },
  });
  s.world.poll();
  await until(() => s.played.length === 1);
  assert.match(s.played[0].instruction, /开心/);
  assert.equal(s.played[0].text, "真替你高兴！");
});
test("optional ordinal annotation carries no body and binds tones to the following speech beats", async (t) => {
  const s = fixture(t, { toneMode: "ordinal" });
  await s.start();
  assert.ok(TONE_TOOL.parameters.properties.tones);
  assert.equal(TONE_TOOL.parameters.properties.lines, undefined);
  const tool = s.world.tools()[0];
  await tool.handler(
    { tones: ["轻声安慰", "开心惊喜"] },
    { callId: "ordinal-review" },
  );
  const tap = s.world.outputTap(),
    args = JSON.stringify({
      script: "别着急，慢慢说。【happy】太好了，真替你高兴！",
    });
  tap.onEvent({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      name: "pet_say",
      id: "speech-review",
      arguments: args,
    },
  });
  tap.onEvent({
    type: "response.function_call_arguments.done",
    item_id: "speech-review",
    arguments: args,
  });
  tap.onRoundEnd();
  s.store.add({
    ...say(1, ""),
    meta: {
      kind: "say",
      beats: [
        { text: "别着急，慢慢说。" },
        { text: "太好了，真替你高兴！", mood: { id: "happy" } },
      ],
    },
  });
  s.world.poll();
  await until(() => s.played.length === 2);
  assert.match(s.played[0].instruction, /轻声安慰/);
  assert.match(s.played[1].instruction, /开心惊喜/);
  assert.deepEqual(
    s.played.map((r) => r.text),
    ["别着急，慢慢说。", "太好了，真替你高兴！"],
  );
});
test("a full queue immediately releases only the rejected reply bubble", async (t) => {
  const s = fixture(t);
  await s.start();
  const sent = [];
  const socket = wrapPetWebSocket({
    send: (raw) => sent.push(JSON.parse(raw)),
  });
  socket.send(
    JSON.stringify({ t: "say", id: "drop", beats: [{ text: "目标句。" }] }),
  );
  socket.send(
    JSON.stringify({
      t: "say",
      id: "later",
      beats: [{ text: "后面的句子。" }],
    }),
  );
  s.world.queue = Array.from({ length: 6 }, () => ({
    text: "queued",
    preview: false,
  }));
  assert.equal(s.world.enqueue("目标句。", false), undefined);
  assert.deepEqual(
    sent.map((message) => message.id),
    ["drop"],
  );
});
test("one enqueue failure does not lose later events after the cursor advances", async (t) => {
  const s = fixture(t);
  await s.start();
  const original = s.world.enqueue.bind(s.world);
  t.mock.method(s.world, "enqueue", (text, ...args) => {
    if (text === "坏事件。") throw new Error("fixture failure");
    return original(text, ...args);
  });
  s.store.add(say(1, "坏事件。"));
  s.store.add(say(2, "后面有效。"));
  s.world.poll();
  await until(() => s.played.length === 1);
  assert.equal(s.played[0].text, "后面有效。");
  assert.equal(s.world.cursor, 2);
});
test("voice and model edits cannot reuse incompatible pre-synthesis", async (t) => {
  const s = fixture(t);
  await s.start();
  const task = s.world.prewarmText("同一句话。");
  await task.promise;
  s.cfg.voice = "different-voice";
  s.world.enqueue("同一句话。", false);
  await until(() => s.played.length === 1);
  assert.equal(s.played[0].voice, "different-voice");
  assert.equal(s.requests.length, 2);
});
test("a speculative tone plan starts no paid synthesis; confirmed plans warm only the first line", async (t) => {
  const s = fixture(t, { toneMode: "ordinal" });
  await s.start();
  const args = {
    lines: Array.from({ length: 5 }, (_, i) => ({
      text: `第${i + 1}句话。`,
      tone: "自然。",
    })),
  };
  s.world.prewarmTonePlan(
    s.world.tonePlans.register(args, "speculative", false),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(s.requests.length, 0);
  s.world.prewarmTonePlan(
    s.world.tonePlans.register(args, "speculative", true),
  );
  await until(() => s.requests.length === 1);
  assert.equal(s.requests[0].text, "第1句话。");
});
test("continuous World playback consumes later packets before provider completion", async (t) => {
  const s = fixture(t);
  await s.start();
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const writes = [];
  let ended = false;
  s.world.createStream = (signal, options) => ({
    write(wav) {
      writes.push(wav);
      options.onStart();
      return Promise.resolve();
    },
    finish() {
      ended = true;
      return Promise.resolve();
    },
    cancel() {},
    promise: Promise.resolve(),
  });
  const controller = new AbortController(),
    task = {
      controller,
      promise,
      earlyChunks: [wave(120)],
      streamed: true,
      waitEarly: () => Promise.resolve(),
      sink: null,
    };
  const result = s.world.runSynthTask(
    task,
    "持续播放。",
    s.cfg,
    controller,
    false,
  );
  await until(() => writes.length === 1);
  task.sink(wave(120));
  assert.equal(writes.length, 2);
  assert.equal(ended, false);
  resolve(null);
  await result;
  assert.equal(ended, true);
});
test("automatic bubble discovery ignores unrelated socket routes and verifies the explicit pet route", (t) => {
  setBubbleSyncGate(() => ({ enabled: true }));
  t.after(() => setBubbleSyncGate(null));
  const server = new http.Server();
  server.on("upgrade", () => {});
  const sent = [],
    ws = new EventEmitter();
  ws.send = (raw) => sent.push(raw);
  const socket = {
    remoteAddress: "127.0.0.1",
    localPort: 50000,
    [Symbol("websocket")]: ws,
  };
  const original = ws.send;
  server.emit(
    "upgrade",
    { url: "/socket?role=other" },
    socket,
    Buffer.alloc(0),
  );
  assert.equal(ws.send, original);
  server.emit(
    "upgrade",
    { url: "/socket?role=pet&host=window" },
    socket,
    Buffer.alloc(0),
  );
  assert.notEqual(ws.send, original);
  assert.equal(getBubbleSyncDiagnostics().mode, "active");
  ws.emit("close");
  assert.equal(getBubbleSyncDiagnostics().mode, "degraded");
});
