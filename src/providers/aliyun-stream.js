import crypto from "node:crypto";
import { openWebSocket } from "../transport.js";
import { MAX_AUDIO_BYTES, pcmToWave, validateWave } from "../audio.js";

const idleSockets = new Map();
const IDLE_MS = 15000,
  MAX_IDLE = 4;
const keyOf = (endpoint, credentials) =>
  JSON.stringify([
    endpoint,
    crypto
      .createHash("sha256")
      .update(credentials?.apiKey ?? "")
      .digest("hex"),
  ]);

function retire(entry) {
  clearTimeout(entry.timer);
  entry.failed = true;
  entry.handshakeController.abort(
    new DOMException("预热连接已回收。", "AbortError"),
  );
  entry.connPromise.then(
    (conn) => conn.close(false),
    () => {},
  );
  if (idleSockets.get(entry.key) === entry) idleSockets.delete(entry.key);
}
export function clearIdleAliyunSockets() {
  for (const entry of idleSockets.values()) retire(entry);
  idleSockets.clear();
}
export function prewarmAliyunSocket(endpoint, credentials) {
  const key = keyOf(endpoint, credentials),
    old = idleSockets.get(key);
  if (old && !old.failed && Date.now() - old.createdAt < IDLE_MS) return old;
  if (old) retire(old);
  const entry = {
    key,
    createdAt: Date.now(),
    failed: false,
    handshakeController: new AbortController(),
    timer: null,
    connPromise: null,
  };
  const forget = () => {
    entry.failed = true;
    if (idleSockets.get(key) === entry) idleSockets.delete(key);
    clearTimeout(entry.timer);
  };
  entry.connPromise = openWebSocket(endpoint, {
    headers: { Authorization: `Bearer ${credentials.apiKey}` },
    signal: entry.handshakeController.signal,
    timeoutMs: 10000,
  }).then(
    (conn) => {
      if (entry.failed) {
        conn.close(false);
        throw new Error("预热连接已回收。");
      }
      conn.unref();
      conn.setHandlers({ onClose: forget, onError: forget });
      return conn;
    },
    (error) => {
      forget();
      throw error;
    },
  );
  entry.readyPromise = entry.connPromise;
  // Compatibility alias: readiness now means handshake-ready, not task-started.
  entry.startedPromise = entry.readyPromise;
  entry.readyPromise.catch(() => {});
  entry.timer = setTimeout(() => retire(entry), IDLE_MS);
  entry.timer.unref?.();
  idleSockets.set(key, entry);
  while (idleSockets.size > MAX_IDLE) retire(idleSockets.values().next().value);
  return entry;
}
function leaseSocket(endpoint, credentials) {
  const entry = prewarmAliyunSocket(endpoint, credentials);
  idleSockets.delete(entry.key);
  clearTimeout(entry.timer);
  return entry;
}

function audioCollector(cfg, options, finalize) {
  const rate = cfg.sampleRate ?? 24000;
  const each =
    typeof options.onAudioChunk === "function" ? options.onAudioChunk : null;
  const first =
    !each && typeof options.onFirstChunk === "function"
      ? options.onFirstChunk
      : null;
  const threshold = Math.max(2, Math.round(rate * (each ? 0.12 : 0.6)) * 2);
  let pending = Buffer.alloc(0),
    total = 0,
    emitted = false,
    early = false,
    container = null;
  const isWave = () => container === "wave";
  const emit = (pcm) => {
    emitted = true;
    (each ?? first)(pcmToWave(pcm, rate));
  };
  return {
    add(chunk) {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) throw new Error("TTS 音频超过 16 MB。");
      pending = Buffer.concat([pending, chunk]);
      if (container === null && pending.length >= 12)
        container =
          pending.toString("ascii", 0, 4) === "RIFF" &&
          pending.toString("ascii", 8, 12) === "WAVE"
            ? "wave"
            : "pcm";
      if (isWave()) return;
      if (each) {
        while (pending.length >= threshold) {
          const pcm = pending.subarray(0, threshold);
          pending = pending.subarray(threshold);
          emit(pcm);
        }
      } else if (first && !early && pending.length >= threshold) {
        const pcm = pending.subarray(0, threshold);
        pending = pending.subarray(threshold);
        early = true;
        emit(pcm);
      }
    },
    finish() {
      if (!total) throw new Error("阿里云语音合成未返回完成的音频数据。");
      if (isWave()) {
        const wav = finalize(pending);
        if (each) {
          emitted = true;
          each(wav);
          return null;
        }
        return wav;
      }
      if (pending.length % 2) throw new Error("PCM 音频采样长度未对齐。");
      if (each) {
        if (pending.length) emit(pending);
        return null;
      }
      return pending.length ? pcmToWave(pending, rate) : null;
    },
    get emitted() {
      return emitted;
    },
  };
}

