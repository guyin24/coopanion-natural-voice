import crypto from "node:crypto";
import {
  KEY_NAME,
  DEFAULTS,
  PRESETS,
  PROVIDERS,
  configGroup,
  normalizeConfig,
  validateConfig,
} from "./config.js";
import {
  readCredentials,
  saveCredentials,
  credentialsReady,
  migrateLegacyKey,
  clearCredentials,
} from "./credentials.js";
import {
  spokenSegments,
  splitBeatSegments,
  cleanText,
  extractStreamSegments,
  extractStreamFirstProgress,
  normalizeSegmentKey,
  streamBeatMetadata,
} from "./text.js";
import {
  synthesize,
  prewarmConnection,
  createDuplexSession,
  clearWarmAliyunTasks,
} from "./tts.js";
import { measureWaveGain } from "./audio.js";
import {
  playWave,
  createWaveStream,
  warmPlayer,
  disposePlayer,
  getPlayerDiagnostics,
} from "./player.js";
import { discoverCatalog, getBuiltinCatalog } from "./catalog.js";
import {
  setBubbleSyncGate,
  claimPendingBubble,
  flushPendingBubbles,
  scanActivePetSockets,
  getBubbleSyncDiagnostics,
} from "./pet-sync.js";
import { subscribeStoreAppend } from "./store-subscription.js";
import { fileURLToPath } from "node:url";
import {
  TONE_TOOL,
  DeliveryPlans,
  deliveryInstruction,
  supportsModelTone,
  moodTone,
} from "./delivery.js";

const INPUT_EVENTS = new Set([
  "desktop-pet.message",
  "desktop-pet.speech",
  "desktop-pet.answer",
]);
const PREWARM_TTL_MS = 30000;
const MAX_PREWARM_ENTRIES = 8;

function audioBuffer(signal) {
  const waiting = new Set();
  const state = {
    earlyChunks: [],
    streamed: false,
    sink: null,
    finished: false,
    accept(wave, continuous) {
      if (signal.aborted) return;
      if (continuous) state.streamed = true;
      if (state.sink) state.sink(wave);
      else state.earlyChunks.push(wave);
      for (const resolve of waiting) resolve();
      waiting.clear();
    },
    done() {
      state.finished = true;
      for (const resolve of waiting) resolve();
      waiting.clear();
    },
    waitEarly() {
      return state.earlyChunks.length || state.finished
        ? Promise.resolve()
        : new Promise((resolve) => waiting.add(resolve));
    },
  };
  return state;
}

export class NaturalVoiceWorld {
  id = "natural-voice";
  running = false;
  cursor = 0;
  queue = [];
  active = null;
  task = null;
  timer = null;
  unsubscribeStore = null;
  host = null;
  phase = "offline";
  error = "";
  catalogJobs = new Set();
  prewarmCache = new Map();
  streamItems = new Map();
  tonePlans = new DeliveryPlans();
  lastTone = "";

  constructor(context, options = {}) {
    this.context = context;
    migrateLegacyKey(context);
    Object.assign(context.cfg, normalizeConfig(context.cfg));
    this.synthesize = options.synthesize ?? synthesize;
    this.play = options.play ?? playWave;
    this.playReportsStart = options.playReportsStart ?? this.play === playWave;
    this.createStream =
      options.createWaveStream ??
      (this.play === playWave ? createWaveStream : null);
    this.discoverCatalog = options.catalog ?? discoverCatalog;
    this.createDuplex =
      options.createDuplexSession ??
      (this.synthesize === synthesize ? createDuplexSession : null);
    this.pollMs = options.pollMs ?? 200;
  }