export function createAliyunStream(
  endpoint,
  cfg,
  credentials,
  signal,
  options = {},
  parameters = {},
  finalize = validateWave,
) {
  const taskId = crypto.randomUUID().replaceAll("-", ""),
    input = [];
  let entry,
    conn,
    settled = false,
    started = false,
    finishedInput = false;
  const audio = audioCollector(cfg, options, finalize);
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
    : AbortSignal.timeout(45000);
  const fail = (reason) => {
    if (settled) return;
    settled = true;
    combined.removeEventListener("abort", abort);
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (audio.emitted) error.audioEmitted = true;
    entry?.handshakeController.abort(error);
    conn?.close(false);
    reject(error);
  };
  const abort = () =>
    fail(combined.reason ?? new DOMException("操作已取消。", "AbortError"));
  const flush = () => {
    if (!started || settled || !conn?.alive) return;
    for (const text of input.splice(0))
      conn.sendJson({
        header: {
          action: "continue-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: { input: { text } },
      });
    if (finishedInput === true) {
      finishedInput = "sent";
      conn.sendJson({
        header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
        payload: { input: {} },
      });
    }
  };
  if (combined.aborted) abort();
  else {
    combined.addEventListener("abort", abort, { once: true });
    entry = leaseSocket(endpoint, credentials);
    entry.readyPromise
      .then((socket) => {
        if (settled) {
          socket.close(false);
          return;
        }
        conn = socket;
        conn.ref();
        conn.setHandlers({
          onJson(message) {
            if (settled) return;
            const id = message?.header?.task_id;
            if (id && id !== taskId) return;
            const event = message?.header?.event ?? message?.event,
              code =
                message?.header?.error_code ??
                message?.header?.code ??
                message?.code;
            if (event === "task-failed" || code) {
              fail(
                new Error("阿里云语音合成失败，请检查地域、密钥、模型与音色。"),
              );
              return;
            }
            if (event === "task-started") {
              started = true;
              try {
                flush();
              } catch (error) {
                fail(error);
              }
              return;
            }
            if (event === "task-finished") {
              try {
                const result = audio.finish();
                settled = true;
                combined.removeEventListener("abort", abort);
                conn.close(true);
                resolve(result);
              } catch (error) {
                fail(error);
              }
            }
          },
          onBinary(chunk) {
            if (!settled)
              try {
                audio.add(chunk);
              } catch (error) {
                fail(error);
              }
          },
          onError: fail,
          onClose() {
            if (!settled)
              fail(new Error("TTS WebSocket 连接已关闭，未完成音频合成。"));
          },
        });
        if (!settled)
          conn.sendJson({
            header: {
              action: "run-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: {
              task_group: "audio",
              task: "tts",
              function: "SpeechSynthesizer",
              model: cfg.model,
              parameters: {
                text_type: "PlainText",
                voice: cfg.voice,
                format: "pcm",
                sample_rate: cfg.sampleRate ?? 24000,
                volume: 80,
                rate: cfg.speed ?? 1,
                pitch: 1,
                ...parameters,
              },
              input: {},
            },
          });
      })
      .catch(fail);
  }
  return {
    pushText(text) {
      if (!settled && !finishedInput && text) {
        input.push(text);
        try {
          flush();
        } catch (error) {
          fail(error);
        }
      }
    },
    finishText() {
      if (!settled && !finishedInput) {
        finishedInput = true;
        try {
          flush();
        } catch (error) {
          fail(error);
        }
      }
    },
    promise,
  };
}