  modelToneEnabled() {
    return supportsModelTone(this.context.cfg);
  }
  ordinalToneEnabled() {
    return this.modelToneEnabled() && this.context.cfg.toneMode === "ordinal";
  }
  tools() {
    if (!this.ordinalToneEnabled()) return [];
    return [
      {
        ...TONE_TOOL,
        handler: async (args, ctx = {}) => {
          ctx.signal?.throwIfAborted();
          if (!this.running || !this.ordinalToneEnabled())
            return { text: "语气标注未启用，请直接发言。", failed: true };
          this.prewarmTonePlan(this.tonePlans.register(args, ctx.callId, true));
          return {
            text: "已设置下一条回复各个 beat 的语气；请直接使用桌宠发言工具，不要复述语气。",
          };
        },
      },
    ];
  }
  envPromptVars() {
    return this.ordinalToneEnabled() ? {} : null;
  }
  onTurnEnded() {
    this.tonePlans.clear();
  }
  synthesisIdentity(instruction = this.context.cfg.speechInstruction) {
    const cfg = this.context.cfg;
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          cfg.provider,
          validateConfig(cfg),
          cfg.model,
          cfg.voice,
          cfg.speed,
          cfg.sampleRate,
          instruction,
          readCredentials(this.context, cfg.provider),
        ]),
      )
      .digest("hex");
  }
  updateStreamTone(entry, isDone) {
    const beats = streamBeatMetadata(entry.name, entry.args, isDone);
    if (entry.ordinalPlan) this.tonePlans.bind(entry.ordinalPlan, beats);
    const planTone = entry.ordinalPlan?.confirmed
      ? entry.ordinalPlan.lines[0]?.tone
      : null;
    entry.firstTone = this.modelToneEnabled()
      ? (planTone ?? moodTone(beats[0]?.mood ?? beats[0]?.actions))
      : null;
    return beats;
  }
  instructionFor(text, prefix = false, entry = null) {
    const tone =
      entry?.firstTone ??
      (this.ordinalToneEnabled() ? this.tonePlans.peek(text, prefix) : null);
    return deliveryInstruction(this.context.cfg.speechInstruction, tone);
  }
  prewarmToneLine(line) {
    if (!line?.text) return null;
    return this.prewarmText(
      cleanText(line.text, this.context.cfg.maxChars),
      deliveryInstruction(this.context.cfg.speechInstruction, line.tone),
    );
  }
  prewarmTonePlan(plan) {
    // Never synthesize all speculative annotations. Ordinal tones have no body
    // until the ordinary speech tool supplies it; legacy plans warm only line 1.
    if (!plan.confirmed || !this.canSpeculate()) return;
    const first = plan.lines.find((line) => !line.used && line.text);
    if (first) this.prewarmToneLine(first);
  }
  canSpeculate() {
    this.prunePrewarmCache();
    return !this.active && this.prewarmCache.size === 0;
  }

  onRunPhase(phase) {
    if (!this.running) return;
    if (phase?.state === "model") {
      if (this.play === playWave) warmPlayer();
      scanActivePetSockets();
      if (
        this.context.cfg.autoRead &&
        this.synthesize === synthesize &&
        credentialsReady(this.context, this.context.cfg.provider)
      ) {
        prewarmConnection(
          this.context.cfg,
          readCredentials(this.context, this.context.cfg.provider),
        );
      }
    }
  }

  setDuplexCacheKeys(duplexState, text) {
    for (const oldKey of duplexState.keys) {
      if (this.prewarmCache.get(oldKey) === duplexState.cacheEntry) {
        this.prewarmCache.delete(oldKey);
      }
    }
    duplexState.keys.clear();
    const normKey = normalizeSegmentKey(text) || text;
    duplexState.keys.add(normKey);
    duplexState.keys.add(text);
    this.prewarmCache.set(normKey, duplexState.cacheEntry);
    this.prewarmCache.set(text, duplexState.cacheEntry);
  }

  outputTap() {
    const updateDuplexFirstSegment = (entry, isDone) => {
      if (!this.createDuplex || entry.duplexDisabled) return;
      const beats = this.updateStreamTone(entry, isDone);
      const progress =
        this.modelToneEnabled() && beats[0]
          ? {
              text: cleanText(beats[0].text, this.context.cfg.maxChars),
              closed: beats[0].closed || isDone,
            }
          : extractStreamFirstProgress(
              entry.name,
              entry.args,
              isDone,
              this.context.cfg.maxChars,
            );
      if (!progress?.text) return;
      if (!entry.duplex) {
        if (!this.canSpeculate()) return;
        if (!progress.closed && Array.from(progress.text).length < 2) return;
        const controller = new AbortController();
        const cfg = {
          ...this.context.cfg,
          speechInstruction: this.instructionFor(progress.text, true, entry),
        };
        const credentials = readCredentials(this.context, cfg.provider);
        const chunks = audioBuffer(controller.signal);
        const session = this.createDuplex(cfg, credentials, controller.signal, {
          onFirstChunk: (wave) => chunks.accept(wave, false),
          onAudioChunk: (wave) => chunks.accept(wave, true),
        });
        if (!session) return;
        const cacheEntry = Object.assign(chunks, {
          promise: session.promise,
          controller,
          createdAt: Date.now(),
          session,
          isDuplex: true,
          speechInstruction: cfg.speechInstruction,
          identity: this.synthesisIdentity(cfg.speechInstruction),
        });
        entry.cacheEntries.add(cacheEntry);
        session.promise.then(
          () => chunks.done(),
          () => {
            chunks.done();
            for (const [k, v] of this.prewarmCache)
              if (v === cacheEntry) this.prewarmCache.delete(k);
          },
        );
        entry.duplex = {
          session,
          cacheEntry,
          fedText: "",
          closed: false,
          keys: new Set(),
        };
      }

      const d = entry.duplex;
      const prefixChanged = d.closed
        ? normalizeSegmentKey(progress.text) !== normalizeSegmentKey(d.fedText)
        : !progress.text.startsWith(d.fedText);
      if (prefixChanged) {
        // Markdown cleanup can retract a prefix after it was sent to the provider.
        // That audio cannot be reused under the newly cleaned text's cache key.
        d.cacheEntry.controller.abort();
        for (const key of d.keys) {
          if (this.prewarmCache.get(key) === d.cacheEntry)
            this.prewarmCache.delete(key);
        }
        entry.duplex = null;
        entry.duplexDisabled = true;
        return;
      }
      if (!d.closed && progress.text.startsWith(d.fedText)) {
        const delta = progress.text.slice(d.fedText.length);
        if (delta) {
          d.fedText = progress.text;
          d.session.pushText(delta);
          this.setDuplexCacheKeys(d, progress.text);
        }
      }
      if (progress.closed && !d.closed) {
        d.closed = true;
        const normKey = normalizeSegmentKey(progress.text) || progress.text;
        entry.prewarmed.add(normKey);
        entry.prewarmed.add(progress.text);
        this.setDuplexCacheKeys(d, progress.text);
        d.session.finishText();
        if (this.synthesize === synthesize) {
          // Immediately pre-warm next WebSocket task for segment 1
          prewarmConnection(
            this.context.cfg,
            readCredentials(this.context, this.context.cfg.provider),
          );
        }
      }
    };

    const prewarmRemainingSegments = (entry, isDone) => {
      if (entry.duplex || !this.canSpeculate()) return;
      const beats = this.updateStreamTone(entry, isDone);
      const segments =
        this.modelToneEnabled() && beats[0]
          ? beats[0].closed || isDone
            ? [cleanText(beats[0].text, this.context.cfg.maxChars)]
            : []
          : extractStreamSegments(
              entry.name,
              entry.args,
              isDone,
              this.context.cfg.maxChars,
            );
      const first = segments[0];
      if (!first) return;
      const key = normalizeSegmentKey(first) || first;
      if (!entry.prewarmed.has(key)) {
        entry.prewarmed.add(key);
        const task = this.prewarmText(
          first,
          this.instructionFor(first, false, entry),
        );
        if (task) entry.cacheEntries.add(task);
      }
    };

    const handleStreamEvent = (rawEvent) => {
      if (
        !this.running ||
        !this.context.cfg.autoRead ||
        !credentialsReady(this.context, this.context.cfg.provider)
      )
        return;
      const type = rawEvent?.type;
      if (type === "response.output_item.added") {
        const item = rawEvent.item;
        if (item?.type === "function_call" && item.name === TONE_TOOL.name) {
          const entry = {
            name: item.name,
            args: typeof item.arguments === "string" ? item.arguments : "",
            toneId: item.call_id ?? item.id,
          };
          this.streamItems.set(
            item.id ?? item.call_id ?? "tone-default",
            entry,
          );
          if (item.call_id) this.streamItems.set(item.call_id, entry);
          return;
        }
        if (
          item?.type === "function_call" &&
          (item.name === "pet_say" || item.name === "pet_ask")
        ) {
          if (this.synthesize === synthesize) {
            prewarmConnection(
              this.context.cfg,
              readCredentials(this.context, this.context.cfg.provider),
            );
          }
          const initialArgs =
            typeof item.arguments === "string" ? item.arguments : "";
          const entry = {
            name: item.name,
            args: initialArgs,
            prewarmed: new Set(),
            cacheEntries: new Set(),
            duplex: null,
            completed: false,
          };
          entry.ordinalPlan = this.ordinalToneEnabled()
            ? this.tonePlans.reserve(item.call_id ?? item.id)
            : null;
          this.streamItems.set(item.id ?? item.call_id ?? "default", entry);
          if (item.call_id) this.streamItems.set(item.call_id, entry);
          this.streamItems.set("default", entry);
          if (initialArgs) {
            updateDuplexFirstSegment(entry, false);
            prewarmRemainingSegments(entry, false);
          }
        }
        return;
      }
      if (type === "response.function_call_arguments.delta") {
        const key = rawEvent.item_id ?? rawEvent.call_id ?? "default";
        const unique = [...new Set(this.streamItems.values())];
        const entry =
          rawEvent.item_id || rawEvent.call_id
            ? this.streamItems.get(key)
            : unique.length === 1
              ? unique[0]
              : null;
        if (!entry || typeof rawEvent.delta !== "string") return;
        entry.args += rawEvent.delta;
        if (entry.name === TONE_TOOL.name) return;
        updateDuplexFirstSegment(entry, false);
        prewarmRemainingSegments(entry, false);
        return;
      }
      if (
        type === "response.function_call_arguments.done" ||
        type === "response.output_item.done"
      ) {
        const item = rawEvent.item;
        const key =
          item?.id ??
          rawEvent.item_id ??
          rawEvent.call_id ??
          item?.call_id ??
          "default";
        const entry =
          key !== "default" || new Set(this.streamItems.values()).size === 1
            ? this.streamItems.get(key)
            : null;
        if (key === "default" && !entry) return;
        const name = item?.name ?? entry?.name;
        const args =
          typeof item?.arguments === "string"
            ? item.arguments
            : typeof rawEvent.arguments === "string"
              ? rawEvent.arguments
              : entry?.args;
        if (name === TONE_TOOL.name) {
          if (entry && this.ordinalToneEnabled()) {
            try {
              this.tonePlans.register(
                JSON.parse(args ?? ""),
                entry.toneId,
                false,
              );
            } catch {}
          }
          return;
        }
        if (name === "pet_say" || name === "pet_ask") {
          if (entry) {
            entry.completed = true;
            if (args) entry.args = args;
            updateDuplexFirstSegment(entry, true);
            prewarmRemainingSegments(entry, true);
            for (const taskEntry of entry.cacheEntries)
              taskEntry.completedCall = true;
          } else {
            for (const seg of extractStreamSegments(
              name,
              args ?? "",
              true,
              this.context.cfg.maxChars,
            ).slice(0, 1)) {
              if (!this.canSpeculate()) break;
              const taskEntry = this.prewarmText(seg);
              if (taskEntry) taskEntry.completedCall = true;
            }
          }
        }
      }
    };

    const clearTurn = () => {
      const entries = [...new Set(this.streamItems.values())].filter(
        (entry) => entry.name !== TONE_TOOL.name,
      );
      const completedTasks = new Set(
        entries
          .filter((entry) => entry.completed)
          .flatMap((entry) => [...entry.cacheEntries]),
      );
      for (const entry of entries) {
        if (entry.completed) continue;
        for (const taskEntry of entry.cacheEntries) {
          // A completed call may share a text-keyed prewarm, and a store event
          // may already have claimed it for playback. Neither is orphaned work.
          if (
            taskEntry.completedCall ||
            completedTasks.has(taskEntry) ||
            ![...this.prewarmCache.values()].includes(taskEntry)
          )
            continue;
          taskEntry.controller.abort();
          for (const [key, value] of this.prewarmCache) {
            if (value === taskEntry) this.prewarmCache.delete(key);
          }
        }
      }
      this.streamItems.clear();
    };

    return {
      externalizes: () => false,
      onEvent: handleStreamEvent,
      onStreamEvent: handleStreamEvent,
      onTurnStart: clearTurn,
      onTurnEnd: clearTurn,
      onRoundEnd: clearTurn,
      onAbort: () => {
        this.tonePlans.clear();
        this.streamItems.clear();
        this.clearPrewarmCache();
        flushPendingBubbles();
      },
    };
  }

  createSynthesisTask(
    text,
    controller,
    speechInstruction = this.instructionFor(text),
  ) {
    const cfg = { ...this.context.cfg, speechInstruction },
      credentials = readCredentials(this.context, cfg.provider);
    const state = audioBuffer(controller.signal);
    let nextWarm = false;
    const promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return this.synthesize(
          cfg,
          credentials,
          text,
          controller.signal,
          this.synthesize === synthesize
            ? {
                onFirstChunk: (wave) => state.accept(wave, false),
                onAudioChunk: (wave) => {
                  state.accept(wave, true);
                  if (!nextWarm) {
                    nextWarm = true;
                    prewarmConnection(cfg, credentials);
                  }
                },
              }
            : undefined,
        );
      })
      .then(
        (audio) => {
          state.done();
          return audio;
        },
        (error) => {
          state.done();
          throw error;
        },
      );
    promise.catch(() => {});
    return Object.assign(state, {
      text,
      promise,
      controller,
      createdAt: Date.now(),
      speechInstruction,
      identity: this.synthesisIdentity(speechInstruction),
    });
  }

  prunePrewarmCache() {
    const now = Date.now();
    for (const [key, entry] of this.prewarmCache.entries()) {
      if (
        now - entry.createdAt > PREWARM_TTL_MS ||
        entry.controller.signal.aborted
      ) {
        entry.controller.abort();
        this.prewarmCache.delete(key);
      }
    }
  }

  clearPrewarmCache() {
    for (const entry of new Set(this.prewarmCache.values())) {
      entry.controller.abort();
    }
    this.prewarmCache.clear();
  }

  prewarmText(text, speechInstruction = this.instructionFor(text)) {
    this.prunePrewarmCache();
    const normKey = normalizeSegmentKey(text) || text;
    if (!text) return null;
    const existing =
      this.prewarmCache.get(text) ?? this.prewarmCache.get(normKey);
    if (
      existing &&
      (!existing.text || existing.text === text) &&
      existing.identity === this.synthesisIdentity(speechInstruction)
    )
      return existing;
    if (existing) {
      existing.controller.abort();
      for (const [k, v] of this.prewarmCache)
        if (v === existing) this.prewarmCache.delete(k);
    }
    const distinctEntries = [...new Set(this.prewarmCache.values())];
    if (distinctEntries.length >= MAX_PREWARM_ENTRIES) {
      const evict =
        distinctEntries.find((e) => !e.isDuplex) ?? distinctEntries[0];
      if (evict) {
        evict.controller.abort();
        for (const [k, v] of this.prewarmCache.entries()) {
          if (v === evict) this.prewarmCache.delete(k);
        }
      }
    }
    try {
      validateConfig(this.context.cfg);
      if (!credentialsReady(this.context, this.context.cfg.provider)) return;
    } catch {
      return;
    }
    const controller = new AbortController();
    const taskEntry = this.createSynthesisTask(
      text,
      controller,
      speechInstruction,
    );
    taskEntry.promise.catch(() => {
      if (this.prewarmCache.get(normKey) === taskEntry)
        this.prewarmCache.delete(normKey);
      if (this.prewarmCache.get(text) === taskEntry)
        this.prewarmCache.delete(text);
    });
    this.prewarmCache.set(normKey, taskEntry);
    this.prewarmCache.set(text, taskEntry);
    return taskEntry;
  }

  takePrewarm(text, speechInstruction = this.context.cfg.speechInstruction) {
    this.prunePrewarmCache();
    const normKey = normalizeSegmentKey(text) || text;
    const entry = this.prewarmCache.get(text) ?? this.prewarmCache.get(normKey);
    if (!entry || (entry.text && entry.text !== text)) return null;
    for (const [k, v] of this.prewarmCache.entries()) {
      if (v === entry) this.prewarmCache.delete(k);
    }
    if (
      Date.now() - entry.createdAt > PREWARM_TTL_MS ||
      entry.controller.signal.aborted ||
      entry.identity !== this.synthesisIdentity(speechInstruction)
    ) {
      entry.controller.abort();
      return null;
    }
    entry.session?.finishText?.();
    return entry;
  }

  state() {
    const credentialStatus = Object.fromEntries(
      Object.entries(PROVIDERS).map(([id, platform]) => {
        const values = readCredentials(this.context, id);
        return [
          id,
          Object.fromEntries(
            platform.credentials.map(({ id: field }) => [
              field,
              Boolean(values[field]),
            ]),
          ),
        ];
      }),
    );
    return {
      running: this.running,
      keySet: credentialsReady(this.context, this.context.cfg.provider),
      modelToneEnabled: this.modelToneEnabled(),
      pendingToneLines: this.tonePlans.pending,
      lastTone: this.lastTone,
      sync: getBubbleSyncDiagnostics(),
      player:
        this.play === playWave ? getPlayerDiagnostics() : { injected: true },
      phase: this.phase,
      busy: this.active !== null,
      queued: this.queue.length,
      error: this.error,
      config: Object.fromEntries(
        Object.keys(DEFAULTS).map((key) => [key, this.context.cfg[key]]),
      ),
      presets: PRESETS,
      providers: PROVIDERS,
      credentialStatus,
    };
  }

  async start(host) {
    this.host = host;
    this.cursor = host.store.latestCursor();
    this.running = true;
    this.phase = "idle";
    if (this.play === playWave) warmPlayer();
    setBubbleSyncGate(() => ({
      enabled: Boolean(
        this.running &&
        this.context.cfg.autoRead &&
        credentialsReady(this.context, this.context.cfg.provider),
      ),
      timeoutMs: 1800,
      maxChars: this.context.cfg.maxChars,
    }));
    this.unsubscribeStore = subscribeStoreAppend(host.store, () => {
      try {
        this.poll();
      } catch (error) {
        this.report(error);
      }
    });
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (error) {
        this.report(error);
      }
    }, this.pollMs);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    setBubbleSyncGate(null);
    this.cancel();
    clearWarmAliyunTasks();
    for (const job of this.catalogJobs) job.abort();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    clearInterval(this.timer);
    this.timer = null;
    await this.task;
    if (this.play === playWave) disposePlayer();
    this.host = null;
    this.phase = "offline";
  }

  releaseEventBubble(event) {
    const opening = spokenSegments(event, this.context.cfg.maxChars)[0];
    if (opening) {
      const group = claimPendingBubble(opening);
      flushPendingBubbles(opening, group);
    }
  }
  poll() {
    if (!this.running || !this.host) return;
    this.prunePrewarmCache();
    const latest = this.host.store.latestCursor();
    if (latest < this.cursor) this.cursor = 0;
    if (!this.context.cfg.autoRead) {
      this.cursor = latest;
      flushPendingBubbles();
      if (this.active && !this.active.preview) this.cancel();
      return;
    }
    if (latest <= this.cursor) return;
    const events = this.host.store.range({
      fromCursor: this.cursor + 1,
      toCursor: latest,
    });
    for (const event of events) {
      try {
        this.consumeEvent(event);
      } catch (error) {
        if (!error.bubbleHandled) this.releaseEventBubble(event);
        this.report(error);
      } finally {
        this.cursor = Math.max(this.cursor, event.cursor ?? 0);
      }
    }
    this.cursor = Math.max(this.cursor, latest);
  }
  consumeEvent(event) {
    if (
      event.source === "desktop-pet" &&
      INPUT_EVENTS.has(event.type) &&
      this.context.cfg.interruptOnInput
    )
      this.cancel();
    const segments = spokenSegments(event, this.context.cfg.maxChars);
    if (!segments.length) return;
    if (!credentialsReady(this.context, this.context.cfg.provider)) {
      this.releaseEventBubble(event);
      return;
    }
    const deliveries = [],
      gainHolder = { gain: null };
    if (this.modelToneEnabled()) {
      const beats =
        event.meta?.kind === "say"
          ? (event.meta.beats ?? [])
          : [{ text: event.meta?.question }];
      if (this.ordinalToneEnabled())
        this.tonePlans.bindUnreserved(
          beats.map((beat) => ({ text: beat.text ?? "", closed: true })),
        );
      let remaining = this.context.cfg.maxChars;
      for (const beat of beats) {
        if (typeof beat.text !== "string" || remaining <= 0) continue;
        const cleaned = cleanText(beat.text, remaining);
        if (!cleaned) continue;
        remaining -= Array.from(cleaned).length;
        const tone =
          (this.ordinalToneEnabled()
            ? this.tonePlans.claim(beat.text)
            : null) ?? moodTone(beat.mood);
        deliveries.push({
          text: cleaned,
          instruction: deliveryInstruction(
            this.context.cfg.speechInstruction,
            tone,
          ),
          tone: tone ?? "",
        });
      }
    }
    const jobs = deliveries.length
      ? deliveries
      : segments.map((text) => ({
          text,
          instruction: this.context.cfg.speechInstruction,
        }));
    for (const [index, job] of jobs.entries()) {
      const queued = this.enqueue(
        job.text,
        false,
        index === 0,
        job.instruction,
        index === 0 ? segments[0] : job.text,
        job.tone,
        gainHolder,
      );
      if (index === 4 && jobs.length > 5) {
        if (queued) queued.following = jobs.slice(5);
        break;
      }
    }
  }

  enqueue(
    text,
    preview,
    releaseBubble = !preview,
    speechInstruction = this.context.cfg.speechInstruction,
    bubbleOpeningText = text,
    tone = "",
    gainHolder = { gain: null },
  ) {
    const bubbleGroup = releaseBubble
      ? claimPendingBubble(bubbleOpeningText)
      : null;
    const reject = () => {
      if (releaseBubble) flushPendingBubbles(bubbleOpeningText, bubbleGroup);
    };
    try {
      if (!this.running) throw new Error("请先启用自然语音 World。");
      validateConfig(this.context.cfg);
      if (!credentialsReady(this.context, this.context.cfg.provider))
        throw new Error("请先保存所选平台的凭据。");
      if (this.queue.length >= 6) {
        reject();
        this.report(new Error("朗读队列已满，已跳过新消息。"));
        return;
      }
    } catch (error) {
      reject();
      error.bubbleHandled = true;
      throw error;
    }
    const prewarmed = preview
      ? null
      : this.takePrewarm(text, speechInstruction);
    const job = {
      text,
      preview,
      releaseBubble,
      bubbleGroup,
      prefetch: prewarmed,
      gainHolder,
      speechInstruction,
      tone,
    };
    this.queue.push(job);
    if (this.phase === "playing" && this.queue.length === 1) {
      this.startPrefetch(this.queue[0]);
    }
    this.kick();
    return job;
  }

  startPrefetch(job) {
    if (
      job?.prefetch &&
      job.prefetch.identity !== this.synthesisIdentity(job.speechInstruction)
    ) {
      job.prefetch.controller.abort();
      job.prefetch = null;
    }
    if (!job || job.prefetch || (!job.preview && !this.context.cfg.autoRead))
      return;
    const prewarmed = this.takePrewarm(job.text, job.speechInstruction);
    if (prewarmed) {
      job.prefetch = prewarmed;
      return;
    }
    const controller = new AbortController();
    const taskEntry = this.createSynthesisTask(
      job.text,
      controller,
      job.speechInstruction,
    );
    taskEntry.promise.catch(() => {});
    job.prefetch = taskEntry;
  }

  kick() {
    if (this.task) return;
    this.task = this.drain().finally(() => {
      this.task = null;
      if (this.running && this.queue.length) this.kick();
    });
  }

  async playStreamingTask(task, cfg, controller, onStart, gainHolder) {
    const local = new AbortController(),
      signal = AbortSignal.any([controller.signal, local.signal]);
    const writes = [];
    let stream;
    const accept = (wave) => {
      if (signal.aborted) return;
      gainHolder.gain ??= measureWaveGain(wave, { volume: cfg.volume ?? 1 });
      stream ??= this.createStream(signal, {
        volume: cfg.volume ?? 1,
        gain: gainHolder.gain,
        onStart,
      });
      const writing = stream.write(wave);
      writing.catch((error) => {
        local.abort(error);
        task.controller.abort(error);
      });
      writes.push(writing);
    };
    try {
      for (const wave of task.earlyChunks.splice(0)) accept(wave);
      task.sink = accept;
      const rest = await task.promise;
      if (rest) accept(rest);
      signal.throwIfAborted();
      if (!stream) throw new Error("语音服务没有返回可播放的音频。");
      await stream.finish();
      await Promise.all(writes);
    } catch (error) {
      local.abort(error);
      task.controller.abort(error);
      stream?.cancel(error);
      await stream?.promise.catch(() => {});
      await Promise.allSettled(writes);
      throw error;
    } finally {
      task.sink = null;
    }
  }

  async runSynthTask(
    synthTask,
    jobText,
    cfg,
    controller,
    releaseBubble = true,
    bubbleGroup = undefined,
    tone = "",
    gainHolder = { gain: null },
  ) {
    const vol = cfg.volume ?? 1;
    let playbackStarted = false;
    const onStart = () => {
      if (playbackStarted || controller.signal.aborted) return;
      playbackStarted = true;
      this.phase = "playing";
      this.lastTone = tone;
      if (releaseBubble)
        flushPendingBubbles(bubbleGroup?.openingKey ?? jobText, bubbleGroup);
      if (this.queue.length) this.startPrefetch(this.queue[0]);
    };
    let onAbort = null;
    if (synthTask.controller !== controller) {
      onAbort = () => synthTask.controller.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    }
    try {
      if (synthTask.waitEarly) {
        await Promise.race([
          synthTask.waitEarly(),
          synthTask.promise.catch(() => {}),
        ]);
      }
      if (synthTask.streamed && this.createStream)
        return await this.playStreamingTask(
          synthTask,
          cfg,
          controller,
          onStart,
          gainHolder,
        );
      if (synthTask.streamed) {
        await synthTask.promise;
        for (const wave of synthTask.earlyChunks.splice(0))
          await this.play(wave, controller.signal, { volume: vol, onStart });
        return;
      }
      if (synthTask.earlyChunks?.length > 0) {
        controller.signal.throwIfAborted();
        if (!this.playReportsStart) onStart();
        if (this.queue.length) this.startPrefetch(this.queue[0]);
        const firstWav = synthTask.earlyChunks.shift();
        let lockedGain = null;
        try {
          lockedGain =
            gainHolder.gain ?? measureWaveGain(firstWav, { volume: vol });
          gainHolder.gain ??= lockedGain;
        } catch {}
        const playbackController = new AbortController();
        const playbackSignal = AbortSignal.any([
          controller.signal,
          playbackController.signal,
        ]);
        const playFirstPromise = Promise.resolve().then(() => {
          playbackSignal.throwIfAborted();
          return this.play(firstWav, playbackSignal, {
            volume: vol,
            gain: lockedGain,
            onStart,
          });
        });
        // Observe playback immediately, including while the provider is still generating.
        const firstOrRemainder = playFirstPromise.then(() => synthTask.promise);
        let playRestPromise = null;
        try {
          const remainderWav = await Promise.race([
            synthTask.promise,
            firstOrRemainder,
          ]);
          if (
            remainderWav &&
            remainderWav.length > 44 &&
            !controller.signal.aborted
          ) {
            if (this.play === playWave) {
              playRestPromise = this.play(remainderWav, playbackSignal, {
                volume: vol,
                gain: lockedGain,
              });
              await Promise.all([playFirstPromise, playRestPromise]);
            } else {
              await playFirstPromise;
              playbackSignal.throwIfAborted();
              playRestPromise = this.play(remainderWav, playbackSignal, {
                volume: vol,
                gain: lockedGain,
              });
              await playRestPromise;
            }
          } else {
            await playFirstPromise;
          }
        } catch (error) {
          playbackController.abort(error);
          if (synthTask.controller !== controller)
            synthTask.controller.abort(error);
          await Promise.allSettled(
            [playFirstPromise, playRestPromise].filter(Boolean),
          );
          throw error;
        }
        return;
      }

      let audio;
      try {
        audio = await synthTask.promise;
      } catch (err) {
        if (synthTask.isDuplex && !controller.signal.aborted) {
          const fallbackTask = this.createSynthesisTask(
            jobText,
            new AbortController(),
            cfg.speechInstruction,
          );
          return await this.runSynthTask(
            fallbackTask,
            jobText,
            cfg,
            controller,
            releaseBubble,
            bubbleGroup,
            tone,
          );
        }
        throw err;
      }
      controller.signal.throwIfAborted();
      if (!this.playReportsStart) onStart();
      if (this.queue.length) this.startPrefetch(this.queue[0]);
      if (audio) {
        try {
          gainHolder.gain ??= measureWaveGain(audio, { volume: vol });
        } catch {}
        await this.play(audio, controller.signal, {
          volume: vol,
          gain: gainHolder.gain,
          onStart,
        });
      }
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async drain() {
    while (this.running && this.queue.length) {
      const job = this.queue.shift();
      // Unfold at most one continuation into the bounded queue. Each part
      // retains its tone; cancellation drops the whole remaining chain.
      if (job.following?.length) {
        const [next, ...following] = job.following;
        this.queue.unshift({
          text: next.text,
          preview: false,
          releaseBubble: false,
          bubbleGroup: null,
          speechInstruction: next.instruction,
          tone: next.tone ?? "",
          following,
          gainHolder: job.gainHolder,
        });
        job.following = null;
      }
      if (!job.preview && !this.context.cfg.autoRead) {
        job.prefetch?.controller?.abort();
        flushPendingBubbles();
        continue;
      }
      if (
        job.prefetch &&
        job.prefetch.identity !== this.synthesisIdentity(job.speechInstruction)
      ) {
        job.prefetch.controller.abort();
        job.prefetch = null;
      }
      const controller = new AbortController();
      controller.preview = job.preview;
      this.active = controller;
      try {
        this.error = "";
        this.phase = "generating";
        const cfg = {
          ...this.context.cfg,
          speechInstruction: job.speechInstruction,
        };
        const synthTask =
          job.prefetch ??
          this.takePrewarm(job.text, job.speechInstruction) ??
          this.createSynthesisTask(
            job.text,
            new AbortController(),
            job.speechInstruction,
          );
        await this.runSynthTask(
          synthTask,
          job.text,
          cfg,
          controller,
          job.releaseBubble,
          job.bubbleGroup,
          job.tone,
          job.gainHolder ?? { gain: null },
        );
      } catch (error) {
        flushPendingBubbles();
        if (!controller.signal.aborted) this.report(error);
      } finally {
        if (this.active === controller) this.active = null;
        this.phase = this.running ? (this.error ? "error" : "idle") : "offline";
      }
    }
  }

  cancel() {
    this.tonePlans.clear();
    this.lastTone = "";
    for (const job of this.queue) job.prefetch?.controller?.abort();
    this.queue.length = 0;
    this.clearPrewarmCache();
    this.streamItems.clear();
    this.active?.abort();
    flushPendingBubbles();
    if (this.host) this.cursor = this.host.store.latestCursor();
  }

  report(error) {
    let message = error instanceof Error ? error.message : String(error);
    const values = [
      this.context.secret(KEY_NAME),
      ...Object.keys(PROVIDERS).flatMap((provider) =>
        Object.values(readCredentials(this.context, provider)),
      ),
    ];
    for (const value of [...new Set(values)]
      .filter((value) => typeof value === "string" && value)
      .sort((a, b) => b.length - a.length))
      message = message.split(value).join("[redacted]");
    this.error = message;
    this.phase = "error";
    this.host?.log.warn(`Natural Voice: ${message}`);
  }

  webUi(language = "zh") {
    const zh = language === "zh";
    const ready = credentialsReady(this.context, this.context.cfg.provider);
    return {
      label: zh ? "自然语音" : "Natural Voice",
      lamps: [
        {
          label: "TTS",
          state: this.error
            ? "error"
            : !this.running || !ready
              ? "offline"
              : this.active
                ? "loading"
                : "online",
          hint:
            this.error ||
            (ready
              ? this.phase
              : zh
                ? "请保存所选服务的凭据。"
                : "Save credentials for the selected service."),
        },
      ],
      config: [configGroup(language)],
      promptDocs: [
        {
          key: "worlds.natural-voice.envPrompt",
          title: zh ? "每句语气说明" : "Per-line delivery guidance",
          description: zh
            ? "指导回复模型为正文标注语气。"
            : "Guide reply-model delivery annotations.",
          path: fileURLToPath(new URL("./tone-prompt.md", import.meta.url)),
          role: "envPrompt",
          vars: [],
        },
      ],
      panels: [
        {
          id: "voice",
          title: zh ? "语音设置与试听" : "Voice settings and preview",
          getMethods: ["state"],
        },
      ],
      invoke: async (panel, method, args = []) => {
        if (panel !== "voice") throw new Error("Unknown panel");
        if (method === "state") return this.state();
        if (method === "catalog") {
          const input = args[0] ?? this.context.cfg;
          const cfg = normalizeConfig(
            Object.fromEntries(
              Object.keys(DEFAULTS)
                .filter((key) => Object.hasOwn(input, key))
                .map((key) => [key, input[key]]),
            ),
          );
          const controller = new AbortController();
          this.catalogJobs.add(controller);
          try {
            return await this.discoverCatalog(
              cfg,
              readCredentials(this.context, cfg.provider),
              controller.signal,
            );
          } catch {
            return {
              ...getBuiltinCatalog(cfg),
              source: "preset",
              note: "在线目录暂时无法读取，已保留官方预设；可刷新重试或手动输入 ID。",
            };
          } finally {
            this.catalogJobs.delete(controller);
          }
        }
        if (method === "saveKey") {
          const key = typeof args[0] === "string" ? args[0].trim() : "";
          saveCredentials(this.context, this.context.cfg.provider, {
            apiKey: key,
          });
          this.error = "";
          return this.state();
        }
        if (method === "saveCredentials") {
          saveCredentials(this.context, args[0], args[1]);
          this.error = "";
          return this.state();
        }
        if (method === "clearCredentials") {
          if (args[0] === this.context.cfg.provider) this.cancel();
          clearCredentials(this.context, args[0]);
          this.error = "";
          return this.state();
        }
        if (method === "validateConfig") {
          validateConfig(args[0] ?? this.context.cfg);
          return { ok: true };
        }
        if (method === "stop") {
          this.cancel();
          return this.state();
        }
        if (method === "preview") {
          const text =
            typeof args[0] === "string"
              ? cleanText(args[0], this.context.cfg.maxChars)
              : "";
          if (!text) throw new Error("请填写试听文本。");
          this.cancel();
          this.enqueue(text, true);
          return this.state();
        }
        throw new Error("Unknown method");
      },
    };
  }
}
